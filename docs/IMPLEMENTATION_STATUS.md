# Implementation status

Branch `feat/typescript-multi-runtime`, uncommitted. Statuses use only what
was actually run.

| Area | Status | Evidence |
|---|---|---|
| Strict TypeScript (server, worker, CLI incl. AWS wizard), compiled output used in production | done | `pnpm typecheck`, `pnpm lint` clean; Docker image runs `dist/` |
| Artifact types (`static` / `image`), additive DB columns, legacy releases stay static | done | unit tests, e2e |
| Build strategies: static, node (generated Dockerfile), dockerfile; deterministic detection | done | unit tests (detection matrix, fixtures); real builds in e2e |
| Image builds | opt-in, **off by default** | weaker isolation than the sandbox (host daemon); documented |
| Docker target (SSH, proxy blue/green, rollback, cleanup, secrets via env file) | done | unit tests with fake remote + e2e against docker-in-docker |
| Kubernetes / K3s target | implemented | **only a fake API server and fake docker runner; never run against a real cluster or registry** |
| Release evidence, `shipflow diagnose`, advisory-analyzer interface | done | unit tests; no AI provider is shipped |
| CI (typecheck, lint, build, unit, e2e) | updated | workflow edited; not yet run on GitHub |

## Known limitations

- Cancelling during a running `docker build` takes effect after the build ends.
- The Dockerfile build has ordinary outbound network access (BuildKit cannot attach to the restricted sandbox network).
- Docker target: single host, no high availability; containerd-image-store *target* hosts untested; first-manifest-only archive reader.
- Kubernetes: see above; `runAsNonRoot` is not forced; exposure of the live Service is the operator's job.
- `shipflow init` still only generates static-site configs; image targets are configured by editing `shipflow.yml` (see `examples/`).
- The e2e suite needs internet (pulls `node:22-alpine`, `nginx:1.27-alpine`) and a privileged docker-in-docker service.
- Buildpacks were deliberately not added (nothing was tested for them).
