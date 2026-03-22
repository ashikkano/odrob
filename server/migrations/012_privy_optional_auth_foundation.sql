CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  primary_wallet_address TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_users_primary_wallet ON app_users(primary_wallet_address);

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  subject TEXT,
  email TEXT,
  phone TEXT,
  verified_at INTEGER,
  metadata_json TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, provider_user_id, identity_type)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON auth_identities(user_id);

CREATE TABLE IF NOT EXISTS user_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  wallet_kind TEXT NOT NULL,
  wallet_provider TEXT NOT NULL,
  wallet_ref TEXT,
  label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(wallet_address, wallet_provider)
);

CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id ON user_wallets(user_id, created_at DESC);

ALTER TABLE auth_sessions ADD COLUMN user_id TEXT;
ALTER TABLE auth_sessions ADD COLUMN auth_provider TEXT;
ALTER TABLE auth_sessions ADD COLUMN auth_level TEXT;
ALTER TABLE auth_sessions ADD COLUMN active_wallet_address TEXT;
ALTER TABLE auth_sessions ADD COLUMN privy_user_id TEXT;