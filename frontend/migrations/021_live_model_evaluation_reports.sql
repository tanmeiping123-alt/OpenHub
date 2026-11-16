ALTER TABLE model_executions
  DROP CONSTRAINT model_executions_purpose_check,
  ADD CONSTRAINT model_executions_purpose_check CHECK (purpose IN
    ('PROMPT_GENERATION','OPTIMIZATION','PLAYGROUND','EVALUATION_ADVICE','EVALUATION_REPORT')),
  ADD COLUMN evaluation_report jsonb,
  ADD COLUMN evaluation_principles jsonb,
  ADD COLUMN evaluation_request_key text,
  ADD CONSTRAINT model_evaluation_report_binding CHECK (
    (purpose <> 'EVALUATION_REPORT' AND evaluation_report IS NULL AND evaluation_principles IS NULL AND evaluation_request_key IS NULL) OR
    (purpose = 'EVALUATION_REPORT' AND prompt_id IS NOT NULL AND prompt_version_id IS NOT NULL
      AND evaluation_request_key IS NOT NULL AND length(evaluation_request_key) BETWEEN 8 AND 100
      AND evaluation_principles IS NOT NULL AND provider = 'deepseek'
      AND (status <> 'SUCCEEDED' OR evaluation_report IS NOT NULL))
  );

CREATE UNIQUE INDEX model_evaluation_request_idx ON model_executions(owner_user_id,purpose,evaluation_request_key)
  WHERE purpose='EVALUATION_REPORT' AND evaluation_request_key IS NOT NULL;

CREATE FUNCTION preserve_model_evaluation_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purpose='EVALUATION_REPORT' AND (
    OLD.evaluation_request_key IS DISTINCT FROM NEW.evaluation_request_key OR
    OLD.evaluation_principles IS DISTINCT FROM NEW.evaluation_principles OR
    OLD.input_sha256 IS DISTINCT FROM NEW.input_sha256 OR
    OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR
    OLD.prompt_id IS DISTINCT FROM NEW.prompt_id OR
    OLD.prompt_version_id IS DISTINCT FROM NEW.prompt_version_id OR
    OLD.purpose IS DISTINCT FROM NEW.purpose OR
    (OLD.status <> 'PENDING' AND (
      OLD.status IS DISTINCT FROM NEW.status OR OLD.evaluation_report IS DISTINCT FROM NEW.evaluation_report OR
      OLD.output_text IS DISTINCT FROM NEW.output_text OR OLD.provider IS DISTINCT FROM NEW.provider OR
      OLD.requested_model IS DISTINCT FROM NEW.requested_model OR OLD.resolved_model IS DISTINCT FROM NEW.resolved_model OR
      OLD.product_version IS DISTINCT FROM NEW.product_version OR OLD.total_tokens IS DISTINCT FROM NEW.total_tokens OR
      OLD.prompt_tokens IS DISTINCT FROM NEW.prompt_tokens OR OLD.completion_tokens IS DISTINCT FROM NEW.completion_tokens OR
      OLD.requested_strength IS DISTINCT FROM NEW.requested_strength OR OLD.output_token_limit IS DISTINCT FROM NEW.output_token_limit OR
      OLD.prompt_cache_hit_tokens IS DISTINCT FROM NEW.prompt_cache_hit_tokens OR OLD.prompt_cache_miss_tokens IS DISTINCT FROM NEW.prompt_cache_miss_tokens OR
      OLD.reasoning_tokens IS DISTINCT FROM NEW.reasoning_tokens OR OLD.provider_request_id IS DISTINCT FROM NEW.provider_request_id OR
      OLD.finish_reason IS DISTINCT FROM NEW.finish_reason OR OLD.system_fingerprint IS DISTINCT FROM NEW.system_fingerprint OR
      OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    ))
  ) THEN RAISE EXCEPTION 'Model evaluation evidence is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_evaluation_immutable BEFORE UPDATE ON model_executions
  FOR EACH ROW EXECUTE FUNCTION preserve_model_evaluation_report();
