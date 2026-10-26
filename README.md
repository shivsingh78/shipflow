# ShipFlow

ShipFlow is a self-hosted, CLI-first CI/CD and deployment server for static
websites and containerised apps. You run it on a machine you control. You point the `shipflow` CLI at
a Git repository, and ShipFlow does the rest:

1. clones the repository;
2. installs, builds and tests it in an isolated, throwaway container;
3. stores an immutable copy of the build;
4. deploys it to a target **you** own;
5. verifies it, then switches it live.

`shipflow rollback` puts an earlier release back.

It uses your infrastructure: your server, optionally your S3 bucket, and your
VPS. Nothing is provisioned or billed on your behalf.

> **Status:** works end to end and is covered by tests (see [Tests](#tests)).
> It is suitable for a single owner or a trusted team. It is **not** hardened
> for anonymous, multi-tenant use; see the
> [isolation limits](docs/self-hosting.md#build-isolation).

```
shipflow CLI ──HTTPS + token──► API ──► PostgreSQL (projects, releases, logs, secrets*, live pointers)
                                 │              * encrypted
GitHub webhook (signed) ─────────┘──► Redis/BullMQ ──► Worker
                                                         │
     PREPARE ─► BUILD ─► TEST ─► DEPLOY ─► VERIFY ─► ACTIVATE
     clone      sandbox container          store artifact   candidate     switch live,
                (no secrets, registry-     + transfer to    check         live check,
                 only network, then none)    the target                    auto-revert
                                                         │
                       artifact storage: local volume or S3-compatible bucket
                       targets: "shipflow" (built-in site server) · "ssh" (your server)
                                "docker" (your Docker host) · "kubernetes" (your cluster)
```

## Deployment targets

| Target | Where the site runs | Candidate check | Atomic switch | Rollback | Status |
|---|---|---|---|---|---|
| `shipflow` | ShipFlow's own site port, streamed from artifact storage; host-based routing per project | HTTP (`/preview/<id>/`) | yes (pointer row) | yes | implemented, e2e-tested |
| `ssh` | your server or VPS: `releases/<id>/` + `current` symlink, served by your nginx/Caddy | SHA-256 of every file | yes (`rename(2)`) | yes | implemented, e2e-tested against OpenSSH + nginx |
| `docker` | **container image** on a separate Docker host over SSH, behind a managed nginx proxy (blue/green container switch) | HTTP from the proxy network | yes (proxy reload after `nginx -t`) | yes (image reloaded from storage, no rebuild) | implemented; e2e-tested against a real Docker daemon (docker-in-docker); single host, no HA |
| `kubernetes` | **container image** on a Kubernetes / K3s cluster: per-release `Deployment`, live `Service` selector switch, image pushed to your registry and pinned by digest | API-server service proxy | yes (one `Service` apply) | yes | implemented; **verified only against a fake API server in unit tests, not a real cluster** |
| object storage + CDN, Cloudflare Pages, Netlify, Vercel | — | — | — | — | **not implemented**; the [adapter interface](src/targets/index.ts) is designed for them |

A **build strategy** (how it is built) is separate from the target (where it
runs): `static` (files), `node` (a Node API without a Dockerfile: ShipFlow
generates the image) and `dockerfile` (your own Dockerfile). Detection rules,
examples and the image-build isolation trade-off (**off by default**) are in
[docs/configuration.md](docs/configuration.md#build-strategies-and-detection)
and [docs/self-hosting.md](docs/self-hosting.md#container-deployments-docker-and-kubernetes-targets).
Working examples: [`examples/`](examples/).

Artifact storage is separate from the target: `local` (a Docker volume, the
default) or any S3-compatible bucket.

## Quick start

**1. Run the server** (Docker + Compose v2.24+). See
[docs/self-hosting.md](docs/self-hosting.md) for TLS, backups and upgrades.

```bash
git clone https://github.com/shivsingh78/shipflow.git && cd shipflow
cp .env.example .env    # set SHIPFLOW_API_TOKEN, DB_PASSWORD, SHIPFLOW_ALLOWED_REPO_PREFIXES,
                        # SHIPFLOW_SECRETS_KEY (each: openssl rand -hex 32)
docker compose up -d --build --wait
```

**2. Use the CLI** from your project directory (Node.js 22+):

```bash
npm install -g shipflow-cli          # package name not yet published, see "npm" below
shipflow login --server https://shipflow.example.com
shipflow init                        # asks only what your chosen target needs → shipflow.yml
shipflow secrets set SSH_PRIVATE_KEY < ~/.ssh/my_site_deploy_key   # ssh target only
shipflow doctor                      # checks config, server, worker, and the target itself
shipflow deploy
```

Example `shipflow.yml` (full reference: [docs/configuration.md](docs/configuration.md)):

```yaml
version: 1
project:
  name: my-site
  repository: https://github.com/me/my-site
build:
  output: dist
deployment:
  target: ssh
  ssh:
    host: vps.example.com
    user: deploy
    path: /srv/my-site
    hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1...
    url: https://my-site.example.com/
```

## CLI

| Command | What it does |
|---|---|
| `shipflow login [--server URL] [--token-stdin]` | verify and store the server and token (`~/.config/shipflow/credentials.json`, mode 600) |
| `shipflow init [--yes ...]` | create `shipflow.yml` interactively, or non-interactively with flags |
| `shipflow deploy [-c file] [--ref REF] [--no-wait] [--timeout MIN]` | register the project and run a release |
| `shipflow deploy <repoUrl>` | the original quick mode: default settings, `default` project |
| `shipflow status / logs / releases [--project]` | release state, stage logs (with build output) and notifications |
| `shipflow rollback <id>` | put an earlier successful release live again (no rebuild) |
| `shipflow cancel <id>` | stop a queued or running release before activation |
| `shipflow secrets set\|list\|rm` | deployment secrets, encrypted on the server, never printed |
| `shipflow projects [name]`, `shipflow targets` | inspect projects and supported targets |
| `shipflow doctor` | diagnostics; no secrets printed |
| `shipflow cloud deploy\|status\|destroy` | create, inspect and remove one temporary AWS EC2 VPS (see below) |

- `--json` gives machine-readable output.
- Exit codes: `0` ok, `1` failed, `2` usage/config error, `3` server
  unreachable or unauthorized, `4` timeout.
- In CI, set `SHIPFLOW_API_URL` and `SHIPFLOW_API_TOKEN` instead of using
  `login`.

## Try it on a real server: temporary AWS EC2 VPS

`shipflow cloud deploy` is an interactive wizard that creates **one** EC2 instance
in **your own** AWS account, then deploys a **public** repository to it through the
normal pipeline and the `ssh` target (immutable releases, checksum verification,
atomic switch, rollback). It is for testing, not production, and static sites only.

```bash
shipflow cloud deploy       # asks for credentials, region, repo, ... then shows a review screen
shipflow cloud status       # state and public IP
shipflow cloud destroy      # terminate it and remove its resources (type DESTROY)
```

- **Credentials:** your AWS profile / SSO, or typed keys held in memory only. Never
  saved, never accepted as flags. Validated with STS before anything is created.
- **Confirmation:** you must type `CREATE` after a review screen (resources, firewall,
  estimated cost). There is no `--yes`.
- **Firewall:** SSH only from the worker's egress IP/CIDR that you confirm; HTTP open.
  No Elastic IP, NAT gateway or load balancer is created.
- **Cost:** `t3.micro` with 8 GiB is on the order of $0.017/hour (about $12.5/month)
  **while it exists**. The estimate uses AWS price data checked 2026-10-15 (the EBS rate
  is unverified) and is not a billing guarantee; AWS credits may not cover every charge.
  Run `shipflow cloud destroy` when done.
- **Needs:** a ShipFlow server with `SHIPFLOW_SECRETS_KEY`, reachable while the wizard
  runs (the worker uploads to the VPS), and a fixed worker egress IP.
- **Limits:** plain HTTP, one VM, default VPC, x86_64, public repos only. Tested with fakes
  and a local STS stub, **not yet against a live AWS account**.

IAM permissions, every question, cleanup details and limitations:
[cli/README.md](cli/README.md#temporary-aws-ec2-vps-shipflow-cloud).

## How a release works

| Stage | What happens | If it fails |
|---|---|---|
| PREPARE | shallow clone of the branch, PR ref or commit (no credentials in git's environment); source snapshot stored | nothing changed |
| BUILD | new sandbox container. Install via lockfile (`npm ci`, `pnpm --frozen-lockfile`, `yarn --frozen-lockfile`) through the registry-only egress proxy. Then **all networking removed** and the build runs. | nothing changed |
| TEST | the test script or configured command, no network. Missing tests are `SKIPPED`, never `PASSED`. | nothing changed |
| DEPLOY | artifact produced and validated (static: index.html exists, referenced assets exist, size limits; image: built, digest recorded, size limit), stored immutably, sandbox destroyed. **Only then** are deploy secrets decrypted, and the candidate is transferred to the target. | live site unchanged |
| VERIFY | candidate checked: HTTP for `shipflow`, SHA-256 of every file for `ssh`, health check of the not-yet-live container for `docker` / `kubernetes` | live site unchanged |
| ACTIVATE | atomic switch under a per-project lock (older releases can't overwrite newer ones), then live HTTP check | switched **back** to the previous release |

Releases started by pull-request webhooks run in **check** mode: PREPARE,
BUILD and TEST only, with no secrets and no deployment.

## Security summary

**Implemented:**

- bearer-token API with constant-time comparison;
- repository allowlist and strict input validation;
- secrets encrypted at rest (AES-256-GCM), never returned, redacted from
  logs, never given to builds;
- build sandbox: non-root, no capabilities, resource limits, no host mounts or
  socket, no direct network (internal network plus a registry-only proxy
  during install, none afterwards);
- signed, de-duplicated webhooks;
- SSH with a pinned host key and fixed command templates;
- PostgreSQL and Redis never published; API and site bound to localhost by
  default.

**Remaining limits:**

- the worker can control the Docker daemon;
- containers share the host kernel;
- one shared admin token, no per-user accounts;
- install scripts can reach the allowlisted registries;
- no commit statuses back to GitHub.

Details: [docs/self-hosting.md](docs/self-hosting.md#build-isolation).

## Tests

```bash
pnpm typecheck   # strict TypeScript (server + CLI)
pnpm lint        # eslint (typescript-eslint, type-checked rules)
pnpm build       # compile to dist/ and cli/dist/ (what production runs)
pnpm test        # builds, then unit and component tests against the compiled code (no Docker)
pnpm test:e2e    # full stack in Docker: API, worker, PostgreSQL, Redis, egress proxy,
                 # S3 mock, fixture git server, a real OpenSSH + nginx "VPS", and a
                 # docker-in-docker "Docker host" (needs internet to pull node/nginx images)
```

The e2e suite drives the real CLI. It checks:

- a sandbox probe for secrets, files, host and gateway ports, the cloud
  metadata address, and proxy abuse;
- npm, pnpm and yarn builds;
- build, test and artifact failures leaving the live site untouched;
- rollback;
- the full SSH journey: `init` → missing secret → `secrets` → `doctor` →
  deploy → replace → rollback;
- a wrong host key being refused, and a failed live check reverting the
  symlink;
- host-routed projects, check mode, cancellation, and webhook signature and
  dedupe;
- the container journey on a real Docker daemon: Node API without a Dockerfile
  → image → candidate health check → live → second release → rollback without
  rebuild → a crashing release leaving the live one untouched → a Dockerfile
  project, with runtime secrets checked for leaks.

The AWS wizard has its own unit tests (fake EC2/STS, plus the real AWS SDK's request
serialization with the network stubbed); no test or CI job creates AWS resources.

GitHub Actions runs typecheck, lint, build and both suites on every push and
pull request (`.github/workflows/ci.yml`).

Not covered by any automated test: a real Kubernetes cluster or registry, a
containerd-image-store *target* host, and the AWS wizard against real AWS.

## npm

The CLI is a separate, small package in [`cli/`](cli/) whose only dependency
is `yaml`. The server package is `private` and is never published.

- `npm view shipflow` belongs to another project, so the CLI is named
  `shipflow-cli`. That name was unclaimed when checked; publishing is a
  manual step.
- `cd cli && npm pack --dry-run` lists exactly what would ship (compiled
  `dist/` and the README; no server code, no `.env`).

## Repository layout

TypeScript (strict, NodeNext); production runs the compiled `dist/`.

```
cli/                  CLI package (index.ts, API client, shipflow.yml schema, prompts); builds to cli/dist
index.ts, worker.ts   API + site server, and the worker
src/pipeline.ts       release stages
src/strategies/       build strategies (static, node, dockerfile), detection, image builder
src/artifacts.ts      artifact types (static | image)
src/targets/          deployment adapters (shipflow, ssh, docker, kubernetes) + interface docs
src/evidence.ts       structured release evidence + deterministic diagnosis (`shipflow diagnose`)
src/artifactStore.ts  artifact storage (local, s3)
src/sandbox.ts        build sandbox; src/egressProxy.ts the registry-only proxy
src/secrets.ts        encrypted project secrets
src/webhooks.ts       GitHub webhooks
db/schema.sql         idempotent schema
examples/             shipflow.yml examples (static, ssh, Node API, Dockerfile, Kubernetes)
docs/                 configuration, self-hosting, technical report
test/                 unit (JS, import compiled output), e2e, fixtures
```
