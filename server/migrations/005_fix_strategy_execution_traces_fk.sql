PRAGMA foreign_keys = OFF;

ALTER TABLE strategy_execution_events RENAME TO strategy_execution_events_old;

CREATE TABLE strategy_execution_events (
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

INSERT INTO strategy_execution_events (
  id,
  strategy_instance_id,
  agent_id,
  strategy_template_id,
  strategy_version_id,
  index_id,
  mode,
  outcome,
  matched_rule_ids_json,
  signal_count,
  signals_json,
  context_snapshot_json,
  created_at
)
SELECT
  id,
  strategy_instance_id,
  agent_id,
  strategy_template_id,
  strategy_version_id,
  index_id,
  mode,
  outcome,
  matched_rule_ids_json,
  signal_count,
  signals_json,
  context_snapshot_json,
  created_at
FROM strategy_execution_events_old;

DROP TABLE strategy_execution_events_old;

CREATE INDEX IF NOT EXISTS idx_strategy_execution_events_agent_created
  ON strategy_execution_events(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_execution_events_instance_created
  ON strategy_execution_events(strategy_instance_id, created_at DESC);

PRAGMA foreign_keys = ON;