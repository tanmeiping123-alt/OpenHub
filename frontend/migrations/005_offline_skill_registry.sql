-- Stage 13B-1: owner-private OFFLINE snapshots only. No runtime or GitHub fetch.
CREATE TABLE skill_import_jobs (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation = 'OFFLINE_IMPORT'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  source_snapshot jsonb NOT NULL CHECK (source_snapshot->>'kind' = 'OFFLINE'),
  status text NOT NULL CHECK (status IN ('RECEIVED', 'REGISTERED', 'FAILED')),
  version_id text,
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_user_id, id),
  UNIQUE (owner_user_id, operation, idempotency_key),
  CHECK ((status = 'RECEIVED' AND version_id IS NULL AND manifest_sha256 IS NULL AND error_code IS NULL AND completed_at IS NULL)
    OR (status = 'REGISTERED' AND version_id IS NOT NULL AND manifest_sha256 IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL)
    OR (status = 'FAILED' AND version_id IS NULL AND manifest_sha256 IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE skills (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  enabled boolean NOT NULL DEFAULT false CHECK (enabled = false),
  pinned_version_id text,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, id),
  UNIQUE (owner_user_id, source_key)
);

CREATE TABLE skill_versions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  skill_id text NOT NULL,
  import_job_id text NOT NULL,
  profile text NOT NULL CHECK (profile = 'opc-offline-text-v1'),
  parser_version text NOT NULL,
  source_snapshot jsonb NOT NULL CHECK (source_snapshot->>'kind' = 'OFFLINE'),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  body text NOT NULL,
  main_sha256 text NOT NULL CHECK (main_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_text text NOT NULL CHECK (jsonb_typeof(manifest_text::jsonb) = 'object'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 = encode(sha256(convert_to(manifest_text, 'UTF8')), 'hex')),
  warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, id),
  UNIQUE (owner_user_id, skill_id, id),
  UNIQUE (owner_user_id, skill_id, manifest_sha256),
  FOREIGN KEY (owner_user_id, skill_id) REFERENCES skills(owner_user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id, import_job_id) REFERENCES skill_import_jobs(owner_user_id, id) ON DELETE RESTRICT
);
ALTER TABLE skills ADD CONSTRAINT skill_pin_same_owner_and_skill
  FOREIGN KEY (owner_user_id, id, pinned_version_id) REFERENCES skill_versions(owner_user_id, skill_id, id) ON DELETE RESTRICT;
ALTER TABLE skill_import_jobs ADD CONSTRAINT skill_job_version_same_owner
  FOREIGN KEY (owner_user_id, version_id) REFERENCES skill_versions(owner_user_id, id) ON DELETE RESTRICT;

CREATE TABLE skill_resources (
  owner_user_id text NOT NULL,
  version_id text NOT NULL,
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 512),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 131072),
  resource_type text NOT NULL CHECK (resource_type IN ('MAIN','REFERENCE','ASSET','SCRIPT_QUARANTINED')),
  content_text text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 = encode(sha256(convert_to(content_text, 'UTF8')), 'hex')),
  git_blob_sha text CHECK (git_blob_sha ~ '^[a-f0-9]{40}$'),
  quarantined boolean NOT NULL,
  PRIMARY KEY (owner_user_id, version_id, path),
  CHECK (size_bytes = octet_length(content_text)),
  CHECK (quarantined = (resource_type = 'SCRIPT_QUARANTINED')),
  FOREIGN KEY (owner_user_id, version_id) REFERENCES skill_versions(owner_user_id, id) ON DELETE RESTRICT
);

CREATE TABLE skill_version_reviews (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  version_id text NOT NULL,
  status text NOT NULL CHECK (status = 'PENDING_REVIEW'),
  reason_code text NOT NULL CHECK (reason_code = 'OFFLINE_SOURCE_UNVERIFIED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, version_id) REFERENCES skill_versions(owner_user_id, id) ON DELETE RESTRICT
);

CREATE TABLE skill_registry_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  job_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('IMPORT_REGISTERED','IMPORT_FAILED')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, job_id) REFERENCES skill_import_jobs(owner_user_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION reject_skill_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SKILL_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER skill_versions_immutable BEFORE UPDATE OR DELETE ON skill_versions FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TRIGGER skill_resources_immutable BEFORE UPDATE OR DELETE ON skill_resources FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TRIGGER skill_reviews_append_only BEFORE UPDATE OR DELETE ON skill_version_reviews FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TRIGGER skill_events_append_only BEFORE UPDATE OR DELETE ON skill_registry_events FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TRIGGER skills_retire_not_delete BEFORE DELETE ON skills FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();

CREATE FUNCTION validate_skill_version_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j_status text;
BEGIN
  SELECT status INTO j_status FROM skill_import_jobs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.import_job_id FOR UPDATE;
  IF j_status IS DISTINCT FROM 'RECEIVED' THEN RAISE EXCEPTION 'SKILL_JOB_SEALED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_versions_validate BEFORE INSERT ON skill_versions FOR EACH ROW EXECUTE FUNCTION validate_skill_version_insert();

-- Close resource insertion after registration, and bind every row to its manifest entry.
CREATE FUNCTION validate_skill_resource_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v skill_versions; j_status text;
BEGIN
  SELECT * INTO STRICT v FROM skill_versions WHERE owner_user_id=NEW.owner_user_id AND id=NEW.version_id;
  SELECT status INTO j_status FROM skill_import_jobs WHERE owner_user_id=v.owner_user_id AND id=v.import_job_id FOR UPDATE;
  IF j_status <> 'RECEIVED' OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v.manifest_text::jsonb->'files') f
    WHERE f->>'path'=NEW.path AND (f->>'size')::integer=NEW.size_bytes AND f->>'type'=NEW.resource_type AND f->>'sha256'=NEW.sha256
  ) THEN RAISE EXCEPTION 'SKILL_RESOURCE_SEALED_OR_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_resources_validate BEFORE INSERT ON skill_resources FOR EACH ROW EXECUTE FUNCTION validate_skill_resource_insert();

CREATE FUNCTION validate_skill_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v skill_versions;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'RECEIVED' THEN RAISE EXCEPTION 'SKILL_JOB_INITIAL_STATE' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SKILL_JOB_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF OLD.status <> 'RECEIVED' OR NEW.status NOT IN ('REGISTERED','FAILED') OR
    (to_jsonb(NEW) - ARRAY['status','version_id','manifest_sha256','error_code','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','version_id','manifest_sha256','error_code','completed_at'])
  THEN RAISE EXCEPTION 'SKILL_JOB_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.status='REGISTERED' THEN
    SELECT * INTO STRICT v FROM skill_versions WHERE owner_user_id=NEW.owner_user_id AND id=NEW.version_id;
    IF v.manifest_sha256 <> NEW.manifest_sha256 OR
      (SELECT count(*) FROM skill_resources WHERE owner_user_id=v.owner_user_id AND version_id=v.id) <> jsonb_array_length(v.manifest_text::jsonb->'files') OR
      NOT EXISTS (SELECT 1 FROM skill_resources WHERE owner_user_id=v.owner_user_id AND version_id=v.id AND path='SKILL.md' AND resource_type='MAIN' AND sha256=v.main_sha256) OR
      NOT EXISTS (SELECT 1 FROM skill_version_reviews WHERE owner_user_id=v.owner_user_id AND version_id=v.id)
    THEN RAISE EXCEPTION 'SKILL_REGISTRATION_INCOMPLETE' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status='FAILED' AND EXISTS (SELECT 1 FROM skill_versions WHERE owner_user_id=NEW.owner_user_id AND import_job_id=NEW.id)
  THEN RAISE EXCEPTION 'SKILL_FAILED_IMPORT_HAS_VERSION' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_jobs_terminal BEFORE INSERT OR UPDATE OR DELETE ON skill_import_jobs FOR EACH ROW EXECUTE FUNCTION validate_skill_job_transition();
