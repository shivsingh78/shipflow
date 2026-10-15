# shipflow-cli

Command-line client for [ShipFlow](https://github.com/shivsingh78/shipflow), a
self-hosted CI/CD and static-site deployment server. You run the ShipFlow server
yourself (Docker Compose), and the CLI talks to it.

```bash
npm install -g shipflow-cli        # Node.js 22+

shipflow login --server https://shipflow.example.com   # paste the server's API token
shipflow init                      # writes shipflow.yml (no secrets in it)
shipflow secrets set SSH_PRIVATE_KEY < ~/.ssh/deploy_key   # only for the ssh target
shipflow doctor                    # checks config, server, and the deploy target
shipflow deploy                    # build, test, deploy, verify, activate
```

Other commands: `status`, `releases`, `logs`, `rollback`, `cancel`, `projects`,
`targets`, `logout`. Add `--json` for machine-readable output.

Exit codes: `0` ok, `1` failed, `2` usage or configuration error, `3` server
unreachable or unauthorized, `4` timed out waiting.

Credentials are stored in `~/.config/shipflow/credentials.json` (mode 600) and
are only sent to the server they were saved for. In CI, set `SHIPFLOW_API_URL`
and `SHIPFLOW_API_TOKEN` instead.

Uninstall: `npm uninstall -g shipflow-cli`, then remove `~/.config/shipflow`.
