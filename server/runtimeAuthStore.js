import { createHash, randomBytes } from 'crypto'
import pg from 'pg'
import config from './config.js'
import {
  createAdminSession as sqliteCreateAdminSession,
  createAppUser as sqliteCreateAppUser,
  createAuthSession as sqliteCreateAuthSession,
  countPersistedAdminAuditEvents as sqliteCountPersistedAdminAuditEvents,
  countPersistedAdminAuditEventsFiltered as sqliteCountPersistedAdminAuditEventsFiltered,
  cleanupExpiredAuth as sqliteCleanupExpiredAuth,
  consumeAuthNonce as sqliteConsumeAuthNonce,
  deleteAdminSession as sqliteDeleteAdminSession,
  deleteAuthSession as sqliteDeleteAuthSession,
  deleteAuthSessionsByAddress as sqliteDeleteAuthSessionsByAddress,
  getAdminSession as sqliteGetAdminSession,
  getAppUser as sqliteGetAppUser,
  getAppUserByPrimaryWallet as sqliteGetAppUserByPrimaryWallet,
  getAuthIdentity as sqliteGetAuthIdentity,
  getAuthSession as sqliteGetAuthSession,
  getLegacyAgent as sqliteGetLegacyAgent,
  getLegacyAgentsByOwner as sqliteGetLegacyAgentsByOwner,
  getNextManagedWalletAccountIndex as sqliteGetNextManagedWalletAccountIndex,
  getOracleSnapshots as sqliteGetOracleSnapshots,
  getUser as sqliteGetUser,
  getUserProfile as sqliteGetUserProfile,
  getUserWalletByAddress as sqliteGetUserWalletByAddress,
  getWallet as sqliteGetWallet,
  insertLegacyAgent as sqliteInsertLegacyAgent,
  insertManagedWalletRecord as sqliteInsertManagedWalletRecord,
  insertWallet as sqliteInsertWallet,
  issueAuthNonce as sqliteIssueAuthNonce,
  listAuthIdentitiesByUserId as sqliteListAuthIdentitiesByUserId,
  countLegacyByOwner as sqliteCountLegacyByOwner,
  listManagedWalletsByOwner as sqliteListManagedWalletsByOwner,
  listPersistedAdminAuditEvents as sqliteListPersistedAdminAuditEvents,
  listPersistedAdminAuditEventsFiltered as sqliteListPersistedAdminAuditEventsFiltered,
  listUserWalletsByUserId as sqliteListUserWalletsByUserId,
  listWalletConnectionsByOwner as sqliteListWalletConnectionsByOwner,
  loadSystemState as sqliteLoadSystemState,
  saveAdminAuditEvent as sqliteSaveAdminAuditEvent,
  upsertSubscription as sqliteUpsertSubscription,
  updateLegacyAgent as sqliteUpdateLegacyAgent,
  touchAdminSession as sqliteTouchAdminSession,
  touchAuthSession as sqliteTouchAuthSession,
  updateAppUserPrimaryWallet as sqliteUpdateAppUserPrimaryWallet,
  updateAuthSessionActiveWallet as sqliteUpdateAuthSessionActiveWallet,
  upsertAuthIdentity as sqliteUpsertAuthIdentity,
  upsertUser as sqliteUpsertUser,
  upsertUserProfile as sqliteUpsertUserProfile,
  upsertUserWallet as sqliteUpsertUserWallet,
  upsertWalletConnection as sqliteUpsertWalletConnection,
  deleteSubscription as sqliteDeleteSubscription,
  deleteLegacyAgent as sqliteDeleteLegacyAgent,
  deleteWallet as sqliteDeleteWallet,
} from './db.js'

const { Pool } = pg

const POSTGRES_ENABLED = config.db.driver === 'postgres'
const POSTGRES_SCHEMA = config.db.schema
const POSTGRES_URL = config.db.databaseUrl

const postgresPool = POSTGRES_ENABLED && POSTGRES_URL
  ? new Pool({ connectionString: POSTGRES_URL })
  : null

let ensureRuntimeAuthStorePromise = null

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

function qualifiedTable(tableName) {
  return `${quoteIdent(POSTGRES_SCHEMA)}.${quoteIdent(tableName)}`
}

function hashForStorage(value = '') {
  if (!value) return null
  return createHash('sha256').update(String(value)).digest('hex')
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parseAppUser(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    primaryWalletAddress: row.primary_wallet_address,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseAuthIdentity(row) {
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
    verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseUserWallet(row) {
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
    isActive: row.is_active == null ? true : Boolean(row.is_active),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseUserProfile(row) {
  if (!row) return null
  return {
    ownerAddress: row.owner_address,
    displayName: row.display_name,
    username: row.username,
    registrationMode: row.registration_mode,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseWalletConnection(row) {
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
    metadata: parseJson(row.metadata_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseManagedWallet(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerAddress: row.owner_address,
    walletId: row.wallet_id,
    walletAddress: row.wallet_address,
    provider: row.provider,
    mode: row.mode,
    label: row.label,
    accountIndex: row.account_index == null ? 0 : Number(row.account_index),
    derivationPath: row.derivation_path,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseWallet(row) {
  if (!row) return null
  return {
    id: row.id,
    address: row.address,
    address_bounce: row.address_bounce,
    address_raw: row.address_raw,
    mnemonic: row.mnemonic,
    public_key: row.public_key,
    secret_key: row.secret_key,
    created_at: Number(row.created_at),
  }
}

function parseLegacyAgent(row) {
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
    config: parseJson(row.config_json, {}),
    riskParams: parseJson(row.risk_params_json, {}),
    deposits: parseJson(row.deposits_json, []),
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
  }
}

function parseAdminSession(row) {
  if (!row) return null
  return {
    id: row.id,
    actorLabel: row.actor_label,
    role: row.role,
    authMode: row.auth_mode,
    localBypassEnabled: Boolean(row.local_bypass_enabled),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    lastSeenAt: Number(row.last_seen_at),
  }
}

function parseAdminAuditEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    authMode: row.auth_mode,
    role: row.admin_role,
    targetType: row.target_type,
    targetId: row.target_id,
    details: parseJson(row.details_json, {}),
    ip: row.ip,
    timestamp: Number(row.created_at),
  }
}

async function query(sql, params = []) {
  if (!postgresPool) throw new Error('DATABASE_URL must be set when DB_DRIVER=postgres')
  await ensureRuntimeAuthStoreReady()
  return postgresPool.query(sql, params)
}

export function getRuntimeAuthStoreLabel() {
  if (!POSTGRES_ENABLED) return 'SQLite (full runtime)'
  if (config.db.sqlitePath === ':memory:') {
    return 'Postgres (auth/admin runtime) + in-memory compatibility store'
  }
  return 'Postgres (auth/admin runtime) + SQLite compatibility store'
}

export async function ensureRuntimeAuthStoreReady() {
  if (!POSTGRES_ENABLED) return { driver: 'sqlite' }
  if (ensureRuntimeAuthStorePromise) return ensureRuntimeAuthStorePromise

  ensureRuntimeAuthStorePromise = (async () => {
    if (!postgresPool) throw new Error('DATABASE_URL must be set when DB_DRIVER=postgres')

    await postgresPool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(POSTGRES_SCHEMA)}`)

    const bootstrapStatements = [
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('users')} (address TEXT PRIMARY KEY, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('auth_nonces')} (address TEXT PRIMARY KEY, nonce TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('auth_sessions')} (
        id TEXT PRIMARY KEY,
        address TEXT,
        ua_hash TEXT,
        ip_hash TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        user_id TEXT,
        auth_provider TEXT,
        auth_level TEXT,
        active_wallet_address TEXT,
        privy_user_id TEXT
      )`,
      `ALTER TABLE ${qualifiedTable('auth_sessions')} ALTER COLUMN address DROP NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_auth_sessions_address')} ON ${qualifiedTable('auth_sessions')} (address)`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_auth_sessions_exp')} ON ${qualifiedTable('auth_sessions')} (expires_at)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('admin_sessions')} (
        id TEXT PRIMARY KEY,
        actor_label TEXT NOT NULL,
        role TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        local_bypass_enabled BIGINT NOT NULL DEFAULT 0,
        ua_hash TEXT,
        ip_hash TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_admin_sessions_exp')} ON ${qualifiedTable('admin_sessions')} (expires_at)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('user_profiles')} (
        owner_address TEXT PRIMARY KEY,
        display_name TEXT,
        username TEXT,
        registration_mode TEXT NOT NULL DEFAULT 'optional',
        metadata_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('wallet_connections')} (
        id TEXT PRIMARY KEY,
        owner_address TEXT,
        wallet_address TEXT NOT NULL,
        wallet_kind TEXT NOT NULL,
        wallet_provider TEXT NOT NULL,
        wallet_ref TEXT,
        label TEXT,
        is_primary BIGINT NOT NULL DEFAULT 0,
        metadata_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(wallet_address, wallet_provider)
      )`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_wallet_connections_owner')} ON ${qualifiedTable('wallet_connections')} (owner_address, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('managed_wallets')} (
        id TEXT PRIMARY KEY,
        owner_address TEXT,
        wallet_id TEXT,
        wallet_address TEXT NOT NULL,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'create',
        label TEXT,
        account_index BIGINT DEFAULT 0,
        derivation_path TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(wallet_id)
      )`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_managed_wallets_owner')} ON ${qualifiedTable('managed_wallets')} (owner_address, created_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent('idx_managed_wallets_provider_path')} ON ${qualifiedTable('managed_wallets')} (provider, derivation_path) WHERE derivation_path IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('wallets')} (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        address_bounce TEXT,
        address_raw TEXT,
        mnemonic TEXT NOT NULL,
        public_key TEXT NOT NULL,
        secret_key TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('legacy_agents')} (
        id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        name TEXT NOT NULL,
        preset TEXT,
        strategy TEXT,
        idx TEXT DEFAULT 'FLOOR',
        icon TEXT DEFAULT '🤖',
        status TEXT DEFAULT 'funding',
        wallet_id TEXT,
        wallet_address TEXT,
        wallet_address_bounce TEXT,
        wallet_public_key TEXT,
        balance DOUBLE PRECISION DEFAULT 0,
        initial_balance DOUBLE PRECISION DEFAULT 0,
        config_json TEXT DEFAULT '{}',
        risk_params_json TEXT DEFAULT '{}',
        deposits_json TEXT DEFAULT '[]',
        created_at BIGINT NOT NULL,
        started_at BIGINT
      )`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_legacy_agents_owner')} ON ${qualifiedTable('legacy_agents')} (owner_address, created_at ASC)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('index_oracle_snapshots')} (
        index_id TEXT NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        formula_inputs_json TEXT DEFAULT '{}',
        band_low DOUBLE PRECISION,
        band_high DOUBLE PRECISION,
        circulating DOUBLE PRECISION,
        holder_count BIGINT,
        timestamp BIGINT NOT NULL,
        PRIMARY KEY (index_id, timestamp)
      )`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('agent_index_subs')} (
        agent_id TEXT NOT NULL,
        index_id TEXT NOT NULL,
        subscribed_at BIGINT NOT NULL,
        allocation_pct DOUBLE PRECISION DEFAULT 10,
        status TEXT DEFAULT 'active',
        PRIMARY KEY (agent_id, index_id)
      )`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('system_state')} (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL DEFAULT '{}',
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('app_users')} (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        primary_wallet_address TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_app_users_primary_wallet')} ON ${qualifiedTable('app_users')} (primary_wallet_address)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('auth_identities')} (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES ${qualifiedTable('app_users')} (id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        identity_type TEXT NOT NULL,
        subject TEXT,
        email TEXT,
        phone TEXT,
        verified_at BIGINT,
        metadata_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(provider, provider_user_id, identity_type)
      )`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_auth_identities_user_id')} ON ${qualifiedTable('auth_identities')} (user_id)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('user_wallets')} (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES ${qualifiedTable('app_users')} (id) ON DELETE CASCADE,
        wallet_address TEXT NOT NULL,
        wallet_kind TEXT NOT NULL,
        wallet_provider TEXT NOT NULL,
        wallet_ref TEXT,
        label TEXT,
        is_primary BIGINT NOT NULL DEFAULT 0,
        is_active BIGINT NOT NULL DEFAULT 1,
        metadata_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(wallet_address, wallet_provider)
      )`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_user_wallets_user_id')} ON ${qualifiedTable('user_wallets')} (user_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable('admin_audit_events')} (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        admin_role TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details_json TEXT DEFAULT '{}',
        ip TEXT,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_admin_audit_created_at')} ON ${qualifiedTable('admin_audit_events')} (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_admin_audit_action')} ON ${qualifiedTable('admin_audit_events')} (action, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_admin_audit_role')} ON ${qualifiedTable('admin_audit_events')} (admin_role, created_at DESC)`,
    ]

    for (const statement of bootstrapStatements) {
      await postgresPool.query(statement)
    }

    return { driver: 'postgres', schema: POSTGRES_SCHEMA }
  })().catch((error) => {
    ensureRuntimeAuthStorePromise = null
    throw error
  })

  return ensureRuntimeAuthStorePromise
}

export async function upsertUser(address) {
  if (!POSTGRES_ENABLED) return sqliteUpsertUser(address)
  const now = Date.now()
  await query(`INSERT INTO ${qualifiedTable('users')} (address, created_at) VALUES ($1, $2) ON CONFLICT(address) DO NOTHING`, [address, now])
  return getUser(address)
}

export async function getUser(address) {
  if (!POSTGRES_ENABLED) return sqliteGetUser(address)
  const result = await query(`SELECT * FROM ${qualifiedTable('users')} WHERE address = $1 LIMIT 1`, [address])
  return result.rows[0] || null
}

export async function createAppUser({ id, status = 'active', primaryWalletAddress = null, metadata = {} }) {
  if (!POSTGRES_ENABLED) return sqliteCreateAppUser({ id, status, primaryWalletAddress, metadata })
  const now = Date.now()
  await query(
    `INSERT INTO ${qualifiedTable('app_users')} (id, status, primary_wallet_address, metadata_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, status, primaryWalletAddress, JSON.stringify(metadata || {}), now, now],
  )
  return getAppUser(id)
}

export async function getAppUser(id) {
  if (!POSTGRES_ENABLED) return sqliteGetAppUser(id)
  const result = await query(`SELECT * FROM ${qualifiedTable('app_users')} WHERE id = $1 LIMIT 1`, [id])
  return parseAppUser(result.rows[0])
}

export async function getAppUserByPrimaryWallet(address) {
  if (!POSTGRES_ENABLED) return sqliteGetAppUserByPrimaryWallet(address)
  const result = await query(`SELECT * FROM ${qualifiedTable('app_users')} WHERE primary_wallet_address = $1 LIMIT 1`, [address])
  return parseAppUser(result.rows[0])
}

export async function updateAppUserPrimaryWallet(userId, primaryWalletAddress) {
  if (!POSTGRES_ENABLED) return sqliteUpdateAppUserPrimaryWallet(userId, primaryWalletAddress)
  await query(
    `UPDATE ${qualifiedTable('app_users')} SET primary_wallet_address = $1, updated_at = $2 WHERE id = $3`,
    [primaryWalletAddress || null, Date.now(), userId],
  )
  return getAppUser(userId)
}

export async function getAuthIdentity(provider, providerUserId, identityType) {
  if (!POSTGRES_ENABLED) return sqliteGetAuthIdentity(provider, providerUserId, identityType)
  const result = await query(
    `SELECT * FROM ${qualifiedTable('auth_identities')} WHERE provider = $1 AND provider_user_id = $2 AND identity_type = $3 LIMIT 1`,
    [provider, providerUserId, identityType],
  )
  return parseAuthIdentity(result.rows[0])
}

export async function upsertAuthIdentity(identity) {
  if (!POSTGRES_ENABLED) return sqliteUpsertAuthIdentity(identity)
  const existing = await getAuthIdentity(identity.provider, identity.providerUserId, identity.identityType)
  const now = Date.now()
  await query(
    `INSERT INTO ${qualifiedTable('auth_identities')} (
      id, user_id, provider, provider_user_id, identity_type, subject, email, phone, verified_at, metadata_json, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT(provider, provider_user_id, identity_type) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      subject = EXCLUDED.subject,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      verified_at = EXCLUDED.verified_at,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = EXCLUDED.updated_at`,
    [
      identity.id || existing?.id || randomBytes(16).toString('hex'),
      identity.userId,
      identity.provider,
      identity.providerUserId,
      identity.identityType,
      identity.subject || null,
      identity.email || null,
      identity.phone || null,
      identity.verifiedAt || now,
      JSON.stringify(identity.metadata || {}),
      existing?.createdAt || now,
      now,
    ],
  )
  return getAuthIdentity(identity.provider, identity.providerUserId, identity.identityType)
}

export async function listAuthIdentitiesByUserId(userId) {
  if (!POSTGRES_ENABLED) return sqliteListAuthIdentitiesByUserId(userId)
  const result = await query(`SELECT * FROM ${qualifiedTable('auth_identities')} WHERE user_id = $1 ORDER BY created_at ASC`, [userId])
  return result.rows.map(parseAuthIdentity)
}

export async function getUserWalletByAddress(walletAddress, walletProvider = 'wdk-ton') {
  if (!POSTGRES_ENABLED) return sqliteGetUserWalletByAddress(walletAddress, walletProvider)
  const result = await query(
    `SELECT * FROM ${qualifiedTable('user_wallets')} WHERE wallet_address = $1 AND wallet_provider = $2 LIMIT 1`,
    [walletAddress, walletProvider],
  )
  return parseUserWallet(result.rows[0])
}

export async function upsertUserWallet(wallet) {
  if (!POSTGRES_ENABLED) return sqliteUpsertUserWallet(wallet)
  const existing = await getUserWalletByAddress(wallet.walletAddress, wallet.walletProvider)
  const now = Date.now()
  await query(
    `INSERT INTO ${qualifiedTable('user_wallets')} (
      id, user_id, wallet_address, wallet_kind, wallet_provider, wallet_ref, label, is_primary, is_active, metadata_json, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT(wallet_address, wallet_provider) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      wallet_kind = EXCLUDED.wallet_kind,
      wallet_ref = EXCLUDED.wallet_ref,
      label = EXCLUDED.label,
      is_primary = EXCLUDED.is_primary,
      is_active = EXCLUDED.is_active,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = EXCLUDED.updated_at`,
    [
      wallet.id || existing?.id || randomBytes(16).toString('hex'),
      wallet.userId,
      wallet.walletAddress,
      wallet.walletKind,
      wallet.walletProvider,
      wallet.walletRef || null,
      wallet.label || null,
      wallet.isPrimary ? 1 : 0,
      wallet.isActive === false ? 0 : 1,
      JSON.stringify(wallet.metadata || {}),
      existing?.createdAt || now,
      now,
    ],
  )
  return getUserWalletByAddress(wallet.walletAddress, wallet.walletProvider)
}

export async function listUserWalletsByUserId(userId) {
  if (!POSTGRES_ENABLED) return sqliteListUserWalletsByUserId(userId)
  const result = await query(`SELECT * FROM ${qualifiedTable('user_wallets')} WHERE user_id = $1 ORDER BY is_primary DESC, created_at ASC`, [userId])
  return result.rows.map(parseUserWallet)
}

export async function getUserProfile(ownerAddress) {
  if (!POSTGRES_ENABLED) return sqliteGetUserProfile(ownerAddress)
  const result = await query(`SELECT * FROM ${qualifiedTable('user_profiles')} WHERE owner_address = $1 LIMIT 1`, [ownerAddress])
  return parseUserProfile(result.rows[0])
}

export async function upsertUserProfile(profile) {
  if (!POSTGRES_ENABLED) return sqliteUpsertUserProfile(profile)
  const now = Date.now()
  await query(
    `INSERT INTO ${qualifiedTable('user_profiles')} (
      owner_address, display_name, username, registration_mode, metadata_json, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(owner_address) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      username = EXCLUDED.username,
      registration_mode = EXCLUDED.registration_mode,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = EXCLUDED.updated_at`,
    [
      profile.ownerAddress,
      profile.displayName || null,
      profile.username || null,
      profile.registrationMode || 'optional',
      JSON.stringify(profile.metadata || {}),
      profile.createdAt || now,
      profile.updatedAt || now,
    ],
  )
  return getUserProfile(profile.ownerAddress)
}

async function getWalletConnectionByAddress(walletAddress, walletProvider) {
  const result = await query(
    `SELECT * FROM ${qualifiedTable('wallet_connections')} WHERE wallet_address = $1 AND wallet_provider = $2 LIMIT 1`,
    [walletAddress, walletProvider],
  )
  return parseWalletConnection(result.rows[0])
}

export async function upsertWalletConnection(connection) {
  if (!POSTGRES_ENABLED) return sqliteUpsertWalletConnection(connection)
  const now = Date.now()
  await query(
    `INSERT INTO ${qualifiedTable('wallet_connections')} (
      id, owner_address, wallet_address, wallet_kind, wallet_provider, wallet_ref, label, is_primary, metadata_json, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT(wallet_address, wallet_provider) DO UPDATE SET
      owner_address = EXCLUDED.owner_address,
      wallet_kind = EXCLUDED.wallet_kind,
      wallet_ref = EXCLUDED.wallet_ref,
      label = EXCLUDED.label,
      is_primary = EXCLUDED.is_primary,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = EXCLUDED.updated_at`,
    [
      connection.id,
      connection.ownerAddress || null,
      connection.walletAddress,
      connection.walletKind,
      connection.walletProvider,
      connection.walletRef || null,
      connection.label || null,
      connection.isPrimary ? 1 : 0,
      JSON.stringify(connection.metadata || {}),
      connection.createdAt || now,
      connection.updatedAt || now,
    ],
  )
  return getWalletConnectionByAddress(connection.walletAddress, connection.walletProvider)
}

export async function listWalletConnectionsByOwner(ownerAddress) {
  if (!POSTGRES_ENABLED) return sqliteListWalletConnectionsByOwner(ownerAddress)
  const result = await query(`SELECT * FROM ${qualifiedTable('wallet_connections')} WHERE owner_address = $1 ORDER BY is_primary DESC, created_at ASC`, [ownerAddress])
  return result.rows.map(parseWalletConnection)
}

export async function insertManagedWalletRecord(record) {
  if (!POSTGRES_ENABLED) return sqliteInsertManagedWalletRecord(record)
  const now = Date.now()
  const result = await query(
    `INSERT INTO ${qualifiedTable('managed_wallets')} (
      id, owner_address, wallet_id, wallet_address, provider, mode, label, account_index, derivation_path, status, metadata_json, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *`,
    [
      record.id,
      record.ownerAddress || null,
      record.walletId,
      record.walletAddress,
      record.provider,
      record.mode || 'create',
      record.label || null,
      record.accountIndex || 0,
      record.derivationPath || null,
      record.status || 'active',
      JSON.stringify(record.metadata || {}),
      record.createdAt || now,
      record.updatedAt || now,
    ],
  )
  return parseManagedWallet(result.rows[0])
}

export async function listManagedWalletsByOwner(ownerAddress) {
  if (!POSTGRES_ENABLED) return sqliteListManagedWalletsByOwner(ownerAddress)
  const result = await query(`SELECT * FROM ${qualifiedTable('managed_wallets')} WHERE owner_address = $1 ORDER BY created_at ASC`, [ownerAddress])
  return result.rows.map(parseManagedWallet)
}

export async function getOracleSnapshots(indexId, limit = 200) {
  if (!POSTGRES_ENABLED) return sqliteGetOracleSnapshots(indexId, limit)
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200))
  const result = await query(
    `SELECT index_id, price, formula_inputs_json, band_low, band_high, circulating, holder_count, timestamp
    FROM ${qualifiedTable('index_oracle_snapshots')}
    WHERE index_id = $1
    ORDER BY timestamp DESC
    LIMIT $2`,
    [indexId, safeLimit],
  )
  const rows = [...result.rows].reverse().map((row) => ({
    indexId: row.index_id,
    price: Number(row.price || 0),
    formulaInputs: parseJson(row.formula_inputs_json, {}),
    bandLow: Number(row.band_low || 0),
    bandHigh: Number(row.band_high || 0),
    circulating: Number(row.circulating || 0),
    holderCount: Number(row.holder_count || 0),
    timestamp: Number(row.timestamp || 0),
  }))

  // During partial migration oracle snapshots can still be produced by SQLite paths.
  if (rows.length === 0) return sqliteGetOracleSnapshots(indexId, safeLimit)
  return rows
}

export async function upsertSubscription(sub) {
  if (!POSTGRES_ENABLED) return sqliteUpsertSubscription(sub)
  await query(
    `INSERT INTO ${qualifiedTable('agent_index_subs')} (agent_id, index_id, subscribed_at, allocation_pct, status)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (agent_id, index_id)
    DO UPDATE SET
      allocation_pct = EXCLUDED.allocation_pct,
      status = EXCLUDED.status`,
    [
      sub.agentId,
      sub.indexId,
      sub.subscribedAt || Date.now(),
      sub.allocationPct ?? 10,
      sub.status || 'active',
    ],
  )
}

export async function deleteSubscription(agentId, indexId) {
  if (!POSTGRES_ENABLED) return sqliteDeleteSubscription(agentId, indexId)
  await query(`DELETE FROM ${qualifiedTable('agent_index_subs')} WHERE agent_id = $1 AND index_id = $2`, [agentId, indexId])
}

export async function loadSystemState(key, defaultValue = null) {
  if (!POSTGRES_ENABLED) return sqliteLoadSystemState(key, defaultValue)
  const result = await query(`SELECT value_json FROM ${qualifiedTable('system_state')} WHERE key = $1 LIMIT 1`, [key])
  const row = result.rows[0]
  if (!row) return defaultValue
  return parseJson(row.value_json, defaultValue)
}

export async function insertWallet(wallet) {
  if (!POSTGRES_ENABLED) return sqliteInsertWallet(wallet)
  await query(
    `INSERT INTO ${qualifiedTable('wallets')} (id, address, address_bounce, address_raw, mnemonic, public_key, secret_key, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      wallet.id,
      wallet.address,
      wallet.address_bounce || null,
      wallet.address_raw || null,
      wallet.mnemonic,
      wallet.public_key,
      wallet.secret_key,
      wallet.created_at,
    ],
  )
  return wallet
}

export async function getWallet(id) {
  if (!POSTGRES_ENABLED) return sqliteGetWallet(id)
  const result = await query(`SELECT * FROM ${qualifiedTable('wallets')} WHERE id = $1 LIMIT 1`, [id])
  return parseWallet(result.rows[0])
}

export async function deleteWallet(id) {
  if (!POSTGRES_ENABLED) return sqliteDeleteWallet(id)
  await query(`DELETE FROM ${qualifiedTable('wallets')} WHERE id = $1`, [id])
}

export async function insertLegacyAgent(agent) {
  if (!POSTGRES_ENABLED) return sqliteInsertLegacyAgent(agent)
  await query(
    `INSERT INTO ${qualifiedTable('legacy_agents')} (
      id, owner_address, name, preset, strategy, idx, icon, status,
      wallet_id, wallet_address, wallet_address_bounce, wallet_public_key,
      balance, initial_balance, config_json, risk_params_json, deposits_json, created_at, started_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18, $19
    )`,
    [
      agent.id,
      agent.ownerAddress,
      agent.name,
      agent.preset || null,
      agent.strategy || 'mean_reversion',
      agent.index || 'FLOOR',
      agent.icon || '🤖',
      agent.status || 'funding',
      agent.walletId || null,
      agent.walletAddress || null,
      agent.walletAddressBounceable || null,
      agent.walletPublicKey || null,
      agent.balance || 0,
      agent.initialBalance || 0,
      JSON.stringify(agent.config || {}),
      JSON.stringify(agent.riskParams || {}),
      JSON.stringify(agent.deposits || []),
      agent.createdAt,
      agent.startedAt || null,
    ],
  )
  return agent
}

export async function getLegacyAgent(id) {
  if (!POSTGRES_ENABLED) return sqliteGetLegacyAgent(id)
  const result = await query(`SELECT * FROM ${qualifiedTable('legacy_agents')} WHERE id = $1 LIMIT 1`, [id])
  return parseLegacyAgent(result.rows[0])
}

export async function getLegacyAgentsByOwner(ownerAddress) {
  if (!POSTGRES_ENABLED) return sqliteGetLegacyAgentsByOwner(ownerAddress)
  const result = await query(`SELECT * FROM ${qualifiedTable('legacy_agents')} WHERE owner_address = $1 ORDER BY created_at ASC`, [ownerAddress])
  return result.rows.map(parseLegacyAgent)
}

export async function countLegacyByOwner(ownerAddress) {
  if (!POSTGRES_ENABLED) return sqliteCountLegacyByOwner(ownerAddress)
  const result = await query(`SELECT COUNT(*)::bigint AS cnt FROM ${qualifiedTable('legacy_agents')} WHERE owner_address = $1`, [ownerAddress])
  return Number(result.rows[0]?.cnt || 0)
}

export async function updateLegacyAgent(agent) {
  if (!POSTGRES_ENABLED) return sqliteUpdateLegacyAgent(agent)
  await query(
    `UPDATE ${qualifiedTable('legacy_agents')}
    SET name = $1,
        config_json = $2,
        risk_params_json = $3,
        status = $4,
        balance = $5,
        initial_balance = $6,
        deposits_json = $7,
        started_at = $8
    WHERE id = $9`,
    [
      agent.name,
      JSON.stringify(agent.config || {}),
      JSON.stringify(agent.riskParams || {}),
      agent.status,
      agent.balance || 0,
      agent.initialBalance || 0,
      JSON.stringify(agent.deposits || []),
      agent.startedAt || null,
      agent.id,
    ],
  )
}

export async function deleteLegacyAgent(id) {
  if (!POSTGRES_ENABLED) return sqliteDeleteLegacyAgent(id)
  await query(`DELETE FROM ${qualifiedTable('legacy_agents')} WHERE id = $1`, [id])
}

export async function getNextManagedWalletAccountIndex(provider = 'wdk-ton') {
  if (!POSTGRES_ENABLED) return sqliteGetNextManagedWalletAccountIndex(provider)
  const result = await query(
    `SELECT COALESCE(MAX(account_index), -1) + 1 AS next_index FROM ${qualifiedTable('managed_wallets')} WHERE provider = $1`,
    [provider],
  )
  return Number(result.rows[0]?.next_index || 0)
}

export async function issueAuthNonce(address, ttlMs = 5 * 60 * 1000) {
  if (!POSTGRES_ENABLED) return sqliteIssueAuthNonce(address, ttlMs)
  const now = Date.now()
  const nonce = randomBytes(24).toString('hex')
  await query(
    `INSERT INTO ${qualifiedTable('auth_nonces')} (address, nonce, created_at, expires_at) VALUES ($1, $2, $3, $4)
    ON CONFLICT(address) DO UPDATE SET nonce = EXCLUDED.nonce, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
    [address, nonce, now, now + ttlMs],
  )
  return { address, nonce, expiresAt: now + ttlMs }
}

export async function consumeAuthNonce(address, nonce) {
  if (!POSTGRES_ENABLED) return sqliteConsumeAuthNonce(address, nonce)
  const result = await query(`SELECT * FROM ${qualifiedTable('auth_nonces')} WHERE address = $1 LIMIT 1`, [address])
  const row = result.rows[0]
  await query(`DELETE FROM ${qualifiedTable('auth_nonces')} WHERE address = $1`, [address])
  if (!row) return false
  return row.nonce === nonce && Number(row.expires_at) > Date.now()
}

export async function createAuthSession({
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
  if (!POSTGRES_ENABLED) {
    return sqliteCreateAuthSession({ address, userAgent, ip, ttlMs, userId, authProvider, authLevel, activeWalletAddress, privyUserId })
  }
  const now = Date.now()
  const id = randomBytes(32).toString('hex')
  const resolvedActiveWalletAddress = activeWalletAddress || address || null
  await query(
    `INSERT INTO ${qualifiedTable('auth_sessions')} (
      id, address, ua_hash, ip_hash, created_at, expires_at, last_seen_at, user_id, auth_provider, auth_level, active_wallet_address, privy_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      resolvedActiveWalletAddress || address,
      hashForStorage(userAgent),
      hashForStorage(ip),
      now,
      now + ttlMs,
      now,
      userId,
      authProvider,
      authLevel,
      resolvedActiveWalletAddress,
      privyUserId,
    ],
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

export async function getAuthSession(id) {
  if (!POSTGRES_ENABLED) return sqliteGetAuthSession(id)
  const result = await query(`SELECT * FROM ${qualifiedTable('auth_sessions')} WHERE id = $1 LIMIT 1`, [id])
  return result.rows[0] || null
}

export async function touchAuthSession(id) {
  if (!POSTGRES_ENABLED) return sqliteTouchAuthSession(id)
  await query(`UPDATE ${qualifiedTable('auth_sessions')} SET last_seen_at = $1 WHERE id = $2`, [Date.now(), id])
}

export async function updateAuthSessionActiveWallet(id, walletAddress) {
  if (!POSTGRES_ENABLED) return sqliteUpdateAuthSessionActiveWallet(id, walletAddress)
  await query(
    `UPDATE ${qualifiedTable('auth_sessions')} SET address = $1, active_wallet_address = $2, last_seen_at = $3 WHERE id = $4`,
    [walletAddress, walletAddress, Date.now(), id],
  )
  return getAuthSession(id)
}

export async function deleteAuthSession(id) {
  if (!POSTGRES_ENABLED) return sqliteDeleteAuthSession(id)
  await query(`DELETE FROM ${qualifiedTable('auth_sessions')} WHERE id = $1`, [id])
}

export async function deleteAuthSessionsByAddress(address) {
  if (!POSTGRES_ENABLED) return sqliteDeleteAuthSessionsByAddress(address)
  await query(`DELETE FROM ${qualifiedTable('auth_sessions')} WHERE address = $1`, [address])
}

export async function createAdminSession({
  actorLabel,
  role,
  authMode,
  localBypassEnabled = false,
  userAgent = '',
  ip = '',
  ttlMs = 12 * 60 * 60 * 1000,
}) {
  if (!POSTGRES_ENABLED) {
    return sqliteCreateAdminSession({ actorLabel, role, authMode, localBypassEnabled, userAgent, ip, ttlMs })
  }
  const now = Date.now()
  const id = randomBytes(32).toString('hex')
  await query(
    `INSERT INTO ${qualifiedTable('admin_sessions')} (
      id, actor_label, role, auth_mode, local_bypass_enabled, ua_hash, ip_hash, created_at, expires_at, last_seen_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      actorLabel,
      role,
      authMode,
      localBypassEnabled ? 1 : 0,
      hashForStorage(userAgent),
      hashForStorage(ip),
      now,
      now + ttlMs,
      now,
    ],
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

export async function getAdminSession(id) {
  if (!POSTGRES_ENABLED) return sqliteGetAdminSession(id)
  const result = await query(`SELECT * FROM ${qualifiedTable('admin_sessions')} WHERE id = $1 LIMIT 1`, [id])
  return parseAdminSession(result.rows[0])
}

export async function touchAdminSession(id) {
  if (!POSTGRES_ENABLED) return sqliteTouchAdminSession(id)
  await query(`UPDATE ${qualifiedTable('admin_sessions')} SET last_seen_at = $1 WHERE id = $2`, [Date.now(), id])
}

export async function deleteAdminSession(id) {
  if (!POSTGRES_ENABLED) return sqliteDeleteAdminSession(id)
  await query(`DELETE FROM ${qualifiedTable('admin_sessions')} WHERE id = $1`, [id])
}

export async function cleanupExpiredAuth() {
  if (!POSTGRES_ENABLED) return sqliteCleanupExpiredAuth()
  const now = Date.now()
  const nonceResult = await query(`DELETE FROM ${qualifiedTable('auth_nonces')} WHERE expires_at < $1`, [now])
  const sessionResult = await query(`DELETE FROM ${qualifiedTable('auth_sessions')} WHERE expires_at < $1`, [now])
  const adminSessionResult = await query(`DELETE FROM ${qualifiedTable('admin_sessions')} WHERE expires_at < $1`, [now])
  return {
    nonces: nonceResult.rowCount || 0,
    sessions: sessionResult.rowCount || 0,
    adminSessions: adminSessionResult.rowCount || 0,
  }
}

export async function saveAdminAuditEvent(event) {
  if (!POSTGRES_ENABLED) return sqliteSaveAdminAuditEvent(event)
  await query(
    `INSERT INTO ${qualifiedTable('admin_audit_events')} (
      id, action, actor, auth_mode, admin_role, target_type, target_id, details_json, ip, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT(id) DO UPDATE SET
      action = EXCLUDED.action,
      actor = EXCLUDED.actor,
      auth_mode = EXCLUDED.auth_mode,
      admin_role = EXCLUDED.admin_role,
      target_type = EXCLUDED.target_type,
      target_id = EXCLUDED.target_id,
      details_json = EXCLUDED.details_json,
      ip = EXCLUDED.ip,
      created_at = EXCLUDED.created_at`,
    [
      event.id,
      event.action,
      event.actor,
      event.authMode || 'unknown',
      event.role || 'viewer',
      event.targetType || null,
      event.targetId || null,
      JSON.stringify(event.details || {}),
      event.ip || null,
      event.timestamp || Date.now(),
    ],
  )
}

export async function listPersistedAdminAuditEvents(limit = 50) {
  if (!POSTGRES_ENABLED) return sqliteListPersistedAdminAuditEvents(limit)
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)
  const result = await query(`SELECT * FROM ${qualifiedTable('admin_audit_events')} ORDER BY created_at DESC LIMIT $1`, [safeLimit])
  return result.rows.map(parseAdminAuditEvent)
}

export async function listPersistedAdminAuditEventsFiltered(filters = {}) {
  if (!POSTGRES_ENABLED) return sqliteListPersistedAdminAuditEventsFiltered(filters)
  const safeLimit = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 500)
  const search = String(filters.query || '').trim().toLowerCase()
  const likeQuery = search ? `%${search}%` : null
  const result = await query(
    `SELECT *
    FROM ${qualifiedTable('admin_audit_events')}
    WHERE ($1::text IS NULL OR auth_mode = $1)
      AND ($2::text IS NULL OR action = $2)
      AND ($3::text IS NULL OR actor = $3)
      AND ($4::text IS NULL OR target_type = $4)
      AND ($5::text IS NULL OR (
        lower(coalesce(action, '')) LIKE $5
        OR lower(coalesce(actor, '')) LIKE $5
        OR lower(coalesce(auth_mode, '')) LIKE $5
        OR lower(coalesce(target_type, '')) LIKE $5
        OR lower(coalesce(target_id, '')) LIKE $5
        OR lower(coalesce(details_json, '')) LIKE $5
      ))
    ORDER BY created_at DESC
    LIMIT $6`,
    [filters.authMode || null, filters.action || null, filters.actor || null, filters.targetType || null, likeQuery, safeLimit],
  )
  return result.rows.map(parseAdminAuditEvent)
}

export async function countPersistedAdminAuditEvents() {
  if (!POSTGRES_ENABLED) return sqliteCountPersistedAdminAuditEvents()
  const result = await query(`SELECT COUNT(*)::bigint AS total FROM ${qualifiedTable('admin_audit_events')}`)
  return Number(result.rows[0]?.total || 0)
}

export async function countPersistedAdminAuditEventsFiltered(filters = {}) {
  if (!POSTGRES_ENABLED) return sqliteCountPersistedAdminAuditEventsFiltered(filters)
  const search = String(filters.query || '').trim().toLowerCase()
  const likeQuery = search ? `%${search}%` : null
  const result = await query(
    `SELECT COUNT(*)::bigint AS total
    FROM ${qualifiedTable('admin_audit_events')}
    WHERE ($1::text IS NULL OR auth_mode = $1)
      AND ($2::text IS NULL OR action = $2)
      AND ($3::text IS NULL OR actor = $3)
      AND ($4::text IS NULL OR target_type = $4)
      AND ($5::text IS NULL OR (
        lower(coalesce(action, '')) LIKE $5
        OR lower(coalesce(actor, '')) LIKE $5
        OR lower(coalesce(auth_mode, '')) LIKE $5
        OR lower(coalesce(target_type, '')) LIKE $5
        OR lower(coalesce(target_id, '')) LIKE $5
        OR lower(coalesce(details_json, '')) LIKE $5
      ))`,
    [filters.authMode || null, filters.action || null, filters.actor || null, filters.targetType || null, likeQuery],
  )
  return Number(result.rows[0]?.total || 0)
}

export async function closeRuntimeAuthStore() {
  if (!POSTGRES_ENABLED || !postgresPool) return
  await postgresPool.end()
}
