-- External subjects are linked explicitly; matching email alone never claims an
-- existing account or grants an administrator role.
CREATE TABLE account_external_identities (
  provider text NOT NULL CHECK (provider = 'supabase'),
  subject uuid NOT NULL,
  user_id text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);
-- The project uses server-side PostgreSQL only. Public Auth keys must not expose
-- this mapping through the Supabase Data API.
ALTER TABLE account_external_identities ENABLE ROW LEVEL SECURITY;
