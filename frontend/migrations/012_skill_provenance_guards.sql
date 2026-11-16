ALTER TABLE prompt_versions ADD CONSTRAINT prompt_version_owner_identity UNIQUE(owner_user_id,id);
ALTER TABLE model_executions ADD CONSTRAINT model_execution_owner_identity UNIQUE(owner_user_id,id);
ALTER TABLE prompt_skill_sources ADD CONSTRAINT source_result_owner FOREIGN KEY(owner_user_id,prompt_version_id) REFERENCES prompt_versions(owner_user_id,id);
ALTER TABLE prompt_skill_sources ADD CONSTRAINT source_plan_owner FOREIGN KEY(owner_user_id,plan_id) REFERENCES skill_workflow_plans(owner_user_id,id);
ALTER TABLE prompt_skill_sources ADD CONSTRAINT source_execution_owner FOREIGN KEY(owner_user_id,model_execution_id) REFERENCES model_executions(owner_user_id,id);
ALTER TABLE skill_model_contexts ADD CONSTRAINT context_execution_owner FOREIGN KEY(owner_user_id,execution_id) REFERENCES model_executions(owner_user_id,id);
CREATE FUNCTION guard_skill_workflow_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow history is immutable'; END IF;
  IF OLD.status<>'RUNNING' OR NEW.id<>OLD.id OR NEW.owner_user_id<>OLD.owner_user_id OR NEW.request_key<>OLD.request_key OR NEW.payload_sha256<>OLD.payload_sha256 OR NEW.plan_id<>OLD.plan_id OR NEW.created_at<>OLD.created_at OR NEW.status NOT IN ('SUCCEEDED','FAILED') OR NEW.completed_at IS NULL THEN RAISE EXCEPTION 'invalid workflow transition'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_run_guard BEFORE UPDATE OR DELETE ON skill_workflow_runs FOR EACH ROW EXECUTE FUNCTION guard_skill_workflow_run();
