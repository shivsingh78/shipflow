-- ShipFlow schema. Idempotent: safe to run on every start and on databases
-- created by earlier ShipFlow versions (only additive changes).

CREATE TABLE IF NOT EXISTS releases (
  id SERIAL PRIMARY KEY,
  release_id VARCHAR(20) NOT NULL UNIQUE,
  repo_url TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  current_stage VARCHAR(30) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE releases ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS deployment_url TEXT;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS artifact_path TEXT;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS public_deployment_url TEXT;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS commit_sha VARCHAR(40);
ALTER TABLE releases ADD COLUMN IF NOT EXISTS test_status VARCHAR(20);

CREATE TABLE IF NOT EXISTS release_logs (
  id SERIAL PRIMARY KEY,
  release_id VARCHAR(20) NOT NULL,
  stage VARCHAR(50) NOT NULL,
  level VARCHAR(20) NOT NULL DEFAULT 'INFO',
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS release_logs_release_id_idx
  ON release_logs (release_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  release_id VARCHAR(20) NOT NULL,
  type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS notifications_release_id_idx
  ON notifications (release_id, id);

-- Append-only history of which release is live. The newest row wins.
-- release_id is NULL when a revert leaves no release active.
CREATE TABLE IF NOT EXISTS activations (
  id SERIAL PRIMARY KEY,
  release_id VARCHAR(20) REFERENCES releases (release_id),
  previous_release_id VARCHAR(20),
  action VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------- v2
-- Projects, per-project live pointers, secrets and webhook dedupe.
-- Existing rows belong to the implicit project "default".

ALTER TABLE releases ADD COLUMN IF NOT EXISTS project VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE releases ADD COLUMN IF NOT EXISTS mode VARCHAR(10) NOT NULL DEFAULT 'deploy';
ALTER TABLE releases ADD COLUMN IF NOT EXISTS ref VARCHAR(255);
ALTER TABLE releases ADD COLUMN IF NOT EXISTS trigger VARCHAR(20) NOT NULL DEFAULT 'cli';
ALTER TABLE releases ADD COLUMN IF NOT EXISTS target VARCHAR(40) NOT NULL DEFAULT 'shipflow';
ALTER TABLE releases ADD COLUMN IF NOT EXISTS config JSONB;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS releases_project_idx ON releases (project, id);

CREATE TABLE IF NOT EXISTS projects (
  name VARCHAR(64) PRIMARY KEY,
  repo_url TEXT NOT NULL,
  target VARCHAR(40) NOT NULL,
  hostname VARCHAR(253) UNIQUE,
  config JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE activations ADD COLUMN IF NOT EXISTS project VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS activations_project_idx ON activations (project, id);

-- Values are AES-256-GCM encrypted with SHIPFLOW_SECRETS_KEY; plaintext is
-- never stored or returned by the API.
CREATE TABLE IF NOT EXISTS project_secrets (
  project VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project, name)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id VARCHAR(100) PRIMARY KEY,
  event VARCHAR(40) NOT NULL,
  project VARCHAR(64),
  release_id VARCHAR(20),
  outcome TEXT,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE releases ADD COLUMN IF NOT EXISTS artifacts_pruned BOOLEAN NOT NULL DEFAULT FALSE;

-- Artifact types: static files (the default for every pre-existing release)
-- or a container image. artifact_path keeps pointing at the artifact-store
-- prefix so retention and legacy readers keep working.
ALTER TABLE releases ADD COLUMN IF NOT EXISTS artifact_type VARCHAR(20) NOT NULL DEFAULT 'static';
ALTER TABLE releases ADD COLUMN IF NOT EXISTS artifact JSONB;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS build_strategy VARCHAR(20);
-- Target-specific facts recorded at activation (never secrets).
ALTER TABLE releases ADD COLUMN IF NOT EXISTS deployment JSONB;
