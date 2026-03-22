// ═══════════════════════════════════════════════════════════════════════
// Index Routes — Custom Indexes with oracle pricing
// ═══════════════════════════════════════════════════════════════════════

import { Router } from 'express'
import { AGENT_FORMULA_TEMPLATES } from '../engine/agentIndexFactory.js'
import { createTTLCache } from '../utils/hotCache.js'
import {
  getOracleSnapshots,
  upsertSubscription, deleteSubscription,
} from '../runtimeAuthStore.js'
import {
  validate, ok, fail, notFound,
  placeOrderSchema, subscribeSchema, createByAgentSchema,
} from '../validation/index.js'

/**
 * @param {{ engine, indexRegistry, agentIndexFactory, systemMMs, normalizeAddr }} deps
 */
export default function indexRoutes({ engine, indexRegistry, agentIndexFactory, systemMMs, normalizeAddr }) {
  const router = Router()
  const hotCache = createTTLCache(1200)

  const getRequestWallet = (req) => normalizeAddr(req.userAddress || '')
  const getSubscriptionControlState = (agent) => {
    const sanitized = engine?._sanitizeAgent ? engine._sanitizeAgent(agent) : null
    const subscriptionOwner = sanitized?.subscriptionOwner || (agent?.config?.enableSubscriptionRotation ? 'classic' : 'manual')
    if (subscriptionOwner === 'manual') return null

    const ownerLabel = subscriptionOwner === 'llm_scope'
      ? 'shared LLM scope'
      : subscriptionOwner === 'custom'
        ? 'custom strategy rotation'
        : 'strategy runtime rotation'

    return {
      subscriptionOwner,
      message: `Subscriptions are managed by ${ownerLabel}. Disable strategy-managed rotation before changing them manually.`,
    }
  }

  // List all indexes (summary)
  router.get('/', (req, res) => {
    ok(res, indexRegistry.getAllIndexSnapshots())
  })

  // ── Static routes MUST come before :id wildcard ──

  // Global index feed (all indexes) — BEFORE :id wildcard
  router.get('/feed/global', (req, res) => {
    const limit = parseInt(req.query.limit) || 100
    const all = []
    for (const [, feed] of indexRegistry.feeds) {
      all.push(...feed)
    }
    all.sort((a, b) => b.timestamp - a.timestamp)
    ok(res, all.slice(0, limit))
  })

  router.get('/templates', (req, res) => {
    ok(res, AGENT_FORMULA_TEMPLATES)
  })

  router.get('/can-create/:agentId', (req, res) => {
    ok(res, agentIndexFactory.canCreateIndex(req.params.agentId))
  })

  router.get('/creator-stats/:agentId', (req, res) => {
    ok(res, agentIndexFactory.getCreatorStats(req.params.agentId))
  })

  router.get('/global-pool', (req, res) => {
    ok(res, agentIndexFactory.getGlobalPoolSnapshot())
  })

  // Single index detail
  router.get('/:id', (req, res) => {
    const snapshot = indexRegistry.getIndexSnapshot(req.params.id)
    if (!snapshot) return notFound(res, 'Index')
    ok(res, snapshot)
  })

  // Lightweight price-only endpoint
  router.get('/:id/price', (req, res) => {
    const price = indexRegistry.getIndexPrice(req.params.id)
    if (!price) return notFound(res, 'Index')
    ok(res, price)
  })

  // Index order book
  router.get('/:id/orderbook', (req, res) => {
    const depth = parseInt(req.query.depth) || 15
    const cacheKey = `ob:${req.params.id}:${depth}`
    const cached = hotCache.get(cacheKey)
    if (cached) return ok(res, cached)

    const ob = indexRegistry.getOrderBook(req.params.id, depth)
    if (!ob) return notFound(res, 'Index')
    hotCache.set(cacheKey, ob)
    ok(res, ob)
  })

  // Index recent trades
  router.get('/:id/trades', (req, res) => {
    const state = indexRegistry.indexes.get(req.params.id)
    if (!state) return notFound(res, 'Index')
    const limit = parseInt(req.query.limit) || 50
    ok(res, state.recentTrades.slice(0, limit))
  })

  // Index holders
  router.get('/:id/holders', (req, res) => {
    const holders = indexRegistry.getHolders(req.params.id)
    if (!holders) return notFound(res, 'Index')
    ok(res, holders)
  })

  // Index oracle history
  router.get('/:id/oracle', async (req, res) => {
    const limit = parseInt(req.query.limit) || 200
    ok(res, await getOracleSnapshots(req.params.id, limit))
  })

  // Index feed (events)
  router.get('/:id/feed', (req, res) => {
    const limit = parseInt(req.query.limit) || 50
    const feed = indexRegistry.feeds.get(req.params.id) || []
    ok(res, feed.slice(0, limit))
  })

  // Index context (what agents see)
  router.get('/:id/context', (req, res) => {
    const ctx = indexRegistry.getIndexContext(req.params.id)
    if (!ctx) return notFound(res, 'Index')
    ok(res, ctx)
  })

  // Place order on index
  router.post('/:id/order', validate(placeOrderSchema), (req, res) => {
    try {
      const { agentId, side, price, size } = req.body

      const agent = engine.getAgent(agentId)
      if (!agent) return notFound(res, 'Agent')

      const reqWallet = getRequestWallet(req)
      if (agent.isUserAgent && agent.walletAddress && reqWallet !== normalizeAddr(agent.walletAddress)) {
        return fail(res, 'Access denied — not your agent', 403)
      }

      if (side === 'buy') {
        const cost = price * size
        if (cost > agent.virtualBalance * 0.5) {
          return fail(res, 'Insufficient balance (max 50% per order)')
        }
      }

      let preAvgEntry = 0
      if (side === 'sell') {
        const state = indexRegistry.indexes.get(req.params.id)
        const holder = state?.holders.get(agentId)
        preAvgEntry = holder?.avgEntryPrice || 0
      }

      const result = indexRegistry.placeOrder(req.params.id, {
        agentId, side,
        price: parseFloat(price),
        size: parseFloat(size),
        reasoning: req.body.reasoning || 'manual order',
      })

      if (result.error) return fail(res, result.error)

      if (result.fills && result.fills.length > 0) {
        const indexState = indexRegistry.indexes.get(req.params.id)
        const indexSymbol = indexState?.symbol || req.params.id

        for (const fill of result.fills) {
          const cost = fill.price * fill.size
          const feePreview = side === 'sell' && indexRegistry.agentIndexFactory
            ? indexRegistry.agentIndexFactory.getFeePreview(req.params.id, cost, 'trade')
            : null
          const payableFee = feePreview?.payableFee || 0
          if (side === 'buy') agent.virtualBalance -= cost
          else                agent.virtualBalance += cost - payableFee

          let tradePnl = 0
          if (side === 'sell' && preAvgEntry > 0) {
            tradePnl = ((fill.price - preAvgEntry) * fill.size) - payableFee
            if (tradePnl > 0)      agent.winningTrades = (agent.winningTrades || 0) + 1
            else if (tradePnl < 0) agent.losingTrades = (agent.losingTrades || 0) + 1
            agent.realizedPnl = (agent.realizedPnl || 0) + tradePnl
          }

          agent.totalTrades = (agent.totalTrades || 0) + 1
          agent.totalVolume = (agent.totalVolume || 0) + cost

          const tradeEntry = {
            id: fill.id || `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            side,
            orderType: 'limit',
            price: fill.price,
            size: fill.size,
            value: cost,
            feePaid: Math.round(payableFee * 10000) / 10000,
            pnl: Math.round(tradePnl * 10000) / 10000,
            indexId: req.params.id,
            indexSymbol,
            balance: Math.round(agent.virtualBalance * 100) / 100,
            timestamp: Date.now(),
            source: 'manual',
          }
          if (agent.trades) {
            agent.trades.unshift(tradeEntry)
            if (agent.trades.length > 100) agent.trades = agent.trades.slice(0, 100)
          }
          if (engine.tradeLog) {
            engine.tradeLog.push({ ...tradeEntry, agentId: agent.id, agentName: agent.name })
          }
        }
      }

      const safeResult = {
        order: result.order ? {
          id: result.order.id,
          side: result.order.side,
          price: result.order.price,
          size: result.order.size,
          filled: result.order.filled,
          remaining: result.order.remaining,
          status: result.order.status,
        } : null,
        fills: (result.fills || []).map(f => ({
          id: f.id,
          price: f.price,
          size: f.size,
          buyAgentId: f.buyAgentId,
          sellAgentId: f.sellAgentId,
          aggressorSide: f.aggressorSide,
          timestamp: f.timestamp,
        })),
      }
      res.json(safeResult)
    } catch (err) {
      fail(res, err.message, 500)
    }
  })

  // Subscribe agent to index
  router.post('/:id/subscribe', validate(subscribeSchema), async (req, res) => {
    try {
      const { agentId, allocationPct } = req.body

      const agent = engine.getAgent(agentId)
      if (!agent) return notFound(res, 'Agent')

      const reqWallet = getRequestWallet(req)
      if (agent.isUserAgent && agent.walletAddress && reqWallet !== normalizeAddr(agent.walletAddress)) {
        return fail(res, 'Access denied — not your agent', 403)
      }

      const subscriptionControlState = getSubscriptionControlState(agent)
      if (subscriptionControlState) {
        return fail(res, subscriptionControlState.message, 409)
      }

      const result = engine.subscribeAgentToIndex(agentId, req.params.id, allocationPct || 5)
      if (result.error) return fail(res, result.error)

      await upsertSubscription({
        agentId,
        indexId: req.params.id,
        allocationPct: allocationPct || 5,
        status: 'active',
        subscribedAt: Date.now(),
      })

      ok(res, result)
    } catch (err) {
      fail(res, err.message, 500)
    }
  })

  // Unsubscribe agent from index
  router.delete('/:id/subscribe/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params

      const agent = engine.getAgent(agentId)
      if (!agent) return notFound(res, 'Agent')

      const reqWallet = getRequestWallet(req)
      if (agent.isUserAgent && agent.walletAddress && reqWallet !== normalizeAddr(agent.walletAddress)) {
        return fail(res, 'Access denied — not your agent', 403)
      }

      const subscriptionControlState = getSubscriptionControlState(agent)
      if (subscriptionControlState) {
        return fail(res, subscriptionControlState.message, 409)
      }

      const result = engine.unsubscribeAgentFromIndex(agentId, req.params.id)
      if (result.error) return fail(res, result.error)

      await deleteSubscription(agentId, req.params.id)
      ok(res, result)
    } catch (err) {
      fail(res, err.message, 500)
    }
  })

  // System Market Maker status
  router.get('/:id/market-maker', (req, res) => {
    const mm = systemMMs[req.params.id]
    if (!mm) return notFound(res, 'System MM for this index')
    ok(res, mm.getSnapshot())
  })

  // Protocol Treasury status
  router.get('/:id/treasury', (req, res) => {
    const snap = indexRegistry.getTreasurySnapshot(req.params.id)
    if (!snap) return notFound(res, 'Index')
    ok(res, snap)
  })

  // Create agent index
  router.post('/create-by-agent', validate(createByAgentSchema), (req, res) => {
    try {
      const { agentId, templateId, name, symbol, description, icon, params } = req.body

      const agent = engine.getAgent(agentId)
      if (!agent) return notFound(res, 'Agent')

      const reqWallet = getRequestWallet(req)
      if (agent.isUserAgent && agent.walletAddress && reqWallet !== normalizeAddr(agent.walletAddress)) {
        return fail(res, 'Access denied — not your agent', 403)
      }

      const result = agentIndexFactory.createAgentIndex(agentId, {
        templateId, name, symbol, description, icon, params,
      })

      if (result.error) return fail(res, result.error)

      try {
        engine.subscribeAgentToIndex(agentId, result.indexId, 10)
      } catch {}

      ok(res, result, 201)
    } catch (err) {
      fail(res, err.message, 500)
    }
  })

  return router
}
