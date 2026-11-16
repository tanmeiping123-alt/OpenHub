-- Follow-up hardening: PostgreSQL CHECK accepts NULL. Make missing/null JSON
-- identity and pinned provenance fail closed without rewriting applied 005/006.
CREATE FUNCTION valid_skill_github_source(s jsonb, resolved boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(s)='object' AND s->>'kind'='GITHUB'
    AND jsonb_typeof(s->'repositoryId')='number'
    AND s->>'repositoryId' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(s->'repositoryOwner')='string' AND s->>'repositoryOwner' ~ '^[a-z0-9][a-z0-9-]{0,38}$'
    AND jsonb_typeof(s->'repositoryName')='string' AND s->>'repositoryName' ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'
    AND jsonb_typeof(s->'path')='string' AND length(s->>'path') BETWEEN 1 AND 160
    AND jsonb_typeof(s->'ref')='string' AND length(s->>'ref') BETWEEN 1 AND 120
    AND jsonb_typeof(s->'approvalId')='string' AND s->>'approvalId' ~ '^[A-Za-z0-9._-]{1,120}$'
    AND s->>'licensePath'='LICENSE'
    AND jsonb_typeof(s->'licenseSha256')='string' AND s->>'licenseSha256' ~ '^[a-f0-9]{64}$'
    AND (NOT resolved OR (
      jsonb_typeof(s->'commitSha')='string' AND s->>'commitSha' ~ '^[a-f0-9]{40}$'
      AND jsonb_typeof(s->'rootTreeSha')='string' AND s->>'rootTreeSha' ~ '^[a-f0-9]{40}$'
      AND jsonb_typeof(s->'skillTreeSha')='string' AND s->>'skillTreeSha' ~ '^[a-f0-9]{40}$'
      AND (s->>'ref' !~ '^[a-f0-9]{40}$' OR s->>'commitSha'=s->>'ref')
    )), false);
$$;

ALTER TABLE skill_import_jobs ADD CONSTRAINT skill_job_source_evidence CHECK (
  COALESCE(jsonb_typeof(source_snapshot)='object' AND (
    (operation='OFFLINE_IMPORT' AND source_snapshot->>'kind'='OFFLINE') OR
    (operation='GITHUB_IMPORT' AND valid_skill_github_source(source_snapshot,false)
      AND (resolved_source IS NULL OR valid_skill_github_source(resolved_source,true)))
  ),false)
);
ALTER TABLE skill_versions ADD CONSTRAINT skill_version_source_evidence CHECK (
  COALESCE(jsonb_typeof(source_snapshot)='object' AND (
    (profile='opc-offline-text-v1' AND source_snapshot->>'kind'='OFFLINE') OR
    (profile='opc-github-text-v1' AND valid_skill_github_source(source_snapshot,true)
      AND manifest_text::jsonb->>'profile'=profile
      AND manifest_text::jsonb->>'mainSha256'=main_sha256
      AND jsonb_typeof(manifest_text::jsonb->'files')='array')
  ),false)
);

CREATE FUNCTION validate_github_registration_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source jsonb;
BEGIN
  IF NEW.operation='GITHUB_IMPORT' AND NEW.status='REGISTERED' THEN
    SELECT source_snapshot INTO STRICT source FROM skill_versions WHERE owner_user_id=NEW.owner_user_id AND id=NEW.version_id;
    IF NOT EXISTS (SELECT 1 FROM skill_resources WHERE owner_user_id=NEW.owner_user_id AND version_id=NEW.version_id
      AND path='references/SOURCE-LICENSE.txt' AND resource_type='REFERENCE'
      AND sha256=source->>'licenseSha256' AND git_blob_sha IS NOT NULL)
      OR EXISTS (SELECT 1 FROM skill_resources WHERE owner_user_id=NEW.owner_user_id AND version_id=NEW.version_id AND git_blob_sha IS NULL)
    THEN RAISE EXCEPTION 'GITHUB_EVIDENCE_INCOMPLETE' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER github_registration_evidence BEFORE UPDATE ON skill_import_jobs
  FOR EACH ROW EXECUTE FUNCTION validate_github_registration_evidence();
