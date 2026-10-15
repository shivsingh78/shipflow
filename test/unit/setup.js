// Preloaded into every unit-test process (package.json "test":
// node --test --import ./test/unit/setup.js). Unit tests must never reach a
// real database, queue, cloud account or the developer's .env:
//   * .env is not loaded (SHIPFLOW_NO_DOTENV=1, honoured by src/config.js);
//   * PostgreSQL and Redis point at a reserved, never-resolving hostname
//     (RFC 2606 ".invalid"), so an unmocked call fails immediately instead of
//     falling through to localhost:5432 or another default;
//   * cloud and API credentials inherited from the shell are removed, and
//     artifacts use local storage.
const UNREACHABLE = "unit-tests.shipflow.invalid";

process.env.SHIPFLOW_NO_DOTENV = "1";

for (const name of [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SECRET_KEY", "AWS_SESSION_TOKEN",
  "AWS_PROFILE", "S3_BUCKET_NAME", "S3_ENDPOINT", "SHIPFLOW_SECRETS_KEY",
  "SHIPFLOW_GITHUB_WEBHOOK_SECRET", "SHIPFLOW_API_TOKEN", "DATABASE_URL",
  "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE",
]) {
  delete process.env[name];
}

Object.assign(process.env, {
  DB_HOST: UNREACHABLE,
  DB_PORT: "5432",
  DB_USER: "unit-test",
  DB_PASSWORD: "unit-test",
  DB_NAME: "unit-test",
  REDIS_HOST: UNREACHABLE,
  SHIPFLOW_ARTIFACT_STORE: "local",
});
