# Web dashboard

ShipFlow serves a web dashboard from its API at **`/ui`** (for example
`http://localhost:8000/ui/`). It is a static single-page app (React, TypeScript,
Vite) in [`ui/`](../ui) that talks to the same API the CLI uses, on the same
origin. There is no separate server and nothing to configure.

```bash
docker compose up -d --build --wait     # the image builds and ships the dashboard
open http://localhost:8000/ui/          # sign in with SHIPFLOW_API_TOKEN
```

Opening the API root (`/`) in a browser redirects to `/ui/`; API clients are
unaffected. Set `SHIPFLOW_UI=off` to serve the API only, or `SHIPFLOW_UI_DIR` to
serve a build from another directory.

## What it does

| Area | Pages | Backed by |
|---|---|---|
| Workspace | Overview, Applications (list, detail with 7 tabs, create wizard), Deployments, Build Runs, release detail | `GET /projects`, `/projects/:name`, `PUT /projects/:name`, `/releases`, `/releases/:id`, `/logs`, `/evidence`, `POST /deploy`, `/releases/:id/cancel`, `/rollback/:id` |
| Infrastructure | Servers, Container Registries, Domains | **Derived** from each project's configuration; the only action is `POST /projects/:name/check` (read-only target diagnostics) |
| Operations | Activity, Logs | **Derived** from release records; logs are **polled** every 2 s while a release runs (there is no streaming endpoint) |
| Administration | Settings, Account | `GET /whoami`, `/ready` |

A ShipFlow *project* is the one real entity, so "Applications" is the project
list. Anything the backend does not offer is shown as a clearly labelled,
disabled state with the real alternative, not a fake control:

- **Projects** (workspace grouping) and **Environments**: not a ShipFlow concept (use one project per environment).
- **Servers, registries, domains as objects**: they live inside an application's configuration; edit that.
- **User accounts, profiles, notifications, API keys**: ShipFlow has one shared API token.
- **Deleting an application**: there is no delete endpoint yet.
- **Continuous health monitoring**: ShipFlow checks health at deploy time; "Run target check" runs the target's diagnostics on demand.
- **Kubernetes** is labelled *Experimental: not verified on a real cluster*.

## Security model

- The dashboard files are public static content (no secrets, no data). **Every
  API call needs the bearer token**, exactly like the CLI. Responses to `/ui`
  carry a strict Content-Security-Policy (`script-src 'self'`, `connect-src 'self'`,
  `frame-ancestors 'none'`, no inline script), `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- The token is held in `sessionStorage` (gone when the tab closes). "Remember on
  this device" is an explicit opt-in (`localStorage`). It is only ever sent as an
  `Authorization` header to the server that served the page, never in a URL.
  The Account page shows it masked and never in full.
- **Secrets are write-only.** The API lists secret *names*; the dashboard never
  requests, prefills or displays a stored value. Secret inputs are masked, cleared
  after saving, and the value goes only in the body of the single `PUT`.
- Configuration is validated in the browser with the **same validator the server
  uses** (`cli/lib/projectConfig.ts`) and again by the server; no free text
  becomes a command beyond what the `shipflow.yml` schema already permits.
- Releases started from the dashboard are recorded with trigger `dashboard`
  (a display label only; it grants nothing).
- The token is a single shared admin credential. Put TLS in front of the API
  (see [self-hosting](self-hosting.md#network-exposure)) before exposing it.

## Design

The look follows a single design reference: a warm near-black theme with an orange primary,
Sora headings and Manrope text. The dashboard is **dark-only** (the design defines no light
theme), so there is no theme switch. Colours, radii and type sizes are tokens in
[`ui/src/styles/tokens.css`](../ui/src/styles/tokens.css); every page uses them, so the
reference's Overview layout and the other pages share one visual system. The reference only
designs the Overview page; the other pages are built from the same tokens and components.

The two fonts are **self-hosted** in `ui/public/fonts/` (SIL OFL 1.1, see the README there)
because the Content-Security-Policy only allows this origin. Do not point the CSS at a font CDN:
`pnpm test` fails if a stylesheet loads anything from another origin.

## Demo mode

The sign-in page has **Explore with sample data**. It uses an in-memory client with
made-up applications and releases, shows a permanent banner, contacts no server and
deploys nothing. The same client is used by the UI tests. It is never mixed with
live responses.

## Development

```bash
pnpm install
pnpm dev                 # API (needs Postgres/Redis; or: docker compose up)
pnpm dev:ui              # Vite on :5173, proxying API routes to http://127.0.0.1:8000
pnpm build:ui            # ui/dist (what the API serves)
pnpm --filter shipflow-ui test    # vitest + testing-library
pnpm check               # typecheck, lint, build, server + CLI + UI tests
```

`SHIPFLOW_API_URL` points the dev proxy at another API. All UI packages are
devDependencies: only the built static files ship in the Docker image.

## Known limitations

- Logs are polled, not streamed; "last N releases" figures come from the newest 200 releases the API returns.
- Overview and Applications load each project's configuration with one request per project.
- Activity events are derived from release records (queued plus current state); the API does not record when a release actually started.
- Host keys are shown as key type plus truncated key, not a computed fingerprint.
- Browser testing so far: Chromium (Chrome for Testing) only; no screen-reader pass.
