# Running a ShipFlow server

ShipFlow runs on a machine you control. It uses your compute and, optionally,
your own S3 bucket, and deploys to servers you own. Nothing is provisioned or
billed on your behalf.

## What you need

| Component | Where | Notes |
|---|---|---|
| A Linux host with Docker Engine + Compose v2.24+ | your VPS, VM or workstation | 2 vCPU / 4 GB RAM is comfortable for one build at a time (each sandbox is limited to 1 CPU / 1 GB by default) |
| Disk | same host | Docker images, build workspaces, and artifacts when using local storage. Builds refuse to start below `SHIPFLOW_MIN_FREE_DISK_MB` (1 GB) free. |
| PostgreSQL 17, Redis 7 | containers in the same Compose stack | not published to the host |
| Artifact storage | local Docker volume **or** your S3-compatible bucket | local needs no cloud account |
| Deployment targets | your servers (ssh) or the ShipFlow site port | |
| TLS reverse proxy (Caddy, nginx) | in front of ports 8000/8080 | required for anything beyond localhost |

Costs depend entirely on your provider and workload. The main drivers are:

- the always-on host;
- build minutes multiplied by concurrency;
- stored artifacts (`SHIPFLOW_KEEP_RELEASES` bounds this);
- S3 requests and egress, if you use S3;
- traffic served by the site port.

## First-time setup

```bash
git clone https://github.com/shivsingh78/shipflow.git && cd shipflow
cp .env.example .env
# Set at least: SHIPFLOW_API_TOKEN, DB_PASSWORD, SHIPFLOW_ALLOWED_REPO_PREFIXES,
# and SHIPFLOW_SECRETS_KEY if you will use the ssh target.
#   openssl rand -hex 32   (run once per value)
chmod 600 .env

docker compose up -d --build --wait
docker compose ps            # all services healthy/running
curl -s http://127.0.0.1:8000/health
```

On start-up the API and worker apply `db/schema.sql`. The schema changes are
additive and idempotent, so upgrades run the same command.

Then, from your laptop:

```bash
npm install -g shipflow-cli
shipflow login --server https://shipflow.example.com    # prompts for the token (hidden)
shipflow doctor
```

## Network exposure

| Port | Service | Who must reach it |
|---|---|---|
| 8000 | API | the CLI, CI jobs, GitHub webhooks (if used). Protect with TLS. |
| 8080 | site server (`shipflow` target) | visitors |
| — | PostgreSQL, Redis, egress proxy | never published; internal network only |

Both published ports bind to `127.0.0.1` by default (`API_BIND`, `SITE_BIND`).
Put a reverse proxy with TLS in front, for example with Caddy:

```
shipflow-api.example.com { reverse_proxy 127.0.0.1:8000 }
site.example.com         { reverse_proxy 127.0.0.1:8080 }
```

The CLI refuses to send the token over plain HTTP to a non-local address.

## Build isolation

Each release builds in a new container. It runs as uid 1000, with all
capabilities dropped, `no-new-privileges`, and memory, CPU and PID limits. It
gets no ShipFlow environment variables, no host mounts, no Docker socket, and
no network access except the following.

The container joins the internal `shipflow-sandbox` network, which has no
route to the internet, the host, or other containers. During dependency
install, its only exit is the `egress-proxy` service. That proxy:

- allows HTTPS (`CONNECT :443`) only to `SHIPFLOW_EGRESS_ALLOWLIST` (the npm
  and Yarn registries by default);
- refuses any name that resolves to a private, loopback, link-local or
  metadata address (`169.254.169.254`).

Before the build and test commands run, the container is disconnected from
every network. The e2e suite's probe project checks each of these properties
on every run.

This isolation has limits:

- **The worker can reach the Docker daemon.** It mounts the Docker socket to
  create sandboxes, so whoever compromises the worker container controls the
  host. Treat the ShipFlow host as dedicated to ShipFlow; for hostile
  workloads, run workers on a separate VM, or use rootless Docker or a
  socket proxy.
- **The kernel is shared.** Containers share the host kernel, so this is not
  the same boundary as a VM per build.
- **Install scripts reach the registries.** Dependency install scripts can
  download anything from the allowlisted registries.
- **Not for public multi-tenant use.** ShipFlow is meant for a single owner
  or a trusted team, not anonymous users.

## Container deployments (docker and kubernetes targets)

Besides static sites, ShipFlow can build and run container images. Read the
isolation trade-off first.

**Image builds are off by default.** `docker build` runs the repository's
Dockerfile `RUN` steps (or the Dockerfile ShipFlow generates for the `node`
strategy) through the worker's Docker daemon. Unlike the static build
sandbox, BuildKit cannot attach those steps to the restricted network, so
they have ordinary outbound network access and run as the daemon allows. Only
turn this on for repositories you trust as much as the worker host itself:

```bash
# worker environment (.env)
SHIPFLOW_IMAGE_BUILDS=enabled
SHIPFLOW_MAX_IMAGE_BYTES=1073741824        # refuse larger images (default 1 GiB)
SHIPFLOW_IMAGE_BUILD_TIMEOUT_MS=900000     # default 15 minutes
```

No secret, build argument or environment variable is passed to `docker
build`. The finished image is stored in the artifact store (local volume or
S3) as a `docker save` archive and identified by its image ID; rollbacks
reload the stored archive and never rebuild. A cancelled release stops at the
next stage boundary; a `docker build` already running finishes first.

### Docker target

Runs the image on a **separate** Docker host that you own, reached over SSH
with a pinned host key, the same trust model as the `ssh` target. Prepare it
once:

```bash
# on the Docker host: a dedicated non-root user that may run docker
sudo adduser --disabled-password deploy && sudo usermod -aG docker deploy
# append the public key to /home/deploy/.ssh/authorized_keys, then:
shipflow secrets set SSH_PRIVATE_KEY < deploy_key      # on your workstation
```

Each project gets a Docker network and a managed `nginx` proxy container that
publishes `publishPort`. A release runs as its own container; ShipFlow starts
the candidate (no published port), checks its health from the proxy network,
and only then rewrites the proxy configuration, runs `nginx -t`, reloads, and
waits until the running proxy reports the new release (a reload is
asynchronous, so a live check could otherwise be answered by the previous
release). The previous release keeps running until the new one passes its
live check. If that check fails, the previous release is switched back: its
container is started if it was stopped, or recreated from the stored image if
it is gone, its health is verified *before* traffic returns to it, and its
live check is repeated afterwards. If nothing was live (a first deployment),
the proxy answers 503 and the failed container is removed. A candidate that
was prepared but never went live (the release failed or was cancelled before
or during activation) is removed too, but never one the proxy is serving. Runtime secrets
travel in a temporary `0600` env file, never on a command line. After a
release passes its live check, older releases are stopped but kept (the newest
three, plus whatever is live, are never pruned). Add TLS in front of
`publishPort` yourself (a load balancer, or Caddy/nginx on the host).

**Proxy name resolution.** The proxy resolves the release container by name
for each request (`resolver 127.0.0.11`, cached 5 s, with a variable
`proxy_pass`), so a restarted or recreated container with a new IP is picked
up automatically, nginx starts even when the release container is absent, and
an absent or unreachable release answers `503` with `Retry-After: 5` rather
than a raw 502. This relies on Docker's embedded DNS, which exists on the
user-defined network ShipFlow creates for each project; it is not available on
the default bridge network or outside Docker, so do not move the proxy off its
project network. The client address nginx sees behind Docker's published ports may not be the
visitor's (in the end-to-end environment a request from another container was
not distinguishable from loopback), so applications should not trust
`X-Real-IP` / `X-Forwarded-For` from this proxy for access control.

Limits: one host is one failure domain (no high availability); the activation
reload is graceful, but connections to the old container end when it stops.

### Kubernetes / K3s target

Pushes the image to a registry you own and applies a per-release `Deployment`
plus a candidate `Service`; activation switches the live `Service` selector.
Needs `registry` (nodes cannot read ShipFlow's artifact store), a kubeconfig
stored as a secret (bearer-token or client-certificate auth only; `exec`
plugins and file-path credentials are rejected), and, for private registries,
a Docker `config.json` secret. Exposing the live `Service`
(`shipflow-<project>`, ClusterIP) through an Ingress or load balancer is yours
to configure.

**Honest status:** this adapter is verified only against a fake Kubernetes API
server and a fake Docker runner in unit tests. It has not been run against a
real cluster or registry. `replicas: N` gives pod-level redundancy; a
single-node or single-control-plane K3s cluster remains a single point of
failure, and Service-selector switching is subject to normal kube-proxy
propagation delay.

## Secrets

- `SHIPFLOW_API_TOKEN` authenticates the CLI. Rotate it by changing `.env`,
  running `docker compose up -d`, and running `shipflow login` again.
- Deployment secrets (`shipflow secrets set`):
  - are encrypted at rest with AES-256-GCM under `SHIPFLOW_SECRETS_KEY`;
  - are bound to their project and name;
  - are never returned by the API or written to logs (values are redacted);
  - are never given to sandboxes;
  - are decrypted only after the build container has been destroyed, for
    the deploy, verify, activate and rollback steps;
  - are never used for pull-request check runs.
- **Back up `SHIPFLOW_SECRETS_KEY`.** Without it, stored secrets can't be
  decrypted; set them again.
- Use a dedicated deploy key per project and revoke it on the server to cut
  access.

## Preparing a server for the `ssh` target

On the target server:

```bash
sudo adduser --disabled-password deploy
sudo mkdir -p /srv/my-site && sudo chown deploy:deploy /srv/my-site
# Web server root: /srv/my-site/current   (nginx: root /srv/my-site/current;)
ssh-keygen -t ed25519 -f my_site_deploy_key -N ""      # on your laptop
# append my_site_deploy_key.pub to /home/deploy/.ssh/authorized_keys
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub       # compare with what `shipflow init` shows
```

Requirements: a POSIX shell, `tar`, `sha256sum`, and GNU `mv` (supports `-T`).
`shipflow doctor` checks all of them.

The server layout is `releases/<id>/` per release, plus a `current` symlink.
Activation is an atomic `rename(2)` of the symlink. Old release directories
are kept for rollback; ShipFlow doesn't delete them yet, so prune them
yourself if disk is tight.

## GitHub webhooks (optional)

1. Set `SHIPFLOW_GITHUB_WEBHOOK_SECRET` in `.env` and restart.
2. In the repository, go to *Settings → Webhooks → Add webhook*:
   - Payload URL: `https://shipflow-api.example.com/webhooks/github`
   - Content type: `application/json`
   - Secret: the same value
   - Events: *Pushes* and *Pull requests*
3. Register the project once with `shipflow deploy` (or `shipflow secrets set`)
   from a checkout containing `shipflow.yml`.

What each event does:

- **Pull requests** start **check** runs: build and test of
  `refs/pull/<n>/head`, with no deployment and no secrets.
- **Pushes to `github.deployBranch`** deploy only when `github.deployOnPush`
  is true.
- **Other pushes to `project.branch`** run checks.

Every delivery is verified with HMAC-SHA256 and de-duplicated by
`X-GitHub-Delivery`. ShipFlow doesn't post commit statuses back to GitHub yet;
see results with `shipflow releases --project <name>`.

## Reliability and delivery guarantees

- **Delivery and execution.** BullMQ delivers jobs at least once. A release
  is claimed atomically (`QUEUED` → `RUNNING`), so a duplicate delivery does
  nothing.
- **No automatic re-runs.** Stalled jobs are not re-run (`maxStalledCount:
  0`), because deploy steps have side effects. The worker marks orphaned
  releases `FAILED`, both at start-up and every hour.
- **A crash during ACTIVATE.** The release is marked with a message telling
  you to check `shipflow status`, because it may already be live.
- **Activation order.** Activation is serialized per project by a PostgreSQL
  advisory lock. An older release can never be activated over a newer live
  one (`StaleReleaseError`); rollback is the deliberate exception.
- **Cancellation.** `shipflow cancel` stops queued and running releases. It
  is ignored once ACTIVATE has begun.

## Backup and restore

What to back up:

- the database;
- the artifact volume, if you use local storage (rollback needs it);
- `.env`, including `SHIPFLOW_SECRETS_KEY`.

```bash
# Backup
docker compose exec -T postgres pg_dump -U shipflow -d shipflow --format=custom > shipflow-db.dump
docker compose exec -T api tar -C /var/lib/shipflow -czf - artifacts > shipflow-artifacts.tgz

# Restore (into a fresh stack)
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U shipflow -d shipflow --clean --if-exists < shipflow-db.dump
docker compose run --rm --user root -T --entrypoint tar api -C /var/lib/shipflow -xzf - < shipflow-artifacts.tgz
docker compose up -d --wait
```

With S3 storage, enable bucket versioning or backups on the provider side.
ShipFlow only deletes artifacts through retention (`SHIPFLOW_KEEP_RELEASES`).

## Upgrading

```bash
docker compose exec -T postgres pg_dump -U shipflow -d shipflow --format=custom > pre-upgrade.dump
git pull
docker compose up -d --build --wait
shipflow doctor
```

Schema migrations are additive. Releases created by older versions belong to
the project `default`, keep working, and can still be listed and rolled back
if their artifacts exist.

## Limits and retention (cost controls)

| Variable | Default | Effect |
|---|---|---|
| `SHIPFLOW_WORKER_CONCURRENCY` | 1 | builds at the same time per worker |
| `SHIPFLOW_MAX_QUEUED` | 5 | pending releases before `429` |
| `SHIPFLOW_SANDBOX_MEMORY` / `_CPUS` / `_PIDS` | 1g / 1 / 512 | per build container |
| `SHIPFLOW_*_TIMEOUT_MS` | 10 min install/build, 5 min test | per step |
| `SHIPFLOW_MAX_ARTIFACT_FILES` / `_BYTES` | 5000 / 200 MB | per release |
| `SHIPFLOW_KEEP_RELEASES` | 10 | stored releases per project; live one always kept; 0 keeps all |
| `SHIPFLOW_LOG_RETENTION_DAYS` | 90 | log and notification rows |
| `SHIPFLOW_MIN_FREE_DISK_MB` | 1024 | refuse to start a build below this |

## Troubleshooting

Start with `shipflow doctor`. It checks:

- the CLI configuration and `shipflow.yml`;
- that the server is reachable and the token works;
- PostgreSQL, Redis, the queue, artifact storage and the worker heartbeat;
- whether the sandbox network is restricted;
- secret storage, the project's secrets, and the deploy target itself (for
  SSH: connection, write access, `tar`, `sha256sum`, `mv -T`).

| Symptom | Likely cause |
|---|---|
| `server reachable ✖` | API container not running (`docker compose ps`), wrong `--server`, or the proxy isn't forwarding |
| `workers ✖ no worker heartbeat` | `docker compose logs worker`: often the Docker socket isn't mounted or `SHIPFLOW_API_TOKEN` is unset |
| `WARNING: unrestricted install network` | worker started outside Compose without `SHIPFLOW_EGRESS_PROXY` |
| dependency install fails with `fetch failed` / `403` | package registry not in `SHIPFLOW_EGRESS_ALLOWLIST` |
| `Host key ... does not match` | the server was rebuilt or this is the wrong host; verify the new key out-of-band and update `hostKey` |
| `Permission denied (publickey)` | the secret doesn't match `authorized_keys` for the deploy user |
| release stuck `RUNNING` | the worker died; it is reconciled to `FAILED` when a worker starts (or within an hour) |
