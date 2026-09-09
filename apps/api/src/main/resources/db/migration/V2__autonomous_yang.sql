ALTER TABLE runs ADD COLUMN selection_json JSONB NOT NULL DEFAULT '{"mode":"MANUAL","poolId":null,"includePoolIds":[],"excludePoolIds":[],"minReward":null,"modalities":["text","image","audio"],"includeTraining":false,"includeExams":false}';
ALTER TABLE runs ADD COLUMN selected_project_json JSONB;
ALTER TABLE runs ADD COLUMN selection_reason TEXT;
ALTER TABLE runs ADD COLUMN instruction_progress_json JSONB;
ALTER TABLE run_items ADD COLUMN legacy_response JSONB;
UPDATE run_items SET legacy_response=jsonb_build_object('optionId',option_id,'confirmationNonce',confirmation_nonce,'confirmRequestId',confirm_request_id,'confirmHash',confirm_hash);
ALTER TABLE run_items DROP COLUMN option_id;
ALTER TABLE run_items DROP COLUMN confirmation_nonce;
ALTER TABLE run_items DROP COLUMN confirm_request_id;
ALTER TABLE run_items DROP COLUMN confirm_hash;
ALTER TABLE run_items RENAME COLUMN project_id TO pool_id;
ALTER TABLE run_items RENAME COLUMN task_id TO suite_id;
ALTER TABLE run_items ADD COLUMN answer_json JSONB;
UPDATE runs SET status='INTERRUPTED',error_code='AUTONOMOUS_UPGRADE' WHERE status='AWAITING_CONFIRMATION';
DROP INDEX one_active_run_per_user;
CREATE UNIQUE INDEX one_active_run_per_user ON runs(user_id)
 WHERE status IN ('SELECTING','PREPARING','ANALYZING','FILLING','WAITING_FOR_AUTH','WAITING_FOR_USER','SUBMITTING');
CREATE TABLE selection_settings(user_id UUID PRIMARY KEY REFERENCES users(id), settings_json JSONB NOT NULL);
