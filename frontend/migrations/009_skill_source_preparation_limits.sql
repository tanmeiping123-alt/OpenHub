-- Reserve attempts before network work; failed preparations count too.
CREATE TABLE skill_source_preparation_limits (
  owner_user_id text PRIMARY KEY REFERENCES app_users(id),
  attempts integer NOT NULL CHECK (attempts > 0),
  window_start timestamptz NOT NULL DEFAULT clock_timestamp()
);
