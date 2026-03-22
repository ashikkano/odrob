// ═══════════════════════════════════════════════════════════════════════
// Engine Routes — Autonomous agent engine API
// ═══════════════════════════════════════════════════════════════════════

import { Router } from 'express'
import { STRATEGIES } from '../engine/strategies.js'
import { getMemoryStore } from '../engine/llm/index.js'
import { hasAdminSessionCookie } from '../middleware/adminAuth.js'
import { createTTLCache } from '../utils/hotCache.js'
import {
  saveUserAgent, deleteUserAgent, saveUserAgentsBatch,
} from '../runtimeEngineStore.js'
import { upsertSubscription } from '../runtimeAuthStore.js'
import {
  validate, ok, fail, notFound,
  createEngineAgentSchema, updateEngineAgentSchema,
} from '../validation/index.js'

/**
 * @param {{ engine, indexRegistry, normalizeAddr, auth, adminAuth }} deps
 */
export default function engineRoutes({ engine, indexRegistry, normalizeAddr, auth, adminAuth }) {
  const router = Router()
  const hotCache = createTTLCache(1500)

  // SEC-003: Use ONLY session-based auth — no X-Wallet-Address header fallback
  const getRequestWallet = (req) => normalizeAddr(req.userAddress || '')
  const wantsAdminAccess = (req) => hasAdminSessionCookie(req)

  function requireExplicitAdmin(req, res, next) {
    if (!wantsAdminAccess(req)) {
      return fail(res, 'Admin access required', 403)
    }
    return adminAuth(req, res, next)
  }

  function authorizeAgentCreate(req, res, next) {
    if (wantsAdminAccess(req)) {
      return adminAuth(req, res, next)
    }
    if (!req.body?.isUserAgent) {
      return fail(res, 'Admin access required', 403)
    }
    return auth(req, res, next)
  }

  function authorizeAgentAccess(req, res, next, { allowOwner = false } = {}) {
    const agent = engine.getAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')

    req.targetAgent = agent

    if (wantsAdminAccess(req)) {
      return adminAuth(req, res, next)
    }

    if (!allowOwner || !agent.isUserAgent) {
      return fail(res, 'Admin access required', 403)
    }

    return auth(req, res, () => {
      const reqWallet = getRequestWallet(req)
      if (agent.walletAddress && reqWallet !== normalizeAddr(agent.walletAddress)) {
        return fail(res, 'Access denied — not your agent', 403)
      }
      next()
    })
  }

  function buildPublicAgentSummary(agent) {
    const sanitized = engine._sanitizeAgent(agent)
    return {
      id: sanitized.id,
      name: sanitized.name,
      strategy: sanitized.strategy,
      strategyName: sanitized.strategyName,
      icon: sanitized.icon,
      bio: sanitized.bio,
      isUserAgent: sanitized.isUserAgent,
      walletAddress: sanitized.walletAddress,
      riskLevel: sanitized.riskLevel,
      status: sanitized.status,
      pauseReason: sanitized.pauseReason,
      virtualBalance: sanitized.virtualBalance,
      initialBalance: sanitized.initialBalance,
      position: sanitized.position,
      positionValue: sanitized.positionValue,
      equity: sanitized.equity,
      pnl: sanitized.pnl,
      realizedPnl: sanitized.realizedPnl,
      unrealizedPnl: sanitized.unrealizedPnl,
      feeIncome: sanitized.feeIncome,
      dividendIncome: sanitized.dividendIncome,
      royaltyIncome: sanitized.royaltyIncome,
      otherIncome: sanitized.otherIncome,
      pnlPercent: sanitized.pnlPercent,
      totalTrades: sanitized.totalTrades,
      winRate: sanitized.winRate,
      winningTrades: sanitized.winningTrades,
      losingTrades: sanitized.losingTrades,
      totalVolume: sanitized.totalVolume,
      maxDrawdown: sanitized.maxDrawdown,
      indexSubscriptions: sanitized.indexSubscriptions,
      activeStrategyTemplateId: sanitized.activeStrategyTemplateId,
      activeStrategyName: sanitized.activeStrategyName,
      activeStrategyDescription: sanitized.activeStrategyDescription,
      activeStrategyMode: sanitized.activeStrategyMode,
      strategySource: sanitized.strategySource,
      executionOwner: sanitized.executionOwner,
      subscriptionOwner: sanitized.subscriptionOwner,
      lastSubscriptionRotationSummary: sanitized.lastSubscriptionRotationSummary,
      lastSubscriptionRotationAt: sanitized.lastSubscriptionRotationAt,
      recentRotationEvents: sanitized.recentRotationEvents,
      lastIdleReason: sanitized.lastIdleReason,
      lastIdleAt: sanitized.lastIdleAt,
      lastIdleIndexId: sanitized.lastIdleIndexId,
      lastIdleIndexSymbol: sanitized.lastIdleIndexSymbol,
      lastIdleMeta: sanitized.lastIdleMeta,
      openOrders: sanitized.openOrders,
      lastTickAt: sanitized.lastTickAt,
      tickCount: sanitized.tickCount,
      createdAt: sanitized.createdAt,
      decisions: sanitized.decisions,
      trades: sanitized.trades,
      equityCurve: sanitized.equityCurve,
      lastThinking: sanitized.lastThinking,
      lastReasoning: sanitized.lastReasoning,
      lastConfidence: sanitized.lastConfidence,
      lastAction: sanitized.lastAction,
      llmLatencyMs: sanitized.llmLatencyMs,
      llmProvider: sanitized.llmProvider,
      llmModel: sanitized.llmModel,
      createdIndexes: sanitized.createdIndexes,
      creatorRevenue: sanitized.creatorRevenue,
      royaltyIncome: sanitized.royaltyIncome,
      isCreator: sanitized.isCreator,
    }
  }

  // Dashboard metrics
  router.get('/metrics', (req, res) => {
    ok(res, engine.getMetrics())
  })

  // All autonomous agents
  router.get('/agents', requireExplicitAdmin, (req, res) => {
    const cached = hotCache.get('agents:list')
    if (cached) return ok(res, cached)

    const agents = engine.getAllAgents()
    const memStore = getMemoryStore()
    for (const a of agents) {
      if (a.strategy === 'llm_trader') {
        const decisions = memStore.getRecentMemory(a.id, 20)
        a.llmDecisionOutcomes = decisions
          .filter(d => (d.outcomeTag === 'win' || d.outcomeTag === 'loss') && d.outcomePnl != null)
          .map(d => ({ pnl: d.outcomePnl, tag: d.outcomeTag, action: d.action, instrument: d.instrument }))
      }
    }
    hotCache.set('agents:list', agents)
    ok(res, agents)
  })

  // Public-safe fleet summary for dashboards and lite UI
  router.get('/agents/public', (req, res) => {
    const cached = hotCache.get('agents:public:list')
    if (cached) return ok(res, cached)

    const agents = engine.getAllAgents().map(buildPublicAgentSummary)
    hotCache.set('agents:public:list', agents)
    ok(res, agents)
  })

  // Single agent detail
  router.get('/agents/:id', (req, res, next) => authorizeAgentAccess(req, res, next, { allowOwner: true }), (req, res) => {
    const agent = req.targetAgent
    const sanitized = engine._sanitizeAgent(agent)
    sanitized.decisions = agent.decisions.slice(0, 50)
    sanitized.trades = agent.trades.slice(0, 50)
    sanitized.equityCurve = agent.equityCurve.slice(-100)
    ok(res, sanitized)
  })

  // Find agent by wallet address
  router.get('/agents/by-wallet/:address', (req, res) => {
    const addr = normalizeAddr(req.params.address)
    if (!addr) return fail(res, 'address required')
    const raw = Array.from(engine.agents.values())
    const found = raw.find(a => normalizeAddr(a.walletAddress) === addr && a.isUserAgent)
    if (!found) return ok(res, { agent: null })
    ok(res, { agent: engine._sanitizeAgent(found) })
  })

  // Create autonomous agent (1 wallet = 1 agent) — SEC-009: auth required
  router.post('/agents', validate(createEngineAgentSchema), authorizeAgentCreate, async (req, res) => {
    try {
      const { name, strategy, icon, virtualBalance, config, isUserAgent, walletAddress, riskLevel, bio, llmProvider, llmModel, llmApiKey } = req.body
      if (!STRATEGIES[strategy]) return fail(res, `Unknown strategy: ${strategy}`, 400, { available: Object.keys(STRATEGIES) })

      const requestedUserAgent = Boolean(isUserAgent)
      const requestWallet = getRequestWallet(req)
      let normWallet = normalizeAddr(walletAddress)

      if (requestedUserAgent) {
        if (!requestWallet) {
          return fail(res, 'Authenticated wallet required for user agents', 401)
        }
        if (normWallet && normWallet !== requestWallet) {
          return fail(res, 'Wallet address must match authenticated session', 403)
        }
        normWallet = requestWallet
      }

      if (requestedUserAgent && normWallet) {
        const raw = Array.from(engine.agents.values())
        const existing = raw.find(a => normalizeAddr(a.walletAddress) === normWallet && a.isUserAgent)
        if (existing) {
          return fail(res, 'Wallet already has an agent', 409, { existingAgentId: existing.id })
        }
      }

      const agentConfig = { ...(config || {}) }
      if (llmProvider) agentConfig.llmProvider = llmProvider
      if (llmModel)    agentConfig.llmModel = llmModel
      if (llmApiKey)   agentConfig.llmApiKey = llmApiKey

      const agent = engine.addAgent({
        name, strategy, icon,
        virtualBalance: virtualBalance || 1000,
        config: agentConfig,
        isUserAgent: requestedUserAgent,
        walletAddress: normWallet || null,
        riskLevel: riskLevel || 'medium',
        bio: bio || '',
      })

      if (indexRegistry) {
        const bootstrap = engine.subscribeAgentToBootstrapIndexes(agent.id, {
          allocationPct: 5,
          maxSystemIndexes: 3,
          maxAgentIndexes: agent.isUserAgent ? 2 : 0,
        })

        if (agent.isUserAgent) {
          for (const indexId of bootstrap.indexIds) {
            try {
              await upsertSubscription({ agentId: agent.id, indexId, allocationPct: 5, status: 'active', subscribedAt: Date.now() })
            } catch {}
          }
        }
        console.log(`  🔗 Auto-subscribed agent ${agent.name} to ${bootstrap.count} bootstrap index(es)`)
      }

      if (agent.isUserAgent && agent.walletAddress) {
        saveUserAgent(agent)
        console.log(`💾 Persisted user agent: ${agent.name} [${agent.id}] wallet=${agent.walletAddress}`)
      }

      ok(res, engine._sanitizeAgent(agent), 201)
    } catch (err) { fail(res, err.message, 500) }
  })

  // Update agent — SEC-009: auth required
  router.patch('/agents/:id', validate(updateEngineAgentSchema), (req, res, next) => authorizeAgentAccess(req, res, next, { allowOwner: true }), (req, res) => {
    const agent = req.targetAgent
    const { name, config, virtualBalance } = req.body
    if (name) agent.name = name
    if (config) agent.config = { ...agent.config, ...config }
    if (virtualBalance !== undefined) { agent.virtualBalance = virtualBalance; agent.initialBalance = virtualBalance; agent.peakEquity = virtualBalance }
    ok(res, engine._sanitizeAgent(agent))
  })

  // Delete agent (ownership check for user agents) — SEC-009: auth required
  router.delete('/agents/:id', (req, res, next) => authorizeAgentAccess(req, res, next, { allowOwner: true }), (req, res) => {
    const agent = req.targetAgent
    const reqWallet = getRequestWallet(req)
    if (agent.isUserAgent && agent.walletAddress && reqWallet !== normalizeAddr(agent.walletAddress)) {
      return fail(res, 'Access denied — not your agent', 403)
    }
    if (agent.isUserAgent) {
      deleteUserAgent(req.params.id)
      console.log(`🗑  Deleted user agent from DB: ${agent.name} [${req.params.id}]`)
    }
    const deleted = engine.removeAgent(req.params.id)
    if (!deleted) return notFound(res, 'Agent')
    ok(res, { deleted: true })
  })

  // Helper: check wallet ownership
  function checkAgentOwnership(req, res) {
    const agent = req.targetAgent || engine.getAgent(req.params.id)
    if (!agent) { notFound(res, 'Agent'); return null }
    const reqWallet = getRequestWallet(req)
    if (agent.isUserAgent && agent.walletAddress && reqWallet !== normalizeAddr(agent.walletAddress)) {
      fail(res, 'Access denied — not your agent', 403); return null
    }
    return agent
  }

  router.post('/agents/:id/start', (req, res, next) => authorizeAgentAccess(req, res, next, { allowOwner: true }), (req, res) => {
    if (!checkAgentOwnership(req, res)) return
    const agent = engine.startAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')
    ok(res, engine._sanitizeAgent(agent))
  })

  router.post('/agents/:id/pause', (req, res, next) => authorizeAgentAccess(req, res, next, { allowOwner: true }), (req, res) => {
    if (!checkAgentOwnership(req, res)) return
    const agent = engine.pauseAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')
    ok(res, engine._sanitizeAgent(agent))
  })

  router.post('/agents/:id/stop', (req, res, next) => authorizeAgentAccess(req, res, next, { allowOwner: true }), (req, res) => {
    if (!checkAgentOwnership(req, res)) return
    const agent = engine.stopAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')
    ok(res, engine._sanitizeAgent(agent))
  })

  // Decision logs
  router.get('/agents/:id/decisions', (req, res, next) => authorizeAgentAccess(req, res, next, { allowOwner: true }), (req, res) => {
    ok(res, engine.getDecisionLog(req.params.id, parseInt(req.query.limit) || 50))
  })

  router.get('/decisions', requireExplicitAdmin, (req, res) => {
    ok(res, engine.getDecisionLog(null, parseInt(req.query.limit) || 100))
  })

  // Recent trades
  router.get('/trades', (req, res) => {
    ok(res, engine.getRecentTrades(parseInt(req.query.limit) || 50))
  })

  // Equity curve
  router.get('/equity', (req, res) => {
    ok(res, engine.getEquityCurve())
  })

  // Available strategies
  router.get('/strategies', (req, res) => {
    ok(res, Object.entries(STRATEGIES).map(([id, s]) => ({ id, name: s.name, icon: s.icon, desc: s.desc })))
  })

  // Agent's index subscriptions
  router.get('/agents/:id/indexes', (req, res, next) => authorizeAgentAccess(req, res, next, { allowOwner: true }), (req, res) => {
    const agent = req.targetAgent
    ok(res, agent.indexSubscriptions || [])
  })

  // Agent's index holdings
  router.get('/agents/:id/index-holdings', (req, res) => {
    const agent = engine.getAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')

    const holdings = []
    for (const [indexId, state] of indexRegistry.indexes) {
      const h = state.holders.get(req.params.id)
      if (h && h.balance > 0) {
        holdings.push({
          indexId,
          symbol: state.symbol,
          balance: Math.round(h.balance * 100) / 100,
          avgEntryPrice: h.avgEntryPrice,
          currentPrice: state.oraclePrice,
          unrealizedPnl: Math.round((state.oraclePrice - h.avgEntryPrice) * h.balance * 100) / 100,
          realizedPnl: Math.round(h.realizedPnl * 100) / 100,
          holdingValue: Math.round(h.balance * state.oraclePrice * 100) / 100,
        })
      }
    }
    ok(res, holdings)
  })

  // Engine control — SEC-009: admin-only
  router.post('/start', adminAuth, (req, res) => { engine.start().then(() => ok(res, { status: 'running' })) })
  router.post('/stop', adminAuth, (req, res) => { engine.stop(); ok(res, { status: 'stopped' }) })
  router.get('/status', (req, res) => { ok(res, { running: engine.running, tickCount: engine.tickCount, uptime: engine.startTime ? Date.now() - engine.startTime : 0 }) })

  return router
}
