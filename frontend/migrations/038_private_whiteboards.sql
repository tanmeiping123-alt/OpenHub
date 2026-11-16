CREATE TABLE private_whiteboards (
  owner_user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility = 'PRIVATE'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  scene jsonb NOT NULL DEFAULT '{"elements":[],"appState":{},"files":{}}'::jsonb,
  library_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(scene) = 'object'),
  CHECK (jsonb_typeof(library_items) = 'array')
);
