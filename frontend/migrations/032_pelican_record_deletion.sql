-- Private test-record removal is audited separately from immutable generation and billing evidence.
CREATE TABLE pelican_batch_deletions (
 batch_id text PRIMARY KEY REFERENCES pelican_batches(id),
 deleted_by text NOT NULL REFERENCES administrator_users(user_id),
 deleted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION preserve_pelican_batch_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS (
  SELECT 1 FROM pelican_batches b
  JOIN administrator_users a ON a.user_id=NEW.deleted_by
  WHERE b.id=NEW.batch_id AND b.owner_user_id=NEW.deleted_by
   AND b.status IN ('DRAFT','COMPLETE') AND NOT a.disabled
   AND NOT EXISTS (
    SELECT 1 FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id
    WHERE s.batch_id=b.id AND m.status='PENDING'
   )
 ) THEN RAISE EXCEPTION 'Invalid Pelican batch deletion audit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pelican_batch_deletion_audit BEFORE INSERT OR UPDATE OR DELETE
 ON pelican_batch_deletions FOR EACH ROW EXECUTE FUNCTION preserve_pelican_batch_deletion();
