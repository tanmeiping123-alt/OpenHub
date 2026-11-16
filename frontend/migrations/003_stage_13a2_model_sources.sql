ALTER TABLE model_executions
  DROP CONSTRAINT model_executions_purpose_check,
  ADD CONSTRAINT model_executions_purpose_check
    CHECK (purpose IN ('PROMPT_GENERATION', 'OPTIMIZATION', 'PLAYGROUND', 'EVALUATION_ADVICE'));

ALTER TABLE model_executions
  DROP CONSTRAINT model_executions_check2,
  ADD CONSTRAINT model_executions_check2
    CHECK (
      status <> 'FAILED' OR (
        error_code IS NOT NULL AND
        error_message IS NOT NULL AND
        completed_at IS NOT NULL
      )
    );

ALTER TABLE optimization_records
  DROP CONSTRAINT optimization_records_source_check,
  ADD CONSTRAINT optimization_records_source_check
    CHECK (source IN ('MOCK_SIMULATED', 'DEEPSEEK_LIVE_OPTIMIZATION'));

ALTER TABLE optimization_records
  ADD COLUMN IF NOT EXISTS model_execution_id text
    REFERENCES model_executions(id) ON DELETE RESTRICT;

ALTER TABLE optimization_records
  ADD CONSTRAINT optimization_records_live_execution_check
    CHECK (
      (source = 'MOCK_SIMULATED' AND model_execution_id IS NULL) OR
      (source = 'DEEPSEEK_LIVE_OPTIMIZATION' AND model_execution_id IS NOT NULL)
    );

ALTER TABLE playground_sessions
  DROP CONSTRAINT playground_sessions_source_check,
  ADD CONSTRAINT playground_sessions_source_check
    CHECK (source IN ('MOCK_SIMULATED', 'DEEPSEEK_LIVE_PLAYGROUND'));

ALTER TABLE playground_sessions
  ADD COLUMN IF NOT EXISTS model_execution_id text
    REFERENCES model_executions(id) ON DELETE RESTRICT;

ALTER TABLE playground_sessions
  ADD CONSTRAINT playground_sessions_live_execution_check
    CHECK (
      (source = 'MOCK_SIMULATED' AND model_execution_id IS NULL) OR
      (source = 'DEEPSEEK_LIVE_PLAYGROUND' AND model_execution_id IS NOT NULL)
    );

ALTER TABLE model_comparison_results
  DROP CONSTRAINT model_comparison_results_source_check,
  ADD CONSTRAINT model_comparison_results_source_check
    CHECK (source IN ('MOCK_SIMULATED', 'DEEPSEEK_LIVE_PLAYGROUND'));

CREATE INDEX IF NOT EXISTS optimization_records_model_execution_idx
  ON optimization_records(model_execution_id)
  WHERE model_execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS playground_sessions_model_execution_idx
  ON playground_sessions(model_execution_id)
  WHERE model_execution_id IS NOT NULL;
