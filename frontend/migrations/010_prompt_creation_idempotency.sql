CREATE TABLE prompt_creation_requests (
  owner_user_id text NOT NULL REFERENCES app_users(id),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 120),
  payload_sha256 text NOT NULL,
  prompt_id text NOT NULL,
  version_id text NOT NULL REFERENCES prompt_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,request_key),
  FOREIGN KEY(owner_user_id,prompt_id) REFERENCES prompts(owner_user_id,id)
);
