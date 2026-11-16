-- Derived previews may be repaired after publication without touching the immutable
-- original output. New revisions stay append-only; raw hash, adapter version, admin and
-- successful execution are still enforced. Remove the batch-status restriction so a
-- broken renderer can be fixed for already-published or withdrawn works too.
CREATE OR REPLACE FUNCTION preserve_pelican_preview_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sample pelican_samples;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Pelican preview revisions are immutable' USING ERRCODE='23514'; END IF;
 SELECT s.* INTO sample FROM pelican_samples s WHERE s.id=NEW.sample_id;
 IF sample.raw_output IS NULL OR sample.adapter_version IS NULL
 OR NEW.adapter_version=sample.adapter_version
 OR NEW.raw_sha256<>encode(sha256(convert_to(sample.raw_output,'UTF8')),'hex')
 OR NOT EXISTS(SELECT 1 FROM administrator_users WHERE user_id=NEW.created_by AND NOT disabled)
 OR NOT EXISTS(SELECT 1 FROM model_executions WHERE id=sample.execution_id AND status='SUCCEEDED')
 THEN RAISE EXCEPTION 'Invalid Pelican preview revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
