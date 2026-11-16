-- NULL preserves historical classification fallback; explicit empty metadata stays empty.
CREATE FUNCTION prompt_descriptor_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE tag jsonb; purpose jsonb;
BEGIN
  IF jsonb_typeof(value)<>'object' OR NOT value ?& ARRAY['purposes','tags']
    OR value - 'purposes' - 'tags' <> '{}'::jsonb
    OR jsonb_typeof(value->'purposes')<>'array' OR jsonb_typeof(value->'tags')<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'purposes')>6 OR jsonb_array_length(value->'tags')>12 THEN RETURN false; END IF;
  FOR purpose IN SELECT * FROM jsonb_array_elements(value->'purposes') LOOP
    IF jsonb_typeof(purpose)<>'string' OR NOT (purpose #>> '{}')=ANY(ARRAY['create','understand','analyze','plan','build','improve']) THEN RETURN false; END IF;
  END LOOP;
  FOR tag IN SELECT * FROM jsonb_array_elements(value->'tags') LOOP
    IF jsonb_typeof(tag)<>'string' OR length(btrim(tag #>> '{}')) NOT BETWEEN 1 AND 40
      OR (tag #>> '{}') ~ '[[:cntrl:]<>]' OR (tag #>> '{}') ~* 'https?://|www\.' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END; $$;
ALTER TABLE prompts ADD COLUMN descriptor jsonb CHECK(descriptor IS NULL OR prompt_descriptor_valid(descriptor));
ALTER TABLE community_publications ADD COLUMN purposes text[] CHECK(purposes IS NULL OR (cardinality(purposes)<=6 AND array_position(purposes,NULL) IS NULL AND purposes <@ ARRAY['create','understand','analyze','plan','build','improve']::text[]));
-- New snapshots preserve the author's exact purposes alongside their per-version consent.
ALTER TABLE community_versions ADD COLUMN purposes text[] CHECK(purposes IS NULL OR (cardinality(purposes)<=6 AND array_position(purposes,NULL) IS NULL AND purposes <@ ARRAY['create','understand','analyze','plan','build','improve']::text[]));
CREATE INDEX community_publication_purposes ON community_publications USING gin(purposes) WHERE status='PUBLISHED';
CREATE INDEX community_version_tags ON community_versions USING gin(tags);
CREATE OR REPLACE FUNCTION community_publication_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.creator_id IS DISTINCT FROM OLD.creator_id OR NEW.first_published_at IS DISTINCT FROM OLD.first_published_at OR NEW.consent_snapshot IS DISTINCT FROM OLD.consent_snapshot THEN RAISE EXCEPTION 'Publication identity and consent are immutable'; END IF;
  IF NEW.current_version NOT IN (OLD.current_version,OLD.current_version+1) THEN RAISE EXCEPTION 'Publication versions must advance sequentially'; END IF;
  IF NEW.purposes IS DISTINCT FROM OLD.purposes AND NEW.current_version<>OLD.current_version+1 THEN RAISE EXCEPTION 'Purpose changes require a newly consented version'; END IF;
  RETURN NEW;
END; $$;
