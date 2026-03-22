CREATE TABLE IF NOT EXISTS strategy_revenue_events (
  id                    TEXT PRIMARY KEY,
  owner_user_address    TEXT NOT NULL,
  strategy_template_id  TEXT NOT NULL,
  strategy_instance_id  TEXT,
  agent_id              TEXT,
  payer_agent_id        TEXT,
  source_index_id       TEXT,
  source_trade_id       TEXT,
  fee_type              TEXT NOT NULL DEFAULT 'trade',
  fee_value             REAL NOT NULL DEFAULT 0,
  protocol_fee_before   REAL NOT NULL DEFAULT 0,
  royalty_rate          REAL NOT NULL DEFAULT 0,
  royalty_amount        REAL NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  FOREIGN KEY(strategy_template_id) REFERENCES strategy_templates(id) ON DELETE CASCADE,
  FOREIGN KEY(strategy_instance_id) REFERENCES agent_strategy_instances(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_strategy_revenue_owner_created
  ON strategy_revenue_events(owner_user_address, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_revenue_template_created
  ON strategy_revenue_events(strategy_template_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_revenue_agent_created
  ON strategy_revenue_events(agent_id, created_at DESC);
