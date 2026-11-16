-- Fixed-task executions are independent from private Prompt / Playground records.
ALTER TABLE model_executions DROP CONSTRAINT model_executions_purpose_check;
ALTER TABLE model_executions ADD CONSTRAINT model_executions_purpose_check CHECK (purpose IN
 ('PROMPT_GENERATION','OPTIMIZATION','PLAYGROUND','EVALUATION_ADVICE','EVALUATION_REPORT','PELICAN_TEST'));
ALTER TABLE model_executions DROP CONSTRAINT model_executions_check1;
ALTER TABLE model_executions ADD CONSTRAINT model_executions_check1 CHECK (
 status<>'SUCCEEDED' OR (
   output_text IS NOT NULL AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL
   AND total_tokens IS NOT NULL AND latency_ms IS NOT NULL AND completed_at IS NOT NULL
   AND error_code IS NULL AND error_message IS NULL
   AND (purpose='PELICAN_TEST' OR (resolved_model IS NOT NULL AND prompt_id IS NOT NULL AND prompt_version_id IS NOT NULL))
 ));
CREATE TABLE pelican_batches (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL REFERENCES administrator_users(user_id),
 request_key text NOT NULL,
 identity_sha256 text NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
 challenge_version text NOT NULL CHECK(challenge_version='pelican-svg-v1'),
 prompt_text text NOT NULL CHECK(prompt_text='创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画'),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','RUNNING','COMPLETE','PUBLISHED','WITHDRAWN')),
 created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz,
 withdrawn_at timestamptz,
 withdrawal_reason text CHECK(length(withdrawal_reason) BETWEEN 1 AND 500),
 UNIQUE(owner_user_id,request_key)
);
CREATE TABLE pelican_samples (
 id text PRIMARY KEY,
 batch_id text NOT NULL REFERENCES pelican_batches(id),
 ordinal integer NOT NULL CHECK(ordinal>0),
 model_key text NOT NULL,
 model_name text NOT NULL,
 config_snapshot jsonb NOT NULL,
 request_payload jsonb NOT NULL,
 rerun_of text REFERENCES pelican_samples(id),
 rerun_request_key text,
 execution_id text UNIQUE REFERENCES model_executions(id),
 raw_output text CHECK(length(raw_output)<=200000),
 response_model text,
 response_finish_reason text,
 preview_html text CHECK(length(preview_html)<=200000),
 preview_status text NOT NULL DEFAULT 'PENDING' CHECK(preview_status IN ('PENDING','READY','STATIC','INVALID','BLOCKED','UNSUPPORTED','TRUNCATED')),
 preview_reason text,
 adapter_version text,
 thumbnail bytea,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,ordinal), UNIQUE(batch_id,rerun_request_key),
 CHECK((rerun_of IS NULL)=(rerun_request_key IS NULL))
);
CREATE INDEX pelican_published ON pelican_batches(published_at DESC,id) WHERE status='PUBLISHED';
CREATE INDEX pelican_samples_batch ON pelican_samples(batch_id,ordinal);
CREATE FUNCTION preserve_pelican_sample() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.id IS DISTINCT FROM NEW.id OR OLD.created_at IS DISTINCT FROM NEW.created_at
 OR OLD.batch_id IS DISTINCT FROM NEW.batch_id OR OLD.model_key IS DISTINCT FROM NEW.model_key
 OR OLD.model_name IS DISTINCT FROM NEW.model_name OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
 OR OLD.config_snapshot IS DISTINCT FROM NEW.config_snapshot OR OLD.request_payload IS DISTINCT FROM NEW.request_payload
 OR OLD.rerun_of IS DISTINCT FROM NEW.rerun_of OR OLD.rerun_request_key IS DISTINCT FROM NEW.rerun_request_key
 OR (OLD.execution_id IS NOT NULL AND OLD.execution_id IS DISTINCT FROM NEW.execution_id)
 OR (OLD.raw_output IS NOT NULL AND OLD.raw_output IS DISTINCT FROM NEW.raw_output)
 OR ((OLD.raw_output IS NOT NULL OR OLD.adapter_version IS NOT NULL) AND (
   OLD.response_model IS DISTINCT FROM NEW.response_model OR OLD.response_finish_reason IS DISTINCT FROM NEW.response_finish_reason))
 OR (OLD.adapter_version IS NOT NULL AND (
   OLD.preview_html IS DISTINCT FROM NEW.preview_html OR OLD.preview_status IS DISTINCT FROM NEW.preview_status
   OR OLD.preview_reason IS DISTINCT FROM NEW.preview_reason OR OLD.thumbnail IS DISTINCT FROM NEW.thumbnail
   OR OLD.adapter_version IS DISTINCT FROM NEW.adapter_version))
 THEN RAISE EXCEPTION 'Pelican sample evidence is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pelican_sample_immutable BEFORE UPDATE OR DELETE ON pelican_samples FOR EACH ROW EXECUTE FUNCTION preserve_pelican_sample();
CREATE FUNCTION preserve_pelican_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.purpose='PELICAN_TEST' THEN RAISE EXCEPTION 'Pelican execution evidence is immutable' USING ERRCODE='23514'; END IF;
   RETURN OLD;
 END IF;
 IF OLD.purpose='PELICAN_TEST' AND (
 OLD.id IS DISTINCT FROM NEW.id OR OLD.execution_mode IS DISTINCT FROM NEW.execution_mode
 OR OLD.input_sha256 IS DISTINCT FROM NEW.input_sha256 OR OLD.model_policy_version IS DISTINCT FROM NEW.model_policy_version
 OR OLD.dispatched_messages_sha256 IS DISTINCT FROM NEW.dispatched_messages_sha256
 OR OLD.request_identity_sha256 IS DISTINCT FROM NEW.request_identity_sha256
 OR OLD.purpose IS DISTINCT FROM NEW.purpose OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
 OR OLD.provider IS DISTINCT FROM NEW.provider OR OLD.requested_model IS DISTINCT FROM NEW.requested_model
 OR OLD.product_version IS DISTINCT FROM NEW.product_version OR OLD.requested_strength IS DISTINCT FROM NEW.requested_strength
 OR OLD.output_token_limit IS DISTINCT FROM NEW.output_token_limit OR OLD.reasoning_token_reserve IS DISTINCT FROM NEW.reasoning_token_reserve
 OR OLD.prompt_id IS DISTINCT FROM NEW.prompt_id OR OLD.prompt_version_id IS DISTINCT FROM NEW.prompt_version_id
 OR OLD.created_at IS DISTINCT FROM NEW.created_at
 OR (OLD.status<>'PENDING' AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.output_text IS DISTINCT FROM NEW.output_text
 OR OLD.resolved_model IS DISTINCT FROM NEW.resolved_model OR OLD.finish_reason IS DISTINCT FROM NEW.finish_reason
 OR OLD.prompt_tokens IS DISTINCT FROM NEW.prompt_tokens OR OLD.completion_tokens IS DISTINCT FROM NEW.completion_tokens
 OR OLD.total_tokens IS DISTINCT FROM NEW.total_tokens OR OLD.provider_request_id IS DISTINCT FROM NEW.provider_request_id
 OR OLD.prompt_cache_hit_tokens IS DISTINCT FROM NEW.prompt_cache_hit_tokens
 OR OLD.prompt_cache_miss_tokens IS DISTINCT FROM NEW.prompt_cache_miss_tokens
 OR OLD.reasoning_tokens IS DISTINCT FROM NEW.reasoning_tokens OR OLD.system_fingerprint IS DISTINCT FROM NEW.system_fingerprint
 OR OLD.latency_ms IS DISTINCT FROM NEW.latency_ms OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
 OR OLD.error_code IS DISTINCT FROM NEW.error_code OR OLD.error_message IS DISTINCT FROM NEW.error_message)))
 THEN RAISE EXCEPTION 'Pelican execution evidence is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pelican_execution_immutable BEFORE UPDATE OR DELETE ON model_executions FOR EACH ROW EXECUTE FUNCTION preserve_pelican_execution();
CREATE FUNCTION preserve_pelican_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.id IS DISTINCT FROM NEW.id OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR OLD.request_key IS DISTINCT FROM NEW.request_key
 OR OLD.identity_sha256 IS DISTINCT FROM NEW.identity_sha256 OR OLD.title IS DISTINCT FROM NEW.title
 OR OLD.challenge_version IS DISTINCT FROM NEW.challenge_version OR OLD.prompt_text IS DISTINCT FROM NEW.prompt_text
 OR OLD.created_at IS DISTINCT FROM NEW.created_at OR (OLD.published_at IS NOT NULL AND OLD.published_at IS DISTINCT FROM NEW.published_at)
 THEN RAISE EXCEPTION 'Pelican batch identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pelican_batch_immutable BEFORE UPDATE OR DELETE ON pelican_batches FOR EACH ROW EXECUTE FUNCTION preserve_pelican_batch();
