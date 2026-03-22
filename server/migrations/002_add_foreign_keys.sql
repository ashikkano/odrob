-- ═══════════════════════════════════════════════════════════════════════
-- Migration 002: Add foreign keys on index_trades, index_holders,
-- index_oracle_snapshots, index_feed, agent_index_subs (DB-001)
--
-- SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so we recreate
-- tables with proper REFERENCES + ON DELETE CASCADE.
--
-- Note: agent_trades and agent_decisions DON'T get FK to user_agents
-- because engine seed agents (non-user) are in-memory only and never
-- persisted to user_agents. FK would break on insert.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. index_trades → indexes ──

CREATE TABLE IF NOT EXISTS index_trades_new (
  id              TEXT PRIMARY KEY,
  index_id        TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
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

INSERT OR IGNORE INTO index_trades_new SELECT * FROM index_trades;
DROP TABLE IF EXISTS index_trades;
ALTER TABLE index_trades_new RENAME TO index_trades;
CREATE INDEX IF NOT EXISTS idx_index_trades ON index_trades(index_id, timestamp DESC);

-- ── 2. index_holders → indexes ──

CREATE TABLE IF NOT EXISTS index_holders_new (
  index_id        TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
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

INSERT OR IGNORE INTO index_holders_new SELECT * FROM index_holders;
DROP TABLE IF EXISTS index_holders;
ALTER TABLE index_holders_new RENAME TO index_holders;

-- ── 3. index_oracle_snapshots → indexes ──

CREATE TABLE IF NOT EXISTS index_oracle_snapshots_new (
  index_id        TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  price           REAL NOT NULL,
  formula_inputs_json TEXT DEFAULT '{}',
  band_low        REAL,
  band_high       REAL,
  circulating     REAL,
  holder_count    INTEGER,
  timestamp       INTEGER NOT NULL,
  PRIMARY KEY (index_id, timestamp)
);

INSERT OR IGNORE INTO index_oracle_snapshots_new SELECT * FROM index_oracle_snapshots;
DROP TABLE IF EXISTS index_oracle_snapshots;
ALTER TABLE index_oracle_snapshots_new RENAME TO index_oracle_snapshots;

-- ── 4. agent_index_subs → indexes ──

CREATE TABLE IF NOT EXISTS agent_index_subs_new (
  agent_id        TEXT NOT NULL,
  index_id        TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  subscribed_at   INTEGER NOT NULL,
  allocation_pct  REAL DEFAULT 10,
  status          TEXT DEFAULT 'active',
  PRIMARY KEY (agent_id, index_id)
);

INSERT OR IGNORE INTO agent_index_subs_new SELECT * FROM agent_index_subs;
DROP TABLE IF EXISTS agent_index_subs;
ALTER TABLE agent_index_subs_new RENAME TO agent_index_subs;

-- ── 5. index_feed → indexes ──

CREATE TABLE IF NOT EXISTS index_feed_new (
  id              TEXT PRIMARY KEY,
  index_id        TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  severity        TEXT DEFAULT 'info',
  title           TEXT NOT NULL,
  detail_json     TEXT DEFAULT '{}',
  timestamp       INTEGER NOT NULL
);

INSERT OR IGNORE INTO index_feed_new SELECT * FROM index_feed;
DROP TABLE IF EXISTS index_feed;
ALTER TABLE index_feed_new RENAME TO index_feed;
CREATE INDEX IF NOT EXISTS idx_feed_index ON index_feed(index_id, timestamp DESC);
