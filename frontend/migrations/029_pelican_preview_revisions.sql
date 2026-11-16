-- Reprocess saved outputs after adapter changes without altering original evidence.
CREATE TABLE pelican_preview_revisions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 sample_id text NOT NULL REFERENCES pelican_samples(id),
 adapter_version text NOT NULL CHECK(length(adapter_version) BETWEEN 1 AND 100),
 raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[a-f0-9]{64}$'),
 preview_html text CHECK(octet_length(preview_html)<=1000000),
 preview_status text NOT NULL CHECK(preview_status IN ('READY','STATIC','INVALID','BLOCKED','UNSUPPORTED','TRUNCATED')),
 preview_reason text,
 thumbnail bytea,
 created_by text NOT NULL REFERENCES administrator_users(user_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(sample_id,adapter_version)
);
CREATE FUNCTION preserve_pelican_preview_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sample pelican_samples; batch_status text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Pelican preview revisions are immutable' USING ERRCODE='23514'; END IF;
 SELECT s.* INTO sample FROM pelican_samples s WHERE s.id=NEW.sample_id;
 SELECT status INTO batch_status FROM pelican_batches WHERE id=sample.batch_id FOR UPDATE;
 IF sample.raw_output IS NULL OR sample.adapter_version IS NULL
 OR batch_status NOT IN ('DRAFT','COMPLETE','RUNNING')
 OR NEW.adapter_version=sample.adapter_version
 OR NEW.raw_sha256<>encode(sha256(convert_to(sample.raw_output,'UTF8')),'hex')
 OR NOT EXISTS(SELECT 1 FROM administrator_users WHERE user_id=NEW.created_by AND NOT disabled)
 OR NOT EXISTS(SELECT 1 FROM model_executions WHERE id=sample.execution_id AND status='SUCCEEDED')
 THEN RAISE EXCEPTION 'Invalid Pelican preview revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pelican_preview_revision_evidence BEFORE INSERT OR UPDATE OR DELETE
 ON pelican_preview_revisions FOR EACH ROW EXECUTE FUNCTION preserve_pelican_preview_revision();
CREATE VIEW pelican_effective_samples AS
 SELECT s.id,s.batch_id,s.ordinal,s.model_key,s.model_name,s.config_snapshot,s.request_payload,
 s.rerun_of,s.rerun_request_key,s.execution_id,s.raw_output,s.response_model,s.response_finish_reason,
 CASE WHEN r.id IS NULL THEN s.preview_html ELSE r.preview_html END preview_html,
 COALESCE(r.preview_status,s.preview_status) preview_status,
 CASE WHEN r.id IS NULL THEN s.preview_reason ELSE r.preview_reason END preview_reason,
 COALESCE(r.adapter_version,s.adapter_version) adapter_version,
 CASE WHEN r.id IS NULL THEN s.thumbnail ELSE r.thumbnail END thumbnail,s.created_at
 FROM pelican_samples s LEFT JOIN LATERAL (
 SELECT * FROM pelican_preview_revisions WHERE sample_id=s.id ORDER BY id DESC LIMIT 1
 ) r ON true;
