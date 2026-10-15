# `shipflow.yml` reference (version 1)

`shipflow init` writes this file for you. It describes **how to build** a
project and **where to deploy it**. It must never contain secrets: the server
rejects keys such as `password`, `token` or `privateKey`, and values that look
like private keys or access keys.

Unknown fields are rejected and every error names its field, for example
`deployment.ssh.path: must be at least two levels deep`.

## Example: deploy to your own server over SSH

```yaml
version: 1

project:
  name: my-site                                  # required
  repository: https://github.com/me/my-site      # required, must be on the server's allowlist
  branch: main                                   # default: main

build:                                           # all optional
  install: auto            # auto (npm/pnpm/yarn from the lockfile) | none
  command: auto            # auto (package.json "build" script) | any shell command
  output: dist             # auto (first of dist/, build/, out/) | a relative directory
  test: auto               # auto (package.json "test" script) | none | any shell command
  env:                     # PUBLIC build-time values only (no secrets)
    VITE_API_URL: https://api.example.com

deployment:
  target: ssh
  ssh:
    host: vps.example.com                       # required
    port: 22                                    # default 22
    user: deploy                                # required, not root
    path: /srv/my-site                          # required, absolute, >= 2 levels deep
    hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1...    # required: the server's public host key
    privateKeySecret: SSH_PRIVATE_KEY           # default SSH_PRIVATE_KEY (a secret NAME)
    url: https://my-site.example.com/           # required: public URL for the live check

verification:
  path: /                  # default /
  expectStatus: 200        # default 200 (200-399 allowed)

github:                    # used only by webhooks (see self-hosting guide)
  checkPullRequests: true  # default true: build + test PRs, never deploy them
  deployOnPush: false      # default false: never auto-deploy unless you opt in
  deployBranch: main       # default: project.branch
```

## Example: served by the ShipFlow site server

```yaml
version: 1
project:
  name: docs
  repository: https://github.com/me/docs
deployment:
  target: shipflow
  shipflow:
    hostname: docs.example.com   # optional; requests with this Host get this project
```

## Fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `version` | yes | — | Must be `1`. |
| `project.name` | yes | — | `a-z 0-9 -`, up to 63 characters. Identifies the project on the server. |
| `project.repository` | yes | — | `https://` URL that starts with one of the server's `SHIPFLOW_ALLOWED_REPO_PREFIXES`. No credentials in the URL. |
| `project.branch` | no | `main` | Branch deployed by `shipflow deploy` (unless `--ref` is given). |
| `build.install` | no | `auto` | `auto` uses `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` when a lockfile exists. |
| `build.command` | no | `auto` | Runs in the sandbox with `sh -c`, with no network. |
| `build.output` | no | `auto` | Relative directory that must contain `index.html`. |
| `build.test` | no | `auto` | A missing or placeholder test script is recorded as `SKIPPED`, never `PASSED`. |
| `build.env` | no | `{}` | Public values passed to the build. Visible to repository code. |
| `deployment.target` | yes | — | `shipflow` or `ssh` (run `shipflow targets` to see what the server supports). |
| `deployment.shipflow.hostname` | no | — | Unique per server. |
| `deployment.ssh.*` | target `ssh` | see example | `hostKey` is enforced; host-key checking is never disabled. |
| `verification.path` | no | `/` | With `/`, the SSH target also checks that the served `index.html` is byte-identical to the build. |
| `verification.expectStatus` | no | `200` | |
| `github.*` | no | see example | Has no effect unless the server has `SHIPFLOW_GITHUB_WEBHOOK_SECRET`. |

## Where settings are stored

`shipflow deploy` validates the file locally, then uploads it to the server
(`PUT /projects/<name>`). The server validates it again, and each release
stores a snapshot of the configuration it was built with.

Webhook-triggered releases use the configuration last uploaded through the
CLI, not the copy inside the repository. A pull request therefore cannot
change the deployment target, server or build settings.

## Environments (staging, production)

Use one file and one project per environment, for example `shipflow.yml`
(project `my-site`) and `shipflow.staging.yml` (project `my-site-staging`,
different host or path):

```bash
shipflow deploy -c shipflow.staging.yml
```

Each project has its own releases, live pointer, secrets and rollback history.

## Versioning and migration

The file declares `version: 1`. Changes that break the schema will use a new
version number; the CLI and server reject versions they don't understand,
naming the field. When version 2 exists, its upgrade notes will list each
changed field.

## Secrets

Secrets are referenced by name (`privateKeySecret: SSH_PRIVATE_KEY`) and
stored on the server:

```bash
shipflow secrets set SSH_PRIVATE_KEY < ~/.ssh/my_site_deploy_key   # value from stdin, never echoed
shipflow secrets list
shipflow secrets rm SSH_PRIVATE_KEY
```

See the security notes in [self-hosting.md](self-hosting.md#secrets) for how
they are protected.
