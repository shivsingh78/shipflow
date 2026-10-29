# RepoPilot

RepoPilot analyses a GitHub repository with an AI model, proposes **one** fix plus a regression
test for a finding you choose, checks the patch when an isolated sandbox is available, and opens a
**draft pull request only after you approve the exact change**. It never merges.

> **Status: partially implemented.** Everything except real test execution works and is tested
> (see [What is and is not validated](#what-is-and-is-not-validated)). Sandbox verification is
> **off by default and no sandbox implementation ships in this repository**: until you provision and
> validate an isolated runner, every patch is reported as *inconclusive: verification unavailable*.

## The workflow

1. You authorise a repository and store **your own** Anthropic API key.
2. You start an analysis. The worker pins the exact commit SHA, builds a manifest, and asks the
   model for structured findings (suggestions, not facts).
3. You pick a finding. The worker asks the model for a source diff and a new test, validates both
   against policy, and dry-runs them against the pinned snapshot.
4. If a sandbox is available: baseline, control (new test only) and patched runs are recorded and
   classified `improved` / `unchanged` / `regressed` / `inconclusive`. Otherwise: `inconclusive`.
5. You review the diffs and evidence and explicitly authorise the pull request. The authorisation
   is bound to the patch digest, base commit and outcome you saw.
6. The worker re-checks all of that, creates a `repopilot/…` branch from the *analysed* commit
   through the Git Data API, and opens a draft pull request.

## Trust boundaries

```
Browser ──token──► API ───────────────► PostgreSQL ◄────────── repopilot-worker
                    │ validates, stores,                          │ GitHub token (env, worker only)
                    │ enqueues IDs only                           │ credential PRIVATE key (worker only)
                    │ holds the credential PUBLIC key             │ never runs repository code
                    ▼                                             ▼
                  Redis/BullMQ ───────────────────────────► GitHub API · Anthropic API (customer's key)

            [ sandbox runner: separate, isolated host/VM — NOT part of this repository ]
```

* The **API** never holds the GitHub token, the credential private key, or a Docker socket. If
  either secret appears in the API's environment, RepoPilot refuses to start there.
* The **worker** reads GitHub and calls the provider. It has no Docker socket, no workspace volume
  and no way to execute repository code (a test enforces that no RepoPilot module imports
  `child_process`).
* **Model output is untrusted**: strict Zod schemas, a deep scan for fields a model must never
  supply (verification results, approvals, merges), and grounding against the files actually sent.
* **Only sandbox records determine verification outcomes.** There is no field in any model schema
  that could carry one.

## Enabling it

All of this is opt-in. Nothing below is on by default.

1. **Generate the credential key pair** (once; keep the private key safe, rotating invalidates stored keys):
   `node dist/src/repopilot/keygen.js ./repopilot-keys`
2. **API (`.env`)**: `REPOPILOT=enabled` and `REPOPILOT_CREDENTIAL_PUBLIC_KEY_FILE=<public key path>`.
3. **Worker (`repopilot-worker.env`, copy from `repopilot-worker.env.example`)**:
   `REPOPILOT_GITHUB_TOKEN` and `REPOPILOT_CREDENTIAL_PRIVATE_KEY_FILE`. **Never put these in `.env`**:
   the API shares that file. Mount the private key as a file/secret.
4. Start the worker: `docker compose --profile repopilot up -d` (or `pnpm repopilot-worker`).
5. In the dashboard open **RepoPilot**, store your key, authorise a repository, start an analysis.

### GitHub token

Use a **fine-grained personal access token** limited to the repositories you want analysed:
*Contents: read & write* (to create the `repopilot/*` branch) and *Pull requests: read & write*.
Nothing else: no administration, workflows, or merge-related permission. The token lives only in
the worker's environment: never in queue payloads, the database, logs, artifacts or responses.
A GitHub App (short-lived installation tokens) would be the better long-term design; it is not
implemented. Pull requests are opened from a branch in the same repository, so the token needs push
access there; fork-based pull requests are not supported.

### AI provider key (BYOK)

RepoPilot only ever uses a key the customer stored. There is no code path that reads an
operator-level key from the environment (a test scans for it), and a missing key fails the stage
with an explanation instead of falling back. Keys are sealed with **RSA-OAEP (SHA-256)** to the public
key; only the worker's private key can open them. **Limit:** the API process sees the key in memory
while handling the submit request; sealing protects stored keys from a later API or database
compromise, not from a compromise at the moment of submission.

## Environment variables

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `REPOPILOT` | API, worker | off | `enabled` turns the feature on (exact value) |
| `REPOPILOT_SANDBOX` | worker | `off` | `off` or `remote`. `remote` currently reports *unavailable* |
| `REPOPILOT_CREDENTIAL_PUBLIC_KEY[_FILE]` | API, worker | – | PEM public key; a private key here is refused |
| `REPOPILOT_CREDENTIAL_PRIVATE_KEY[_FILE]` | **worker only** | – | PEM private key |
| `REPOPILOT_GITHUB_TOKEN` | **worker only** | – | fine-grained PAT |
| `REPOPILOT_ALLOW_PRIVATE` | worker | `false` | allow private repos (their code goes to your AI provider) |
| `REPOPILOT_PR_DRAFT` | worker | `true` | open PRs as drafts |
| `REPOPILOT_AI_MODEL` | worker | `claude-sonnet-5-5` | model id |
| `REPOPILOT_MAX_ACTIVE_RUNS` | API, worker | 3 | unfinished runs per owner |
| `REPOPILOT_MAX_AI_REQUESTS` / `_INPUT_TOKENS` / `_OUTPUT_TOKENS` | worker | 8 / 200000 / 40000 | per-run spend guard (customer's key) |
| `REPOPILOT_MAX_CONTEXT_TOKENS` | worker | 60000 | source sent per analysis |
| `REPOPILOT_MAX_FILE_BYTES` / `_SNAPSHOT_BYTES` / `_MANIFEST_FILES` | worker | 256 KiB / 25 MiB / 2000 | ingestion bounds |
| `REPOPILOT_AI_TIMEOUT_MS` | worker | 120000 | provider call timeout |
| `REPOPILOT_VERIFY_ATTEMPTS` / `_TIMEOUT_MS` / `_MAX_VERIFY_LOG_BYTES` | worker | 2 / 300000 / 256 KiB | verification |
| `REPOPILOT_RATE_READ_PER_MIN` / `_WRITE_` / `_CREDENTIALS_` | API | 240 / 30 / 5 | per-process rate limits |
| `REPOPILOT_EVIDENCE_RETENTION_DAYS` | worker | 90 | logs and artifacts of finished runs |
| `REPOPILOT_WORKER_CONCURRENCY` | worker | 1 | parallel stages |

Invalid numbers fail startup with the variable's name. Unsupported values never enable anything.

## API (all under `/repopilot`, bearer-token authenticated)

`GET /status` · `GET /metrics` · `GET|POST /repositories`, `DELETE /repositories/:owner/:name` ·
`GET /credentials`, `PUT|DELETE /credentials/:provider` · `GET|POST /runs`, `GET /runs/:id`,
`POST /runs/:id/cancel` · `GET /runs/:id/{findings,patches,patches/:pid,verifications,logs,audit,artifacts,artifacts/:aid,pull-request}` ·
`POST /runs/:id/findings/:fid/patch` · `POST /runs/:id/pull-request`.

**Authorisation.** ShipFlow has one shared API token, so there is one principal (the instance
operator). Every data access is still scoped by owner in SQL (another owner's run is simply "not
found"), and `resolvePrincipal` is the single place a multi-user model would plug in. Multiple
users, per-user repository permissions and SSO are **not** implemented. Runs need an explicitly
authorised repository; a PR needs a user actor; actors are `user:`, `worker:` or `system`, never a model.

Inputs are validated (ids, queries, bodies are strict); errors never echo input, SQL or paths.
Request bodies are limited to 64 KB; rate limits are in-memory per API process.

## Data, migrations, rollback

`db/schema.sql` gains `rp_*` tables (runs, stages, repositories, findings, patches, verifications,
outcomes, pull_requests, artifacts, logs, credentials, audit_events). It is additive and
idempotent like the rest of the file and runs at startup under the existing advisory lock.
Notable constraints: patch bytes are immutable (trigger); the audit log is append-only and
hash-chained (trigger + `GET /runs/:id/audit` verifies the chain); at most one PR per patch.
**Rollback:** the tables are independent of releases, so rolling back means disabling RepoPilot
(`REPOPILOT` unset); the tables can stay or be dropped (`DROP TABLE rp_… CASCADE`) with no effect on
deployments. Retention removes logs and artifact objects of finished runs after
`REPOPILOT_EVIDENCE_RETENTION_DAYS`; runs, findings, patches, outcomes and the audit history are kept.

## Queue, retries, recovery

One BullMQ queue (`repopilot-queue`). Jobs carry only `{runId, stage, attempt, findingId?}` and a
deterministic id, so a duplicate add is a no-op. Retries are **persisted stage attempts** (3 for
ingest/analyze/patch, 2 for manifest/verify, **1 for the pull-request stage**, which is never retried
automatically) with exponential backoff; stalled jobs are failed, never re-run. Each stage's
results and its run-state change commit in one transaction. A recovery pass fails stages whose
worker stopped heart-beating and re-queues steps that were committed but never enqueued. Failed
jobs stay in Redis for a week as the dead-letter record.

## Sandbox requirements (not provided)

Verification must run in a **dedicated, disposable, isolated environment you provision and
validate**: a separate VM or host (a hardened runtime such as gVisor may help but is not assumed),
a fresh environment per run, no network during tests, no secrets, no host mounts or Docker socket,
no cloud-metadata access, unprivileged with dropped capabilities, CPU/memory/disk/process/output/time
limits, dependency install with lifecycle scripts disabled, and safe archive extraction. Implement
`SandboxRunner` (`src/repopilot/verifySandbox.ts`) and validate it adversarially before enabling it.
**Do not run untrusted repositories on the ShipFlow host or on a developer machine.** A container alone
is not a sufficient boundary for hostile code, and Docker-daemon access is a residual escape risk.
Until then `REPOPILOT_SANDBOX` stays `off` and the dashboard says so.

## What is and is not validated

* **Validated by tests in this repo:** state machine, schemas, patch policy and applier, outcome
  classifier, store transactions, concurrency and idempotency (real PostgreSQL), queue behaviour
  (real Redis), API (real HTTP + PostgreSQL), ingestion/PR creation against an *in-memory GitHub*,
  AI calls against an *in-memory provider*, dashboard behaviour.
* **Not validated:** any real GitHub repository, the real Anthropic API, a real sandbox, S3 evidence
  storage, multi-instance rate limiting, load.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Dashboard says RepoPilot is off | `REPOPILOT` not `enabled`, or worker secrets are set on the API (see status `problems`) |
| "No RepoPilot worker is running" | start the `repopilot-worker` service; check `/ready` |
| Run fails `github_not_configured` / `github_auth_failed` | token missing/expired in `repopilot-worker.env` |
| `repository_not_accessible` | wrong name, private repo, or token lacks access |
| `ai_credentials_missing` / `credential_unreadable` | store your key; the worker needs the matching private key |
| `ai_budget_exceeded` | the run's request/token cap was reached (a safeguard) |
| `github_rate_limited` | GitHub API limit; retry later |
| `base_moved_conflict` | the base branch changed the patched files; run a new analysis |
| Patch "rejected by policy" | it touched a protected path, security-sensitive code, or did not apply |

## Local development and tests

```sh
pnpm check                 # typecheck, lint, unit + UI tests (integration tests are skipped)
# throw-away services for the integration suite (test-only credentials, localhost):
docker run -d --rm --name rp-test-pg -e POSTGRES_USER=rptest -e POSTGRES_PASSWORD=rptest -e POSTGRES_DB=rptest -p 127.0.0.1:55432:5432 postgres:17
docker run -d --rm --name rp-test-redis -p 127.0.0.1:56379:6379 redis:7
REPOPILOT_TEST_PG=postgres://rptest:rptest@127.0.0.1:55432/rptest REPOPILOT_TEST_REDIS=127.0.0.1:56379 pnpm test:integration
```

The database name must end in `test` (the suite truncates `rp_*`). Without the variables the integration tests are reported as **skipped**, not passed.

## Production readiness checklist

- [ ] A validated, isolated sandbox runner exists (or you accept that every outcome is *inconclusive*).
- [ ] Credential key pair generated; private key mounted only on the worker; backed up.
- [ ] Fine-grained, repo-scoped GitHub token in `repopilot-worker.env` only.
- [ ] API shows RepoPilot enabled with no `problems`; `/ready` shows a live worker.
- [ ] Tried end to end against a throw-away *public* repository you own.
- [ ] Evidence storage (local volume or S3) is backed up as you need; retention set.
- [ ] You accept the single-operator access model, or have added per-user authorisation.
- [ ] Rate limits and per-run AI caps reviewed for your provider budget.
