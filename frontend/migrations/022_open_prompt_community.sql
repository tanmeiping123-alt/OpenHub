-- Community identities and snapshots deliberately do not reuse private prompt DTOs.
CREATE TABLE community_creators (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE RESTRICT,
  display_name text NOT NULL DEFAULT '' CHECK(length(display_name)<=80),
  bio text NOT NULL DEFAULT '' CHECK(length(bio)<=500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE community_publications (
  id text PRIMARY KEY,
  creator_id text NOT NULL REFERENCES community_creators(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PUBLISHED' CHECK(status IN ('PUBLISHED','WITHDRAWN','REMOVED')),
  removed_from_status text CHECK(removed_from_status IN ('PUBLISHED','WITHDRAWN')),
  current_version integer NOT NULL CHECK(current_version>0),
  first_published_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  consent_snapshot jsonb NOT NULL CHECK(jsonb_typeof(consent_snapshot)='object' AND consent_snapshot @> '{"license":"CC0-1.0","accepted":true,"rightsConfirmed":true}'::jsonb)
);
CREATE TABLE community_versions (
  public_id text NOT NULL REFERENCES community_publications(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK(version_number>0),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
  summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 1000),
  task_type text NOT NULL CHECK(task_type IN ('Coding','UI/UX Design','Writing','Data Analysis','Business','Research','AI Agent','General')),
  language text NOT NULL CHECK(language IN ('zh-CN','en','other')),
  tags text[] NOT NULL DEFAULT '{}',
  content text NOT NULL CHECK(length(content) BETWEEN 1 AND 200000),
  variables text NOT NULL DEFAULT '', model_notes text NOT NULL DEFAULT '',
  example_input text NOT NULL DEFAULT '', example_output text NOT NULL DEFAULT '', usage_notes text NOT NULL DEFAULT '',
  change_note text NOT NULL DEFAULT '', content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  license text NOT NULL DEFAULT 'CC0-1.0' CHECK(license='CC0-1.0'),
  consent_snapshot jsonb NOT NULL CHECK(jsonb_typeof(consent_snapshot)='object' AND consent_snapshot @> '{"license":"CC0-1.0","accepted":true,"rightsConfirmed":true}'::jsonb),
  source_version_id text,
  origin_public_id text, origin_version integer, origin_title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(public_id,version_number),
  CHECK((origin_public_id IS NULL AND origin_version IS NULL AND origin_title IS NULL) OR (origin_public_id IS NOT NULL AND origin_version>0 AND origin_title IS NOT NULL)),
  FOREIGN KEY(origin_public_id,origin_version) REFERENCES community_versions(public_id,version_number) ON DELETE RESTRICT
);
ALTER TABLE community_publications ADD CONSTRAINT community_current_version_fk FOREIGN KEY(id,current_version) REFERENCES community_versions(public_id,version_number) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE community_stars (
  id text PRIMARY KEY, public_id text NOT NULL REFERENCES community_publications(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true, excluded boolean NOT NULL DEFAULT false,
  first_starred_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(public_id,actor_id)
);
CREATE INDEX community_stars_counts ON community_stars(public_id,first_starred_at) WHERE active AND NOT excluded;
CREATE INDEX community_stars_actor ON community_stars(actor_id,public_id) WHERE active;
CREATE TABLE community_copy_sources (
  prompt_id text PRIMARY KEY, owner_user_id text NOT NULL,
  copied_version_id text NOT NULL,
  public_id text NOT NULL, version_number integer NOT NULL,
  title text NOT NULL, content_hash text NOT NULL, license text NOT NULL CHECK(license='CC0-1.0'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(prompt_id,owner_user_id) REFERENCES prompts(id,owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY(prompt_id,copied_version_id) REFERENCES prompt_versions(prompt_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(public_id,version_number) REFERENCES community_versions(public_id,version_number) ON DELETE RESTRICT
);
CREATE TABLE community_receipts (
  actor_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  operation text NOT NULL, request_key text NOT NULL, payload_hash text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,operation,request_key)
);
CREATE TABLE community_write_limits (
  actor_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  operation text NOT NULL, bucket timestamptz NOT NULL, used integer NOT NULL CHECK(used>0),
  PRIMARY KEY(actor_id,operation,bucket)
);
CREATE TABLE community_reports (
  id text PRIMARY KEY, public_id text NOT NULL REFERENCES community_publications(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK(category IN ('privacy','rights','spam','other')),
  detail text NOT NULL CHECK(length(detail) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','DISMISSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE community_events (
  id text PRIMARY KEY, public_id text REFERENCES community_publications(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  action text NOT NULL, reason text NOT NULL,
  report_id text REFERENCES community_reports(id) ON DELETE RESTRICT,
  star_id text REFERENCES community_stars(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_publications_creator ON community_publications(creator_id,status,first_published_at DESC,id);
CREATE INDEX community_publications_listing ON community_publications(status,first_published_at DESC,id);
CREATE INDEX community_reports_review ON community_reports(created_at DESC,id);
CREATE OR REPLACE FUNCTION community_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Community snapshot/audit records are immutable'; END; $$;
CREATE TRIGGER community_versions_immutable BEFORE UPDATE OR DELETE ON community_versions FOR EACH ROW EXECUTE FUNCTION community_immutable_record();
CREATE TRIGGER community_copy_sources_immutable BEFORE UPDATE OR DELETE ON community_copy_sources FOR EACH ROW EXECUTE FUNCTION community_immutable_record();
CREATE TRIGGER community_receipts_immutable BEFORE UPDATE OR DELETE ON community_receipts FOR EACH ROW EXECUTE FUNCTION community_immutable_record();
CREATE TRIGGER community_events_immutable BEFORE UPDATE OR DELETE ON community_events FOR EACH ROW EXECUTE FUNCTION community_immutable_record();
CREATE OR REPLACE FUNCTION community_star_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Star first-time records must be retained'; END IF;
  IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.public_id IS DISTINCT FROM OLD.public_id OR NEW.first_starred_at IS DISTINCT FROM OLD.first_starred_at) THEN RAISE EXCEPTION 'Star identity and first time are immutable'; END IF;
  IF EXISTS(SELECT 1 FROM community_publications p JOIN community_creators c ON c.id=p.creator_id WHERE p.id=NEW.public_id AND c.owner_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Self Star is forbidden'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER community_star_integrity BEFORE INSERT OR UPDATE OR DELETE ON community_stars FOR EACH ROW EXECUTE FUNCTION community_star_integrity();
CREATE OR REPLACE FUNCTION community_publication_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.creator_id IS DISTINCT FROM OLD.creator_id OR NEW.first_published_at IS DISTINCT FROM OLD.first_published_at OR NEW.consent_snapshot IS DISTINCT FROM OLD.consent_snapshot THEN RAISE EXCEPTION 'Publication identity and consent are immutable'; END IF;
  IF NEW.current_version NOT IN (OLD.current_version,OLD.current_version+1) THEN RAISE EXCEPTION 'Publication versions must advance sequentially'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER community_publication_integrity BEFORE UPDATE ON community_publications FOR EACH ROW EXECUTE FUNCTION community_publication_integrity();
