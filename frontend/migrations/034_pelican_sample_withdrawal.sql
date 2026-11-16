-- Per-sample publication withdrawal and re-publication, independent of batch status.
-- Withdrawing one sample hides it from the public gallery while the rest of the batch
-- stays published; the batch itself can still be withdrawn/re-published as before.
ALTER TABLE pelican_samples
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_reason text CHECK(octet_length(withdrawn_reason) <= 500),
  ADD COLUMN withdrawn_by text REFERENCES administrator_users(user_id);

-- Surface withdrawal state through the effective view so listing and access checks share it.
CREATE OR REPLACE VIEW pelican_effective_samples AS
  SELECT s.id,s.batch_id,s.ordinal,s.model_key,s.model_name,s.config_snapshot,s.request_payload,
    s.rerun_of,s.rerun_request_key,s.execution_id,s.raw_output,s.response_model,s.response_finish_reason,
    CASE WHEN r.id IS NULL THEN s.preview_html ELSE r.preview_html END preview_html,
    COALESCE(r.preview_status,s.preview_status) preview_status,
    CASE WHEN r.id IS NULL THEN s.preview_reason ELSE r.preview_reason END preview_reason,
    COALESCE(r.adapter_version,s.adapter_version) adapter_version,
    CASE WHEN r.id IS NULL THEN s.thumbnail ELSE r.thumbnail END thumbnail,
    s.created_at,s.withdrawn_at,s.withdrawn_reason,s.withdrawn_by
  FROM pelican_samples s LEFT JOIN LATERAL (
    SELECT * FROM pelican_preview_revisions WHERE sample_id=s.id ORDER BY id DESC LIMIT 1
  ) r ON true;

CREATE INDEX pelican_samples_visible ON pelican_samples(batch_id) WHERE withdrawn_at IS NULL;
