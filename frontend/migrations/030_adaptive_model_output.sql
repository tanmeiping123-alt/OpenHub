-- Extend documented direct-provider reasoning without rewriting historical evidence.
ALTER TABLE model_executions DROP CONSTRAINT model_executions_requested_strength_check;
ALTER TABLE model_executions ADD CONSTRAINT model_executions_requested_strength_check
  CHECK (requested_strength IN ('default','off','low','high','max'));

-- Model output can legitimately exceed the original 200,000-character prototype
-- ceiling. Keep the full authenticated provider result and its saved derivative.
-- Request-size validation and provider/quota token limits remain separate.
ALTER TABLE model_executions DROP CONSTRAINT model_executions_output_text_check;
ALTER TABLE prompt_versions DROP CONSTRAINT prompt_versions_content_check;
ALTER TABLE optimization_records DROP CONSTRAINT optimization_records_proposed_content_check;
