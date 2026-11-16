CREATE TABLE skill_library_withdrawals (
  version_id text PRIMARY KEY REFERENCES skill_library_entries(version_id),
  administrator_id text NOT NULL REFERENCES administrator_users(user_id),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER withdrawal_history BEFORE UPDATE OR DELETE ON skill_library_withdrawals FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TABLE skill_workflow_plans (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id),
  goal text NOT NULL,
  task_type text NOT NULL,
  locale text NOT NULL,
  matching_mode text NOT NULL CHECK(matching_mode IN ('AUTO','HYBRID','MANUAL')),
  analysis jsonb NOT NULL,
  selections jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,id)
);
CREATE TRIGGER workflow_plan_immutable BEFORE UPDATE OR DELETE ON skill_workflow_plans FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TABLE skill_workflow_runs (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id),
  request_key text NOT NULL,
  payload_sha256 text NOT NULL,
  plan_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(owner_user_id,request_key),
  FOREIGN KEY(owner_user_id,plan_id) REFERENCES skill_workflow_plans(owner_user_id,id)
);
CREATE TABLE prompt_skill_sources (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id),
  prompt_version_id text NOT NULL REFERENCES prompt_versions(id),
  skill_version_id text NOT NULL REFERENCES skill_versions(id),
  evidence_kind text NOT NULL CHECK(evidence_kind IN ('ADOPTED_TEXT','MODEL_CONTEXT')),
  manifest_sha256 text NOT NULL,
  resources jsonb NOT NULL,
  plan_id text REFERENCES skill_workflow_plans(id),
  model_execution_id text REFERENCES model_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(prompt_version_id,skill_version_id,evidence_kind)
);
CREATE TRIGGER prompt_skill_sources_immutable BEFORE UPDATE OR DELETE ON prompt_skill_sources FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TABLE skill_model_contexts (
  execution_id text PRIMARY KEY REFERENCES model_executions(id),
  owner_user_id text NOT NULL REFERENCES app_users(id),
  plan_id text NOT NULL,
  selections jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_user_id,plan_id) REFERENCES skill_workflow_plans(owner_user_id,id)
);
CREATE TRIGGER skill_model_context_immutable BEFORE UPDATE OR DELETE ON skill_model_contexts FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
