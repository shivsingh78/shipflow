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
