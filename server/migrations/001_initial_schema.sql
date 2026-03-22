-- ═══════════════════════════════════════════════════════════════════════
-- Migration 001: Initial Schema (baseline)
-- This captures the existing schema so new databases get the same structure.
-- For databases that already have these tables, this migration is a no-op
-- (CREATE TABLE IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════

-- Users
CREATE TABLE IF NOT EXISTS users (
  address       TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

-- Wallet login challenges (short-lived nonces)
CREATE TABLE IF NOT EXISTS auth_nonces (
  address       TEXT PRIMARY KEY,
  nonce         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- Browser sessions (server-side)
CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT PRIMARY KEY,
  address       TEXT NOT NULL,
  ua_hash       TEXT,
  ip_hash       TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_address ON auth_sessions(address);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_exp ON auth_sessions(expires_at);

-- TON Wallets
CREATE TABLE IF NOT EXISTS wallets (
  id              TEXT PRIMARY KEY,
  address         TEXT NOT NULL,
  address_bounce  TEXT,
  address_raw     TEXT,
  mnemonic        TEXT NOT NULL,
  public_key      TEXT NOT NULL,
  secret_key      TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

-- Legacy agents from User API
CREATE TABLE IF NOT EXISTS legacy_agents (
  id              TEXT PRIMARY KEY,
  owner_address   TEXT NOT NULL,
  name            TEXT NOT NULL,
  preset          TEXT,
  strategy        TEXT,
  idx             TEXT DEFAULT 'FLOOR',
  icon            TEXT DEFAULT '🤖',
  status          TEXT DEFAULT 'funding',
  wallet_id       TEXT REFERENCES wallets(id),
  wallet_address  TEXT,
  wallet_address_bounce TEXT,
  wallet_public_key TEXT,
  balance         REAL DEFAULT 0,
  initial_balance REAL DEFAULT 0,
  config_json     TEXT DEFAULT '{}',
  risk_params_json TEXT DEFAULT '{}',
  deposits_json   TEXT DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  started_at      INTEGER
);

-- Engine user agents — full state persistence
CREATE TABLE IF NOT EXISTS user_agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  strategy        TEXT NOT NULL,
  strategy_name   TEXT,
  icon            TEXT DEFAULT '🤖',
  bio             TEXT DEFAULT '',
  is_user_agent   INTEGER DEFAULT 1,
  wallet_address  TEXT,
  risk_level      TEXT DEFAULT 'medium',
  status          TEXT DEFAULT 'active',
  virtual_balance REAL NOT NULL DEFAULT 1000,
  initial_balance REAL NOT NULL DEFAULT 1000,
  position        REAL DEFAULT 0,
  position_value  REAL DEFAULT 0,
  avg_entry_price REAL DEFAULT 0,
  pnl             REAL DEFAULT 0,
  realized_pnl    REAL DEFAULT 0,
  unrealized_pnl  REAL DEFAULT 0,
  total_trades    INTEGER DEFAULT 0,
  winning_trades  INTEGER DEFAULT 0,
  losing_trades   INTEGER DEFAULT 0,
  total_volume    REAL DEFAULT 0,
  max_drawdown    REAL DEFAULT 0,
  peak_equity     REAL DEFAULT 1000,
  config_json     TEXT DEFAULT '{}',
  open_orders_json TEXT DEFAULT '[]',
  tick_count      INTEGER DEFAULT 0,
  last_tick_at    INTEGER,
  last_decision_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Agent trades
CREATE TABLE IF NOT EXISTS agent_trades (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  side            TEXT NOT NULL,
  price           REAL NOT NULL,
  size            REAL NOT NULL,
  value           REAL NOT NULL,
  pnl             REAL DEFAULT 0,
  position_after  REAL DEFAULT 0,
  balance_after   REAL DEFAULT 0,
  timestamp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_agent ON agent_trades(agent_id, timestamp DESC);

-- Agent decisions
CREATE TABLE IF NOT EXISTS agent_decisions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  agent_name      TEXT,
  strategy        TEXT,
  action          TEXT NOT NULL,
  price           REAL,
  size            REAL,
  reasoning       TEXT,
  confidence      REAL DEFAULT 0,
  equity          REAL,
  position        REAL,
  timestamp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_agent ON agent_decisions(agent_id, timestamp DESC);

-- Agent equity curve
CREATE TABLE IF NOT EXISTS agent_equity (
  agent_id        TEXT NOT NULL,
  equity          REAL NOT NULL,
  timestamp       INTEGER NOT NULL,
  PRIMARY KEY (agent_id, timestamp)
);

-- Index registry
CREATE TABLE IF NOT EXISTS indexes (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL UNIQUE,
  description     TEXT DEFAULT '',
  formula_id      TEXT NOT NULL,
  icon            TEXT DEFAULT '📊',
  status          TEXT DEFAULT 'active',
  oracle_interval_ms  INTEGER NOT NULL DEFAULT 30000,
  last_oracle_at      INTEGER,
  oracle_price        REAL DEFAULT 0,
  prev_oracle_price   REAL DEFAULT 0,
  band_width_pct      REAL DEFAULT 3.0,
  band_low            REAL DEFAULT 0,
  band_high           REAL DEFAULT 0,
  max_supply          REAL NOT NULL DEFAULT 1000000,
  circulating_supply  REAL DEFAULT 0,
  initial_price       REAL NOT NULL DEFAULT 1.0,
  total_volume        REAL DEFAULT 0,
  total_trades        INTEGER DEFAULT 0,
  holder_count        INTEGER DEFAULT 0,
  treasury_json       TEXT DEFAULT '{}',
  params_json         TEXT DEFAULT '{}',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Index holders
CREATE TABLE IF NOT EXISTS index_holders (
  index_id        TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  holder_type     TEXT DEFAULT 'agent',
  balance         REAL DEFAULT 0,
  avg_entry_price REAL DEFAULT 0,
  realized_pnl    REAL DEFAULT 0,
  total_bought    REAL DEFAULT 0,
  total_sold      REAL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (index_id, agent_id)
);

-- Index trades
CREATE TABLE IF NOT EXISTS index_trades (
  id              TEXT PRIMARY KEY,
  index_id        TEXT NOT NULL,
  buyer_id        TEXT NOT NULL,
  seller_id       TEXT,
  side            TEXT NOT NULL,
  price           REAL NOT NULL,
  size            REAL NOT NULL,
  value           REAL NOT NULL,
  is_mint         INTEGER DEFAULT 0,
  is_burn         INTEGER DEFAULT 0,
  timestamp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_index_trades ON index_trades(index_id, timestamp DESC);

-- Oracle price snapshots
CREATE TABLE IF NOT EXISTS index_oracle_snapshots (
  index_id        TEXT NOT NULL,
  price           REAL NOT NULL,
  formula_inputs_json TEXT DEFAULT '{}',
  band_low        REAL,
  band_high       REAL,
  circulating     REAL,
  holder_count    INTEGER,
  timestamp       INTEGER NOT NULL,
  PRIMARY KEY (index_id, timestamp)
);

-- Agent <-> Index subscriptions
CREATE TABLE IF NOT EXISTS agent_index_subs (
  agent_id        TEXT NOT NULL,
  index_id        TEXT NOT NULL,
  subscribed_at   INTEGER NOT NULL,
  allocation_pct  REAL DEFAULT 10,
  status          TEXT DEFAULT 'active',
  PRIMARY KEY (agent_id, index_id)
);

-- Index event feed
CREATE TABLE IF NOT EXISTS index_feed (
  id              TEXT PRIMARY KEY,
  index_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  severity        TEXT DEFAULT 'info',
  title           TEXT NOT NULL,
  detail_json     TEXT DEFAULT '{}',
  timestamp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_index ON index_feed(index_id, timestamp DESC);

-- LLM Agent Memory
CREATE TABLE IF NOT EXISTS llm_decisions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id            TEXT NOT NULL,
  tick                INTEGER NOT NULL,
  timestamp           INTEGER NOT NULL,
  context_summary     TEXT,
  raw_response        TEXT,
  action              TEXT NOT NULL,
  instrument          TEXT DEFAULT 'MAIN',
  price               REAL,
  size                REAL,
  confidence          REAL,
  reasoning           TEXT,
  thinking            TEXT,
  outcome_pnl         REAL,
  outcome_tag         TEXT,
  outcome_evaluated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_llm_dec_agent ON llm_decisions(agent_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS llm_insights (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id            TEXT NOT NULL,
  timestamp           INTEGER NOT NULL,
  type                TEXT NOT NULL,
  content             TEXT NOT NULL,
  relevance_score     REAL DEFAULT 1.0,
  times_used          INTEGER DEFAULT 0,
  last_used_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_llm_ins_agent ON llm_insights(agent_id, relevance_score DESC);

CREATE TABLE IF NOT EXISTS llm_learned_patterns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id            TEXT NOT NULL,
  pattern_type        TEXT,
  description         TEXT,
  conditions_json     TEXT,
  success_rate        REAL DEFAULT 0,
  sample_size         INTEGER DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_pat_agent ON llm_learned_patterns(agent_id, success_rate DESC);

-- System State — Key/Value store
CREATE TABLE IF NOT EXISTS system_state (
  key             TEXT PRIMARY KEY,
  value_json      TEXT NOT NULL DEFAULT '{}',
  updated_at      INTEGER NOT NULL
);
