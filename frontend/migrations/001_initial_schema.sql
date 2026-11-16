CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY,
  identity_key text NOT NULL UNIQUE,
  account_kind text NOT NULL CHECK (account_kind = 'LOCAL_DEMO'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prompts (
  id text NOT NULL,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('TEMPLATE', 'PERSONAL_PROMPT')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  task_type text NOT NULL CHECK (
    task_type IN ('Coding', 'UI/UX Design', 'Writing', 'Data Analysis', 'Business', 'Research', 'AI Agent', 'General')
  ),
  description text NOT NULL DEFAULT '',
  current_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, id),
  UNIQUE (id, owner_user_id)
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id text PRIMARY KEY,
  prompt_id text NOT NULL,
  owner_user_id text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  content text NOT NULL CHECK (length(content) <= 200000),
  created_by text NOT NULL,
  source text NOT NULL,
  parent_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version_number),
  UNIQUE (prompt_id, id),
  FOREIGN KEY (prompt_id, owner_user_id)
    REFERENCES prompts(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (prompt_id, parent_version_id)
    REFERENCES prompt_versions(prompt_id, id) ON DELETE RESTRICT
);

ALTER TABLE prompts
  ADD CONSTRAINT prompts_current_version_same_prompt_fk
  FOREIGN KEY (id, current_version_id)
  REFERENCES prompt_versions(prompt_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS evaluation_reports (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  prompt_id text NOT NULL,
  prompt_version_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('MOCK / SIMULATED', 'LOCAL_HUMAN_CALIBRATION')),
  rubric_version text NOT NULL CHECK (length(rubric_version) BETWEEN 1 AND 200),
  layer1 jsonb NOT NULL CHECK (jsonb_typeof(layer1) = 'object'),
  layer2 jsonb NOT NULL CHECK (jsonb_typeof(layer2) = 'object'),
  layer3 jsonb NOT NULL CHECK (jsonb_typeof(layer3) = 'object'),
  calibration_snapshot jsonb,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (prompt_id, owner_user_id)
    REFERENCES prompts(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (prompt_id, prompt_version_id)
    REFERENCES prompt_versions(prompt_id, id) ON DELETE RESTRICT,
  CHECK (
    layer1->'score' = 'null'::jsonb OR
    ((layer1->>'score')::numeric >= 0 AND (layer1->>'score')::numeric <= 100)
  ),
  CHECK (
    layer2->'score' = 'null'::jsonb OR
    ((layer2->>'score')::numeric >= 0 AND (layer2->>'score')::numeric <= 100)
  ),
  CHECK (
    layer3->'score' = 'null'::jsonb OR
    ((layer3->>'score')::numeric >= 0 AND (layer3->>'score')::numeric <= 100)
  ),
  CHECK (
    layer3->>'status' <> 'NOT_EXECUTED' OR
    (layer3->'score' = 'null'::jsonb AND layer3->'grade' = 'null'::jsonb)
  )
);

CREATE OR REPLACE FUNCTION enforce_general_layer2_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prompt_task_type text;
BEGIN
  SELECT task_type INTO prompt_task_type
  FROM prompts
  WHERE id = NEW.prompt_id AND owner_user_id = NEW.owner_user_id;

  IF prompt_task_type = 'General' AND NOT (
    NEW.layer2->>'status' = 'NOT_AVAILABLE' AND
    NEW.layer2->'score' = 'null'::jsonb AND
    NEW.layer2->'grade' = 'null'::jsonb AND
    NEW.layer2->'dimensions' = '[]'::jsonb
  ) THEN
    RAISE EXCEPTION 'General Layer 2 must be NOT_AVAILABLE with null scores and no dimensions'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evaluation_reports_general_layer2_contract ON evaluation_reports;
CREATE TRIGGER evaluation_reports_general_layer2_contract
  BEFORE INSERT OR UPDATE ON evaluation_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_general_layer2_contract();

CREATE TABLE IF NOT EXISTS library_items (
  owner_user_id text NOT NULL,
  prompt_id text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, prompt_id),
  FOREIGN KEY (prompt_id, owner_user_id)
    REFERENCES prompts(id, owner_user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS favorites (
  owner_user_id text NOT NULL,
  prompt_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, prompt_id),
  FOREIGN KEY (prompt_id, owner_user_id)
    REFERENCES prompts(id, owner_user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS history_records (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  prompt_id text NOT NULL,
  prompt_version_id text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (prompt_id, owner_user_id)
    REFERENCES prompts(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (prompt_id, prompt_version_id)
    REFERENCES prompt_versions(prompt_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS playground_sessions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  prompt_id text NOT NULL,
  prompt_version_id text NOT NULL,
  source text NOT NULL DEFAULT 'MOCK_SIMULATED' CHECK (source = 'MOCK_SIMULATED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (prompt_id, owner_user_id)
    REFERENCES prompts(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (prompt_id, prompt_version_id)
    REFERENCES prompt_versions(prompt_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS optimization_records (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  prompt_id text NOT NULL,
  source_prompt_version_id text NOT NULL,
  proposed_content text NOT NULL CHECK (length(proposed_content) <= 200000),
  source text NOT NULL DEFAULT 'MOCK_SIMULATED' CHECK (source = 'MOCK_SIMULATED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (prompt_id, owner_user_id)
    REFERENCES prompts(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (prompt_id, source_prompt_version_id)
    REFERENCES prompt_versions(prompt_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS model_comparison_results (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES playground_sessions(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  model_label text NOT NULL,
  output_text text NOT NULL,
  source text NOT NULL DEFAULT 'MOCK_SIMULATED' CHECK (source = 'MOCK_SIMULATED'),
  UNIQUE (session_id, sort_order)
);

CREATE INDEX IF NOT EXISTS prompt_versions_owner_prompt_created_idx
  ON prompt_versions(owner_user_id, prompt_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evaluation_reports_owner_prompt_created_idx
  ON evaluation_reports(owner_user_id, prompt_id, created_at DESC);
CREATE INDEX IF NOT EXISTS history_records_owner_created_idx
  ON history_records(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS playground_sessions_owner_created_idx
  ON playground_sessions(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS optimization_records_owner_prompt_created_idx
  ON optimization_records(owner_user_id, prompt_id, created_at DESC);
