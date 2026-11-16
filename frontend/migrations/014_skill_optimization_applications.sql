ALTER TABLE optimization_records ADD CONSTRAINT optimization_owner_identity UNIQUE(owner_user_id,id);
CREATE TABLE skill_optimization_applications (
  optimization_id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  prompt_version_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_user_id,optimization_id) REFERENCES optimization_records(owner_user_id,id),
  FOREIGN KEY(owner_user_id,prompt_version_id) REFERENCES prompt_versions(owner_user_id,id)
);
CREATE TRIGGER skill_application_immutable BEFORE UPDATE OR DELETE ON skill_optimization_applications FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
