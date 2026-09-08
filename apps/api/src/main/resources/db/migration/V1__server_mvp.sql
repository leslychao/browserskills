CREATE TABLE users (
  id UUID PRIMARY KEY, login VARCHAR(128) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE browser_assignments (
  worker_id INTEGER PRIMARY KEY CHECK (worker_id BETWEEN 1 AND 5),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id)
);
CREATE TABLE runs (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), request_id UUID NOT NULL,
  max_tasks INTEGER NOT NULL CHECK(max_tasks BETWEEN 1 AND 50), processed INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL, generation VARCHAR(128), error_code VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(user_id,request_id)
);
CREATE UNIQUE INDEX one_active_run_per_user ON runs(user_id)
  WHERE status IN ('PREPARING','ANALYZING','AWAITING_CONFIRMATION','SUBMITTING');
CREATE TABLE run_items (
  id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL,
  project_id VARCHAR(256) NOT NULL, task_id VARCHAR(256) NOT NULL, snapshot_hash CHAR(64) NOT NULL,
  instruction_hash CHAR(64) NOT NULL, confirmation_nonce UUID NOT NULL,
  status VARCHAR(24) NOT NULL, option_id VARCHAR(256), code VARCHAR(128),
  confirm_request_id UUID, confirm_hash CHAR(64), created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(run_id,ordinal), UNIQUE(run_id,confirm_request_id)
);
CREATE INDEX unresolved_task ON run_items(project_id,task_id) WHERE status IN ('SUBMIT_INTENT','UNKNOWN');
CREATE TABLE ai_usage (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), request_id UUID NOT NULL,
  snapshot_hash CHAR(64) NOT NULL, instruction_hash CHAR(64) NOT NULL, model_hash VARCHAR(128),
  status VARCHAR(32) NOT NULL, result_json TEXT, error_code VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
  UNIQUE(user_id,request_id)
);
CREATE INDEX usage_day ON ai_usage(user_id,created_at);
