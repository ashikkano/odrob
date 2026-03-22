-- ═════════════════════════════════════════════════════════════════════
-- 007_normalize_custom_strategy_modes.sql
-- Collapse legacy custom strategy modes to direct-only in persisted data
-- ═════════════════════════════════════════════════════════════════════

UPDATE agent_strategy_instances
SET mode = 'direct'
WHERE COALESCE(mode, 'direct') <> 'direct';

UPDATE strategy_execution_events
SET mode = 'direct'
WHERE COALESCE(mode, 'direct') <> 'direct';

UPDATE user_agents
SET config_json = json_set(COALESCE(NULLIF(config_json, ''), '{}'), '$.strategyMode', 'direct')
WHERE json_type(COALESCE(NULLIF(config_json, ''), '{}'), '$.strategyMode') IS NOT NULL
  AND json_extract(COALESCE(NULLIF(config_json, ''), '{}'), '$.strategyMode') <> 'direct';

UPDATE legacy_agents
SET config_json = json_set(COALESCE(NULLIF(config_json, ''), '{}'), '$.strategyMode', 'direct')
WHERE json_type(COALESCE(NULLIF(config_json, ''), '{}'), '$.strategyMode') IS NOT NULL
  AND json_extract(COALESCE(NULLIF(config_json, ''), '{}'), '$.strategyMode') <> 'direct';