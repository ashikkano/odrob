// ═══════════════════════════════════════════════════════════════════════
// ODROB Persistence Compatibility Layer
// File-backed SQLite in local mode, in-memory SQLite compatibility store
// when the runtime is switched to PostgreSQL.
// ═══════════════════════════════════════════════════════════════════════

import Database from 'better-sqlite3'
import { dirname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, existsSync } from 'fs'
import { randomBytes, createHash } from 'crypto'
import { runMigrations } from './migrations/runner.js'
import config from './config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = dirname(__dirname)

function resolveSqlitePath(sqlitePath) {
  if (!sqlitePath || sqlitePath === ':memory:') return ':memory:'
  return isAbsolute(sqlitePath)
    ? sqlitePath
    : resolve(ROOT_DIR, sqlitePath)
}

const DB_PATH = resolveSqlitePath(config.db.sqlitePath)

if (DB_PATH !== ':memory:') {
  const dataDir = dirname(DB_PATH)
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
}

// ─── Initialize Database ─────────────────────────────────────────────

const db = new Database(DB_PATH)

// Performance pragmas
db.pragma('journal_mode = WAL')    // Write-Ahead Logging for concurrency
db.pragma('synchronous = NORMAL')  // Good balance of speed & safety
db.pragma('foreign_keys = ON')

console.log(DB_PATH === ':memory:'
  ? '🗄  SQLite compatibility store: in-memory'
  : `🗄  SQLite compatibility store: ${DB_PATH}`)

// ─── Schema ──────────────────────────────────────────────────────────

db.exec(`
  -- Users (replaces users.json)
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
    address       TEXT,
    ua_hash       TEXT,
    ip_hash       TEXT,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_address ON auth_sessions(address);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_exp ON auth_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id                    TEXT PRIMARY KEY,
    actor_label           TEXT NOT NULL,
    role                  TEXT NOT NULL,
    auth_mode             TEXT NOT NULL,
    local_bypass_enabled  INTEGER NOT NULL DEFAULT 0,
    ua_hash               TEXT,
    ip_hash               TEXT,
    created_at            INTEGER NOT NULL,
    expires_at            INTEGER NOT NULL,
    last_seen_at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(expires_at);

  -- TON Wallets (replaces wallets.json)
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

  CREATE TABLE IF NOT EXISTS user_profiles (
    owner_address     TEXT PRIMARY KEY,
    display_name      TEXT,
    username          TEXT,
    registration_mode TEXT NOT NULL DEFAULT 'optional',
    metadata_json     TEXT DEFAULT '{}',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallet_connections (
    id                TEXT PRIMARY KEY,
    owner_address     TEXT,
    wallet_address    TEXT NOT NULL,
    wallet_kind       TEXT NOT NULL,
    wallet_provider   TEXT NOT NULL,
    wallet_ref        TEXT,
    label             TEXT,
    is_primary        INTEGER NOT NULL DEFAULT 0,
    metadata_json     TEXT DEFAULT '{}',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE(wallet_address, wallet_provider)
  );
  CREATE INDEX IF NOT EXISTS idx_wallet_connections_owner ON wallet_connections(owner_address, created_at DESC);

  CREATE TABLE IF NOT EXISTS managed_wallets (
    id                TEXT PRIMARY KEY,
    owner_address     TEXT,
    wallet_id         TEXT REFERENCES wallets(id) ON DELETE CASCADE,
    wallet_address    TEXT NOT NULL,
    provider          TEXT NOT NULL,
    mode              TEXT NOT NULL DEFAULT 'create',
    label             TEXT,
    account_index     INTEGER DEFAULT 0,
    derivation_path   TEXT,
    status            TEXT NOT NULL DEFAULT 'active',
    metadata_json     TEXT DEFAULT '{}',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE(wallet_id)
  );
  CREATE INDEX IF NOT EXISTS idx_managed_wallets_owner ON managed_wallets(owner_address, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_wallets_provider_path
    ON managed_wallets(provider, derivation_path)
    WHERE derivation_path IS NOT NULL;

  -- Legacy agents from User API (replaces agents.json)
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

  -- ═══════════════════════════════════════════════════════════════════
  -- INDEX SYSTEM — Custom indexes with oracle pricing
  -- ═══════════════════════════════════════════════════════════════════

  -- Index registry
  CREATE TABLE IF NOT EXISTS indexes (
    id              TEXT PRIMARY KEY,         -- e.g. 'AI_TRADE'
    name            TEXT NOT NULL,            -- 'AI Trade Index'
    symbol          TEXT NOT NULL UNIQUE,     -- 'AIDX'
    description     TEXT DEFAULT '',
    formula_id      TEXT NOT NULL,            -- key into formula registry
    icon            TEXT DEFAULT '📊',
    status          TEXT DEFAULT 'active',    -- active | paused | delisted
    -- Oracle
    oracle_interval_ms  INTEGER NOT NULL DEFAULT 30000,   -- how often oracle recalculates
    last_oracle_at      INTEGER,
    oracle_price        REAL DEFAULT 0,                    -- last calculated fair price
    prev_oracle_price   REAL DEFAULT 0,                    -- previous oracle price (for change %)
    -- Trading band
    band_width_pct      REAL DEFAULT 3.0,                  -- ±3% around oracle price
    band_low            REAL DEFAULT 0,
    band_high           REAL DEFAULT 0,
    -- Emission
    max_supply          REAL NOT NULL DEFAULT 1000000,     -- max contracts
    circulating_supply  REAL DEFAULT 0,                    -- currently in circulation
    initial_price       REAL NOT NULL DEFAULT 1.0,         -- P0 for formula
    -- Stats
    total_volume        REAL DEFAULT 0,
    total_trades        INTEGER DEFAULT 0,
    holder_count        INTEGER DEFAULT 0,
    -- Treasury state (JSON)
    treasury_json       TEXT DEFAULT '{}',
    -- Growth parameters (JSON — formula-specific)
    params_json         TEXT DEFAULT '{}',
    -- Timestamps
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  -- Index holders (who owns how many contracts)
  CREATE TABLE IF NOT EXISTS index_holders (
    index_id        TEXT NOT NULL,
    agent_id        TEXT NOT NULL,            -- can be engine agent or wallet address
    holder_type     TEXT DEFAULT 'agent',     -- 'agent' | 'wallet'
    balance         REAL DEFAULT 0,           -- number of index contracts held
    avg_entry_price REAL DEFAULT 0,
    realized_pnl    REAL DEFAULT 0,
    total_bought    REAL DEFAULT 0,
    total_sold      REAL DEFAULT 0,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (index_id, agent_id)
  );

  -- Index trades (per-index trade history)
  CREATE TABLE IF NOT EXISTS index_trades (
    id              TEXT PRIMARY KEY,
    index_id        TEXT NOT NULL,
    buyer_id        TEXT NOT NULL,
    seller_id       TEXT,                     -- NULL for mint (emission buy)
    side            TEXT NOT NULL,            -- 'buy' | 'sell'
    price           REAL NOT NULL,
    size            REAL NOT NULL,
    value           REAL NOT NULL,
    is_mint         INTEGER DEFAULT 0,       -- 1 if new contracts were minted
    is_burn         INTEGER DEFAULT 0,       -- 1 if contracts were burned
    timestamp       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_index_trades ON index_trades(index_id, timestamp DESC);

  -- Oracle price snapshots (history for charts)
  CREATE TABLE IF NOT EXISTS index_oracle_snapshots (
    index_id        TEXT NOT NULL,
    price           REAL NOT NULL,
    formula_inputs_json TEXT DEFAULT '{}',    -- snapshot of inputs for auditability
    band_low        REAL,
    band_high       REAL,
    circulating     REAL,
    holder_count    INTEGER,
    timestamp       INTEGER NOT NULL,
    PRIMARY KEY (index_id, timestamp)
  );

  -- Agent ↔ Index subscriptions (which agents trade which indexes)
  CREATE TABLE IF NOT EXISTS agent_index_subs (
    agent_id        TEXT NOT NULL,
    index_id        TEXT NOT NULL,
    subscribed_at   INTEGER NOT NULL,
    allocation_pct  REAL DEFAULT 10,          -- % of agent balance allocated to this index
    status          TEXT DEFAULT 'active',    -- active | paused
    PRIMARY KEY (agent_id, index_id)
  );

  -- Index event feed (decisions/news agents can read)
  CREATE TABLE IF NOT EXISTS index_feed (
    id              TEXT PRIMARY KEY,
    index_id        TEXT NOT NULL,
    event_type      TEXT NOT NULL,            -- 'oracle_update' | 'band_breach' | 'emission' | 'large_trade' | 'holder_change'
    severity        TEXT DEFAULT 'info',      -- 'info' | 'warning' | 'critical'
    title           TEXT NOT NULL,
    detail_json     TEXT DEFAULT '{}',
    timestamp       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feed_index ON index_feed(index_id, timestamp DESC);

  -- ═══════════════════════════════════════════════════════════════════
  -- LLM Agent Memory — decisions, insights, learned patterns
  -- ═══════════════════════════════════════════════════════════════════

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
    outcome_tag         TEXT,               -- 'win' | 'loss' | 'neutral' | 'no_fill'
    outcome_evaluated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_llm_dec_agent ON llm_decisions(agent_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS llm_insights (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id            TEXT NOT NULL,
    timestamp           INTEGER NOT NULL,
    type                TEXT NOT NULL,      -- 'reflection' | 'pattern' | 'rule'
    content             TEXT NOT NULL,      -- JSON
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

  -- ═══════════════════════════════════════════════════════════════════
  -- System State — Key/Value store for persistent engine state
  -- ═══════════════════════════════════════════════════════════════════

  CREATE TABLE IF NOT EXISTS system_state (
    key             TEXT PRIMARY KEY,
    value_json      TEXT NOT NULL DEFAULT '{}',
    updated_at      INTEGER NOT NULL
  );
`)

// ─── DB-002: Run numbered SQL migrations ─────────────────────────────
runMigrations(db)

db.exec(`
  UPDATE wallets
  SET secret_key = '__derived_from_wdk_master_seed__'
  WHERE mnemonic = '__wdk_master_seed__'
    AND secret_key != '__derived_from_wdk_master_seed__';
`)

// Self-heal strategy royalty ledger in case schema_version drift marked the
// migration as applied before the table existed on disk.
db.exec(`
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
`)

// ═══════════════════════════════════════════════════════════════════════
// Prepared Statements (compiled once → fast)
// ═══════════════════════════════════════════════════════════════════════

// ─── Users ───────────────────────────────────────────────────────────

const _upsertUser = db.prepare(`
  INSERT OR IGNORE INTO users (address, created_at) VALUES (?, ?)
`)
const _getUser = db.prepare(`SELECT * FROM users WHERE address = ?`)
const _insertAppUser = db.prepare(`
  INSERT INTO app_users (id, status, primary_wallet_address, metadata_json, created_at, updated_at)
  VALUES (@id, @status, @primary_wallet_address, @metadata_json, @created_at, @updated_at)
`)
const _getAppUser = db.prepare(`SELECT * FROM app_users WHERE id = ?`)
const _getAppUserByPrimaryWallet = db.prepare(`SELECT * FROM app_users WHERE primary_wallet_address = ?`)
const _updateAppUserPrimaryWallet = db.prepare(`
  UPDATE app_users
  SET primary_wallet_address = ?, updated_at = ?
  WHERE id = ?
`)
const _upsertAuthIdentity = db.prepare(`
  INSERT INTO auth_identities (id, user_id, provider, provider_user_id, identity_type, subject, email, phone, verified_at, metadata_json, created_at, updated_at)
  VALUES (@id, @user_id, @provider, @provider_user_id, @identity_type, @subject, @email, @phone, @verified_at, @metadata_json, @created_at, @updated_at)
  ON CONFLICT(provider, provider_user_id, identity_type) DO UPDATE SET
    user_id=excluded.user_id,
    subject=excluded.subject,
    email=excluded.email,
    phone=excluded.phone,
    verified_at=excluded.verified_at,
    metadata_json=excluded.metadata_json,
    updated_at=excluded.updated_at
`)
const _getAuthIdentity = db.prepare(`SELECT * FROM auth_identities WHERE provider = ? AND provider_user_id = ? AND identity_type = ?`)
const _listAuthIdentitiesByUserId = db.prepare(`SELECT * FROM auth_identities WHERE user_id = ? ORDER BY created_at ASC`)
const _upsertUserWallet = db.prepare(`
  INSERT INTO user_wallets (id, user_id, wallet_address, wallet_kind, wallet_provider, wallet_ref, label, is_primary, is_active, metadata_json, created_at, updated_at)
  VALUES (@id, @user_id, @wallet_address, @wallet_kind, @wallet_provider, @wallet_ref, @label, @is_primary, @is_active, @metadata_json, @created_at, @updated_at)
  ON CONFLICT(wallet_address, wallet_provider) DO UPDATE SET
    user_id=excluded.user_id,
    wallet_kind=excluded.wallet_kind,
    wallet_ref=excluded.wallet_ref,
    label=excluded.label,
    is_primary=excluded.is_primary,
    is_active=excluded.is_active,
    metadata_json=excluded.metadata_json,
    updated_at=excluded.updated_at
`)
const _listUserWalletsByUserId = db.prepare(`SELECT * FROM user_wallets WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC`)
const _getUserWalletByAddress = db.prepare(`SELECT * FROM user_wallets WHERE wallet_address = ? AND wallet_provider = ?`)

export function upsertUser(address) {
  _upsertUser.run(address, Date.now())
  return _getUser.get(address)
}

export function getUser(address) {
  return _getUser.get(address)
}

function _parseAppUser(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    primaryWalletAddress: row.primary_wallet_address,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function _parseAuthIdentity(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    identityType: row.identity_type,
    subject: row.subject,
    email: row.email,
    phone: row.phone,
    verifiedAt: row.verified_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function _parseUserWallet(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    walletKind: row.wallet_kind,
    walletProvider: row.wallet_provider,
    walletRef: row.wallet_ref,
    label: row.label,
    isPrimary: Boolean(row.is_primary),
    isActive: Boolean(row.is_active),
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createAppUser({ id, status = 'active', primaryWalletAddress = null, metadata = {} }) {
  const now = Date.now()
  _insertAppUser.run({
    id,
    status,
    primary_wallet_address: primaryWalletAddress,
    metadata_json: JSON.stringify(metadata || {}),
    created_at: now,
    updated_at: now,
  })
  return getAppUser(id)
}

export function getAppUser(id) {
  return _parseAppUser(_getAppUser.get(id))
}

export function getAppUserByPrimaryWallet(address) {
  return _parseAppUser(_getAppUserByPrimaryWallet.get(address))
}

export function updateAppUserPrimaryWallet(userId, primaryWalletAddress) {
  _updateAppUserPrimaryWallet.run(primaryWalletAddress || null, Date.now(), userId)
  return getAppUser(userId)
}

export function upsertAuthIdentity(identity) {
  const existing = _getAuthIdentity.get(identity.provider, identity.providerUserId, identity.identityType)
  const now = Date.now()
  _upsertAuthIdentity.run({
    id: identity.id || existing?.id || randomBytes(16).toString('hex'),
    user_id: identity.userId,
    provider: identity.provider,
    provider_user_id: identity.providerUserId,
    identity_type: identity.identityType,
    subject: identity.subject || null,
    email: identity.email || null,
    phone: identity.phone || null,
    verified_at: identity.verifiedAt || now,
    metadata_json: JSON.stringify(identity.metadata || {}),
    created_at: existing?.created_at || now,
    updated_at: now,
  })
  return getAuthIdentity(identity.provider, identity.providerUserId, identity.identityType)
}

export function getAuthIdentity(provider, providerUserId, identityType) {
  return _parseAuthIdentity(_getAuthIdentity.get(provider, providerUserId, identityType))
}

export function listAuthIdentitiesByUserId(userId) {
  return _listAuthIdentitiesByUserId.all(userId).map(_parseAuthIdentity)
}

export function upsertUserWallet(wallet) {
  const existing = _getUserWalletByAddress.get(wallet.walletAddress, wallet.walletProvider)
  const now = Date.now()
  _upsertUserWallet.run({
    id: wallet.id || existing?.id || randomBytes(16).toString('hex'),
    user_id: wallet.userId,
    wallet_address: wallet.walletAddress,
    wallet_kind: wallet.walletKind,
    wallet_provider: wallet.walletProvider,
    wallet_ref: wallet.walletRef || null,
    label: wallet.label || null,
    is_primary: wallet.isPrimary ? 1 : 0,
    is_active: wallet.isActive === false ? 0 : 1,
    metadata_json: JSON.stringify(wallet.metadata || {}),
    created_at: existing?.created_at || now,
    updated_at: now,
  })
  return getUserWalletByAddress(wallet.walletAddress, wallet.walletProvider)
}

export function listUserWalletsByUserId(userId) {
  return _listUserWalletsByUserId.all(userId).map(_parseUserWallet)
}

export function getUserWalletByAddress(walletAddress, walletProvider = 'wdk-ton') {
  return _parseUserWallet(_getUserWalletByAddress.get(walletAddress, walletProvider))
}

const _upsertUserProfile = db.prepare(`
  INSERT INTO user_profiles (owner_address, display_name, username, registration_mode, metadata_json, created_at, updated_at)
  VALUES (@owner_address, @display_name, @username, @registration_mode, @metadata_json, @created_at, @updated_at)
  ON CONFLICT(owner_address) DO UPDATE SET
    display_name=excluded.display_name,
    username=excluded.username,
    registration_mode=excluded.registration_mode,
    metadata_json=excluded.metadata_json,
    updated_at=excluded.updated_at
`)
const _getUserProfile = db.prepare(`SELECT * FROM user_profiles WHERE owner_address = ?`)

const _upsertWalletConnection = db.prepare(`
  INSERT INTO wallet_connections (id, owner_address, wallet_address, wallet_kind, wallet_provider, wallet_ref, label, is_primary, metadata_json, created_at, updated_at)
  VALUES (@id, @owner_address, @wallet_address, @wallet_kind, @wallet_provider, @wallet_ref, @label, @is_primary, @metadata_json, @created_at, @updated_at)
  ON CONFLICT(wallet_address, wallet_provider) DO UPDATE SET
    owner_address=excluded.owner_address,
    wallet_kind=excluded.wallet_kind,
    wallet_ref=excluded.wallet_ref,
    label=excluded.label,
    is_primary=excluded.is_primary,
    metadata_json=excluded.metadata_json,
    updated_at=excluded.updated_at
`)
const _listWalletConnectionsByOwner = db.prepare(`SELECT * FROM wallet_connections WHERE owner_address = ? ORDER BY is_primary DESC, created_at ASC`)
const _getWalletConnectionByAddress = db.prepare(`SELECT * FROM wallet_connections WHERE wallet_address = ? AND wallet_provider = ?`)

const _insertManagedWalletRecord = db.prepare(`
  INSERT INTO managed_wallets (id, owner_address, wallet_id, wallet_address, provider, mode, label, account_index, derivation_path, status, metadata_json, created_at, updated_at)
  VALUES (@id, @owner_address, @wallet_id, @wallet_address, @provider, @mode, @label, @account_index, @derivation_path, @status, @metadata_json, @created_at, @updated_at)
`)
const _listManagedWalletsByOwner = db.prepare(`SELECT * FROM managed_wallets WHERE owner_address = ? ORDER BY created_at ASC`)
const _getNextManagedWalletAccountIndex = db.prepare(`
  SELECT COALESCE(MAX(account_index), -1) + 1 AS next_index
  FROM managed_wallets
  WHERE provider = ?
`)

function _parseUserProfile(row) {
  if (!row) return null
  return {
    ownerAddress: row.owner_address,
    displayName: row.display_name,
    username: row.username,
    registrationMode: row.registration_mode,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function _parseWalletConnection(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerAddress: row.owner_address,
    walletAddress: row.wallet_address,
    walletKind: row.wallet_kind,
    walletProvider: row.wallet_provider,
    walletRef: row.wallet_ref,
    label: row.label,
    isPrimary: Boolean(row.is_primary),
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function _parseManagedWallet(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerAddress: row.owner_address,
    walletId: row.wallet_id,
    walletAddress: row.wallet_address,
    provider: row.provider,
    mode: row.mode,
    label: row.label,
    accountIndex: row.account_index,
    derivationPath: row.derivation_path,
    status: row.status,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function upsertUserProfile(profile) {
  const now = Date.now()
  _upsertUserProfile.run({
    owner_address: profile.ownerAddress,
    display_name: profile.displayName || null,
    username: profile.username || null,
    registration_mode: profile.registrationMode || 'optional',
    metadata_json: JSON.stringify(profile.metadata || {}),
    created_at: profile.createdAt || now,
    updated_at: profile.updatedAt || now,
  })
  return getUserProfile(profile.ownerAddress)
}

export function getUserProfile(ownerAddress) {
  return _parseUserProfile(_getUserProfile.get(ownerAddress))
}

export function upsertWalletConnection(connection) {
  const now = Date.now()
  _upsertWalletConnection.run({
    id: connection.id,
    owner_address: connection.ownerAddress || null,
    wallet_address: connection.walletAddress,
    wallet_kind: connection.walletKind,
    wallet_provider: connection.walletProvider,
    wallet_ref: connection.walletRef || null,
    label: connection.label || null,
    is_primary: connection.isPrimary ? 1 : 0,
    metadata_json: JSON.stringify(connection.metadata || {}),
    created_at: connection.createdAt || now,
    updated_at: connection.updatedAt || now,
  })
  return _parseWalletConnection(_getWalletConnectionByAddress.get(connection.walletAddress, connection.walletProvider))
}

export function listWalletConnectionsByOwner(ownerAddress) {
  return _listWalletConnectionsByOwner.all(ownerAddress).map(_parseWalletConnection)
}

export function insertManagedWalletRecord(record) {
  const now = Date.now()
  _insertManagedWalletRecord.run({
    id: record.id,
    owner_address: record.ownerAddress || null,
    wallet_id: record.walletId,
    wallet_address: record.walletAddress,
    provider: record.provider,
    mode: record.mode || 'create',
    label: record.label || null,
    account_index: record.accountIndex || 0,
    derivation_path: record.derivationPath || null,
    status: record.status || 'active',
    metadata_json: JSON.stringify(record.metadata || {}),
    created_at: record.createdAt || now,
    updated_at: record.updatedAt || now,
  })
  return _parseManagedWallet({
    id: record.id,
    owner_address: record.ownerAddress || null,
    wallet_id: record.walletId,
    wallet_address: record.walletAddress,
    provider: record.provider,
    mode: record.mode || 'create',
    label: record.label || null,
    account_index: record.accountIndex || 0,
    derivation_path: record.derivationPath || null,
    status: record.status || 'active',
    metadata_json: JSON.stringify(record.metadata || {}),
    created_at: record.createdAt || now,
    updated_at: record.updatedAt || now,
  })
}

export function listManagedWalletsByOwner(ownerAddress) {
  return _listManagedWalletsByOwner.all(ownerAddress).map(_parseManagedWallet)
}

export function getNextManagedWalletAccountIndex(provider = 'wdk-ton') {
  const row = _getNextManagedWalletAccountIndex.get(provider)
  return Number.isFinite(row?.next_index) ? row.next_index : 0
}

// ─── Auth nonces / sessions ─────────────────────────────────────────

const _upsertAuthNonce = db.prepare(`
  INSERT INTO auth_nonces (address, nonce, created_at, expires_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET
    nonce = excluded.nonce,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at
`)
const _getAuthNonce = db.prepare(`SELECT * FROM auth_nonces WHERE address = ?`)
const _deleteAuthNonce = db.prepare(`DELETE FROM auth_nonces WHERE address = ?`)

const _insertAuthSession = db.prepare(`
  INSERT INTO auth_sessions (id, address, ua_hash, ip_hash, created_at, expires_at, last_seen_at, user_id, auth_provider, auth_level, active_wallet_address, privy_user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const _getAuthSession = db.prepare(`SELECT * FROM auth_sessions WHERE id = ?`)
const _touchAuthSession = db.prepare(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`)
const _updateAuthSessionActiveWallet = db.prepare(`UPDATE auth_sessions SET address = ?, active_wallet_address = ?, last_seen_at = ? WHERE id = ?`)
const _deleteAuthSession = db.prepare(`DELETE FROM auth_sessions WHERE id = ?`)
const _deleteAuthSessionsByAddress = db.prepare(`DELETE FROM auth_sessions WHERE address = ?`)
const _insertAdminSession = db.prepare(`
  INSERT INTO admin_sessions (id, actor_label, role, auth_mode, local_bypass_enabled, ua_hash, ip_hash, created_at, expires_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const _getAdminSession = db.prepare(`SELECT * FROM admin_sessions WHERE id = ?`)
const _touchAdminSession = db.prepare(`UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?`)
const _deleteAdminSession = db.prepare(`DELETE FROM admin_sessions WHERE id = ?`)
const _cleanupAuthNonces = db.prepare(`DELETE FROM auth_nonces WHERE expires_at < ?`)
const _cleanupAuthSessions = db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`)
const _cleanupAdminSessions = db.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?`)

function _hashForStorage(value = '') {
  if (!value) return null
  return createHash('sha256').update(String(value)).digest('hex')
}

export function issueAuthNonce(address, ttlMs = 5 * 60 * 1000) {
  const now = Date.now()
  const nonce = randomBytes(24).toString('hex')
  _upsertAuthNonce.run(address, nonce, now, now + ttlMs)
  return { address, nonce, expiresAt: now + ttlMs }
}

export function consumeAuthNonce(address, nonce) {
  const row = _getAuthNonce.get(address)
  if (!row) return false
  const now = Date.now()
  const valid = row.nonce === nonce && row.expires_at > now
  _deleteAuthNonce.run(address)
  return valid
}

export function createAuthSession({
  address,
  userAgent = '',
  ip = '',
  ttlMs = 7 * 24 * 60 * 60 * 1000,
  userId = null,
  authProvider = 'session',
  authLevel = 'wallet_verified',
  activeWalletAddress = null,
  privyUserId = null,
}) {
  const now = Date.now()
  const id = randomBytes(32).toString('hex')
  const resolvedActiveWalletAddress = activeWalletAddress || address || null
  _insertAuthSession.run(
    id,
    resolvedActiveWalletAddress || address,
    _hashForStorage(userAgent),
    _hashForStorage(ip),
    now,
    now + ttlMs,
    now,
    userId,
    authProvider,
    authLevel,
    resolvedActiveWalletAddress,
    privyUserId,
  )
  return {
    id,
    address: resolvedActiveWalletAddress || address,
    activeWalletAddress: resolvedActiveWalletAddress,
    userId,
    authProvider,
    authLevel,
    privyUserId,
    createdAt: now,
    expiresAt: now + ttlMs,
  }
}

export function getAuthSession(id) {
  return _getAuthSession.get(id)
}

export function touchAuthSession(id) {
  _touchAuthSession.run(Date.now(), id)
}

export function updateAuthSessionActiveWallet(id, walletAddress) {
  _updateAuthSessionActiveWallet.run(walletAddress, walletAddress, Date.now(), id)
  return getAuthSession(id)
}

export function deleteAuthSession(id) {
  _deleteAuthSession.run(id)
}

export function deleteAuthSessionsByAddress(address) {
  _deleteAuthSessionsByAddress.run(address)
}

function _parseAdminSession(row) {
  if (!row) return null
  return {
    id: row.id,
    actorLabel: row.actor_label,
    role: row.role,
    authMode: row.auth_mode,
    localBypassEnabled: Boolean(row.local_bypass_enabled),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  }
}

export function createAdminSession({
  actorLabel,
  role,
  authMode,
  localBypassEnabled = false,
  userAgent = '',
  ip = '',
  ttlMs = 12 * 60 * 60 * 1000,
}) {
  const now = Date.now()
  const id = randomBytes(32).toString('hex')

  _insertAdminSession.run(
    id,
    actorLabel,
    role,
    authMode,
    localBypassEnabled ? 1 : 0,
    _hashForStorage(userAgent),
    _hashForStorage(ip),
    now,
    now + ttlMs,
    now,
  )

  return {
    id,
    actorLabel,
    role,
    authMode,
    localBypassEnabled,
    createdAt: now,
    expiresAt: now + ttlMs,
  }
}

export function getAdminSession(id) {
  return _parseAdminSession(_getAdminSession.get(id))
}

export function touchAdminSession(id) {
  _touchAdminSession.run(Date.now(), id)
}

export function deleteAdminSession(id) {
  _deleteAdminSession.run(id)
}

export function cleanupExpiredAuth() {
  const now = Date.now()
  const nonces = _cleanupAuthNonces.run(now).changes
  const sessions = _cleanupAuthSessions.run(now).changes
  const adminSessions = _cleanupAdminSessions.run(now).changes
  return { nonces, sessions, adminSessions }
}

// ─── Wallets ─────────────────────────────────────────────────────────

const _insertWallet = db.prepare(`
  INSERT INTO wallets (id, address, address_bounce, address_raw, mnemonic, public_key, secret_key, created_at)
  VALUES (@id, @address, @address_bounce, @address_raw, @mnemonic, @public_key, @secret_key, @created_at)
`)
const _getWallet = db.prepare(`SELECT * FROM wallets WHERE id = ?`)
const _deleteWallet = db.prepare(`DELETE FROM wallets WHERE id = ?`)

export function insertWallet(w) {
  _insertWallet.run(w)
  return w
}

export function getWallet(id) {
  return _getWallet.get(id)
}

export function deleteWallet(id) {
  _deleteWallet.run(id)
}

// ─── Legacy Agents (User API) ────────────────────────────────────────

const _insertLegacyAgent = db.prepare(`
  INSERT INTO legacy_agents (id, owner_address, name, preset, strategy, idx, icon, status,
    wallet_id, wallet_address, wallet_address_bounce, wallet_public_key,
    balance, initial_balance, config_json, risk_params_json, deposits_json, created_at, started_at)
  VALUES (@id, @owner_address, @name, @preset, @strategy, @idx, @icon, @status,
    @wallet_id, @wallet_address, @wallet_address_bounce, @wallet_public_key,
    @balance, @initial_balance, @config_json, @risk_params_json, @deposits_json, @created_at, @started_at)
`)
const _getLegacyAgent = db.prepare(`SELECT * FROM legacy_agents WHERE id = ?`)
const _getLegacyAgentsByOwner = db.prepare(`SELECT * FROM legacy_agents WHERE owner_address = ? ORDER BY created_at ASC`)
const _updateLegacyAgent = db.prepare(`
  UPDATE legacy_agents SET name=@name, config_json=@config_json, risk_params_json=@risk_params_json,
    status=@status, balance=@balance, initial_balance=@initial_balance,
    deposits_json=@deposits_json, started_at=@started_at
  WHERE id = @id
`)
const _deleteLegacyAgent = db.prepare(`DELETE FROM legacy_agents WHERE id = ?`)
const _countLegacyByOwner = db.prepare(`SELECT COUNT(*) as cnt FROM legacy_agents WHERE owner_address = ?`)

function _parseLegacy(row) {
  if (!row) return null
  return {
    ...row,
    ownerAddress: row.owner_address,
    walletId: row.wallet_id,
    walletAddress: row.wallet_address,
    walletAddressBounceable: row.wallet_address_bounce,
    walletPublicKey: row.wallet_public_key,
    initialBalance: row.initial_balance,
    index: row.idx,
    config: JSON.parse(row.config_json || '{}'),
    riskParams: JSON.parse(row.risk_params_json || '{}'),
    deposits: JSON.parse(row.deposits_json || '[]'),
    createdAt: row.created_at,
    startedAt: row.started_at,
  }
}

export function insertLegacyAgent(a) {
  _insertLegacyAgent.run({
    id: a.id,
    owner_address: a.ownerAddress,
    name: a.name,
    preset: a.preset || null,
    strategy: a.strategy || 'mean_reversion',
    idx: a.index || 'FLOOR',
    icon: a.icon || '🤖',
    status: a.status || 'funding',
    wallet_id: a.walletId || null,
    wallet_address: a.walletAddress || null,
    wallet_address_bounce: a.walletAddressBounceable || null,
    wallet_public_key: a.walletPublicKey || null,
    balance: a.balance || 0,
    initial_balance: a.initialBalance || 0,
    config_json: JSON.stringify(a.config || {}),
    risk_params_json: JSON.stringify(a.riskParams || {}),
    deposits_json: JSON.stringify(a.deposits || []),
    created_at: a.createdAt,
    started_at: a.startedAt || null,
  })
  return a
}

export function getLegacyAgent(id) {
  return _parseLegacy(_getLegacyAgent.get(id))
}

export function getLegacyAgentsByOwner(ownerAddress) {
  return _getLegacyAgentsByOwner.all(ownerAddress).map(_parseLegacy)
}

export function countLegacyByOwner(ownerAddress) {
  return _countLegacyByOwner.get(ownerAddress)?.cnt || 0
}

export function updateLegacyAgent(a) {
  _updateLegacyAgent.run({
    id: a.id,
    name: a.name,
    config_json: JSON.stringify(a.config || {}),
    risk_params_json: JSON.stringify(a.riskParams || {}),
    status: a.status,
    balance: a.balance || 0,
    initial_balance: a.initialBalance || 0,
    deposits_json: JSON.stringify(a.deposits || []),
    started_at: a.startedAt || null,
  })
}

export function deleteLegacyAgent(id) {
  _deleteLegacyAgent.run(id)
}

// ═══════════════════════════════════════════════════════════════════════
// Engine User Agents — Full State Persistence
// ═══════════════════════════════════════════════════════════════════════

const _upsertUserAgent = db.prepare(`
  INSERT INTO user_agents (
    id, name, strategy, strategy_name, icon, bio, is_user_agent, wallet_address, risk_level,
    status, virtual_balance, initial_balance, position, position_value, avg_entry_price,
    pnl, realized_pnl, unrealized_pnl, fee_income, dividend_income, royalty_income, total_trades, winning_trades, losing_trades,
    total_volume, max_drawdown, peak_equity, config_json, open_orders_json,
    tick_count, last_tick_at, last_decision_at, created_at, updated_at
  ) VALUES (
    @id, @name, @strategy, @strategy_name, @icon, @bio, @is_user_agent, @wallet_address, @risk_level,
    @status, @virtual_balance, @initial_balance, @position, @position_value, @avg_entry_price,
    @pnl, @realized_pnl, @unrealized_pnl, @fee_income, @dividend_income, @royalty_income, @total_trades, @winning_trades, @losing_trades,
    @total_volume, @max_drawdown, @peak_equity, @config_json, @open_orders_json,
    @tick_count, @last_tick_at, @last_decision_at, @created_at, @updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, status=excluded.status,
    virtual_balance=excluded.virtual_balance, position=excluded.position,
    position_value=excluded.position_value, avg_entry_price=excluded.avg_entry_price,
    pnl=excluded.pnl, realized_pnl=excluded.realized_pnl, unrealized_pnl=excluded.unrealized_pnl,
    fee_income=excluded.fee_income, dividend_income=excluded.dividend_income, royalty_income=excluded.royalty_income,
    total_trades=excluded.total_trades, winning_trades=excluded.winning_trades,
    losing_trades=excluded.losing_trades, total_volume=excluded.total_volume,
    max_drawdown=excluded.max_drawdown, peak_equity=excluded.peak_equity,
    config_json=excluded.config_json, open_orders_json=excluded.open_orders_json,
    tick_count=excluded.tick_count, last_tick_at=excluded.last_tick_at,
    last_decision_at=excluded.last_decision_at, updated_at=excluded.updated_at
`)

const _getUserAgent = db.prepare(`SELECT * FROM user_agents WHERE id = ?`)
const _getAllUserAgents = db.prepare(`SELECT * FROM user_agents`)
const _findUserAgentByWallet = db.prepare(`SELECT * FROM user_agents WHERE wallet_address = ?`)
const _deleteUserAgent = db.prepare(`DELETE FROM user_agents WHERE id = ?`)

function _agentToRow(agent) {
  const normalizedConfig = _normalizeAgentConfig(agent.config)
  const now = Date.now()
  return {
    id: agent.id,
    name: agent.name,
    strategy: agent.strategy,
    strategy_name: agent.strategyName || null,
    icon: agent.icon || '🤖',
    bio: agent.bio || '',
    is_user_agent: agent.isUserAgent ? 1 : 0,
    wallet_address: agent.walletAddress || null,
    risk_level: agent.riskLevel || 'medium',
    status: agent.status || 'active',
    virtual_balance: agent.virtualBalance,
    initial_balance: agent.initialBalance,
    position: agent.position || 0,
    position_value: agent.positionValue || 0,
    avg_entry_price: agent.avgEntryPrice || 0,
    pnl: agent.pnl || 0,
    realized_pnl: agent.realizedPnl || 0,
    unrealized_pnl: agent.unrealizedPnl || 0,
    fee_income: agent.feeIncome || 0,
    dividend_income: agent.dividendIncome || 0,
    royalty_income: agent.royaltyIncome || 0,
    total_trades: agent.totalTrades || 0,
    winning_trades: agent.winningTrades || 0,
    losing_trades: agent.losingTrades || 0,
    total_volume: agent.totalVolume || 0,
    max_drawdown: agent.maxDrawdown || 0,
    peak_equity: agent.peakEquity || agent.initialBalance,
    config_json: JSON.stringify(normalizedConfig),
    open_orders_json: JSON.stringify(agent.openOrders || []),
    tick_count: agent.tickCount || 0,
    last_tick_at: agent.lastTickAt || null,
    last_decision_at: agent.lastDecisionAt || null,
    created_at: agent.createdAt || now,
    updated_at: now,
  }
}

function _rowToAgent(row) {
  if (!row) return null
  const config = _normalizeAgentConfig(_tryParseJSON(row.config_json) || {})
  return {
    id: row.id,
    name: row.name,
    strategy: row.strategy,
    strategyName: row.strategy_name,
    icon: row.icon,
    bio: row.bio,
    isUserAgent: !!row.is_user_agent,
    walletAddress: row.wallet_address,
    riskLevel: row.risk_level,
    status: row.status,
    virtualBalance: row.virtual_balance,
    initialBalance: row.initial_balance,
    position: row.position,
    positionValue: row.position_value,
    avgEntryPrice: row.avg_entry_price,
    pnl: row.pnl,
    realizedPnl: row.realized_pnl,
    unrealizedPnl: row.unrealized_pnl,
    feeIncome: row.fee_income,
    dividendIncome: row.dividend_income,
    royaltyIncome: row.royalty_income,
    totalTrades: row.total_trades,
    winningTrades: row.winning_trades,
    losingTrades: row.losing_trades,
    totalVolume: row.total_volume,
    maxDrawdown: row.max_drawdown,
    peakEquity: row.peak_equity,
    config,
    openOrders: JSON.parse(row.open_orders_json || '[]'),
    tickCount: row.tick_count,
    lastTickAt: row.last_tick_at,
    lastDecisionAt: row.last_decision_at,
    createdAt: row.created_at,
  }
}

function _normalizeStrategyMode(mode) {
  return mode ? 'direct' : null
}

function _normalizeAgentConfig(config) {
  const safe = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {}
  if (safe.strategyMode) safe.strategyMode = 'direct'
  return safe
}

/** Save full agent state (upsert) */
export function saveUserAgent(agent) {
  _upsertUserAgent.run(_agentToRow(agent))
}

/** Load a single user agent by id */
export function getUserAgent(id) {
  return _rowToAgent(_getUserAgent.get(id))
}

/** Load all user agents (for restore on startup) */
export function getAllUserAgents() {
  return _getAllUserAgents.all().map(_rowToAgent)
}

/** Find user agent by wallet address (normalized lowercase) */
export function findUserAgentByWallet(walletAddress) {
  return _rowToAgent(_findUserAgentByWallet.get(walletAddress))
}

/** Delete a user agent and all related data */
export const deleteUserAgent = db.transaction((agentId) => {
  _deleteUserAgent.run(agentId)
  _deleteTradesByAgent.run(agentId)
  _deleteDecisionsByAgent.run(agentId)
  _deleteEquityByAgent.run(agentId)
})

// ─── Agent Trades ────────────────────────────────────────────────────

const _insertTrade = db.prepare(`
  INSERT OR IGNORE INTO agent_trades (id, agent_id, side, price, size, value, pnl, position_after, balance_after, timestamp)
  VALUES (@id, @agent_id, @side, @price, @size, @value, @pnl, @position_after, @balance_after, @timestamp)
`)
const _getTradesByAgent = db.prepare(`
  SELECT * FROM agent_trades WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?
`)
const _deleteTradesByAgent = db.prepare(`DELETE FROM agent_trades WHERE agent_id = ?`)

export function saveTrade(trade) {
  _insertTrade.run({
    id: trade.id,
    agent_id: trade.agentId,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    value: trade.value,
    pnl: trade.pnl || 0,
    position_after: trade.position || 0,
    balance_after: trade.balance || 0,
    timestamp: trade.timestamp,
  })
}

export function getTradesByAgent(agentId, limit = 100) {
  return _getTradesByAgent.all(agentId, limit).map(r => ({
    id: r.id,
    agentId: r.agent_id,
    side: r.side,
    price: r.price,
    size: r.size,
    value: r.value,
    pnl: r.pnl,
    position: r.position_after,
    balance: r.balance_after,
    timestamp: r.timestamp,
  }))
}

// ─── Agent Decisions ─────────────────────────────────────────────────

const _insertDecision = db.prepare(`
  INSERT OR IGNORE INTO agent_decisions (id, agent_id, agent_name, strategy, action, price, size, reasoning, confidence, equity, position, timestamp)
  VALUES (@id, @agent_id, @agent_name, @strategy, @action, @price, @size, @reasoning, @confidence, @equity, @position, @timestamp)
`)
const _getDecisionsByAgent = db.prepare(`
  SELECT * FROM agent_decisions WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?
`)
const _deleteDecisionsByAgent = db.prepare(`DELETE FROM agent_decisions WHERE agent_id = ?`)

export function saveDecision(d) {
  _insertDecision.run({
    id: d.id,
    agent_id: d.agentId,
    agent_name: d.agentName || null,
    strategy: d.strategy || null,
    action: d.action,
    price: d.price || null,
    size: d.size || null,
    reasoning: d.reasoning || null,
    confidence: d.confidence || 0,
    equity: d.equity || null,
    position: d.position || null,
    timestamp: d.timestamp,
  })
}

export function getDecisionsByAgent(agentId, limit = 50) {
  return _getDecisionsByAgent.all(agentId, limit).map(r => ({
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    strategy: r.strategy,
    action: r.action,
    price: r.price,
    size: r.size,
    reasoning: r.reasoning,
    confidence: r.confidence,
    equity: r.equity,
    position: r.position,
    timestamp: r.timestamp,
  }))
}

// ─── Agent Equity Curve ──────────────────────────────────────────────

const _insertEquity = db.prepare(`
  INSERT OR IGNORE INTO agent_equity (agent_id, equity, timestamp)
  VALUES (?, ?, ?)
`)
const _getEquityByAgent = db.prepare(`
  SELECT * FROM agent_equity WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?
`)
const _deleteEquityByAgent = db.prepare(`DELETE FROM agent_equity WHERE agent_id = ?`)

export function saveEquityPoint(agentId, equity, timestamp) {
  _insertEquity.run(agentId, equity, timestamp)
}

export function getEquityByAgent(agentId, limit = 500) {
  // Return in chronological order (oldest first)
  return _getEquityByAgent.all(agentId, limit)
    .reverse()
    .map(r => ({ time: r.timestamp, equity: r.equity }))
}

// ─── Admin Audit Events ──────────────────────────────────────────────

const _insertAdminAuditEvent = db.prepare(`
  INSERT OR REPLACE INTO admin_audit_events (
    id, action, actor, auth_mode, admin_role, target_type, target_id, details_json, ip, created_at
  ) VALUES (
    @id, @action, @actor, @auth_mode, @admin_role, @target_type, @target_id, @details_json, @ip, @created_at
  )
`)
const _listAdminAuditEvents = db.prepare(`
  SELECT *
  FROM admin_audit_events
  ORDER BY created_at DESC
  LIMIT ?
`)
const _countAdminAuditEvents = db.prepare(`SELECT COUNT(*) AS total FROM admin_audit_events`)
const _listFilteredAdminAuditEvents = db.prepare(`
  SELECT *
  FROM admin_audit_events
  WHERE (@auth_mode IS NULL OR auth_mode = @auth_mode)
    AND (@action IS NULL OR action = @action)
    AND (@actor IS NULL OR actor = @actor)
    AND (@target_type IS NULL OR target_type = @target_type)
    AND (@query IS NULL OR (
      lower(coalesce(action, '')) LIKE @query
      OR lower(coalesce(actor, '')) LIKE @query
      OR lower(coalesce(auth_mode, '')) LIKE @query
      OR lower(coalesce(target_type, '')) LIKE @query
      OR lower(coalesce(target_id, '')) LIKE @query
      OR lower(coalesce(details_json, '')) LIKE @query
    ))
  ORDER BY created_at DESC
  LIMIT @limit
`)
const _countFilteredAdminAuditEvents = db.prepare(`
  SELECT COUNT(*) AS total
  FROM admin_audit_events
  WHERE (@auth_mode IS NULL OR auth_mode = @auth_mode)
    AND (@action IS NULL OR action = @action)
    AND (@actor IS NULL OR actor = @actor)
    AND (@target_type IS NULL OR target_type = @target_type)
    AND (@query IS NULL OR (
      lower(coalesce(action, '')) LIKE @query
      OR lower(coalesce(actor, '')) LIKE @query
      OR lower(coalesce(auth_mode, '')) LIKE @query
      OR lower(coalesce(target_type, '')) LIKE @query
      OR lower(coalesce(target_id, '')) LIKE @query
      OR lower(coalesce(details_json, '')) LIKE @query
    ))
`)

function _parseAdminAuditEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    authMode: row.auth_mode,
    role: row.admin_role,
    targetType: row.target_type,
    targetId: row.target_id,
    details: _tryParseJSON(row.details_json) || {},
    ip: row.ip,
    timestamp: row.created_at,
  }
}

export function saveAdminAuditEvent(event) {
  _insertAdminAuditEvent.run({
    id: event.id,
    action: event.action,
    actor: event.actor,
    auth_mode: event.authMode || 'unknown',
    admin_role: event.role || 'viewer',
    target_type: event.targetType || null,
    target_id: event.targetId || null,
    details_json: JSON.stringify(event.details || {}),
    ip: event.ip || null,
    created_at: event.timestamp || Date.now(),
  })
}

export function listPersistedAdminAuditEvents(limit = 50) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)
  return _listAdminAuditEvents.all(safeLimit).map(_parseAdminAuditEvent)
}

export function listPersistedAdminAuditEventsFiltered(filters = {}) {
  const safeLimit = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 500)
  const query = String(filters.query || '').trim().toLowerCase()
  return _listFilteredAdminAuditEvents.all({
    limit: safeLimit,
    auth_mode: filters.authMode || null,
    action: filters.action || null,
    actor: filters.actor || null,
    target_type: filters.targetType || null,
    query: query ? `%${query}%` : null,
  }).map(_parseAdminAuditEvent)
}

export function countPersistedAdminAuditEvents() {
  return _countAdminAuditEvents.get()?.total || 0
}

export function countPersistedAdminAuditEventsFiltered(filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase()
  return _countFilteredAdminAuditEvents.get({
    auth_mode: filters.authMode || null,
    action: filters.action || null,
    actor: filters.actor || null,
    target_type: filters.targetType || null,
    query: query ? `%${query}%` : null,
  })?.total || 0
}

// ═══════════════════════════════════════════════════════════════════════
// Batch Operations (wrapped in transactions for atomicity + speed)
// ═══════════════════════════════════════════════════════════════════════

/** Save multiple user agents in a single transaction */
export const saveUserAgentsBatch = db.transaction((agents) => {
  for (const agent of agents) {
    _upsertUserAgent.run(_agentToRow(agent))
  }
})

/** Save multiple trades in a single transaction */
export const saveTradesBatch = db.transaction((trades) => {
  for (const trade of trades) {
    _insertTrade.run({
      id: trade.id,
      agent_id: trade.agentId,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      value: trade.value,
      pnl: trade.pnl || 0,
      position_after: trade.position || 0,
      balance_after: trade.balance || 0,
      timestamp: trade.timestamp,
    })
  }
})

// ─── Graceful Shutdown ───────────────────────────────────────────────

export function closeDb() {
  db.close()
  console.log('🗄  Persistence store closed')
}

/** Raw db handle — for retention policy and direct queries */
export { db as rawDb }

// ═══════════════════════════════════════════════════════════════════════
// INDEX SYSTEM — CRUD Helpers
// ═══════════════════════════════════════════════════════════════════════

// ─── Indexes ─────────────────────────────────────────────────────────

const _upsertIndex = db.prepare(`
  INSERT INTO indexes (id, name, symbol, description, formula_id, icon, status,
    oracle_interval_ms, last_oracle_at, oracle_price, prev_oracle_price,
    band_width_pct, band_low, band_high,
    max_supply, circulating_supply, initial_price,
    total_volume, total_trades, holder_count,
    treasury_json, params_json, created_at, updated_at)
  VALUES (@id, @name, @symbol, @description, @formula_id, @icon, @status,
    @oracle_interval_ms, @last_oracle_at, @oracle_price, @prev_oracle_price,
    @band_width_pct, @band_low, @band_high,
    @max_supply, @circulating_supply, @initial_price,
    @total_volume, @total_trades, @holder_count,
    @treasury_json, @params_json, @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    oracle_price=excluded.oracle_price, prev_oracle_price=excluded.prev_oracle_price,
    last_oracle_at=excluded.last_oracle_at,
    band_low=excluded.band_low, band_high=excluded.band_high,
    circulating_supply=excluded.circulating_supply,
    total_volume=excluded.total_volume, total_trades=excluded.total_trades,
    holder_count=excluded.holder_count, status=excluded.status,
    treasury_json=excluded.treasury_json, params_json=excluded.params_json,
    updated_at=excluded.updated_at
`)
const _getIndex = db.prepare(`SELECT * FROM indexes WHERE id = ?`)
const _getAllIndexes = db.prepare(`SELECT * FROM indexes ORDER BY created_at ASC`)
const _getActiveIndexes = db.prepare(`SELECT * FROM indexes WHERE status = 'active' ORDER BY created_at ASC`)

function _parseIndex(row) {
  if (!row) return null
  const treasury = JSON.parse(row.treasury_json || '{}')
  const policyOverrides = treasury.policyOverrides || {}
  // Extract creatorFees + hwmPrice from treasury_json (persisted there by _serializeIndex)
  const creatorFees = treasury.creatorFees || null
  const hwmPrice = treasury.hwmPrice || 0
  delete treasury.creatorFees  // don't duplicate in treasury object
  delete treasury.hwmPrice
  delete treasury.policyOverrides
  treasury.hwmPrice = hwmPrice // keep hwmPrice on treasury for HWM gate
  const params = JSON.parse(row.params_json || '{}')
  return {
    ...row,
    formulaId: row.formula_id,
    oracleIntervalMs: row.oracle_interval_ms,
    lastOracleAt: row.last_oracle_at,
    oraclePrice: row.oracle_price,
    prevOraclePrice: row.prev_oracle_price,
    bandWidthPct: row.band_width_pct,
    bandLow: row.band_low,
    bandHigh: row.band_high,
    maxSupply: row.max_supply,
    circulatingSupply: row.circulating_supply,
    initialPrice: row.initial_price,
    totalVolume: row.total_volume,
    totalTrades: row.total_trades,
    holderCount: row.holder_count,
    treasury,
    creatorFees,
    // Agent-created index metadata (inferred from persisted data)
    creationType: creatorFees ? 'agent' : (params.creatorAgentId ? 'agent' : 'system'),
    creatorAgentId: params.creatorAgentId || null,
    policyOverrides,
    params,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function upsertIndex(idx) {
  const now = Date.now()
  _upsertIndex.run({
    id: idx.id,
    name: idx.name,
    symbol: idx.symbol,
    description: idx.description || '',
    formula_id: idx.formulaId,
    icon: idx.icon || '📊',
    status: idx.status || 'active',
    oracle_interval_ms: idx.oracleIntervalMs || 30000,
    last_oracle_at: idx.lastOracleAt || null,
    oracle_price: idx.oraclePrice || 0,
    prev_oracle_price: idx.prevOraclePrice || 0,
    band_width_pct: idx.bandWidthPct ?? 3.0,
    band_low: idx.bandLow || 0,
    band_high: idx.bandHigh || 0,
    max_supply: idx.maxSupply || 1000000,
    circulating_supply: idx.circulatingSupply || 0,
    initial_price: idx.initialPrice || 1.0,
    total_volume: idx.totalVolume || 0,
    total_trades: idx.totalTrades || 0,
    holder_count: idx.holderCount || 0,
    treasury_json: JSON.stringify(idx.treasury || {}),
    params_json: JSON.stringify(idx.params || {}),
    created_at: idx.createdAt || now,
    updated_at: now,
  })
}

export function getIndex(id) { return _parseIndex(_getIndex.get(id)) }
export function getAllIndexes() { return _getAllIndexes.all().map(_parseIndex) }
export function getActiveIndexes() { return _getActiveIndexes.all().map(_parseIndex) }

// ─── Index Holders ───────────────────────────────────────────────────

const _upsertHolder = db.prepare(`
  INSERT INTO index_holders (index_id, agent_id, holder_type, balance, avg_entry_price, realized_pnl, total_bought, total_sold, opened_at, opened_tick, updated_at)
  VALUES (@index_id, @agent_id, @holder_type, @balance, @avg_entry_price, @realized_pnl, @total_bought, @total_sold, @opened_at, @opened_tick, @updated_at)
  ON CONFLICT(index_id, agent_id) DO UPDATE SET
    balance=excluded.balance, avg_entry_price=excluded.avg_entry_price,
    realized_pnl=excluded.realized_pnl, total_bought=excluded.total_bought,
    total_sold=excluded.total_sold, opened_at=excluded.opened_at,
    opened_tick=excluded.opened_tick, updated_at=excluded.updated_at
`)
const _getHolder = db.prepare(`SELECT * FROM index_holders WHERE index_id = ? AND agent_id = ?`)
const _getHoldersByIndex = db.prepare(`SELECT * FROM index_holders WHERE index_id = ? AND balance > 0 ORDER BY balance DESC`)
const _deleteZeroHolders = db.prepare(`DELETE FROM index_holders WHERE index_id = ? AND balance <= 0`)
const _countHolders = db.prepare(`SELECT COUNT(*) as cnt FROM index_holders WHERE index_id = ? AND balance > 0`)

export function upsertHolder(h) {
  _upsertHolder.run({
    index_id: h.indexId,
    agent_id: h.agentId,
    holder_type: h.holderType || 'agent',
    balance: h.balance || 0,
    avg_entry_price: h.avgEntryPrice || 0,
    realized_pnl: h.realizedPnl || 0,
    total_bought: h.totalBought || 0,
    total_sold: h.totalSold || 0,
    opened_at: h.openedAt || null,
    opened_tick: Number.isFinite(Number(h.openedTick)) ? Number(h.openedTick) : null,
    updated_at: h.updatedAt || Date.now(),
  })
}

export function getHolder(indexId, agentId) {
  const row = _getHolder.get(indexId, agentId)
  if (!row) return null
  return {
    indexId: row.index_id, agentId: row.agent_id, holderType: row.holder_type,
    balance: row.balance, avgEntryPrice: row.avg_entry_price,
    realizedPnl: row.realized_pnl, totalBought: row.total_bought,
    totalSold: row.total_sold, openedAt: row.opened_at,
    openedTick: row.opened_tick, updatedAt: row.updated_at,
  }
}

export function getHoldersByIndex(indexId) {
  return _getHoldersByIndex.all(indexId).map(r => ({
    indexId: r.index_id, agentId: r.agent_id, holderType: r.holder_type,
    balance: r.balance, avgEntryPrice: r.avg_entry_price,
    realizedPnl: r.realized_pnl, totalBought: r.total_bought,
    totalSold: r.total_sold, openedAt: r.opened_at,
    openedTick: r.opened_tick, updatedAt: r.updated_at,
  }))
}

export function countHolders(indexId) {
  return _countHolders.get(indexId)?.cnt || 0
}

export function cleanupZeroHolders(indexId) {
  _deleteZeroHolders.run(indexId)
}

// ─── Index Trades ────────────────────────────────────────────────────

const _insertIndexTrade = db.prepare(`
  INSERT INTO index_trades (id, index_id, buyer_id, seller_id, side, price, size, value, is_mint, is_burn, timestamp)
  VALUES (@id, @index_id, @buyer_id, @seller_id, @side, @price, @size, @value, @is_mint, @is_burn, @timestamp)
`)
const _getIndexTrades = db.prepare(`
  SELECT * FROM index_trades WHERE index_id = ? ORDER BY timestamp DESC LIMIT ?
`)

export function saveIndexTrade(t) {
  _insertIndexTrade.run({
    id: t.id,
    index_id: t.indexId,
    buyer_id: t.buyerId,
    seller_id: t.sellerId || null,
    side: t.side,
    price: t.price,
    size: t.size,
    value: t.value,
    is_mint: t.isMint ? 1 : 0,
    is_burn: t.isBurn ? 1 : 0,
    timestamp: t.timestamp,
  })
}

export function getIndexTrades(indexId, limit = 50) {
  return _getIndexTrades.all(indexId, limit).map(r => ({
    id: r.id, indexId: r.index_id, buyerId: r.buyer_id, sellerId: r.seller_id,
    side: r.side, price: r.price, size: r.size, value: r.value,
    isMint: !!r.is_mint, isBurn: !!r.is_burn, timestamp: r.timestamp,
  }))
}

// ─── Oracle Snapshots ────────────────────────────────────────────────

const _insertOracleSnapshot = db.prepare(`
  INSERT OR IGNORE INTO index_oracle_snapshots (index_id, price, formula_inputs_json, band_low, band_high, circulating, holder_count, timestamp)
  VALUES (@index_id, @price, @formula_inputs_json, @band_low, @band_high, @circulating, @holder_count, @timestamp)
`)
const _getOracleSnapshots = db.prepare(`
  SELECT * FROM index_oracle_snapshots WHERE index_id = ? ORDER BY timestamp DESC LIMIT ?
`)

export function saveOracleSnapshot(s) {
  _insertOracleSnapshot.run({
    index_id: s.indexId,
    price: s.price,
    formula_inputs_json: JSON.stringify(s.formulaInputs || {}),
    band_low: s.bandLow || 0,
    band_high: s.bandHigh || 0,
    circulating: s.circulating || 0,
    holder_count: s.holderCount || 0,
    timestamp: s.timestamp,
  })
}

export function getOracleSnapshots(indexId, limit = 200) {
  return _getOracleSnapshots.all(indexId, limit)
    .reverse()
    .map(r => ({
      indexId: r.index_id, price: r.price,
      formulaInputs: JSON.parse(r.formula_inputs_json || '{}'),
      bandLow: r.band_low, bandHigh: r.band_high,
      circulating: r.circulating, holderCount: r.holder_count,
      timestamp: r.timestamp,
    }))
}

// ─── Agent ↔ Index Subscriptions ─────────────────────────────────────

const _upsertSub = db.prepare(`
  INSERT INTO agent_index_subs (agent_id, index_id, subscribed_at, allocation_pct, status)
  VALUES (@agent_id, @index_id, @subscribed_at, @allocation_pct, @status)
  ON CONFLICT(agent_id, index_id) DO UPDATE SET
    allocation_pct=excluded.allocation_pct, status=excluded.status
`)
const _getSubsByAgent = db.prepare(`SELECT * FROM agent_index_subs WHERE agent_id = ? AND status = 'active'`)
const _getSubsByIndex = db.prepare(`SELECT * FROM agent_index_subs WHERE index_id = ? AND status = 'active'`)
const _deleteSub = db.prepare(`DELETE FROM agent_index_subs WHERE agent_id = ? AND index_id = ?`)
const _countSubsByIndex = db.prepare(`SELECT COUNT(*) as cnt FROM agent_index_subs WHERE index_id = ? AND status = 'active'`)

export function upsertSubscription(sub) {
  _upsertSub.run({
    agent_id: sub.agentId,
    index_id: sub.indexId,
    subscribed_at: sub.subscribedAt || Date.now(),
    allocation_pct: sub.allocationPct ?? 10,
    status: sub.status || 'active',
  })
}

export function getSubscriptionsByAgent(agentId) {
  return _getSubsByAgent.all(agentId).map(r => ({
    agentId: r.agent_id, indexId: r.index_id,
    subscribedAt: r.subscribed_at, allocationPct: r.allocation_pct, status: r.status,
  }))
}

export function getSubscriptionsByIndex(indexId) {
  return _getSubsByIndex.all(indexId).map(r => ({
    agentId: r.agent_id, indexId: r.index_id,
    subscribedAt: r.subscribed_at, allocationPct: r.allocation_pct, status: r.status,
  }))
}

export function deleteSubscription(agentId, indexId) {
  _deleteSub.run(agentId, indexId)
}

export function countSubscribers(indexId) {
  return _countSubsByIndex.get(indexId)?.cnt || 0
}

// ─── Index Feed ──────────────────────────────────────────────────────

const _insertFeedEvent = db.prepare(`
  INSERT INTO index_feed (id, index_id, event_type, severity, title, detail_json, timestamp)
  VALUES (@id, @index_id, @event_type, @severity, @title, @detail_json, @timestamp)
`)
const _getFeed = db.prepare(`
  SELECT * FROM index_feed WHERE index_id = ? ORDER BY timestamp DESC LIMIT ?
`)
const _getGlobalFeed = db.prepare(`
  SELECT * FROM index_feed ORDER BY timestamp DESC LIMIT ?
`)

export function saveFeedEvent(evt) {
  _insertFeedEvent.run({
    id: evt.id,
    index_id: evt.indexId,
    event_type: evt.eventType,
    severity: evt.severity || 'info',
    title: evt.title,
    detail_json: JSON.stringify(evt.detail || {}),
    timestamp: evt.timestamp || Date.now(),
  })
}

export function getIndexFeed(indexId, limit = 50) {
  return _getFeed.all(indexId, limit).map(r => ({
    id: r.id, indexId: r.index_id, eventType: r.event_type,
    severity: r.severity, title: r.title,
    detail: JSON.parse(r.detail_json || '{}'), timestamp: r.timestamp,
  }))
}

export function getGlobalFeed(limit = 100) {
  return _getGlobalFeed.all(limit).map(r => ({
    id: r.id, indexId: r.index_id, eventType: r.event_type,
    severity: r.severity, title: r.title,
    detail: JSON.parse(r.detail_json || '{}'), timestamp: r.timestamp,
  }))
}

// ─── Batch: save index state (called periodically) ──────────────────

export const saveIndexStateBatch = db.transaction((indexes) => {
  const now = Date.now()
  for (const idx of indexes) {
    idx.updatedAt = now
    _upsertIndex.run({
      id: idx.id,
      name: idx.name,
      symbol: idx.symbol,
      description: idx.description || '',
      formula_id: idx.formulaId,
      icon: idx.icon || '📊',
      status: idx.status || 'active',
      oracle_interval_ms: idx.oracleIntervalMs || 30000,
      last_oracle_at: idx.lastOracleAt || null,
      oracle_price: idx.oraclePrice || 0,
      prev_oracle_price: idx.prevOraclePrice || 0,
      band_width_pct: idx.bandWidthPct ?? 3.0,
      band_low: idx.bandLow || 0,
      band_high: idx.bandHigh || 0,
      max_supply: idx.maxSupply || 1000000,
      circulating_supply: idx.circulatingSupply || 0,
      initial_price: idx.initialPrice || 1.0,
      total_volume: idx.totalVolume || 0,
      total_trades: idx.totalTrades || 0,
      holder_count: idx.holderCount || 0,
      treasury_json: JSON.stringify(idx.treasury || {}),
      params_json: JSON.stringify(idx.params || {}),
      created_at: idx.createdAt || now,
      updated_at: now,
    })
  }
})

// NOTE: SIGINT/SIGTERM handlers removed — graceful shutdown is coordinated
// by server/index.js which saves state first, then calls closeDb().

// ═══════════════════════════════════════════════════════════════════════
// LLM Memory — prepared statements & exports
// ═══════════════════════════════════════════════════════════════════════

const _insertLLMDecision = db.prepare(`
  INSERT INTO llm_decisions
    (agent_id, tick, timestamp, context_summary, raw_response, action, instrument, price, size, confidence, reasoning, thinking)
  VALUES
    (@agent_id, @tick, @timestamp, @context_summary, @raw_response, @action, @instrument, @price, @size, @confidence, @reasoning, @thinking)
`)

const _getRecentLLMDecisions = db.prepare(`
  SELECT * FROM llm_decisions WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?
`)

const _getUnevaluatedLLMDecisions = db.prepare(`
  SELECT * FROM llm_decisions WHERE agent_id = ? AND outcome_tag IS NULL ORDER BY timestamp ASC
`)

const _getEvaluatedLLMDecisions = db.prepare(`
  SELECT * FROM llm_decisions WHERE agent_id = ? AND outcome_tag IS NOT NULL ORDER BY timestamp DESC LIMIT ?
`)

const _updateLLMOutcome = db.prepare(`
  UPDATE llm_decisions SET outcome_pnl = ?, outcome_tag = ?, outcome_evaluated_at = ? WHERE id = ?
`)

const _insertLLMInsight = db.prepare(`
  INSERT INTO llm_insights (agent_id, timestamp, type, content, relevance_score)
  VALUES (@agent_id, @timestamp, @type, @content, @relevance_score)
`)

const _getLLMInsights = db.prepare(`
  SELECT * FROM llm_insights WHERE agent_id = ? ORDER BY relevance_score DESC LIMIT ?
`)

const _decayLLMInsights = db.prepare(`
  UPDATE llm_insights SET relevance_score = relevance_score * ? WHERE agent_id = ?
`)

const _pruneLLMDecisions = db.prepare(`
  DELETE FROM llm_decisions WHERE agent_id = ? AND id NOT IN (
    SELECT id FROM llm_decisions WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?
  )
`)

const _insertLLMPattern = db.prepare(`
  INSERT INTO llm_learned_patterns (agent_id, pattern_type, description, conditions_json, success_rate, sample_size, created_at, updated_at)
  VALUES (@agent_id, @pattern_type, @description, @conditions_json, @success_rate, @sample_size, @created_at, @updated_at)
`)

const _getLLMPatterns = db.prepare(`
  SELECT * FROM llm_learned_patterns WHERE agent_id = ? ORDER BY success_rate DESC LIMIT ?
`)

const _updateLLMPattern = db.prepare(`
  UPDATE llm_learned_patterns SET success_rate = ?, sample_size = ?, updated_at = ? WHERE id = ?
`)

const _deleteLLMMemory = db.prepare(`DELETE FROM llm_decisions WHERE agent_id = ?`)
const _deleteLLMInsights = db.prepare(`DELETE FROM llm_insights WHERE agent_id = ?`)
const _deleteLLMPatterns = db.prepare(`DELETE FROM llm_learned_patterns WHERE agent_id = ?`)

// ── Exported functions ─────────────────────────────────────────────

export function saveLLMDecision(decision) {
  return _insertLLMDecision.run({
    agent_id:        decision.agentId,
    tick:            decision.tick,
    timestamp:       decision.timestamp || Date.now(),
    context_summary: decision.contextSummary || '',
    raw_response:    decision.rawResponse || '',
    action:          decision.action,
    instrument:      decision.instrument || 'MAIN',
    price:           decision.price || 0,
    size:            decision.size || 0,
    confidence:      decision.confidence || 0,
    reasoning:       decision.reasoning || '',
    thinking:        decision.thinking || '',
  })
}

export function getRecentLLMDecisions(agentId, limit = 50) {
  return _getRecentLLMDecisions.all(agentId, limit).map(_parseLLMDecision)
}

export function getUnevaluatedLLMDecisions(agentId) {
  return _getUnevaluatedLLMDecisions.all(agentId).map(_parseLLMDecision)
}

export function getEvaluatedLLMDecisions(agentId, limit = 20) {
  return _getEvaluatedLLMDecisions.all(agentId, limit).map(_parseLLMDecision)
}

export function updateLLMOutcome(decisionId, pnl, tag) {
  _updateLLMOutcome.run(pnl, tag, Date.now(), decisionId)
}

export function saveLLMInsight(insight) {
  return _insertLLMInsight.run({
    agent_id:        insight.agentId,
    timestamp:       insight.timestamp || Date.now(),
    type:            insight.type,
    content:         typeof insight.content === 'string' ? insight.content : JSON.stringify(insight.content),
    relevance_score: insight.relevanceScore ?? 1.0,
  })
}

export function getLLMInsights(agentId, limit = 5) {
  return _getLLMInsights.all(agentId, limit).map(r => ({
    id: r.id,
    agentId: r.agent_id,
    timestamp: r.timestamp,
    type: r.type,
    content: _tryParseJSON(r.content),
    relevanceScore: r.relevance_score,
    timesUsed: r.times_used,
    lastUsedAt: r.last_used_at,
  }))
}

export function decayLLMInsights(agentId, factor = 0.95) {
  _decayLLMInsights.run(factor, agentId)
}

export function pruneLLMDecisions(agentId, keepLast = 1000) {
  _pruneLLMDecisions.run(agentId, agentId, keepLast)
}

export function saveLLMPattern(pattern) {
  const now = Date.now()
  return _insertLLMPattern.run({
    agent_id:        pattern.agentId,
    pattern_type:    pattern.patternType || 'general',
    description:     pattern.description,
    conditions_json: JSON.stringify(pattern.conditions || {}),
    success_rate:    pattern.successRate || 0,
    sample_size:     pattern.sampleSize || 0,
    created_at:      now,
    updated_at:      now,
  })
}

export function getLLMPatterns(agentId, limit = 10) {
  return _getLLMPatterns.all(agentId, limit).map(r => ({
    id: r.id,
    agentId: r.agent_id,
    patternType: r.pattern_type,
    description: r.description,
    conditions: _tryParseJSON(r.conditions_json),
    successRate: r.success_rate,
    sampleSize: r.sample_size,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export function updateLLMPattern(patternId, successRate, sampleSize) {
  _updateLLMPattern.run(successRate, sampleSize, Date.now(), patternId)
}

export const clearLLMMemory = db.transaction((agentId) => {
  _deleteLLMMemory.run(agentId)
  _deleteLLMInsights.run(agentId)
  _deleteLLMPatterns.run(agentId)
})

function _parseLLMDecision(r) {
  return {
    id: r.id,
    agentId: r.agent_id,
    tick: r.tick,
    timestamp: r.timestamp,
    contextSummary: r.context_summary,
    rawResponse: r.raw_response,
    action: r.action,
    instrument: r.instrument,
    price: r.price,
    size: r.size,
    confidence: r.confidence,
    reasoning: r.reasoning,
    thinking: r.thinking,
    outcomePnl: r.outcome_pnl,
    outcomeTag: r.outcome_tag,
    outcomeEvaluatedAt: r.outcome_evaluated_at,
  }
}

function _tryParseJSON(s) {
  try { return JSON.parse(s) } catch { return s }
}

// ─── System State (key-value) ────────────────────────────────────────

const _upsertSystemState = db.prepare(`
  INSERT INTO system_state (key, value_json, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
`)
const _getSystemState = db.prepare(`SELECT value_json FROM system_state WHERE key = ?`)

export function saveSystemState(key, value) {
  _upsertSystemState.run(key, JSON.stringify(value), Date.now())
}

export function loadSystemState(key, defaultValue = null) {
  const row = _getSystemState.get(key)
  if (!row) return defaultValue
  try { return JSON.parse(row.value_json) } catch { return defaultValue }
}

// ═══════════════════════════════════════════════════════════════════════
// Strategy Marketplace & Custom Strategy Runtime — foundation helpers
// ═══════════════════════════════════════════════════════════════════════

const _insertStrategyTemplate = db.prepare(`
  INSERT INTO strategy_templates (
    id, owner_user_address, slug, name, short_description, category, type, visibility, status,
    complexity_score, explainability_score, created_at, updated_at
  ) VALUES (
    @id, @owner_user_address, @slug, @name, @short_description, @category, @type, @visibility, @status,
    @complexity_score, @explainability_score, @created_at, @updated_at
  )
`)
const _getStrategyTemplate = db.prepare(`SELECT * FROM strategy_templates WHERE id = ?`)
const _getStrategyTemplateBySlug = db.prepare(`SELECT * FROM strategy_templates WHERE slug = ?`)
const _listStrategyTemplatesAll = db.prepare(`SELECT * FROM strategy_templates ORDER BY updated_at DESC`)
const _updateStrategyTemplateLifecycle = db.prepare(`
  UPDATE strategy_templates
  SET visibility = ?, status = ?, updated_at = ?
  WHERE id = ?
`)

const _insertStrategyVersion = db.prepare(`
  INSERT INTO strategy_versions (
    id, strategy_template_id, version_number, changelog, definition_json, parameter_schema_json,
    trigger_schema_json, required_channels_json, runtime_requirements_json, risk_defaults_json,
    rotation_defaults_json, published_at, created_at
  ) VALUES (
    @id, @strategy_template_id, @version_number, @changelog, @definition_json, @parameter_schema_json,
    @trigger_schema_json, @required_channels_json, @runtime_requirements_json, @risk_defaults_json,
    @rotation_defaults_json, @published_at, @created_at
  )
`)
const _getStrategyVersion = db.prepare(`SELECT * FROM strategy_versions WHERE id = ?`)
const _listStrategyVersions = db.prepare(`SELECT * FROM strategy_versions WHERE strategy_template_id = ? ORDER BY version_number DESC`)
const _getLatestStrategyVersion = db.prepare(`SELECT * FROM strategy_versions WHERE strategy_template_id = ? ORDER BY version_number DESC LIMIT 1`)
const _markStrategyVersionPublished = db.prepare(`UPDATE strategy_versions SET published_at = ? WHERE id = ?`)

const _upsertStrategyMarketplaceListing = db.prepare(`
  INSERT INTO strategy_marketplace_listings (
    id, strategy_template_id, current_version_id, author_user_address, price_mode, price_value,
    install_count, active_install_count, fork_count, review_count, avg_rating,
    verified_badge, featured_rank, ranking_score, created_at, updated_at
  ) VALUES (
    @id, @strategy_template_id, @current_version_id, @author_user_address, @price_mode, @price_value,
    @install_count, @active_install_count, @fork_count, @review_count, @avg_rating,
    @verified_badge, @featured_rank, @ranking_score, @created_at, @updated_at
  )
  ON CONFLICT(strategy_template_id) DO UPDATE SET
    current_version_id=excluded.current_version_id,
    price_mode=excluded.price_mode,
    price_value=excluded.price_value,
    verified_badge=excluded.verified_badge,
    featured_rank=excluded.featured_rank,
    ranking_score=excluded.ranking_score,
    updated_at=excluded.updated_at
`)
const _getStrategyMarketplaceListing = db.prepare(`SELECT * FROM strategy_marketplace_listings WHERE strategy_template_id = ?`)
const _listAllStrategyMarketplaceListings = db.prepare(`
  SELECT
    l.*, t.slug, t.name, t.short_description, t.category, t.type, t.visibility, t.status AS template_status,
    t.owner_user_address, v.version_number, v.published_at
  FROM strategy_marketplace_listings l
  JOIN strategy_templates t ON t.id = l.strategy_template_id
  LEFT JOIN strategy_versions v ON v.id = l.current_version_id
  WHERE t.visibility = 'public' AND t.status IN ('published', 'verified')
  ORDER BY l.ranking_score DESC, l.active_install_count DESC, l.install_count DESC, l.updated_at DESC
`)
const _incrementStrategyInstallCounts = db.prepare(`
  UPDATE strategy_marketplace_listings
  SET install_count = install_count + 1,
      active_install_count = active_install_count + 1,
      updated_at = ?
  WHERE strategy_template_id = ?
`)

const _deactivateStrategyInstancesForAgent = db.prepare(`UPDATE agent_strategy_instances SET status = 'archived', updated_at = ? WHERE agent_id = ? AND status = 'active'`)
const _insertAgentStrategyInstance = db.prepare(`
  INSERT INTO agent_strategy_instances (
    id, agent_id, strategy_template_id, strategy_version_id, mode, status,
    custom_params_json, custom_risk_json, custom_rotation_json,
    installed_from_marketplace, installed_by_user, created_at, updated_at
  ) VALUES (
    @id, @agent_id, @strategy_template_id, @strategy_version_id, @mode, @status,
    @custom_params_json, @custom_risk_json, @custom_rotation_json,
    @installed_from_marketplace, @installed_by_user, @created_at, @updated_at
  )
`)
const _getActiveStrategyInstanceForAgent = db.prepare(`SELECT * FROM agent_strategy_instances WHERE agent_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`)
const _listAgentStrategyInstances = db.prepare(`SELECT * FROM agent_strategy_instances WHERE agent_id = ? ORDER BY updated_at DESC`)

const _upsertLlmSharedStrategyScope = db.prepare(`
  INSERT INTO llm_shared_strategy_scopes (
    id, scope_key, strategy_template_id, owner_user_address, creator_agent_id, creator_agent_name,
    execution_mode, memory_key, state_key, status, subscription_plan_json, metadata_json,
    created_at, updated_at, last_synced_at
  ) VALUES (
    @id, @scope_key, @strategy_template_id, @owner_user_address, @creator_agent_id, @creator_agent_name,
    @execution_mode, @memory_key, @state_key, @status, @subscription_plan_json, @metadata_json,
    @created_at, @updated_at, @last_synced_at
  )
  ON CONFLICT(scope_key) DO UPDATE SET
    strategy_template_id=excluded.strategy_template_id,
    owner_user_address=excluded.owner_user_address,
    creator_agent_id=COALESCE(excluded.creator_agent_id, llm_shared_strategy_scopes.creator_agent_id),
    creator_agent_name=COALESCE(excluded.creator_agent_name, llm_shared_strategy_scopes.creator_agent_name),
    execution_mode=excluded.execution_mode,
    memory_key=excluded.memory_key,
    state_key=excluded.state_key,
    status=excluded.status,
    updated_at=excluded.updated_at
`)
const _getLlmSharedStrategyScopeById = db.prepare(`SELECT * FROM llm_shared_strategy_scopes WHERE id = ? LIMIT 1`)
const _getLlmSharedStrategyScopeByKey = db.prepare(`SELECT * FROM llm_shared_strategy_scopes WHERE scope_key = ? LIMIT 1`)
const _listLlmSharedStrategyScopes = db.prepare(`SELECT * FROM llm_shared_strategy_scopes WHERE status = ? ORDER BY updated_at DESC`)
const _updateLlmSharedStrategyScopePlan = db.prepare(`
  UPDATE llm_shared_strategy_scopes
  SET subscription_plan_json = ?, metadata_json = ?, status = ?, updated_at = ?, last_synced_at = ?
  WHERE id = ?
`)

const _insertStrategyExecutionEvent = db.prepare(`
  INSERT INTO strategy_execution_events (
    id, strategy_instance_id, agent_id, strategy_template_id, strategy_version_id, index_id,
    mode, outcome, matched_rule_ids_json, signal_count, signals_json, context_snapshot_json, created_at
  ) VALUES (
    @id, @strategy_instance_id, @agent_id, @strategy_template_id, @strategy_version_id, @index_id,
    @mode, @outcome, @matched_rule_ids_json, @signal_count, @signals_json, @context_snapshot_json, @created_at
  )
`)
const _listStrategyExecutionEventsByAgent = db.prepare(`
  SELECT * FROM strategy_execution_events
  WHERE agent_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`)
const _listStrategyExecutionEventsByTemplate = db.prepare(`
  SELECT * FROM strategy_execution_events
  WHERE strategy_template_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`)
const _listStrategyExecutionEventsByInstance = db.prepare(`
  SELECT * FROM strategy_execution_events
  WHERE strategy_instance_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`)

const _insertStrategyRevenueEvent = db.prepare(`
  INSERT INTO strategy_revenue_events (
    id, owner_user_address, strategy_template_id, strategy_instance_id, agent_id, payer_agent_id,
    source_index_id, source_trade_id, fee_type, fee_value, protocol_fee_before,
    royalty_rate, royalty_amount, created_at
  ) VALUES (
    @id, @owner_user_address, @strategy_template_id, @strategy_instance_id, @agent_id, @payer_agent_id,
    @source_index_id, @source_trade_id, @fee_type, @fee_value, @protocol_fee_before,
    @royalty_rate, @royalty_amount, @created_at
  )
`)
const _getStrategyRevenueEvent = db.prepare(`
  SELECT e.*, t.name AS template_name, t.slug AS template_slug
  FROM strategy_revenue_events e
  LEFT JOIN strategy_templates t ON t.id = e.strategy_template_id
  WHERE e.id = ?
`)
const _listStrategyRevenueEventsByOwner = db.prepare(`
  SELECT e.*, t.name AS template_name, t.slug AS template_slug
  FROM strategy_revenue_events e
  LEFT JOIN strategy_templates t ON t.id = e.strategy_template_id
  WHERE e.owner_user_address = ?
  ORDER BY e.created_at DESC
  LIMIT ?
`)
const _listStrategyRevenueEventsByTemplate = db.prepare(`
  SELECT e.*, t.name AS template_name, t.slug AS template_slug
  FROM strategy_revenue_events e
  LEFT JOIN strategy_templates t ON t.id = e.strategy_template_id
  WHERE e.strategy_template_id = ?
  ORDER BY e.created_at DESC
  LIMIT ?
`)
const _listRecentStrategyRevenueEvents = db.prepare(`
  SELECT e.*, t.name AS template_name, t.slug AS template_slug
  FROM strategy_revenue_events e
  LEFT JOIN strategy_templates t ON t.id = e.strategy_template_id
  ORDER BY e.created_at DESC
  LIMIT ?
`)
const _getStrategyRevenueSummaryByOwner = db.prepare(`
  SELECT
    COALESCE(SUM(royalty_amount), 0) AS total_revenue,
    COUNT(*) AS event_count,
    COUNT(DISTINCT strategy_template_id) AS template_count,
    COUNT(DISTINCT agent_id) AS agent_count,
    MAX(created_at) AS last_earned_at
  FROM strategy_revenue_events
  WHERE owner_user_address = ?
`)
const _getStrategyRevenueSummaryGlobal = db.prepare(`
  SELECT
    COALESCE(SUM(royalty_amount), 0) AS total_revenue,
    COUNT(*) AS event_count,
    COUNT(DISTINCT owner_user_address) AS owner_count,
    COUNT(DISTINCT strategy_template_id) AS template_count,
    COUNT(DISTINCT agent_id) AS agent_count,
    MAX(created_at) AS last_earned_at
  FROM strategy_revenue_events
`)

const _insertSignalChannel = db.prepare(`
  INSERT INTO signal_channels (
    id, channel_type, source_ref, name, description, topic_tags_json, quality_score, status, created_at, updated_at
  ) VALUES (
    @id, @channel_type, @source_ref, @name, @description, @topic_tags_json, @quality_score, @status, @created_at, @updated_at
  )
`)
const _getSignalChannelByTypeAndSource = db.prepare(`SELECT * FROM signal_channels WHERE channel_type = ? AND source_ref IS ? LIMIT 1`)
const _getSignalChannel = db.prepare(`SELECT * FROM signal_channels WHERE id = ?`)
const _listSignalChannels = db.prepare(`SELECT * FROM signal_channels ORDER BY quality_score DESC, updated_at DESC`)

const _insertAgentChannelSubscription = db.prepare(`
  INSERT INTO agent_channel_subscriptions (
    id, agent_id, strategy_instance_id, channel_id, subscription_kind, source, weight, priority,
    status, lock_mode, subscribed_at, subscribed_tick, expires_at, metadata_json
  ) VALUES (
    @id, @agent_id, @strategy_instance_id, @channel_id, @subscription_kind, @source, @weight, @priority,
    @status, @lock_mode, @subscribed_at, @subscribed_tick, @expires_at, @metadata_json
  )
`)
const _listAgentChannelSubscriptions = db.prepare(`SELECT * FROM agent_channel_subscriptions WHERE agent_id = ? ORDER BY priority DESC, subscribed_at DESC`)

const _upsertAgentRotationPolicy = db.prepare(`
  INSERT INTO agent_rotation_policies (
    id, agent_id, strategy_instance_id, enabled, goal_mode, profile_name, interval_ticks,
    max_active_channels, min_channel_lifetime_ticks, churn_budget_per_day, max_candidate_channels,
    score_weights_json, filters_json, created_at, updated_at
  ) VALUES (
    @id, @agent_id, @strategy_instance_id, @enabled, @goal_mode, @profile_name, @interval_ticks,
    @max_active_channels, @min_channel_lifetime_ticks, @churn_budget_per_day, @max_candidate_channels,
    @score_weights_json, @filters_json, @created_at, @updated_at
  )
  ON CONFLICT(agent_id) DO UPDATE SET
    strategy_instance_id=excluded.strategy_instance_id,
    enabled=excluded.enabled,
    goal_mode=excluded.goal_mode,
    profile_name=excluded.profile_name,
    interval_ticks=excluded.interval_ticks,
    max_active_channels=excluded.max_active_channels,
    min_channel_lifetime_ticks=excluded.min_channel_lifetime_ticks,
    churn_budget_per_day=excluded.churn_budget_per_day,
    max_candidate_channels=excluded.max_candidate_channels,
    score_weights_json=excluded.score_weights_json,
    filters_json=excluded.filters_json,
    updated_at=excluded.updated_at
`)
const _getAgentRotationPolicy = db.prepare(`SELECT * FROM agent_rotation_policies WHERE agent_id = ? LIMIT 1`)

const _insertAgentRotationEvent = db.prepare(`
  INSERT INTO agent_rotation_events (
    id, agent_id, strategy_instance_id, policy_id, rotated_out_channel_id, rotated_in_channel_id,
    reason_code, before_score, after_score, details_json, created_at
  ) VALUES (
    @id, @agent_id, @strategy_instance_id, @policy_id, @rotated_out_channel_id, @rotated_in_channel_id,
    @reason_code, @before_score, @after_score, @details_json, @created_at
  )
`)
const _listAgentRotationEvents = db.prepare(`SELECT * FROM agent_rotation_events WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`)

function _parseStrategyTemplate(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerUserAddress: row.owner_user_address,
    slug: row.slug,
    name: row.name,
    shortDescription: row.short_description,
    category: row.category,
    type: row.type,
    visibility: row.visibility,
    status: row.status,
    complexityScore: row.complexity_score,
    explainabilityScore: row.explainability_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function _parseStrategyVersion(row) {
  if (!row) return null
  return {
    id: row.id,
    strategyTemplateId: row.strategy_template_id,
    versionNumber: row.version_number,
    changelog: row.changelog,
    definition: _tryParseJSON(row.definition_json) || {},
    parameterSchema: _tryParseJSON(row.parameter_schema_json) || {},
    triggerSchema: _tryParseJSON(row.trigger_schema_json) || {},
    requiredChannels: _tryParseJSON(row.required_channels_json) || [],
    runtimeRequirements: _tryParseJSON(row.runtime_requirements_json) || {},
    riskDefaults: _tryParseJSON(row.risk_defaults_json) || {},
    rotationDefaults: _tryParseJSON(row.rotation_defaults_json) || {},
    publishedAt: row.published_at,
    createdAt: row.created_at,
  }
}

function _parseStrategyMarketplaceListing(row) {
  if (!row) return null
  return {
    id: row.id,
    strategyTemplateId: row.strategy_template_id,
    currentVersionId: row.current_version_id,
    authorUserAddress: row.author_user_address,
    priceMode: row.price_mode,
    priceValue: row.price_value,
    installCount: row.install_count,
    activeInstallCount: row.active_install_count,
    forkCount: row.fork_count,
    reviewCount: row.review_count,
    avgRating: row.avg_rating,
    verifiedBadge: Boolean(row.verified_badge),
    featuredRank: row.featured_rank,
    rankingScore: row.ranking_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.name ? {
      template: {
        id: row.strategy_template_id,
        slug: row.slug,
        name: row.name,
        shortDescription: row.short_description,
        category: row.category,
        type: row.type,
        visibility: row.visibility,
        status: row.template_status,
        ownerUserAddress: row.owner_user_address,
      },
      version: {
        id: row.current_version_id,
        versionNumber: row.version_number,
        publishedAt: row.published_at,
      },
    } : {}),
  }
}

function _parseAgentStrategyInstance(row) {
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id,
    strategyTemplateId: row.strategy_template_id,
    strategyVersionId: row.strategy_version_id,
    mode: _normalizeStrategyMode(row.mode),
    status: row.status,
    customParams: _tryParseJSON(row.custom_params_json) || {},
    customRisk: _tryParseJSON(row.custom_risk_json) || {},
    customRotation: _tryParseJSON(row.custom_rotation_json) || {},
    installedFromMarketplace: Boolean(row.installed_from_marketplace),
    installedByUser: row.installed_by_user,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function _parseLlmSharedStrategyScope(row) {
  if (!row) return null
  return {
    id: row.id,
    scopeKey: row.scope_key,
    strategyTemplateId: row.strategy_template_id,
    ownerUserAddress: row.owner_user_address,
    creatorAgentId: row.creator_agent_id || null,
    creatorAgentName: row.creator_agent_name || null,
    executionMode: row.execution_mode || 'strategy_scope',
    memoryKey: row.memory_key,
    stateKey: row.state_key,
    status: row.status || 'active',
    subscriptionPlan: _tryParseJSON(row.subscription_plan_json) || [],
    metadata: _tryParseJSON(row.metadata_json) || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at || null,
  }
}

function _parseStrategyExecutionEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    strategyInstanceId: row.strategy_instance_id,
    agentId: row.agent_id,
    strategyTemplateId: row.strategy_template_id,
    strategyVersionId: row.strategy_version_id,
    indexId: row.index_id,
    mode: _normalizeStrategyMode(row.mode),
    outcome: row.outcome,
    matchedRuleIds: _tryParseJSON(row.matched_rule_ids_json) || [],
    signalCount: row.signal_count,
    signals: _tryParseJSON(row.signals_json) || [],
    contextSnapshot: _tryParseJSON(row.context_snapshot_json) || {},
    createdAt: row.created_at,
  }
}

function _parseStrategyRevenueEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerUserAddress: row.owner_user_address,
    strategyTemplateId: row.strategy_template_id,
    strategyInstanceId: row.strategy_instance_id,
    agentId: row.agent_id,
    payerAgentId: row.payer_agent_id,
    sourceIndexId: row.source_index_id,
    sourceTradeId: row.source_trade_id,
    feeType: row.fee_type,
    feeValue: row.fee_value,
    protocolFeeBefore: row.protocol_fee_before,
    royaltyRate: row.royalty_rate,
    royaltyAmount: row.royalty_amount,
    templateName: row.template_name || null,
    templateSlug: row.template_slug || null,
    createdAt: row.created_at,
  }
}

function _parseStrategyRevenueSummary(row) {
  if (!row) {
    return {
      totalRevenue: 0,
      eventCount: 0,
      ownerCount: 0,
      templateCount: 0,
      agentCount: 0,
      lastEarnedAt: null,
    }
  }
  return {
    totalRevenue: row.total_revenue || 0,
    eventCount: row.event_count || 0,
    ownerCount: row.owner_count || 0,
    templateCount: row.template_count || 0,
    agentCount: row.agent_count || 0,
    lastEarnedAt: row.last_earned_at || null,
  }
}

function _parseSignalChannel(row) {
  if (!row) return null
  return {
    id: row.id,
    channelType: row.channel_type,
    sourceRef: row.source_ref,
    name: row.name,
    description: row.description,
    topicTags: _tryParseJSON(row.topic_tags_json) || [],
    qualityScore: row.quality_score,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function _parseAgentChannelSubscription(row) {
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id,
    strategyInstanceId: row.strategy_instance_id,
    channelId: row.channel_id,
    subscriptionKind: row.subscription_kind,
    source: row.source,
    weight: row.weight,
    priority: row.priority,
    status: row.status,
    lockMode: row.lock_mode,
    subscribedAt: row.subscribed_at,
    subscribedTick: row.subscribed_tick,
    expiresAt: row.expires_at,
    metadata: _tryParseJSON(row.metadata_json) || {},
  }
}

function _parseAgentRotationPolicy(row) {
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id,
    strategyInstanceId: row.strategy_instance_id,
    enabled: Boolean(row.enabled),
    goalMode: row.goal_mode,
    profileName: row.profile_name,
    intervalTicks: row.interval_ticks,
    maxActiveChannels: row.max_active_channels,
    minChannelLifetimeTicks: row.min_channel_lifetime_ticks,
    churnBudgetPerDay: row.churn_budget_per_day,
    maxCandidateChannels: row.max_candidate_channels,
    scoreWeights: _tryParseJSON(row.score_weights_json) || {},
    filters: _tryParseJSON(row.filters_json) || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createStrategyTemplate(template) {
  _insertStrategyTemplate.run({
    id: template.id,
    owner_user_address: template.ownerUserAddress,
    slug: template.slug,
    name: template.name,
    short_description: template.shortDescription || '',
    category: template.category || 'custom',
    type: template.type || 'custom',
    visibility: template.visibility || 'private',
    status: template.status || 'draft',
    complexity_score: template.complexityScore || 0,
    explainability_score: template.explainabilityScore || 0,
    created_at: template.createdAt || Date.now(),
    updated_at: template.updatedAt || Date.now(),
  })
  return getStrategyTemplate(template.id)
}

export function getStrategyTemplate(idOrSlug) {
  return _parseStrategyTemplate(_getStrategyTemplate.get(idOrSlug) || _getStrategyTemplateBySlug.get(idOrSlug))
}

export function listStrategyTemplates({ ownerUserAddress = null } = {}) {
  const rows = _listStrategyTemplatesAll.all().map(_parseStrategyTemplate)
  return ownerUserAddress
    ? rows.filter((row) => row.ownerUserAddress === ownerUserAddress)
    : rows
}

export function updateStrategyTemplateLifecycle(templateId, { visibility, status }) {
  _updateStrategyTemplateLifecycle.run(visibility, status, Date.now(), templateId)
  return getStrategyTemplate(templateId)
}

export function createStrategyVersion(version) {
  _insertStrategyVersion.run({
    id: version.id,
    strategy_template_id: version.strategyTemplateId,
    version_number: version.versionNumber,
    changelog: version.changelog || '',
    definition_json: JSON.stringify(version.definition || {}),
    parameter_schema_json: JSON.stringify(version.parameterSchema || {}),
    trigger_schema_json: JSON.stringify(version.triggerSchema || {}),
    required_channels_json: JSON.stringify(version.requiredChannels || []),
    runtime_requirements_json: JSON.stringify(version.runtimeRequirements || {}),
    risk_defaults_json: JSON.stringify(version.riskDefaults || {}),
    rotation_defaults_json: JSON.stringify(version.rotationDefaults || {}),
    published_at: version.publishedAt || null,
    created_at: version.createdAt || Date.now(),
  })
  return getStrategyVersion(version.id)
}

export function getStrategyVersion(id) {
  return _parseStrategyVersion(_getStrategyVersion.get(id))
}

export function listStrategyVersions(templateId) {
  return _listStrategyVersions.all(templateId).map(_parseStrategyVersion)
}

export function getLatestStrategyVersionForTemplate(templateId) {
  return _parseStrategyVersion(_getLatestStrategyVersion.get(templateId))
}

export function markStrategyVersionPublished(versionId, publishedAt = Date.now()) {
  _markStrategyVersionPublished.run(publishedAt, versionId)
  return getStrategyVersion(versionId)
}

export function upsertStrategyMarketplaceListing(listing) {
  _upsertStrategyMarketplaceListing.run({
    id: listing.id,
    strategy_template_id: listing.strategyTemplateId,
    current_version_id: listing.currentVersionId,
    author_user_address: listing.authorUserAddress,
    price_mode: listing.priceMode || 'free',
    price_value: listing.priceValue ?? null,
    install_count: listing.installCount || 0,
    active_install_count: listing.activeInstallCount || 0,
    fork_count: listing.forkCount || 0,
    review_count: listing.reviewCount || 0,
    avg_rating: listing.avgRating || 0,
    verified_badge: listing.verifiedBadge ? 1 : 0,
    featured_rank: listing.featuredRank ?? null,
    ranking_score: listing.rankingScore || 0,
    created_at: listing.createdAt || Date.now(),
    updated_at: listing.updatedAt || Date.now(),
  })
  return getStrategyMarketplaceListing(listing.strategyTemplateId)
}

export function getStrategyMarketplaceListing(strategyTemplateId) {
  return _parseStrategyMarketplaceListing(_getStrategyMarketplaceListing.get(strategyTemplateId))
}

function _sortStrategyMarketplaceRows(rows, sort) {
  if (sort === 'newest') {
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }
  if (sort === 'installs') {
    rows.sort((a, b) => (b.installCount || 0) - (a.installCount || 0) || (b.activeInstallCount || 0) - (a.activeInstallCount || 0))
  }
  return rows
}

export function listStrategyMarketplaceListings({ limit = 20, category = null, sort = 'ranking' } = {}) {
  return listStrategyMarketplaceListingsPage({ limit, offset: 0, category, sort }).items
}

export function listStrategyMarketplaceListingsPage({ limit = 20, offset = 0, category = null, sort = 'ranking' } = {}) {
  const safeLimit = Math.max(1, Number(limit) || 20)
  const safeOffset = Math.max(0, Number(offset) || 0)
  const allRows = _listAllStrategyMarketplaceListings.all().map(_parseStrategyMarketplaceListing)
  const categories = Array.from(new Set(allRows.map((row) => row.template?.category || 'custom'))).sort((a, b) => a.localeCompare(b))

  let rows = allRows
  if (category) rows = rows.filter((row) => row.template?.category === category)
  rows = _sortStrategyMarketplaceRows(rows, sort)

  const total = rows.length
  const items = rows.slice(safeOffset, safeOffset + safeLimit)

  return {
    items,
    total,
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + safeLimit < total,
    categories,
  }
}

export function incrementStrategyInstallCounts(strategyTemplateId) {
  _incrementStrategyInstallCounts.run(Date.now(), strategyTemplateId)
}

export const createAgentStrategyInstance = db.transaction((instance) => {
  _deactivateStrategyInstancesForAgent.run(instance.updatedAt || Date.now(), instance.agentId)
  _insertAgentStrategyInstance.run({
    id: instance.id,
    agent_id: instance.agentId,
    strategy_template_id: instance.strategyTemplateId,
    strategy_version_id: instance.strategyVersionId,
    mode: instance.mode || 'direct',
    status: instance.status || 'active',
    custom_params_json: JSON.stringify(instance.customParams || {}),
    custom_risk_json: JSON.stringify(instance.customRisk || {}),
    custom_rotation_json: JSON.stringify(instance.customRotation || {}),
    installed_from_marketplace: instance.installedFromMarketplace ? 1 : 0,
    installed_by_user: instance.installedByUser,
    created_at: instance.createdAt || Date.now(),
    updated_at: instance.updatedAt || Date.now(),
  })
  return getActiveStrategyInstanceForAgent(instance.agentId)
})

export function ensureLlmSharedStrategyScope(scope) {
  const now = Date.now()
  _upsertLlmSharedStrategyScope.run({
    id: scope.id,
    scope_key: scope.scopeKey,
    strategy_template_id: scope.strategyTemplateId,
    owner_user_address: scope.ownerUserAddress,
    creator_agent_id: scope.creatorAgentId || null,
    creator_agent_name: scope.creatorAgentName || null,
    execution_mode: scope.executionMode || 'strategy_scope',
    memory_key: scope.memoryKey,
    state_key: scope.stateKey,
    status: scope.status || 'active',
    subscription_plan_json: JSON.stringify(scope.subscriptionPlan || []),
    metadata_json: JSON.stringify(scope.metadata || {}),
    created_at: scope.createdAt || now,
    updated_at: scope.updatedAt || now,
    last_synced_at: scope.lastSyncedAt || null,
  })
  return getLlmSharedStrategyScope(scope.scopeKey)
}

export function getLlmSharedStrategyScope(idOrKey) {
  return _parseLlmSharedStrategyScope(_getLlmSharedStrategyScopeById.get(idOrKey) || _getLlmSharedStrategyScopeByKey.get(idOrKey))
}

export function listLlmSharedStrategyScopes({ status = 'active' } = {}) {
  return _listLlmSharedStrategyScopes.all(status).map(_parseLlmSharedStrategyScope)
}

export function updateLlmSharedStrategyScopePlan(scopeId, { subscriptionPlan = [], metadata = {}, status = 'active', lastSyncedAt = Date.now() } = {}) {
  const now = Date.now()
  _updateLlmSharedStrategyScopePlan.run(
    JSON.stringify(subscriptionPlan || []),
    JSON.stringify(metadata || {}),
    status,
    now,
    lastSyncedAt || now,
    scopeId,
  )
  return getLlmSharedStrategyScope(scopeId)
}

export function getActiveStrategyInstanceForAgent(agentId) {
  return _parseAgentStrategyInstance(_getActiveStrategyInstanceForAgent.get(agentId))
}

export function listAgentStrategyInstances(agentId) {
  return _listAgentStrategyInstances.all(agentId).map(_parseAgentStrategyInstance)
}

export function createStrategyExecutionEvent(event) {
  _insertStrategyExecutionEvent.run({
    id: event.id,
    strategy_instance_id: event.strategyInstanceId,
    agent_id: event.agentId,
    strategy_template_id: event.strategyTemplateId,
    strategy_version_id: event.strategyVersionId,
    index_id: event.indexId || null,
    mode: event.mode || 'direct',
    outcome: event.outcome || 'fallback',
    matched_rule_ids_json: JSON.stringify(event.matchedRuleIds || []),
    signal_count: event.signalCount ?? 0,
    signals_json: JSON.stringify(event.signals || []),
    context_snapshot_json: JSON.stringify(event.contextSnapshot || {}),
    created_at: event.createdAt || Date.now(),
  })
}

export function listStrategyExecutionEventsByAgent(agentId, { limit = 50, strategyInstanceId = null } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  if (strategyInstanceId) {
    return _listStrategyExecutionEventsByInstance.all(strategyInstanceId, safeLimit)
      .filter((row) => row.agent_id === agentId)
      .map(_parseStrategyExecutionEvent)
  }
  return _listStrategyExecutionEventsByAgent.all(agentId, safeLimit).map(_parseStrategyExecutionEvent)
}

export function listStrategyExecutionEventsByTemplate(strategyTemplateId, { limit = 100 } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100))
  return _listStrategyExecutionEventsByTemplate.all(strategyTemplateId, safeLimit).map(_parseStrategyExecutionEvent)
}

export function createStrategyRevenueEvent(event) {
  _insertStrategyRevenueEvent.run({
    id: event.id,
    owner_user_address: event.ownerUserAddress,
    strategy_template_id: event.strategyTemplateId,
    strategy_instance_id: event.strategyInstanceId || null,
    agent_id: event.agentId || null,
    payer_agent_id: event.payerAgentId || null,
    source_index_id: event.sourceIndexId || null,
    source_trade_id: event.sourceTradeId || null,
    fee_type: event.feeType || 'trade',
    fee_value: event.feeValue ?? 0,
    protocol_fee_before: event.protocolFeeBefore ?? 0,
    royalty_rate: event.royaltyRate ?? 0,
    royalty_amount: event.royaltyAmount ?? 0,
    created_at: event.createdAt || Date.now(),
  })
  return _parseStrategyRevenueEvent(_getStrategyRevenueEvent.get(event.id))
}

export function listStrategyRevenueEventsByOwner(ownerUserAddress, { limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  return _listStrategyRevenueEventsByOwner.all(ownerUserAddress, safeLimit).map(_parseStrategyRevenueEvent)
}

export function listStrategyRevenueEventsByTemplate(strategyTemplateId, { limit = 100 } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100))
  return _listStrategyRevenueEventsByTemplate.all(strategyTemplateId, safeLimit).map(_parseStrategyRevenueEvent)
}

export function listRecentStrategyRevenueEvents({ limit = 25 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 25))
  return _listRecentStrategyRevenueEvents.all(safeLimit).map(_parseStrategyRevenueEvent)
}

export function getStrategyRevenueSummaryByOwner(ownerUserAddress) {
  return _parseStrategyRevenueSummary(_getStrategyRevenueSummaryByOwner.get(ownerUserAddress))
}

export function getStrategyRevenueSummaryGlobal() {
  return _parseStrategyRevenueSummary(_getStrategyRevenueSummaryGlobal.get())
}

export function registerSignalChannel(channel) {
  const existing = _parseSignalChannel(_getSignalChannelByTypeAndSource.get(channel.channelType, channel.sourceRef || null))
  if (existing) return existing
  _insertSignalChannel.run({
    id: channel.id,
    channel_type: channel.channelType,
    source_ref: channel.sourceRef || null,
    name: channel.name,
    description: channel.description || '',
    topic_tags_json: JSON.stringify(channel.topicTags || []),
    quality_score: channel.qualityScore || 0,
    status: channel.status || 'active',
    created_at: channel.createdAt || Date.now(),
    updated_at: channel.updatedAt || Date.now(),
  })
  return _parseSignalChannel(_getSignalChannel.get(channel.id))
}

export function listSignalChannels() {
  return _listSignalChannels.all().map(_parseSignalChannel)
}

export function upsertAgentChannelSubscription(subscription) {
  _insertAgentChannelSubscription.run({
    id: subscription.id,
    agent_id: subscription.agentId,
    strategy_instance_id: subscription.strategyInstanceId || null,
    channel_id: subscription.channelId,
    subscription_kind: subscription.subscriptionKind || 'signal',
    source: subscription.source || 'manual',
    weight: subscription.weight ?? 1,
    priority: subscription.priority ?? 0,
    status: subscription.status || 'active',
    lock_mode: subscription.lockMode || 'managed',
    subscribed_at: subscription.subscribedAt || Date.now(),
    subscribed_tick: subscription.subscribedTick ?? null,
    expires_at: subscription.expiresAt ?? null,
    metadata_json: JSON.stringify(subscription.metadata || {}),
  })
  return listAgentChannelSubscriptions(subscription.agentId).find((row) => row.id === subscription.id) || null
}

export function listAgentChannelSubscriptions(agentId) {
  return _listAgentChannelSubscriptions.all(agentId).map(_parseAgentChannelSubscription)
}

export function upsertAgentRotationPolicy(policy) {
  _upsertAgentRotationPolicy.run({
    id: policy.id,
    agent_id: policy.agentId,
    strategy_instance_id: policy.strategyInstanceId || null,
    enabled: policy.enabled ? 1 : 0,
    goal_mode: policy.goalMode || 'balanced',
    profile_name: policy.profileName || 'balanced',
    interval_ticks: policy.intervalTicks ?? 40,
    max_active_channels: policy.maxActiveChannels ?? 4,
    min_channel_lifetime_ticks: policy.minChannelLifetimeTicks ?? 20,
    churn_budget_per_day: policy.churnBudgetPerDay ?? 6,
    max_candidate_channels: policy.maxCandidateChannels ?? 12,
    score_weights_json: JSON.stringify(policy.scoreWeights || {}),
    filters_json: JSON.stringify(policy.filters || {}),
    created_at: policy.createdAt || Date.now(),
    updated_at: policy.updatedAt || Date.now(),
  })
  return getAgentRotationPolicy(policy.agentId)
}

export function getAgentRotationPolicy(agentId) {
  return _parseAgentRotationPolicy(_getAgentRotationPolicy.get(agentId))
}

export function saveAgentRotationEvent(event) {
  _insertAgentRotationEvent.run({
    id: event.id,
    agent_id: event.agentId,
    strategy_instance_id: event.strategyInstanceId || null,
    policy_id: event.policyId || null,
    rotated_out_channel_id: event.rotatedOutChannelId || null,
    rotated_in_channel_id: event.rotatedInChannelId || null,
    reason_code: event.reasonCode || 'manual',
    before_score: event.beforeScore ?? null,
    after_score: event.afterScore ?? null,
    details_json: JSON.stringify(event.details || {}),
    created_at: event.createdAt || Date.now(),
  })
}

export function getAgentRotationEvents(agentId, limit = 50) {
  return _listAgentRotationEvents.all(agentId, limit).map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    strategyInstanceId: row.strategy_instance_id,
    policyId: row.policy_id,
    rotatedOutChannelId: row.rotated_out_channel_id,
    rotatedInChannelId: row.rotated_in_channel_id,
    reasonCode: row.reason_code,
    beforeScore: row.before_score,
    afterScore: row.after_score,
    details: _tryParseJSON(row.details_json) || {},
    createdAt: row.created_at,
  }))
}

export default db
