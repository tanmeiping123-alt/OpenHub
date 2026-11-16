-- NULL means historical execution: never infer or backfill messages that were not recorded.
ALTER TABLE model_executions
  ADD COLUMN model_policy_version text CHECK (model_policy_version IS NULL OR length(model_policy_version) BETWEEN 1 AND 100),
  ADD COLUMN dispatched_messages_sha256 text CHECK (dispatched_messages_sha256 IS NULL OR dispatched_messages_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN request_identity_sha256 text CHECK (request_identity_sha256 IS NULL OR request_identity_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT model_strategy_evidence_binding CHECK ((model_policy_version IS NULL) = (dispatched_messages_sha256 IS NULL));

CREATE FUNCTION preserve_model_strategy_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.model_policy_version IS DISTINCT FROM NEW.model_policy_version OR
     OLD.dispatched_messages_sha256 IS DISTINCT FROM NEW.dispatched_messages_sha256 OR
     OLD.request_identity_sha256 IS DISTINCT FROM NEW.request_identity_sha256 OR
     OLD.input_sha256 IS DISTINCT FROM NEW.input_sha256 THEN
    RAISE EXCEPTION 'Model strategy evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_strategy_evidence_immutable BEFORE UPDATE ON model_executions
  FOR EACH ROW EXECUTE FUNCTION preserve_model_strategy_evidence();
