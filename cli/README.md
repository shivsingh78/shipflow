# ShipFlow CLI

**ShipFlow CLI** is the command-line client for [ShipFlow](https://github.com/shivsingh78/shipflow), a self-hosted CI/CD and release automation platform for static websites.

Install the CLI with npm, connect it to a ShipFlow server you control, and deploy a site from a Git repository. ShipFlow can build and test your project in an isolated container, keep versioned release artifacts, deploy to the built-in site server or your own Linux server over SSH, verify the candidate, and activate or roll back releases.

> **Important:** Installing `shipflow-cli` installs the client only. You also need a running ShipFlow server. The CLI does not provide a hosted service, and it does not automatically provision infrastructure during a normal deployment.

## Contents

- [Requirements](#requirements)
- [1. Install the CLI](#1-install-the-cli)
- [2. Set up a ShipFlow server](#2-set-up-a-shipflow-server)
- [3. Connect the CLI to your server](#3-connect-the-cli-to-your-server)
- [4. Configure a project](#4-configure-a-project)
- [5. Deploy to the built-in site server](#5-deploy-to-the-built-in-site-server)
- [6. Deploy to your own server with SSH](#6-deploy-to-your-own-server-with-ssh)
- [Useful commands](#useful-commands)
- [Optional AWS EC2 wizard](#optional-aws-ec2-wizard)
- [CI environments](#ci-environments)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Uninstall](#uninstall)

## Requirements

### For the CLI

- Node.js **22 or newer**
- npm
- A terminal (Linux, macOS, or WSL examples are shown below)
- Access to a ShipFlow server

### For a self-hosted ShipFlow server

- A Linux host with Docker Engine and Docker Compose v2.24 or newer
- About 2 vCPU and 4 GB RAM is a comfortable starting point for one build at a time
- A domain name and TLS reverse proxy for access from outside the server

ShipFlow includes PostgreSQL and Redis in its Compose stack. Artifact storage can use a local Docker volume; an S3-compatible bucket is optional.

## 1. Install the CLI

Install the published npm package globally:

```bash
npm install --global shipflow-cli
```

Verify the install:

```bash
shipflow --version
shipflow --help
```

To upgrade to the latest published version later:

```bash
npm install --global shipflow-cli@latest
```

## 2. Set up a ShipFlow server

If you already have a working ShipFlow server, skip to [Connect the CLI](#3-connect-the-cli-to-your-server).

On the Linux machine that will host ShipFlow:

```bash
git clone https://github.com/shivsingh78/shipflow.git
cd shipflow
cp .env.example .env
```

Generate random values for the secrets required by the server. Run the command separately for each value and do not reuse one value for every setting:

```bash
openssl rand -hex 32
```

Edit `.env` and configure at least:

| Variable | What to set |
|---|---|
| `SHIPFLOW_API_TOKEN` | A long, random bearer token used by the CLI to authenticate with the API |
| `DB_PASSWORD` | A strong password for the bundled PostgreSQL database |
| `SHIPFLOW_ALLOWED_REPO_PREFIXES` | URL prefixes for repositories the server is allowed to build, for example `https://github.com/your-user/` |
| `SHIPFLOW_SECRETS_KEY` | A separate 64-character hex key if you will use the SSH deployment target |

Keep `.env` private. Do not commit it, paste it into chat, or include it in a README. Restrict its permissions:

```bash
chmod 600 .env
```

Start the server:

```bash
docker compose up -d --build --wait
docker compose ps
curl -fsS http://127.0.0.1:8000/health
```

The health endpoint should return a successful response when the API is ready.

### Make the API safely reachable

By default, the API and built-in site port bind to localhost. For a remote CLI, put a TLS reverse proxy such as Caddy or nginx in front of the API, then use its HTTPS URL when logging in. For example, the API might be available at `https://shipflow-api.example.com`.

The CLI refuses to send an API token over plain HTTP to a non-local server. Do not expose PostgreSQL or Redis to the public internet.

For server upgrades, TLS, backups, limits, and isolation guidance, see the [self-hosting guide](https://github.com/shivsingh78/shipflow/blob/main/docs/self-hosting.md).

## 3. Connect the CLI to your server

From your workstation, run:

```bash
shipflow login --server https://shipflow-api.example.com
```

Replace the example hostname with your ShipFlow API's real HTTPS address. The CLI prompts for the API token with hidden input. Enter the value of `SHIPFLOW_API_TOKEN` configured on the server; never put the token in a source file or commit it.

Credentials are saved in `~/.config/shipflow/credentials.json` with restrictive file permissions and are associated with the server URL.

Check the connection:

```bash
shipflow doctor
```

`doctor` checks the configuration, API authentication, server health, queue/worker status, artifact storage, secrets, and deployment-target prerequisites where applicable.

## 4. Configure a project

Open a terminal in your website repository—the directory containing its `package.json`—and run:

```bash
shipflow init
```

The interactive setup asks for your repository, branch, build settings, and deployment target, then writes `shipflow.yml` in the current directory. Review the generated file before deploying.

A basic example for a Vite/React static site is:

```yaml
version: 1

project:
  name: my-site
  repository: https://github.com/your-user/my-site
  branch: main

build:
  install: auto
  command: auto
  output: dist
  test: auto

deployment:
  target: shipflow

verification:
  path: /
  expectStatus: 200
```

Adjust the project name and repository URL. The repository must match one of the prefixes configured in `SHIPFLOW_ALLOWED_REPO_PREFIXES` on the server.

### Build settings

- `install: auto` detects npm, pnpm, or Yarn from the repository lockfile and uses a frozen/lockfile-based install when possible.
- `command: auto` runs the `build` script from `package.json` when available.
- `output` is the generated static-site directory (commonly `dist`, `build`, or `out`). It must contain `index.html`.
- `test: auto` attempts to run the project's test script. If no usable test script exists, the result can be `SKIPPED`, not `PASSED`. Add tests to your project to get meaningful test coverage.

The complete configuration reference is in [`docs/configuration.md`](https://github.com/shivsingh78/shipflow/blob/main/docs/configuration.md).

## 5. Deploy to the built-in site server

For a site served by ShipFlow itself, make sure the configuration includes:

```yaml
deployment:
  target: shipflow
```

Then from the project directory run:

```bash
shipflow doctor
shipflow deploy
```

The CLI reports the release ID, pipeline stages, test status, and public URL when deployment succeeds. Make sure the server's site endpoint is reachable by visitors, and configure its domain/TLS via your reverse proxy as needed.

## 6. Deploy to your own server with SSH

Choose the SSH target when you want to serve the site using nginx or Caddy on a Linux VPS you control. You need a non-root deployment user and a web server configured to serve the project's `current` directory.

### Prepare the destination server

The following is a starting example for a Debian/Ubuntu server. Adapt the host and directory to your setup:

```bash
sudo adduser --disabled-password deploy
sudo mkdir -p /srv/my-site
sudo chown deploy:deploy /srv/my-site
```

Configure nginx or Caddy to serve `/srv/my-site/current`. ShipFlow creates versioned directories under `releases/` and uses a `current` symlink to activate a release. The target server needs a POSIX shell, `tar`, `sha256sum`, and GNU `mv` with `-T` support.

### Create a dedicated deployment key

On your workstation, generate a key specifically for this project:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/my_site_deploy_key -N ""
```

Add `~/.ssh/my_site_deploy_key.pub` to the deployment user's `authorized_keys` on the destination server. Do not use your personal login key or a root account for deployment.

### Configure the SSH target

Run `shipflow init` and select the `ssh` target. It asks for the host, port, deployment user, remote path, public URL, and server host key. **Verify the host-key fingerprint on the destination server before trusting it.** Do not blindly trust a key returned by a network scan.

The generated config includes settings like these (use the full, verified `hostKey` value generated/confirmed for your own server):

```yaml
deployment:
  target: ssh
  ssh:
    host: server.example.com
    port: 22
    user: deploy
    path: /srv/my-site
    hostKey: "ssh-ed25519 REPLACE_WITH_FULL_VERIFIED_PUBLIC_HOST_KEY"
    privateKeySecret: SSH_PRIVATE_KEY
    url: https://www.example.com/
```

Store the private deployment key on the ShipFlow server as a project secret. From the project directory, run:

```bash
shipflow secrets set SSH_PRIVATE_KEY --from-file "$HOME/.ssh/my_site_deploy_key"
```

This reads the private key from the local file and transmits it to the ShipFlow API; it does not print the key. Use a trusted HTTPS API endpoint. The ShipFlow server encrypts project secrets at rest using `SHIPFLOW_SECRETS_KEY`.

Then check and deploy:

```bash
shipflow doctor
shipflow deploy
```

See the [SSH target and self-hosting notes](https://github.com/shivsingh78/shipflow/blob/main/docs/self-hosting.md#preparing-a-server-for-the-ssh-target) for further details.

## Useful commands

Run commands in the project directory unless noted otherwise.

| Command | Purpose |
|---|---|
| `shipflow --help` | List CLI commands and global options |
| `shipflow --version` | Show the installed CLI version |
| `shipflow login --server <URL>` | Connect to a ShipFlow server |
| `shipflow logout` | Remove saved CLI credentials |
| `shipflow init` | Create `shipflow.yml` interactively |
| `shipflow doctor` | Diagnose config, server, secrets, and target checks |
| `shipflow deploy` | Register/update the project and start a release |
| `shipflow deploy --ref <branch-or-commit>` | Deploy a specific ref supported by the server |
| `shipflow status <release-id>` | Show one release's status |
| `shipflow logs <release-id>` | View pipeline logs and notifications |
| `shipflow releases --project <name>` | List recent releases for a project |
| `shipflow rollback <release-id>` | Reactivate an earlier successful release |
| `shipflow cancel <release-id>` | Cancel a queued or running release before activation |
| `shipflow secrets set <NAME> --from-file <path>` | Store a deployment secret from a file |
| `shipflow secrets list` | List secret names without showing values |
| `shipflow secrets rm <NAME>` | Delete a project secret |
| `shipflow projects` | List registered projects |
| `shipflow targets` | Show supported deployment targets |

Add `--json` to supported commands for machine-readable output. Exit codes are `0` for success, `1` for an operation failure, `2` for usage/configuration errors, `3` for unreachable/unauthorized server errors, and `4` for a timeout waiting for a release.

### Multiple environments

Use a separate config file and project name for each environment, for example:

```bash
shipflow doctor -c shipflow.staging.yml
shipflow deploy -c shipflow.staging.yml
```

Each project has its own release history and secrets.

## Optional AWS EC2 wizard

The CLI also includes an experimental AWS EC2 wizard:

```bash
shipflow cloud help
shipflow cloud deploy
shipflow cloud status
shipflow cloud destroy
```

Read the help output carefully before running these commands. AWS credentials and permissions must be configured for your account. Provisioning EC2 and related infrastructure can incur charges. `destroy` is destructive and may delete resources created by the wizard; inspect the planned actions and preserve anything you need before confirming. This optional wizard is separate from ordinary `shipflow deploy` deployments.

## CI environments

For automation, you can supply the server URL and token via environment variables instead of running the interactive login flow:

```bash
export SHIPFLOW_API_URL="https://shipflow-api.example.com"
export SHIPFLOW_API_TOKEN="${SHIPFLOW_API_TOKEN}"
shipflow doctor
shipflow deploy
```

Configure `SHIPFLOW_API_TOKEN` as a protected CI secret in your CI provider. Do not hard-code it in a workflow file or print it in logs. The repository must be accessible to the ShipFlow server, and the server's repository allowlist must permit it.

## Troubleshooting

### `Missing or invalid API token` / HTTP 401

Confirm the token entered at login is the same as the server's configured `SHIPFLOW_API_TOKEN`. If that server setting changes, log in again:

```bash
shipflow login --server https://shipflow-api.example.com
shipflow doctor
```

### The server is reachable, but no worker is alive

On the ShipFlow host, check services and logs:

```bash
docker compose ps
docker compose logs --tail=100 api worker
```

### `SSH_PRIVATE_KEY` is missing

From the directory containing `shipflow.yml`, store the private key as a project secret:

```bash
shipflow secrets set SSH_PRIVATE_KEY --from-file "$HOME/.ssh/my_site_deploy_key"
shipflow doctor
```

### SSH permission or host-key mismatch

Check that the public key is installed for the configured non-root user, the user can write to the configured directory, and the pinned host key matches the actual server key. If the server was rebuilt, verify its new fingerprint out-of-band before updating `hostKey`.

### Build or test stage fails

Check the release logs:

```bash
shipflow logs <release-id>
```

Run the same build/test scripts locally, verify that the expected output directory contains `index.html`, and ensure that required dependencies can be installed using the project's lockfile.

For more troubleshooting advice, consult the [self-hosting guide](https://github.com/shivsingh78/shipflow/blob/main/docs/self-hosting.md#troubleshooting).

## Security notes

- Never commit `.env`, API tokens, private SSH keys, or credential files.
- Keep the ShipFlow API behind HTTPS when accessed remotely. Do not send tokens to a remote API over plain HTTP.
- Use a dedicated, non-root deployment user and a dedicated key for each deployment target.
- Put deployment credentials in project secrets, not `shipflow.yml` or build-time environment variables.
- Back up `SHIPFLOW_SECRETS_KEY` securely. If it is lost, existing encrypted project secrets cannot be decrypted.
- ShipFlow is intended for a single owner or trusted team. It is not hardened for anonymous multi-tenant workloads; read the server's isolation notes before exposing it to untrusted users.
- Infrastructure, storage, and network costs are your responsibility.

## Uninstall

```bash
npm uninstall --global shipflow-cli
```

To remove saved CLI credentials as well, run `shipflow logout` before uninstalling, or delete `~/.config/shipflow` after confirming you no longer need the saved server credentials.

## Links

- [GitHub repository](https://github.com/shivsingh78/shipflow)
- [Configuration reference](https://github.com/shivsingh78/shipflow/blob/main/docs/configuration.md)
- [Self-hosting guide](https://github.com/shivsingh78/shipflow/blob/main/docs/self-hosting.md)
- [npm package: `shipflow-cli`](https://www.npmjs.com/package/shipflow-cli)
