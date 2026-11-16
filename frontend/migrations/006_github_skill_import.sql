-- Extend source provenance, never enable execution or weaken 005 snapshots.
ALTER TABLE skill_import_jobs DROP CONSTRAINT skill_import_jobs_operation_check;
ALTER TABLE skill_import_jobs DROP CONSTRAINT skill_import_jobs_source_snapshot_check;
ALTER TABLE skill_import_jobs ADD COLUMN lease_token text;
ALTER TABLE skill_import_jobs ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE skill_import_jobs ADD COLUMN resolved_source jsonb;
ALTER TABLE skill_import_jobs ADD CONSTRAINT skill_import_operation_source CHECK (
  (operation='OFFLINE_IMPORT' AND source_snapshot->>'kind'='OFFLINE'
    AND lease_token IS NULL AND lease_expires_at IS NULL AND resolved_source IS NULL)
  OR (operation='GITHUB_IMPORT' AND source_snapshot->>'kind'='GITHUB'
    AND lease_token IS NOT NULL AND lease_token ~ '^[a-f0-9-]{36}$'
    AND lease_expires_at IS NOT NULL AND lease_expires_at > created_at
    AND (resolved_source IS NULL OR resolved_source->>'kind'='GITHUB'))
);
ALTER TABLE skill_versions DROP CONSTRAINT skill_versions_profile_check;
ALTER TABLE skill_versions DROP CONSTRAINT skill_versions_source_snapshot_check;
ALTER TABLE skill_versions ADD CONSTRAINT skill_version_profile_source CHECK (
  (profile='opc-offline-text-v1' AND source_snapshot->>'kind'='OFFLINE') OR
  (profile='opc-github-text-v1' AND source_snapshot->>'kind'='GITHUB'
    AND source_snapshot ?& ARRAY['repositoryId','repositoryOwner','repositoryName','path','ref','approvalId','commitSha','rootTreeSha','skillTreeSha']
    AND source_snapshot->>'commitSha' ~ '^[a-f0-9]{40}$'
    AND source_snapshot->>'rootTreeSha' ~ '^[a-f0-9]{40}$'
    AND source_snapshot->>'skillTreeSha' ~ '^[a-f0-9]{40}$')
);
ALTER TABLE skill_version_reviews DROP CONSTRAINT skill_version_reviews_reason_code_check;
ALTER TABLE skill_version_reviews ADD CONSTRAINT skill_review_pending_reason CHECK (
  reason_code IN ('OFFLINE_SOURCE_UNVERIFIED','GITHUB_CONTENT_UNREVIEWED')
);
CREATE INDEX github_import_lease_lookup ON skill_import_jobs (owner_user_id,lease_expires_at)
  WHERE operation='GITHUB_IMPORT' AND status='RECEIVED';

CREATE OR REPLACE FUNCTION validate_skill_version_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j skill_import_jobs;
BEGIN
  SELECT * INTO STRICT j FROM skill_import_jobs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.import_job_id FOR UPDATE;
  IF j.status IS DISTINCT FROM 'RECEIVED' THEN RAISE EXCEPTION 'SKILL_JOB_SEALED' USING ERRCODE='23514'; END IF;
  IF (j.operation='OFFLINE_IMPORT' AND (NEW.profile<>'opc-offline-text-v1' OR NEW.source_snapshot IS DISTINCT FROM j.source_snapshot))
    OR (j.operation='GITHUB_IMPORT' AND (NEW.profile<>'opc-github-text-v1'
      OR j.lease_expires_at <= clock_timestamp()
      OR (NEW.source_snapshot - ARRAY['commitSha','rootTreeSha','skillTreeSha']) IS DISTINCT FROM j.source_snapshot
      OR (NEW.manifest_text::jsonb->'source') IS DISTINCT FROM NEW.source_snapshot
      OR NEW.manifest_text::jsonb->>'profile' <> NEW.profile))
  THEN RAISE EXCEPTION 'SKILL_SOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_skill_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v skill_versions;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'RECEIVED' OR NEW.resolved_source IS NOT NULL THEN RAISE EXCEPTION 'SKILL_JOB_INITIAL_STATE' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SKILL_JOB_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF OLD.status <> 'RECEIVED' OR NEW.status NOT IN ('REGISTERED','FAILED') OR
    (to_jsonb(NEW) - ARRAY['status','version_id','manifest_sha256','error_code','completed_at','resolved_source']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','version_id','manifest_sha256','error_code','completed_at','resolved_source'])
  THEN RAISE EXCEPTION 'SKILL_JOB_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.status='REGISTERED' THEN
    SELECT * INTO STRICT v FROM skill_versions WHERE owner_user_id=NEW.owner_user_id AND id=NEW.version_id;
    IF v.manifest_sha256 <> NEW.manifest_sha256 OR
      (SELECT count(*) FROM skill_resources WHERE owner_user_id=v.owner_user_id AND version_id=v.id) <> jsonb_array_length(v.manifest_text::jsonb->'files') OR
      NOT EXISTS (SELECT 1 FROM skill_resources WHERE owner_user_id=v.owner_user_id AND version_id=v.id AND path='SKILL.md' AND resource_type='MAIN' AND sha256=v.main_sha256) OR
      NOT EXISTS (SELECT 1 FROM skill_version_reviews WHERE owner_user_id=v.owner_user_id AND version_id=v.id)
    THEN RAISE EXCEPTION 'SKILL_REGISTRATION_INCOMPLETE' USING ERRCODE='23514'; END IF;
    IF NEW.operation='GITHUB_IMPORT' AND (NEW.lease_expires_at <= clock_timestamp() OR NEW.resolved_source IS NULL
      OR NEW.resolved_source IS DISTINCT FROM v.source_snapshot
      OR v.profile<>'opc-github-text-v1'
      OR (NEW.resolved_source - ARRAY['commitSha','rootTreeSha','skillTreeSha']) IS DISTINCT FROM NEW.source_snapshot)
    THEN RAISE EXCEPTION 'SKILL_SOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
    IF NEW.operation='OFFLINE_IMPORT' AND (v.profile<>'opc-offline-text-v1' OR v.source_snapshot IS DISTINCT FROM NEW.source_snapshot)
    THEN RAISE EXCEPTION 'SKILL_SOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status='FAILED' AND (NEW.resolved_source IS NOT NULL OR EXISTS (SELECT 1 FROM skill_versions WHERE owner_user_id=NEW.owner_user_id AND import_job_id=NEW.id))
  THEN RAISE EXCEPTION 'SKILL_FAILED_IMPORT_HAS_VERSION' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
