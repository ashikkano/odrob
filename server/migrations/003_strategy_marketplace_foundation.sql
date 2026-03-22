-- ═════════════════════════════════════════════════════════════════════
-- 003_strategy_marketplace_foundation.sql
-- Foundation for custom strategies, marketplace, channels, and rotation
-- ═════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS strategy_templates (
  id                    TEXT PRIMARY KEY,
  owner_user_address    TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  short_description     TEXT DEFAULT '',
  category              TEXT DEFAULT 'custom',
  type                  TEXT DEFAULT 'custom',
  visibility            TEXT DEFAULT 'private',
  status                TEXT DEFAULT 'draft',
  complexity_score      REAL DEFAULT 0,
  explainability_score  REAL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_templates_owner ON strategy_templates(owner_user_address, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_templates_visibility ON strategy_templates(visibility, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id                       TEXT PRIMARY KEY,
  strategy_template_id     TEXT NOT NULL,
  version_number           INTEGER NOT NULL,
  changelog                TEXT DEFAULT '',
  definition_json          TEXT NOT NULL DEFAULT '{}',
  parameter_schema_json    TEXT NOT NULL DEFAULT '{}',
  trigger_schema_json      TEXT NOT NULL DEFAULT '{}',
  required_channels_json   TEXT NOT NULL DEFAULT '[]',
  runtime_requirements_json TEXT NOT NULL DEFAULT '{}',
  risk_defaults_json       TEXT NOT NULL DEFAULT '{}',
  rotation_defaults_json   TEXT NOT NULL DEFAULT '{}',
  published_at             INTEGER,
  created_at               INTEGER NOT NULL,
  UNIQUE(strategy_template_id, version_number),
  FOREIGN KEY(strategy_template_id) REFERENCES strategy_templates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_strategy_versions_template ON strategy_versions(strategy_template_id, version_number DESC);

CREATE TABLE IF NOT EXISTS strategy_marketplace_listings (
  id                    TEXT PRIMARY KEY,
  strategy_template_id  TEXT NOT NULL UNIQUE,
  current_version_id    TEXT NOT NULL,
  author_user_address   TEXT NOT NULL,
  price_mode            TEXT DEFAULT 'free',
  price_value           REAL,
  install_count         INTEGER DEFAULT 0,
  active_install_count  INTEGER DEFAULT 0,
  fork_count            INTEGER DEFAULT 0,
  review_count          INTEGER DEFAULT 0,
  avg_rating            REAL DEFAULT 0,
  verified_badge        INTEGER DEFAULT 0,
  featured_rank         INTEGER,
  ranking_score         REAL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  FOREIGN KEY(strategy_template_id) REFERENCES strategy_templates(id) ON DELETE CASCADE,
  FOREIGN KEY(current_version_id) REFERENCES strategy_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_strategy_marketplace_rank ON strategy_marketplace_listings(ranking_score DESC, active_install_count DESC, install_count DESC);

CREATE TABLE IF NOT EXISTS agent_strategy_instances (
  id                      TEXT PRIMARY KEY,
  agent_id                TEXT NOT NULL,
  strategy_template_id    TEXT NOT NULL,
  strategy_version_id     TEXT NOT NULL,
  mode                    TEXT DEFAULT 'direct',
  status                  TEXT DEFAULT 'active',
  custom_params_json      TEXT NOT NULL DEFAULT '{}',
  custom_risk_json        TEXT NOT NULL DEFAULT '{}',
  custom_rotation_json    TEXT NOT NULL DEFAULT '{}',
  installed_from_marketplace INTEGER DEFAULT 0,
  installed_by_user       TEXT NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY(strategy_template_id) REFERENCES strategy_templates(id) ON DELETE CASCADE,
  FOREIGN KEY(strategy_version_id) REFERENCES strategy_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_strategy_instances_agent ON agent_strategy_instances(agent_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS signal_channels (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  source_ref            TEXT,
  name                  TEXT NOT NULL,
  description           TEXT DEFAULT '',
  topic_tags_json       TEXT NOT NULL DEFAULT '[]',
  quality_score         REAL DEFAULT 0,
  status                TEXT DEFAULT 'active',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE(channel_type, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_signal_channels_type ON signal_channels(channel_type, status, quality_score DESC);

CREATE TABLE IF NOT EXISTS agent_channel_subscriptions (
  id                    TEXT PRIMARY KEY,
  agent_id              TEXT NOT NULL,
  strategy_instance_id  TEXT,
  channel_id            TEXT NOT NULL,
  subscription_kind     TEXT DEFAULT 'signal',
  source                TEXT DEFAULT 'manual',
  weight                REAL DEFAULT 1,
  priority              INTEGER DEFAULT 0,
  status                TEXT DEFAULT 'active',
  lock_mode             TEXT DEFAULT 'managed',
  subscribed_at         INTEGER NOT NULL,
  subscribed_tick       INTEGER,
  expires_at            INTEGER,
  metadata_json         TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(strategy_instance_id) REFERENCES agent_strategy_instances(id) ON DELETE SET NULL,
  FOREIGN KEY(channel_id) REFERENCES signal_channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_channel_subscriptions_agent ON agent_channel_subscriptions(agent_id, subscription_kind, status, priority DESC);

CREATE TABLE IF NOT EXISTS agent_rotation_policies (
  id                      TEXT PRIMARY KEY,
  agent_id                TEXT NOT NULL UNIQUE,
  strategy_instance_id    TEXT,
  enabled                 INTEGER DEFAULT 1,
  goal_mode               TEXT DEFAULT 'balanced',
  profile_name            TEXT DEFAULT 'balanced',
  interval_ticks          INTEGER DEFAULT 40,
  max_active_channels     INTEGER DEFAULT 4,
  min_channel_lifetime_ticks INTEGER DEFAULT 20,
  churn_budget_per_day    INTEGER DEFAULT 6,
  max_candidate_channels  INTEGER DEFAULT 12,
  score_weights_json      TEXT NOT NULL DEFAULT '{}',
  filters_json            TEXT NOT NULL DEFAULT '{}',
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY(strategy_instance_id) REFERENCES agent_strategy_instances(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_rotation_events (
  id                      TEXT PRIMARY KEY,
  agent_id                TEXT NOT NULL,
  strategy_instance_id    TEXT,
  policy_id               TEXT,
  rotated_out_channel_id  TEXT,
  rotated_in_channel_id   TEXT,
  reason_code             TEXT DEFAULT 'manual',
  before_score            REAL,
  after_score             REAL,
  details_json            TEXT NOT NULL DEFAULT '{}',
  created_at              INTEGER NOT NULL,
  FOREIGN KEY(strategy_instance_id) REFERENCES agent_strategy_instances(id) ON DELETE SET NULL,
  FOREIGN KEY(policy_id) REFERENCES agent_rotation_policies(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_rotation_events_agent ON agent_rotation_events(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_daily_metrics (
  id                    TEXT PRIMARY KEY,
  strategy_template_id  TEXT NOT NULL,
  strategy_version_id   TEXT,
  date_key              TEXT NOT NULL,
  installs              INTEGER DEFAULT 0,
  active_agents         INTEGER DEFAULT 0,
  retained_agents_d7    INTEGER DEFAULT 0,
  retained_agents_d30   INTEGER DEFAULT 0,
  roi_avg               REAL DEFAULT 0,
  pnl_avg               REAL DEFAULT 0,
  win_rate_avg          REAL DEFAULT 0,
  sharpe_like_avg       REAL DEFAULT 0,
  drawdown_avg          REAL DEFAULT 0,
  fill_rate_avg         REAL DEFAULT 0,
  slippage_avg          REAL DEFAULT 0,
  disable_rate          REAL DEFAULT 0,
  churn_rate            REAL DEFAULT 0,
  ranking_score         REAL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE(strategy_template_id, date_key),
  FOREIGN KEY(strategy_template_id) REFERENCES strategy_templates(id) ON DELETE CASCADE,
  FOREIGN KEY(strategy_version_id) REFERENCES strategy_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_daily_metrics_rank ON strategy_daily_metrics(date_key, ranking_score DESC);
