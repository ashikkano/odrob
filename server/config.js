// ═══════════════════════════════════════════════════════════════════════
// Server Configuration — Environment-based settings
// ═══════════════════════════════════════════════════════════════════════

import { loadLocalEnv } from '../scripts/loadLocalEnv.js'

loadLocalEnv({ overrideProcessEnv: true })

const nodeEnv = process.env.NODE_ENV || 'development'
const isProd = nodeEnv === 'production'
const dbDriver = process.env.DB_DRIVER || (isProd ? 'postgres' : 'sqlite')
const defaultCorsOrigins = process.env.PUBLIC_WEB_ORIGIN
  ? [process.env.PUBLIC_WEB_ORIGIN]
  : ['http://localhost:3000', 'http://localhost:5173']

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 3001,
  nodeEnv,
  isProd,
  publicWebOrigin: process.env.PUBLIC_WEB_ORIGIN || null,
  appDomain: process.env.APP_DOMAIN || null,

  // CORS
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : defaultCorsOrigins,

  // Admin
  adminApiKey: process.env.ADMIN_API_KEY || null,
  adminAllowLocalBypass: process.env.ALLOW_DEV_ADMIN_LOCAL_ONLY === 'true',
  adminDefaultRole: process.env.ADMIN_DEFAULT_ROLE || 'owner',
  adminLocalBypassRole: process.env.ADMIN_LOCAL_BYPASS_ROLE || 'owner',
  adminAllowProviderLoopback: process.env.ALLOW_DEV_EXTERNAL_PROVIDER_LOOPBACK === 'true',
  adminSessionCookie: process.env.ADMIN_SESSION_COOKIE || 'odrob_admin_sid',
  adminSessionTtlMs: parseInt(process.env.ADMIN_SESSION_TTL_MS) || (12 * 60 * 60 * 1000),

  // TON Network
  tonNetwork: process.env.TON_NETWORK || 'testnet',
  isTestnet: (process.env.TON_NETWORK || 'testnet') === 'testnet',
  tonApiBase: (process.env.TON_NETWORK || 'testnet') === 'testnet'
    ? 'https://testnet.toncenter.com/api/v2'
    : 'https://toncenter.com/api/v2',

  managedWallets: {
    masterSeed: process.env.WDK_MASTER_SEED || process.env.MANAGED_WALLET_MASTER_SEED || null,
  },

  privy: {
    enabled: process.env.PRIVY_ENABLED === 'true',
    appId: process.env.PRIVY_APP_ID || null,
    appSecret: process.env.PRIVY_APP_SECRET || null,
    verificationKey: process.env.PRIVY_VERIFICATION_KEY || null,
    autoProvisionWdkWallet: process.env.PRIVY_AUTO_PROVISION_WDK_WALLET !== 'false',
  },

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,    // 1 minute
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX) || 600,           // per window; lite/public UI polls multiple endpoints continuously
    authMaxRequests: parseInt(process.env.RATE_LIMIT_AUTH_MAX) || 20,   // stricter for auth
    adminMaxRequests: parseInt(process.env.RATE_LIMIT_ADMIN_MAX) || 50, // admin routes
  },

  // Request limits
  maxJsonBodySize: process.env.MAX_JSON_BODY || '1mb',

  externalProviders: {
    fetchTimeoutMs: parseInt(process.env.EXTERNAL_PROVIDER_FETCH_TIMEOUT_MS, 10) || 8000,
    maxResponseBytes: parseInt(process.env.EXTERNAL_PROVIDER_MAX_RESPONSE_BYTES, 10) || (256 * 1024),
  },

  db: {
    driver: dbDriver,
    databaseUrl: process.env.DATABASE_URL || null,
    sqlitePath: process.env.SQLITE_PATH || (dbDriver === 'postgres' ? ':memory:' : 'server/data/odrob.db'),
    schema: process.env.PGSCHEMA || 'public',
  },

  // Auth session/challenge
  auth: {
    sessionCookieName: process.env.AUTH_SESSION_COOKIE || 'odrob_sid',
    sessionTtlMs: parseInt(process.env.AUTH_SESSION_TTL_MS) || (7 * 24 * 60 * 60 * 1000), // 7 days
    challengeTtlMs: parseInt(process.env.AUTH_CHALLENGE_TTL_MS) || (5 * 60 * 1000),        // 5 minutes
  },
}

export default config
