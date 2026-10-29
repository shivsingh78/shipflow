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

-- ------------------------------------------------------------ RepoPilot
-- AI-assisted repository analysis. Additive only; nothing here touches the
-- release tables. No column ever holds a provider key, a GitHub token or
-- plaintext credentials: rp_credentials stores RSA-OAEP ciphertext that only
-- the orchestration worker can decrypt.

CREATE TABLE IF NOT EXISTS rp_runs (
  id BIGSERIAL PRIMARY KEY,
  owner TEXT NOT NULL,
  repo_owner VARCHAR(39) NOT NULL,
  repo_name VARCHAR(100) NOT NULL,
  repo_url TEXT NOT NULL,
  requested_ref VARCHAR(255),
  commit_sha CHAR(40),
  default_branch VARCHAR(255),
  state VARCHAR(20) NOT NULL DEFAULT 'queued',
  failure_code VARCHAR(40),
  failure_detail TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key VARCHAR(100),
  -- Customer-funded AI usage for this run; enforced by reserve_ai_request.
  ai_requests INTEGER NOT NULL DEFAULT 0,
  ai_input_tokens BIGINT NOT NULL DEFAULT 0,
  ai_output_tokens BIGINT NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT rp_runs_state_chk CHECK (state IN (
    'queued','ingesting','analyzing','awaiting_patch','patching','verifying',
    'ready_for_review','pr_authorized','pr_opened','failed','cancelled')),
  CONSTRAINT rp_runs_sha_chk CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT rp_runs_ai_chk CHECK (ai_requests >= 0 AND ai_input_tokens >= 0 AND ai_output_tokens >= 0),
  CONSTRAINT rp_runs_finished_chk CHECK (
    (state IN ('pr_opened','failed','cancelled')) = (finished_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS rp_runs_owner_idx ON rp_runs (owner, id DESC);
CREATE INDEX IF NOT EXISTS rp_runs_active_idx ON rp_runs (state, updated_at)
  WHERE state NOT IN ('pr_opened','failed','cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS rp_runs_idempotency_idx
  ON rp_runs (owner, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- One row per stage attempt. The idempotency key makes a redelivered job a
-- no-op: the same attempt can never start twice.
CREATE TABLE IF NOT EXISTS rp_stages (
  run_id BIGINT NOT NULL REFERENCES rp_runs (id) ON DELETE CASCADE,
  stage VARCHAR(10) NOT NULL,
  attempt INTEGER NOT NULL,
  state VARCHAR(10) NOT NULL DEFAULT 'running',
  idempotency_key VARCHAR(60) NOT NULL UNIQUE,
  worker TEXT,
  -- Non-secret inputs, e.g. {"findingId": 7} for the patch stage.
  params JSONB NOT NULL DEFAULT '{}',
  error_code VARCHAR(40),
  error_detail TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, stage, attempt),
  CONSTRAINT rp_stages_stage_chk CHECK (stage IN ('ingest','manifest','analyze','patch','verify','pr')),
  CONSTRAINT rp_stages_state_chk CHECK (state IN ('running','succeeded','failed','skipped')),
  CONSTRAINT rp_stages_attempt_chk CHECK (attempt >= 1),
  CONSTRAINT rp_stages_finished_chk CHECK ((state = 'running') = (finished_at IS NULL))
);

CREATE INDEX IF NOT EXISTS rp_stages_running_idx ON rp_stages (heartbeat_at) WHERE state = 'running';

-- Repositories an owner has explicitly authorised RepoPilot to read.
CREATE TABLE IF NOT EXISTS rp_repositories (
  owner TEXT NOT NULL,
  repo_owner VARCHAR(39) NOT NULL,
  repo_name VARCHAR(100) NOT NULL,
  authorized_by TEXT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, repo_owner, repo_name)
);

CREATE TABLE IF NOT EXISTS rp_findings (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES rp_runs (id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  title VARCHAR(160) NOT NULL,
  category VARCHAR(20) NOT NULL,
  severity VARCHAR(10) NOT NULL,
  evidence_kind VARCHAR(12) NOT NULL,
  file TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  impact TEXT NOT NULL,
  remediation TEXT NOT NULL,
  -- The model's own estimate. A suggestion, never ground truth.
  model_confidence REAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, fingerprint),
  UNIQUE (run_id, rank),
  CONSTRAINT rp_findings_conf_chk CHECK (model_confidence BETWEEN 0 AND 1),
  CONSTRAINT rp_findings_lines_chk CHECK (line_start >= 1 AND line_end >= line_start),
  CONSTRAINT rp_findings_severity_chk CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT rp_findings_kind_chk CHECK (evidence_kind IN ('observed','hypothesis'))
);

-- Proposed changes. diff, test_diff, diff_sha256 and base_commit are
-- immutable (trigger below): the digest a human authorises must always match
-- the bytes that get proposed. validation_* is OUR validator's verdict,
-- never the model's.
CREATE TABLE IF NOT EXISTS rp_patches (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES rp_runs (id) ON DELETE CASCADE,
  finding_id BIGINT NOT NULL REFERENCES rp_findings (id) ON DELETE CASCADE,
  base_commit CHAR(40) NOT NULL,
  title VARCHAR(160) NOT NULL,
  explanation TEXT NOT NULL,
  diff TEXT NOT NULL,
  test_diff TEXT NOT NULL,
  diff_sha256 CHAR(64) NOT NULL,
  validation_ok BOOLEAN NOT NULL,
  validation JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (finding_id, diff_sha256),
  CONSTRAINT rp_patches_sha_chk CHECK (diff_sha256 ~ '^[0-9a-f]{64}$' AND base_commit ~ '^[0-9a-f]{40}$')
);

CREATE INDEX IF NOT EXISTS rp_patches_run_idx ON rp_patches (run_id, id);

-- Sandbox execution records. Written only through the store's
-- recordVerification, which accepts a parsed SandboxRun and nothing else.
CREATE TABLE IF NOT EXISTS rp_verifications (
  id BIGSERIAL PRIMARY KEY,
  patch_id BIGINT NOT NULL REFERENCES rp_patches (id) ON DELETE CASCADE,
  arm VARCHAR(10) NOT NULL,
  attempt INTEGER NOT NULL,
  kind VARCHAR(20) NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  detail TEXT,
  commit_sha CHAR(40) NOT NULL,
  diff_sha256 CHAR(64) NOT NULL,
  test_command TEXT NOT NULL,
  environment_profile JSONB NOT NULL,
  log_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (patch_id, arm, attempt),
  CONSTRAINT rp_verifications_arm_chk CHECK (arm IN ('baseline','control','patched')),
  CONSTRAINT rp_verifications_kind_chk CHECK (kind IN ('exited','timeout','infra_error','resource_limit','no_test_script')),
  CONSTRAINT rp_verifications_attempt_chk CHECK (attempt >= 1)
);

-- Derived from rp_verifications by the classifier; never supplied by a caller.
CREATE TABLE IF NOT EXISTS rp_outcomes (
  patch_id BIGINT PRIMARY KEY REFERENCES rp_patches (id) ON DELETE CASCADE,
  outcome VARCHAR(12) NOT NULL,
  reasons TEXT[] NOT NULL DEFAULT '{}',
  arms JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rp_outcomes_chk CHECK (outcome IN ('improved','unchanged','regressed','inconclusive'))
);

-- At most one pull request per patch: the unique key is what prevents a
-- duplicate job from opening a second PR.
CREATE TABLE IF NOT EXISTS rp_pull_requests (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES rp_runs (id) ON DELETE CASCADE,
  patch_id BIGINT NOT NULL UNIQUE REFERENCES rp_patches (id) ON DELETE CASCADE,
  authorized_by TEXT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  authorized_diff_sha256 CHAR(64) NOT NULL,
  authorized_outcome VARCHAR(12) NOT NULL,
  base_branch VARCHAR(255) NOT NULL,
  base_sha CHAR(40) NOT NULL,
  branch_name VARCHAR(255) NOT NULL UNIQUE,
  state VARCHAR(12) NOT NULL DEFAULT 'authorized',
  pr_number INTEGER,
  pr_url TEXT,
  head_sha CHAR(40),
  error_code VARCHAR(40),
  error_detail TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rp_pr_state_chk CHECK (state IN ('authorized','creating','opened','failed'))
);

-- Evidence kept in the ShipFlow artifact store; this table is the index.
CREATE TABLE IF NOT EXISTS rp_artifacts (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES rp_runs (id) ON DELETE CASCADE,
  patch_id BIGINT REFERENCES rp_patches (id) ON DELETE CASCADE,
  kind VARCHAR(24) NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rp_artifacts_bytes_chk CHECK (bytes >= 0)
);

CREATE INDEX IF NOT EXISTS rp_artifacts_run_idx ON rp_artifacts (run_id, id);

CREATE TABLE IF NOT EXISTS rp_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES rp_runs (id) ON DELETE CASCADE,
  stage VARCHAR(10) NOT NULL,
  level VARCHAR(10) NOT NULL DEFAULT 'INFO',
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rp_logs_run_idx ON rp_logs (run_id, id);

-- Customer (BYOK) provider credentials. ciphertext is RSA-OAEP sealed to the
-- worker's public key, so the API process cannot read it back.
CREATE TABLE IF NOT EXISTS rp_credentials (
  owner TEXT NOT NULL,
  provider VARCHAR(20) NOT NULL,
  ciphertext TEXT NOT NULL,
  fingerprint CHAR(16) NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, provider)
);

-- Append-only, hash-chained audit history. No foreign key on purpose: the
-- history outlives any run's data. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS rp_audit_events (
  id BIGSERIAL PRIMARY KEY,
  chain_key TEXT NOT NULL,
  run_id BIGINT,
  owner TEXT NOT NULL,
  actor TEXT NOT NULL,
  event VARCHAR(40) NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  prev_hash CHAR(64) NOT NULL,
  hash CHAR(64) NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rp_audit_chain_idx ON rp_audit_events (chain_key, id);
CREATE INDEX IF NOT EXISTS rp_audit_run_idx ON rp_audit_events (run_id, id);

CREATE OR REPLACE FUNCTION rp_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RepoPilot: % on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rp_audit_immutable ON rp_audit_events;
CREATE TRIGGER rp_audit_immutable BEFORE UPDATE OR DELETE ON rp_audit_events
  FOR EACH ROW EXECUTE FUNCTION rp_forbid_change();

CREATE OR REPLACE FUNCTION rp_patch_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.diff IS DISTINCT FROM OLD.diff
     OR NEW.test_diff IS DISTINCT FROM OLD.test_diff
     OR NEW.diff_sha256 IS DISTINCT FROM OLD.diff_sha256
     OR NEW.base_commit IS DISTINCT FROM OLD.base_commit
     OR NEW.finding_id IS DISTINCT FROM OLD.finding_id THEN
    RAISE EXCEPTION 'RepoPilot: a stored patch is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rp_patch_immutable ON rp_patches;
CREATE TRIGGER rp_patch_immutable BEFORE UPDATE ON rp_patches
  FOR EACH ROW EXECUTE FUNCTION rp_patch_immutable();
