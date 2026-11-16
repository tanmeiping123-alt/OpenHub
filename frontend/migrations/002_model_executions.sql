CREATE TABLE IF NOT EXISTS model_executions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  purpose text NOT NULL DEFAULT 'PROMPT_GENERATION'
    CHECK (purpose = 'PROMPT_GENERATION'),
  execution_mode text NOT NULL DEFAULT 'LIVE'
    CHECK (execution_mode = 'LIVE'),
  status text NOT NULL
    CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  provider text NOT NULL,
  requested_model text NOT NULL,
  product_version text NOT NULL,
  resolved_model text,
  provider_request_id text,
  system_fingerprint text,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_text text CHECK (output_text IS NULL OR length(output_text) <= 200000),
  prompt_id text,
  prompt_version_id text,
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  total_tokens integer CHECK (total_tokens IS NULL OR total_tokens >= 0),
  prompt_cache_hit_tokens integer
    CHECK (prompt_cache_hit_tokens IS NULL OR prompt_cache_hit_tokens >= 0),
  prompt_cache_miss_tokens integer
    CHECK (prompt_cache_miss_tokens IS NULL OR prompt_cache_miss_tokens >= 0),
  finish_reason text,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (prompt_id, owner_user_id)
    REFERENCES prompts(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (prompt_id, prompt_version_id)
    REFERENCES prompt_versions(prompt_id, id) ON DELETE RESTRICT,
  CHECK ((prompt_id IS NULL) = (prompt_version_id IS NULL)),
  CHECK (
    status <> 'SUCCEEDED' OR (
      resolved_model IS NOT NULL AND
      output_text IS NOT NULL AND
      prompt_id IS NOT NULL AND
      prompt_version_id IS NOT NULL AND
      prompt_tokens IS NOT NULL AND
      completion_tokens IS NOT NULL AND
      total_tokens IS NOT NULL AND
      latency_ms IS NOT NULL AND
      completed_at IS NOT NULL AND
      error_code IS NULL AND
      error_message IS NULL
    )
  ),
  CHECK (
    status <> 'FAILED' OR (
      error_code IS NOT NULL AND
      error_message IS NOT NULL AND
      completed_at IS NOT NULL AND
      prompt_id IS NULL AND
      prompt_version_id IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS model_executions_owner_created_idx
  ON model_executions(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS model_executions_live_usage_idx
  ON model_executions(owner_user_id, created_at DESC)
  WHERE execution_mode = 'LIVE' AND status = 'SUCCEEDED';
CREATE INDEX IF NOT EXISTS model_executions_prompt_version_idx
  ON model_executions(prompt_id, prompt_version_id)
  WHERE prompt_id IS NOT NULL;
