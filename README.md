# ShipFlow

ShipFlow is a self-hosted, CLI-first CI/CD service for static sites (any
Node.js project whose build writes `dist/`, `build/` or `out/`). You give it a
Git repository; it clones, installs, builds and tests the project in an
isolated container, stores an immutable artifact in S3, checks the release over
HTTP, and only then makes it live. Earlier releases can be restored with one
command.

```
shipflow CLI ──HTTP + token──► Express API ──► PostgreSQL (releases, logs, notifications, activations)
                                   │
                                   └──► Redis + BullMQ ──► Worker
                                                            │
                         Prepare → Build → Test → Deploy → Verify → Activate
                         (clone)   (sandboxed container)   (S3 upload) (HTTP checks)
                                                            │
                                     S3: releases/<id>/source/, releases/<id>/build/
                                                            │
                        Site server (:8080) serves the active release from S3
```

## How a release works

| Stage | What happens |
|-------|--------------|
| PREPARE | Validates the repo URL against an allowlist, makes a shallow `git clone` with a timeout, records the commit SHA, uploads a source snapshot (symlinks skipped). |
| BUILD | Starts a throwaway sandbox container and copies the source in. Detects npm/pnpm/yarn and runs `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` when a lockfile exists. Then **disconnects the network** and runs the `build` script. |
| TEST | Runs the `test` script with no network. A missing or npm-placeholder test script is recorded as `SKIPPED`, never `PASSED`. Set `SHIPFLOW_REQUIRE_TESTS=true` to fail such releases. |
| DEPLOY | Copies the build output out of the sandbox and checks it: `index.html` must exist, every local asset it references must exist, and file count and size limits apply. Uploads it to the immutable prefix `releases/<id>/build/` and confirms every object's size. **The live site is untouched.** |
| VERIFY | HTTP check of the candidate through the real serving code (`/preview/<id>/`): status 200, `text/html`, and the right release header. |
| ACTIVATE | Adds a row to `activations` (one atomic insert, so the site is never empty), then checks the live site serves the new release. If that check fails, the previous release is restored. |

A release that fails any stage before ACTIVATE never touches the live site.
Command output (the last 64 KB of each step) is saved in the release logs. A
failure notification is recorded, and an error while logging never hides the
original error.

**Rollback** (`shipflow rollback <releaseId>`) makes a specific earlier release
live again. The target must exist, have status `SUCCESS`, not already be
active, and still have its artifacts in S3. Artifacts are never copied or
deleted; only the active pointer moves, and the live site is checked
afterwards. If that check fails, the rollback is reverted. Each outcome is
written to the logs and notifications.

## Security model

ShipFlow runs code from Git repositories (install scripts, build scripts,
tests). That code is treated as untrusted:

- **Sandbox container per release** (`SHIPFLOW_SANDBOX=docker`, the default):
  - no ShipFlow environment variables (no AWS, database, Redis or API
    secrets)
  - no host mounts and no Docker socket
  - runs as uid 1000 with `--cap-drop ALL` and `no-new-privileges`
  - memory, CPU and PID limits
  - per-step timeouts
  - network only while dependencies install, cut off for build and test
  - removed after the build; orphaned sandboxes are removed when the worker
    starts
- **The worker never runs repository code.** It clones with `git` (shallow,
  no credentials in its environment), copies files into the sandbox, and
  copies the build output back. Symlinks in uploads are skipped, so a
  repository cannot point a link at worker files.
- **API auth**: every endpoint except `/health` needs
  `Authorization: Bearer $SHIPFLOW_API_TOKEN`. The comparison is
  constant-time.
- **Abuse limits**:
  - repository URL prefix allowlist (`SHIPFLOW_ALLOWED_REPO_PREFIXES`)
  - only `http(s)` URLs, with no credentials or extra path segments
  - validated release IDs
  - 10 KB JSON body limit
  - at most `SHIPFLOW_MAX_QUEUED` pending releases
  - worker concurrency of 1 by default
  - BullMQ jobs are not retried
- **Infrastructure**:
  - PostgreSQL and Redis publish no ports
  - the API and site bind to `127.0.0.1` by default
  - `.env` is excluded from the Docker image (`.dockerignore`) and from Git
  - the S3 bucket stays private, and the API streams files from it

The test suite includes a probe project that tries to read secrets and worker
files and to reach internal services from inside every stage. The release
fails if it finds anything.

**Known limitations** (read these before giving anyone else access):

- The worker mounts the Docker socket so it can create sandboxes. The worker
  is trusted code, but if it were compromised, the attacker would control the
  host.
- During dependency install the sandbox has outbound internet access. On EC2,
  require IMDSv2 with hop limit 1 so containers cannot read instance-role
  credentials.
- One API token is shared by all operators. There are no per-user accounts or
  per-user isolation. This is meant to be a single-owner or trusted-team demo,
  not a public multi-tenant service.
- `SHIPFLOW_SANDBOX=none` (local development only) runs repository code
  directly on the worker with a filtered environment. It is **not**
  isolated.

## Quick start (Docker Compose)

Requirements: Docker with Compose v2.24+, an S3 bucket (private) and an IAM
identity limited to that bucket.

```bash
git clone https://github.com/shivsingh78/shipflow.git && cd shipflow
cp .env.example .env
# Edit .env: set SHIPFLOW_API_TOKEN (openssl rand -hex 32), DB_PASSWORD,
# S3_BUCKET_NAME, AWS_REGION, AWS keys and SHIPFLOW_ALLOWED_REPO_PREFIXES.

docker compose up -d --build
docker compose ps                       # api should be "healthy"
curl -s http://localhost:8000/health    # {"success":true,"status":"ok"}
```

The database schema (`db/schema.sql`) is applied automatically when the API
and worker start. It only makes additive changes, so databases created by
earlier ShipFlow versions are upgraded in place.

### Use the CLI

```bash
pnpm install          # or: npm install
pnpm link --global    # exposes the `shipflow` command (or run: node cli/index.js)

export SHIPFLOW_API_URL=http://localhost:8000
export SHIPFLOW_API_TOKEN=<the token from .env>

shipflow deploy https://github.com/<you>/<static-site-repo>
shipflow releases
shipflow status <releaseId>
shipflow logs <releaseId>
shipflow rollback <releaseId>
```

The active release is served at `http://localhost:8080/`.

### Minimal S3 IAM policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::YOUR_BUCKET" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::YOUR_BUCKET/releases/*" }
  ]
}
```

ShipFlow never deletes objects, so it doesn't need `s3:DeleteObject`.

## Deploying to a server

The intended setup is a single small VM (for example an EC2 `t3.small` or
any VPS with 2 GB+ RAM) running the compose stack:

1. Install Docker, clone the repo, create `.env` as above. On EC2, prefer an
   instance role with the policy above (leave the AWS key variables empty),
   and require IMDSv2 with hop limit 1.
2. Leave `API_BIND`/`SITE_BIND` at `127.0.0.1` and put a TLS reverse proxy in
   front, for example Caddy:

   ```
   api.example.com {
     reverse_proxy 127.0.0.1:8000
   }
   site.example.com {
     reverse_proxy 127.0.0.1:8080
   }
   ```

3. Set `PUBLIC_SITE_URL=https://site.example.com/` and keep
   `SHIPFLOW_ALLOWED_REPO_PREFIXES` limited to your own repositories.
4. `docker compose up -d --build`. Every service has `restart: unless-stopped`,
   and data lives in named volumes (`postgres_data`, `redis_data`), so the
   stack survives restarts and reboots.
5. From your laptop: `SHIPFLOW_API_URL=https://api.example.com shipflow deploy ...`

## Local development without Docker for the app

```bash
pnpm install
# Start PostgreSQL and Redis yourself (or temporarily publish their ports),
# then in .env set DB_HOST/REDIS_HOST=127.0.0.1.
pnpm dev            # API on :8000 and site on :8080
pnpm dev:worker     # worker; needs the docker CLI, or SHIPFLOW_SANDBOX=none (unsafe)
```

## Tests

```bash
pnpm test         # unit tests: validation, API auth/404s, site serving,
                  # CLI errors, package-manager detection, real npm builds
                  # with the local sandbox, env filtering, output limits
pnpm test:e2e     # full stack in Docker (separate "shipflow-e2e" project):
                  # real worker, sandboxes, PostgreSQL, Redis, an S3 mock and
                  # a fixture git server, driven through the real CLI
```

The e2e suite deploys small fixture projects (`test/fixtures`) and checks:

- the sandbox probe finds nothing
- npm, pnpm and yarn projects deploy
- a project with no tests is marked `SKIPPED`
- releases replace each other on the live site
- build, test and artifact failures leave the live site unchanged
- logs and notifications are recorded
- rollback works, including rejection of invalid targets
- auth and validation work

GitHub Actions (`.github/workflows/ci.yml`) runs both suites.

## API

All endpoints except `/health` need `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Database connectivity check |
| POST | `/deploy` | `{"repoUrl": "..."}` → 202 with the queued release |
| GET | `/releases` | Recent releases, with `is_active` |
| GET | `/releases/:id` | One release (404 if unknown) |
| GET | `/releases/:id/logs` | Stage logs and notifications (404 if unknown) |
| POST | `/rollback/:id` | Make an earlier successful release live |
| GET | `/preview/:id/*` | Serve any uploaded release (used by VERIFY) |

The site server on port 8080 serves the active release at `/`. Paths without
a file extension fall back to `index.html` (single-page apps).

## Configuration

See `.env.example` for every variable. The important ones:

- `SHIPFLOW_API_TOKEN`
- `SHIPFLOW_ALLOWED_REPO_PREFIXES`
- `PUBLIC_SITE_URL`
- `S3_BUCKET_NAME`, `AWS_REGION`, and the AWS credentials
- the `DB_*` settings
- the sandbox limits (`SHIPFLOW_SANDBOX_MEMORY`, `SHIPFLOW_SANDBOX_CPUS`,
  `SHIPFLOW_*_TIMEOUT_MS`)

Older `.env` files that use `AWS_SECRET_KEY` still work.
