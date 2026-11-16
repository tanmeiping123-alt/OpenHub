-- A no-change optimization records the explicit Apply decision without creating
-- a duplicate version or attaching new provenance to an old immutable version.
CREATE TABLE optimization_no_change_receipts (
  optimization_id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  prompt_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_user_id,optimization_id) REFERENCES optimization_records(owner_user_id,id),
  FOREIGN KEY(owner_user_id,prompt_version_id) REFERENCES prompt_versions(owner_user_id,id)
);
CREATE TRIGGER optimization_no_change_immutable BEFORE UPDATE OR DELETE ON optimization_no_change_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
