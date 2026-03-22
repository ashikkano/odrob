// ═══════════════════════════════════════════════════════════════════════
// ODROB Backend Server v4 — Production-ready with security hardening
// Full API: autonomous agent engine + user wallet auth
// ═══════════════════════════════════════════════════════════════════════

import { loadLocalEnv } from '../scripts/loadLocalEnv.js'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'

loadLocalEnv({ overrideProcessEnv: true })

// Config
import config from './config.js'

// Middleware
import {
  standardLimiter,
  globalErrorHandler, notFoundHandler, setupProcessErrorHandlers,
  requestLogger,
} from './middleware/index.js'

// Engine imports
import { AgentManager } from './engine/agentManager.js'
import { seedAgents } from './engine/seedAgents.js'
import { IndexRegistry } from './engine/indexRegistry.js'
import { IndexMarketMaker } from './engine/indexMarketMaker.js'
import { AgentIndexFactory } from './engine/agentIndexFactory.js'

// Setup process-level error handlers (unhandledRejection, uncaughtException)
setupProcessErrorHandlers()

import {
  saveUserAgent, getAllUserAgents,
  saveTrade, getTradesByAgent,
  saveDecision, getDecisionsByAgent,
  saveEquityPoint, getEquityByAgent,
  saveUserAgentsBatch,
  // Index system (for IndexRegistry init)
  upsertIndex, getIndex, getAllIndexes, getActiveIndexes,
  upsertHolder, getHolder, getHoldersByIndex, countHolders, cleanupZeroHolders,
  saveIndexTrade, getIndexTrades,
  saveOracleSnapshot, getOracleSnapshots,
  upsertSubscription, getSubscriptionsByAgent, getSubscriptionsByIndex,
  deleteSubscription, countSubscribers,
  saveFeedEvent, getIndexFeed, getGlobalFeed,
  saveIndexStateBatch,
  getAgentRotationPolicy,
  getAgentRotationEvents,
  saveAgentRotationEvent,
  closeDb,
  rawDb,
} from './runtimeEngineStore.js'
import {
  ensureLlmSharedStrategyScope,
  getLlmSharedStrategyScope,
  listLlmSharedStrategyScopes,
  updateLlmSharedStrategyScopePlan,
} from './runtimeStrategyStore.js'

import { setupRetentionPolicy } from './utils/retention.js'
import { normalizeAddr } from './utils/tonAddress.js'
import { createTonWalletService } from './services/tonWallet.js'
import { createWdkWalletService } from './services/wdkWallet.js'
import { createWalletProviderRegistry } from './services/walletProviderRegistry.js'
import { createUserManagedWalletProvisioningService } from './services/userManagedWalletProvisioning.js'
import { createPrivyAuthService } from './services/privyAuth.js'
import { createSessionAuth } from './middleware/sessionAuth.js'
import { CustomStrategyRuntime } from './engine/customStrategyRuntime.js'
import { ensureSeededMarketplaceStrategies } from './services/strategyMarketplaceService.js'
import onboardingRoutes from './routes/onboarding.js'
import {
  cleanupExpiredAuth,
  createAppUser,
  createAuthSession,
  ensureRuntimeAuthStoreReady,
  getAppUser,
  getAppUserByPrimaryWallet,
  getAuthIdentity,
  getAuthSession,
  getUser,
  getNextManagedWalletAccountIndex,
  getRuntimeAuthStoreLabel,
  getUserWalletByAddress,
  getWallet,
  listAuthIdentitiesByUserId,
  listManagedWalletsByOwner,
  listUserWalletsByUserId,
  listWalletConnectionsByOwner,
  deleteWallet,
  touchAuthSession,
  updateAppUserPrimaryWallet,
  updateAuthSessionActiveWallet,
  insertWallet,
  upsertAuthIdentity,
  insertManagedWalletRecord,
  upsertUser,
  upsertUserWallet,
  upsertWalletConnection,
} from './runtimeAuthStore.js'

// ─── TON Network Config (from centralized config) ────────────────────

const IS_TESTNET = config.isTestnet
const TON_API_BASE = config.tonApiBase
const customStrategyRuntime = new CustomStrategyRuntime()

const { createTonWallet, getTonBalance, deleteTonWalletById } = createTonWalletService({
  insertWallet,
  getWallet,
  deleteWallet,
  isTestnet: IS_TESTNET,
  tonApiBase: TON_API_BASE,
})

const wdkWalletService = createWdkWalletService({
  insertWallet,
  getWallet,
  deleteWallet,
  getNextManagedWalletAccountIndex,
  isTestnet: IS_TESTNET,
  tonApiBase: TON_API_BASE,
  masterSeed: config.managedWallets.masterSeed,
})

const walletProviderRegistry = createWalletProviderRegistry({
  wdkWalletService,
})

const managedWalletProvisioning = createUserManagedWalletProvisioningService({
  walletProviderRegistry,
  upsertUser,
  upsertWalletConnection,
  insertManagedWalletRecord,
  upsertUserWallet,
  listUserWalletsByUserId,
  getAppUser,
  updateAppUserPrimaryWallet,
})

const privyAuthService = createPrivyAuthService({
  config: config.privy,
})

await ensureRuntimeAuthStoreReady()

const { attachSessionUser, auth } = createSessionAuth({
  getAuthSession,
  touchAuthSession,
  getUser,
  sessionCookieName: config.auth.sessionCookieName,
  normalizeAddr,
})

// ── Restore user agents from the compatibility persistence store ─────
function restoreUserAgents(engine) {
  const saved = getAllUserAgents()
  if (saved.length === 0) return
  console.log(`📂 Restoring ${saved.length} user agent(s) from persistence store...`)
  for (const cfg of saved) {
    if (engine.getAgent(cfg.id)) continue
    try {
      // Load related data from DB
      cfg.trades = getTradesByAgent(cfg.id, 100)
      cfg.decisions = getDecisionsByAgent(cfg.id, 200)
      cfg.equityCurve = getEquityByAgent(cfg.id, 500)

      // Load saved subscriptions from DB
      const dbSubs = getSubscriptionsByAgent(cfg.id)
      if (dbSubs && dbSubs.length > 0) {
        cfg.indexSubscriptions = dbSubs
      }

      engine.restoreAgent(cfg)
      console.log(`  ✅ Restored: ${cfg.name} (${cfg.strategy}) wallet=${cfg.walletAddress?.slice(0,8)}... subs=${(cfg.indexSubscriptions || []).length}`)
    } catch (err) {
      console.error(`  ❌ Failed to restore ${cfg.name}:`, err.message)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Initialize Agent Engine (with persistence hooks)
// ═══════════════════════════════════════════════════════════════════════

const engine = new AgentManager({
  customStrategyRuntime,
  persist: {
    saveTrade,
    saveDecision,
    saveEquity: saveEquityPoint,
    saveAgent: saveUserAgent,
    saveAgentsBatch: saveUserAgentsBatch,
    saveSubscription: upsertSubscription,
    deleteSubscription,
    ensureLlmSharedScope: ensureLlmSharedStrategyScope,
    getLlmSharedScope: getLlmSharedStrategyScope,
    listLlmSharedScopes: listLlmSharedStrategyScopes,
    saveLlmSharedScopePlan: updateLlmSharedStrategyScopePlan,
  },
  strategyRuntime: {
    getAgentRotationPolicy,
    getAgentRotationEvents,
    saveAgentRotationEvent,
  },
})
seedAgents(engine)
restoreUserAgents(engine)

// ═══════════════════════════════════════════════════════════════════════
// Initialize Index Registry (with persistence)
// ═══════════════════════════════════════════════════════════════════════

const indexRegistry = new IndexRegistry({
  db: {
    upsertIndex, getIndex, getAllIndexes, getActiveIndexes,
    upsertHolder, getHolder, getHoldersByIndex, countHolders, cleanupZeroHolders,
    saveIndexTrade, getIndexTrades,
    saveOracleSnapshot, getOracleSnapshots,
    upsertSubscription, getSubscriptionsByAgent, getSubscriptionsByIndex,
    deleteSubscription, countSubscribers,
    saveFeedEvent, getIndexFeed, getGlobalFeed,
    saveIndexStateBatch,
  },
  agentManager: engine,
})

// Wire engine ↔ indexRegistry
engine.setIndexRegistry(indexRegistry)

// Register AI Trade Index
indexRegistry.registerIndex({
  id: 'AI_TRADE',
  name: 'AI Trade Index',
  symbol: 'AIDX',
  description: 'Composite index tracking the AI trading ecosystem health. Price grows with active agents, volume, time, and holder participation.',
  formulaId: 'ai_trade',
  icon: '🧠',
  initialPrice: 1.0,
  maxSupply: 1_000_000,
  bandWidthPct: 3.0,
  oracleIntervalMs: 30_000,  // recalculate every 30s
  params: {},                 // use default formula weights
})

// Seed initial liquidity on AI Trade Index
indexRegistry.seedLiquidity('AI_TRADE')

// ── Register Agent Momentum Index (AMOM) ──
indexRegistry.registerIndex({
  id: 'AGENT_MOMENTUM',
  name: 'Agent Momentum',
  symbol: 'AMOM',
  description: 'Tracks fleet performance — rises when agents profit, drops when they lose. More volatile, performance-driven index.',
  formulaId: 'agent_momentum',
  icon: '🔥',
  initialPrice: 0.50,
  maxSupply: 500_000,
  bandWidthPct: 5.0,        // wider band — more volatile index
  oracleIntervalMs: 20_000, // faster updates (20s)
  params: {},
})
indexRegistry.seedLiquidity('AGENT_MOMENTUM')

// ── Register OIL Commodity Index ──
// External data source: Hyperliquid xyz:CL perpetual (Crude Oil WTI on XYZ dex / HIP-3)
// Data visible at: https://hyperscreener.asxn.xyz/terminal/xyz:CL
indexRegistry.registerExternalProvider({
  id: 'hl_cl_usdc',
  name: 'Hyperliquid xyz:CL (Crude Oil WTI)',
  type: 'hyperliquid',
  coin: 'xyz:CL',                  // XYZ dex perp — uses metaAndAssetCtxs with dex:"xyz"
  intervalMs: 15_000,              // fetch markPx every 15s
  defaultValue: 93.00,             // fallback price (WTI ~$93)
})

indexRegistry.registerIndex({
  id: 'OIL_INDEX',
  name: 'Oil Commodity Index',
  symbol: 'OIL',
  description: 'Tracks Crude Oil WTI price via Hyperliquid xyz:CL perpetual (XYZ dex). Oracle = markPx directly, no modifiers.',
  formulaId: 'pure_external',
  icon: '🛢️',
  initialPrice: 93.00,             // starting near current WTI markPx
  maxSupply: 100_000,
  bandWidthPct: 5.0,               // ±5% trading corridor (commodities are volatile)
  oracleIntervalMs: 15_000,        // 15s oracle updates
  params: {
    externalSource: 'hl_cl_usdc',  // direct source — price = Hyperliquid xyz:CL markPx
  },
})
indexRegistry.seedLiquidity('OIL_INDEX')

// Auto-subscribe all seed agents to AI Trade Index
engine.autoSubscribeSeedAgents('AI_TRADE', 5)
engine.autoSubscribeSeedAgents('AGENT_MOMENTUM', 3)
engine.autoSubscribeSeedAgents('OIL_INDEX', 2)

// Auto-subscribe restored user agents that have no subscriptions yet
{
  const indexIds = ['AI_TRADE', 'AGENT_MOMENTUM', 'OIL_INDEX']
  const allocations = { AI_TRADE: 5, AGENT_MOMENTUM: 3, OIL_INDEX: 2 }
  for (const agent of engine.getAllAgentsRaw()) {
    if (!agent.isUserAgent) continue
    if (agent.indexSubscriptions && agent.indexSubscriptions.length > 0) continue
    for (const indexId of indexIds) {
      engine.subscribeAgentToIndex(agent.id, indexId, allocations[indexId])
    }
    console.log(`  🔗 Auto-subscribed user agent ${agent.name} to ${indexIds.length} indexes`)
  }
}

// Tune restored Lite trend-followers so they trade under moderate momentum too
{
  const trendDefaultsByRisk = {
    low: { lookback: 10, momentumThreshold: 1.25, cooldownMs: 22000 },
    medium: { lookback: 8, momentumThreshold: 1.0, cooldownMs: 16000 },
    high: { lookback: 6, momentumThreshold: 0.8, cooldownMs: 12000 },
  }


try {
  const seededCount = ensureSeededMarketplaceStrategies({ engine, customStrategyRuntime })
  console.log(`🧩 Marketplace seeds ready: ${seededCount} strategies`) 
} catch (err) {
  console.error('❌ Failed to seed marketplace strategies:', err.message)
}
  let tunedCount = 0
  for (const agent of engine.getAllAgentsRaw()) {
    if (!agent.isUserAgent || agent.strategy !== 'trend_follower') continue
    const target = trendDefaultsByRisk[agent.riskLevel] || trendDefaultsByRisk.medium
    const config = { ...(agent.config || {}) }
    let changed = false

    if (!Number.isFinite(config.lookback) || config.lookback > target.lookback) {
      config.lookback = target.lookback
      changed = true
    }
    if (!Number.isFinite(config.momentumThreshold) || config.momentumThreshold > target.momentumThreshold) {
      config.momentumThreshold = target.momentumThreshold
      changed = true
    }
    if (!Number.isFinite(config.cooldownMs) || config.cooldownMs > target.cooldownMs) {
      config.cooldownMs = target.cooldownMs
      changed = true
    }

    if (changed) {
      agent.config = config
      saveUserAgent(agent)
      tunedCount++
      console.log(`  🎯 Tuned Lite trend_follower ${agent.name}: threshold=${config.momentumThreshold}% lookback=${config.lookback} cooldown=${config.cooldownMs}ms`)
    }
  }

  if (tunedCount > 0) {
    console.log(`  ⚙️ Retuned ${tunedCount} user trend-follower agent(s) for Lite momentum defaults`)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// System Market Maker — Passive liquidity provider for AI Trade Index
// ═══════════════════════════════════════════════════════════════════════

function withIndexMarketMakerOverrides(indexId, baseConfig) {
  const overrides = indexRegistry.indexes.get(indexId)?.policyOverrides?.marketMaker || {}
  return { ...baseConfig, ...overrides }
}

const systemMM = new IndexMarketMaker({
  indexId: 'AI_TRADE',
  registry: indexRegistry,
  config: withIndexMarketMakerOverrides('AI_TRADE', {
    minSpreadBps: 40,         // 0.40% minimum spread (passive)
    maxSpreadBps: 200,        // widens under stress / excess profit
    maxInventoryPct: 8,       // max 8% of supply
    targetInventoryPct: 2,    // target ~2% for sell-side liquidity
    baseSizePct: 0.3,         // 0.3% of supply per level
    maxLevels: 8,             // 8 price levels each side
    levelSpacingBps: 15,      // 15bps between levels
    profitCapPct: 0.5,        // profit cap 0.5% of circulating value
    profitDonateRatio: 0.8,   // donate 80% of excess via tighter spreads / burns
    tickIntervalMs: 15_000,   // requote every 15s
    mintEnabled: true,        // can mint new contracts for sell-side
  }),
})
systemMM.start()

// System MM for Agent Momentum Index
const systemMM2 = new IndexMarketMaker({
  indexId: 'AGENT_MOMENTUM',
  registry: indexRegistry,
  config: withIndexMarketMakerOverrides('AGENT_MOMENTUM', {
    minSpreadBps: 60,         // wider spread — more volatile asset
    maxSpreadBps: 300,
    maxInventoryPct: 10,
    targetInventoryPct: 3,
    baseSizePct: 0.4,
    maxLevels: 6,
    levelSpacingBps: 25,
    profitCapPct: 0.5,
    profitDonateRatio: 0.8,
    tickIntervalMs: 12_000,   // faster requote for volatile index
    mintEnabled: true,
  }),
})
systemMM2.start()

// System MM for OIL Commodity Index
const systemMM3 = new IndexMarketMaker({
  indexId: 'OIL_INDEX',
  registry: indexRegistry,
  config: withIndexMarketMakerOverrides('OIL_INDEX', {
    minSpreadBps: 50,         // moderate spread for commodity
    maxSpreadBps: 250,
    maxInventoryPct: 10,
    targetInventoryPct: 3,
    baseSizePct: 0.5,
    maxLevels: 6,
    levelSpacingBps: 20,
    profitCapPct: 0.5,
    profitDonateRatio: 0.8,
    tickIntervalMs: 15_000,
    mintEnabled: true,
  }),
})
systemMM3.start()

// Collect all system MMs in a map for admin API / graceful shutdown
const systemMMs = { AI_TRADE: systemMM, AGENT_MOMENTUM: systemMM2, OIL_INDEX: systemMM3 }

// ═══════════════════════════════════════════════════════════════════════
// Agent Index Factory — Agents can create their own indexes
// ═══════════════════════════════════════════════════════════════════════

const agentIndexFactory = new AgentIndexFactory({
  indexRegistry,
  agentManager: engine,
  systemMMs,
  IndexMarketMaker,
})
// Wire factory reference into IndexRegistry for fee hooks
indexRegistry.agentIndexFactory = agentIndexFactory
agentIndexFactory.start()

// ─── Express App ─────────────────────────────────────────────────────

const app = express()

if (config.isProd) {
  app.set('trust proxy', 1)
}

// Security headers (XSS, clickjacking, MIME sniff, etc.)
app.use(helmet({
  contentSecurityPolicy: false, // API-only server, no HTML to protect
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow cross-origin API calls
}))

// CORS — restrict origins in production
app.use(cors({
  origin: config.isProd ? config.corsOrigins : true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // preflight cache 24h
}))

// Body parser with size limit
app.use(express.json({ limit: config.maxJsonBodySize }))

// Attach authenticated session user (if cookie exists)
app.use(attachSessionUser)

// Request logging
app.use(requestLogger)

// Health check endpoint (no rate limit overhead)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() })
})

// Global rate limit (all routes except health)
app.use(standardLimiter)

// ═══════════════════════════════════════════════════════════════════════
// Route Modules — Split into separate files for maintainability
// ═══════════════════════════════════════════════════════════════════════

import { authRoutes, engineRoutes, indexRoutes, adminRoutes, llmRoutes, strategyRoutes, userRoutes } from './routes/index.js'

import { adminAuth } from './middleware/adminAuth.js'

const sharedDeps = { engine, indexRegistry, agentIndexFactory, systemMMs, normalizeAddr, IndexMarketMaker, rawDb, auth, adminAuth, customStrategyRuntime, walletProviderRegistry }

app.use('/api/engine', engineRoutes(sharedDeps))
app.use('/api/indexes', indexRoutes(sharedDeps))
app.use('/api/admin', adminRoutes(sharedDeps))
app.use('/api/llm', llmRoutes(sharedDeps))
app.use('/api/strategies', strategyRoutes(sharedDeps))
app.use('/api', authRoutes({
  auth,
  config,
  privyAuthService,
  managedWalletProvisioning,
  createAppUser,
  getAppUser,
  getAppUserByPrimaryWallet,
  updateAppUserPrimaryWallet,
  getAuthIdentity,
  upsertAuthIdentity,
  listAuthIdentitiesByUserId,
  listUserWalletsByUserId,
  getUserWalletByAddress,
  listWalletConnectionsByOwner,
  listManagedWalletsByOwner,
  createAuthSession,
  updateAuthSessionActiveWallet,
}))
app.use('/api', onboardingRoutes({ config, normalizeAddr, walletProviderRegistry }))
app.use('/api', userRoutes({ auth, config, normalizeAddr, createTonWallet, getTonBalance, deleteTonWalletById, walletProviderRegistry, privyAuthService }))
// ─── 404 & Global Error Handler ───────────────────────────────────────

app.use(notFoundHandler)
app.use(globalErrorHandler)

// ─── Start Server + Engine ───────────────────────────────────────────

const PORT = config.port
const server = app.listen(PORT, async () => {
  console.log('')
  console.log(`🔑 ODROB Backend v4 running on http://localhost:${PORT}`)
  console.log(`🌐 Network: ${IS_TESTNET ? 'TESTNET' : 'MAINNET'}`)
  console.log(`🛡️  Environment: ${config.nodeEnv}`)
  console.log(`🔒 Admin auth: ${config.adminApiKey ? 'API key required' : (config.adminAllowLocalBypass ? 'localhost-only bypass enabled' : 'blocked until configured')}`)
  console.log(`📦 Storage: ${getRuntimeAuthStoreLabel()}`)
  console.log('')
  // Start the autonomous agent engine
  await engine.start()
  // Start index oracles after engine is running
  indexRegistry.startOracles()
  console.log('')
})

// DB retention policy — periodically clean old records
const retention = setupRetentionPolicy(rawDb, {
  intervalMs: 3_600_000,  // every hour
  maxAgeDays: 30,
  maxOracleAgeDays: 14,
  maxFeedAgeDays: 7,
})

// Auth store cleanup (expired nonces/sessions)
const authCleanupTimer = setInterval(() => {
  void cleanupExpiredAuth().then((r) => {
    if ((r.nonces || 0) + (r.sessions || 0) + (r.adminSessions || 0) > 0) {
      console.log(`🧹 Auth cleanup: nonces=${r.nonces} sessions=${r.sessions} adminSessions=${r.adminSessions || 0}`)
    }
  }).catch((error) => {
    console.error('Auth cleanup failed:', error.message)
  })
}, 5 * 60 * 1000)

// Graceful shutdown: save all user agents + indexes before exit
let _shuttingDown = false
function gracefulShutdown() {
  if (_shuttingDown) return // prevent double-shutdown
  _shuttingDown = true
  console.log('\n🛑 Shutting down...')

  // 1. Stop accepting new connections
  server.close(() => {
    console.log('🔌 HTTP server closed')
  })

  // 2. Stop retention policy timer
  retention.stop()
  clearInterval(authCleanupTimer)

  // 3. Stop agent index factory (auto-delist + global pool timers)
  agentIndexFactory.stop()

  // 4. Stop all system MMs
  for (const [, mm] of Object.entries(systemMMs)) {
    mm.stop()
  }

  // 5. Stop engine + oracles
  engine.stop()
  indexRegistry.stopOracles()

  // 6. Final save of all user agents
  const userAgents = []
  for (const [id, agent] of engine.agents) {
    if (agent.isUserAgent) userAgents.push(agent)
  }
  if (userAgents.length > 0) {
    saveUserAgentsBatch(userAgents)
    console.log(`💾 Saved ${userAgents.length} user agent(s) to persistence store`)
  }

  // 7. Save all index states
  indexRegistry.saveAll()
  console.log(`💾 Saved ${indexRegistry.indexes.size} index(es) to persistence store`)

  // 8. Close DB last
  closeDb()
  console.log('✅ Shutdown complete')
  process.exit(0)
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)
