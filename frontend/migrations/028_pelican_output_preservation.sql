-- Keep authentic supplier output even when it exceeds the preview runtime limits.
-- The renderer separately rejects oversized/unsupported documents without rewriting raw evidence.
ALTER TABLE pelican_samples DROP CONSTRAINT pelican_samples_raw_output_check;
ALTER TABLE pelican_samples DROP CONSTRAINT pelican_samples_preview_html_check;
ALTER TABLE pelican_samples ADD CONSTRAINT pelican_samples_preview_html_check
  CHECK (preview_html IS NULL OR octet_length(preview_html)<=1000000);
ALTER TABLE model_executions DROP CONSTRAINT model_executions_output_text_check;
ALTER TABLE model_executions ADD CONSTRAINT model_executions_output_text_check
  CHECK (purpose='PELICAN_TEST' OR output_text IS NULL OR length(output_text)<=200000);
