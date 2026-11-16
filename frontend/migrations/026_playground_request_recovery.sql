-- Existing unkeyed executions remain valid; a key is a distinct Playground receipt.
ALTER TABLE model_executions
  ADD COLUMN playground_request_key text,
  ADD CONSTRAINT model_playground_request_binding CHECK (
    playground_request_key IS NULL OR (
      purpose='PLAYGROUND' AND playground_request_key ~ '^[A-Za-z0-9_-]{8,100}$'
      AND prompt_id IS NOT NULL AND prompt_version_id IS NOT NULL
      AND request_identity_sha256 IS NOT NULL
    )
  );

CREATE UNIQUE INDEX model_playground_request_idx
  ON model_executions(owner_user_id,purpose,playground_request_key)
  WHERE purpose='PLAYGROUND' AND playground_request_key IS NOT NULL;

CREATE FUNCTION preserve_model_playground_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.playground_request_key IS NOT NULL OR NEW.playground_request_key IS NOT NULL) AND (
    OLD.playground_request_key IS DISTINCT FROM NEW.playground_request_key OR
    OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR
    OLD.purpose IS DISTINCT FROM NEW.purpose OR
    OLD.prompt_id IS DISTINCT FROM NEW.prompt_id OR
    OLD.prompt_version_id IS DISTINCT FROM NEW.prompt_version_id OR
    OLD.provider IS DISTINCT FROM NEW.provider OR
    OLD.requested_model IS DISTINCT FROM NEW.requested_model OR
    OLD.product_version IS DISTINCT FROM NEW.product_version OR
    OLD.requested_strength IS DISTINCT FROM NEW.requested_strength OR
    OLD.output_token_limit IS DISTINCT FROM NEW.output_token_limit OR
    OLD.reasoning_token_reserve IS DISTINCT FROM NEW.reasoning_token_reserve OR
    OLD.created_at IS DISTINCT FROM NEW.created_at OR
    (OLD.status <> 'PENDING' AND (
      OLD.status IS DISTINCT FROM NEW.status OR
      OLD.output_text IS DISTINCT FROM NEW.output_text OR
      OLD.resolved_model IS DISTINCT FROM NEW.resolved_model OR
      OLD.provider_request_id IS DISTINCT FROM NEW.provider_request_id OR
      OLD.system_fingerprint IS DISTINCT FROM NEW.system_fingerprint OR
      OLD.prompt_tokens IS DISTINCT FROM NEW.prompt_tokens OR
      OLD.completion_tokens IS DISTINCT FROM NEW.completion_tokens OR
      OLD.total_tokens IS DISTINCT FROM NEW.total_tokens OR
      OLD.prompt_cache_hit_tokens IS DISTINCT FROM NEW.prompt_cache_hit_tokens OR
      OLD.prompt_cache_miss_tokens IS DISTINCT FROM NEW.prompt_cache_miss_tokens OR
      OLD.reasoning_tokens IS DISTINCT FROM NEW.reasoning_tokens OR
      OLD.finish_reason IS DISTINCT FROM NEW.finish_reason OR
      OLD.latency_ms IS DISTINCT FROM NEW.latency_ms OR
      OLD.completed_at IS DISTINCT FROM NEW.completed_at OR
      OLD.error_code IS DISTINCT FROM NEW.error_code OR
      OLD.error_message IS DISTINCT FROM NEW.error_message
    ))
  ) THEN RAISE EXCEPTION 'Playground request evidence is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_playground_request_immutable BEFORE UPDATE ON model_executions
  FOR EACH ROW EXECUTE FUNCTION preserve_model_playground_request();
