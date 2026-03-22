CREATE TABLE IF NOT EXISTS llm_shared_strategy_scopes (
  id                    TEXT PRIMARY KEY,
  scope_key             TEXT NOT NULL UNIQUE,
  strategy_template_id  TEXT NOT NULL,
  owner_user_address    TEXT NOT NULL,
  creator_agent_id      TEXT,
  creator_agent_name    TEXT,
  execution_mode        TEXT NOT NULL DEFAULT 'strategy_scope',
  memory_key            TEXT NOT NULL,
  state_key             TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  subscription_plan_json TEXT NOT NULL DEFAULT '[]',
  metadata_json         TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  last_synced_at        INTEGER,
  FOREIGN KEY(strategy_template_id) REFERENCES strategy_templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_shared_scopes_template_owner
  ON llm_shared_strategy_scopes(strategy_template_id, owner_user_address);

CREATE INDEX IF NOT EXISTS idx_llm_shared_scopes_status_updated
  ON llm_shared_strategy_scopes(status, updated_at DESC);