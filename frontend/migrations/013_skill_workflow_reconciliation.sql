ALTER TABLE skill_workflow_runs ADD COLUMN execution_id text UNIQUE;
ALTER TABLE skill_workflow_runs ADD CONSTRAINT workflow_execution_owner FOREIGN KEY(owner_user_id,execution_id) REFERENCES model_executions(owner_user_id,id);
CREATE OR REPLACE FUNCTION guard_skill_workflow_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow history is immutable'; END IF;
  IF OLD.status<>'RUNNING' OR NEW.id<>OLD.id OR NEW.owner_user_id<>OLD.owner_user_id OR NEW.request_key<>OLD.request_key OR NEW.payload_sha256<>OLD.payload_sha256 OR NEW.plan_id<>OLD.plan_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'invalid workflow identity'; END IF;
  IF NEW.status='RUNNING' THEN
    IF OLD.execution_id IS NOT NULL OR NEW.execution_id IS NULL OR NEW.result IS DISTINCT FROM OLD.result OR NEW.error_code IS DISTINCT FROM OLD.error_code OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN RAISE EXCEPTION 'invalid workflow execution binding'; END IF;
  ELSE
    IF NEW.status NOT IN ('SUCCEEDED','FAILED') OR NEW.completed_at IS NULL OR NEW.execution_id IS DISTINCT FROM OLD.execution_id THEN RAISE EXCEPTION 'invalid workflow terminal transition'; END IF;
  END IF;
  RETURN NEW;
END $$;
