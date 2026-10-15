#!/bin/sh
# Full end-to-end test: real API, worker, PostgreSQL, Redis, Docker build
# sandboxes and an S3-compatible mock, driven through the real CLI.
# Runs as its own compose project and removes only that project's volumes.
set -eu

cd "$(dirname "$0")/../.."

DOCKER="${DOCKER:-docker}"
export DB_PASSWORD="e2e-db-password"
export DB_USER="shipflow"
export DB_NAME="shipflow"
export SHIPFLOW_SANDBOX_NETWORK_NAME="shipflow-e2e-sandbox"

compose() {
  "$DOCKER" compose -p shipflow-e2e -f docker-compose.yml -f docker-compose.e2e.yml "$@"
}

cleanup() {
  compose logs --no-color api worker > test/e2e/last-run.log 2>&1 || true

  if [ "${KEEP_E2E:-0}" != "1" ]; then
    compose --profile runner down -v --remove-orphans > /dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

compose build api
compose build fixtures vps
compose up -d --wait postgres redis s3 fixtures vps api egress-proxy worker
compose run --rm e2e
