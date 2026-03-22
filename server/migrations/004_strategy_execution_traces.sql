CREATE TABLE IF NOT EXISTS strategy_execution_events (
  id TEXT PRIMARY KEY,
  strategy_instance_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  strategy_template_id TEXT NOT NULL,
  strategy_version_id TEXT NOT NULL,
  index_id TEXT,
  mode TEXT NOT NULL DEFAULT 'direct',
  outcome TEXT NOT NULL DEFAULT 'fallback',
  matched_rule_ids_json TEXT NOT NULL DEFAULT '[]',
  signal_count INTEGER NOT NULL DEFAULT 0,
  signals_json TEXT NOT NULL DEFAULT '[]',
  context_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (strategy_instance_id) REFERENCES agent_strategy_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_template_id) REFERENCES strategy_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_version_id) REFERENCES strategy_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_strategy_execution_events_agent_created
  ON strategy_execution_events(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_execution_events_instance_created
  ON strategy_execution_events(strategy_instance_id, created_at DESC);