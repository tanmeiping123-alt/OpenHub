-- Operational metadata is separate from immutable generation and billing evidence.
CREATE TABLE pelican_batch_runs (
 batch_id text PRIMARY KEY REFERENCES pelican_batches(id),
 run_epoch text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 error_code text
);
CREATE TABLE pelican_sample_controls (
 sample_id text PRIMARY KEY REFERENCES pelican_samples(id),
 started_at timestamptz,
 stop_requested_at timestamptz,
 stop_requested_by text REFERENCES administrator_users(user_id)
);
CREATE TABLE pelican_sample_deletions (
 sample_id text PRIMARY KEY REFERENCES pelican_samples(id),
 deleted_by text NOT NULL REFERENCES administrator_users(user_id),
 deleted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION preserve_pelican_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS (
  SELECT 1 FROM pelican_samples s JOIN pelican_batches b ON b.id=s.batch_id
  JOIN model_executions m ON m.id=s.execution_id
  JOIN administrator_users a ON a.user_id=NEW.deleted_by
  WHERE s.id=NEW.sample_id AND m.status='FAILED' AND b.status IN ('DRAFT','RUNNING','COMPLETE')
  AND b.owner_user_id=NEW.deleted_by AND NOT a.disabled
 ) THEN RAISE EXCEPTION 'Invalid Pelican visibility audit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pelican_deletion_audit BEFORE INSERT OR UPDATE OR DELETE
 ON pelican_sample_deletions FOR EACH ROW EXECUTE FUNCTION preserve_pelican_deletion();
