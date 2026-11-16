-- Preserve existing identity and immutable source tables. Credentials live only
-- in role-specific account tables; app_users remains the shared owner identity.
ALTER TABLE app_users DROP CONSTRAINT app_users_account_kind_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_account_kind_check CHECK (account_kind IN ('LOCAL_DEMO','ADMIN','USER'));
CREATE TABLE administrator_users (
  user_id text PRIMARY KEY REFERENCES app_users(id),
  email text NOT NULL UNIQUE CHECK (email=lower(email) AND length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE regular_users (LIKE administrator_users INCLUDING ALL);
ALTER TABLE regular_users ADD FOREIGN KEY (user_id) REFERENCES app_users(id);
CREATE FUNCTION validate_role_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
  expected := CASE WHEN TG_TABLE_NAME='administrator_users' THEN 'ADMIN' ELSE 'USER' END;
  IF NOT EXISTS (SELECT 1 FROM app_users WHERE id=NEW.user_id AND account_kind=expected AND identity_key='email:'||NEW.email)
  THEN RAISE EXCEPTION 'ACCOUNT_IDENTITY_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admin_identity BEFORE INSERT OR UPDATE ON administrator_users FOR EACH ROW EXECUTE FUNCTION validate_role_account();
CREATE TRIGGER user_identity BEFORE INSERT OR UPDATE ON regular_users FOR EACH ROW EXECUTE FUNCTION validate_role_account();
CREATE TABLE account_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES app_users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_sessions_owner ON account_sessions(user_id);
CREATE TABLE account_login_limits (
  bucket text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL
);
CREATE TABLE skill_prepared_sources (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id),
  approval jsonb NOT NULL CHECK (jsonb_typeof(approval)='object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER prepared_sources_immutable BEFORE UPDATE OR DELETE ON skill_prepared_sources FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();

CREATE TABLE skill_personal_access (
  version_id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES regular_users(user_id),
  risk_notice_version text NOT NULL CHECK (risk_notice_version='personal-risk-v1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id,version_id) REFERENCES skill_versions(owner_user_id,id)
);
CREATE TABLE skill_library_submissions (
  id text PRIMARY KEY,
  version_id text NOT NULL UNIQUE,
  owner_user_id text NOT NULL REFERENCES regular_users(user_id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewer_id text REFERENCES administrator_users(user_id),
  review_note text CHECK (length(review_note)<=2000),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id,version_id) REFERENCES skill_versions(owner_user_id,id),
  CHECK ((status='PENDING' AND reviewer_id IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
    OR (status<>'PENDING' AND reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(trim(review_note))>0))
);
CREATE TABLE skill_library_entries (
  version_id text PRIMARY KEY REFERENCES skill_versions(id),
  publisher_id text NOT NULL REFERENCES administrator_users(user_id),
  publication_kind text NOT NULL CHECK (publication_kind IN ('ADMIN_IMPORT','REVIEW_APPROVED')),
  submission_id text UNIQUE REFERENCES skill_library_submissions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((publication_kind='ADMIN_IMPORT' AND submission_id IS NULL) OR (publication_kind='REVIEW_APPROVED' AND submission_id IS NOT NULL))
);
CREATE TABLE skill_use_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_users(id),
  version_id text NOT NULL REFERENCES skill_versions(id),
  access_kind text NOT NULL CHECK (access_kind IN ('PERSONAL','LIBRARY')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION validate_skill_library_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SKILL_LIBRARY_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='skill_library_submissions' THEN
    IF TG_OP='INSERT' AND (NEW.status<>'PENDING' OR NOT EXISTS (SELECT 1 FROM skill_personal_access WHERE version_id=NEW.version_id AND owner_user_id=NEW.owner_user_id))
    THEN RAISE EXCEPTION 'PERSONAL_SKILL_REQUIRED' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND (OLD.status<>'PENDING' OR NEW.status='PENDING' OR
      (to_jsonb(NEW)-ARRAY['status','reviewer_id','review_note','reviewed_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','reviewer_id','review_note','reviewed_at']) OR
      NOT EXISTS (SELECT 1 FROM administrator_users WHERE user_id=NEW.reviewer_id AND NOT disabled))
    THEN RAISE EXCEPTION 'REVIEW_TRANSITION_REJECTED' USING ERRCODE='23514'; END IF;
  ELSE
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'SKILL_LIBRARY_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM administrator_users WHERE user_id=NEW.publisher_id AND NOT disabled)
    THEN RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE='23514'; END IF;
    IF NEW.publication_kind='ADMIN_IMPORT' AND NOT EXISTS (SELECT 1 FROM skill_versions WHERE id=NEW.version_id AND owner_user_id=NEW.publisher_id)
    THEN RAISE EXCEPTION 'ADMIN_OWN_IMPORT_REQUIRED' USING ERRCODE='23514'; END IF;
    IF NEW.publication_kind='REVIEW_APPROVED' AND NOT EXISTS (SELECT 1 FROM skill_library_submissions WHERE id=NEW.submission_id AND version_id=NEW.version_id AND reviewer_id=NEW.publisher_id AND status='APPROVED')
    THEN RAISE EXCEPTION 'APPROVED_VERSION_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER library_submissions_validate BEFORE INSERT OR UPDATE OR DELETE ON skill_library_submissions FOR EACH ROW EXECUTE FUNCTION validate_skill_library_change();
CREATE TRIGGER library_entries_validate BEFORE INSERT OR UPDATE OR DELETE ON skill_library_entries FOR EACH ROW EXECUTE FUNCTION validate_skill_library_change();
CREATE TRIGGER personal_access_immutable BEFORE UPDATE OR DELETE ON skill_personal_access FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TRIGGER skill_use_immutable BEFORE UPDATE OR DELETE ON skill_use_events FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
-- Availability is permission to read/adopt text. Script/tool runtime stays disabled.
