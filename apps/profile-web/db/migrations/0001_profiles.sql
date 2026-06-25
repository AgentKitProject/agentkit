CREATE TABLE IF NOT EXISTS profiles (
  user_id text PRIMARY KEY,
  email text,
  display_name text,
  handle text,
  avatar_initials text,
  bio text,
  website_url text,
  verified boolean NOT NULL DEFAULT false,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_handle_lower_uniq ON profiles (lower(handle)) WHERE handle IS NOT NULL;
