import { Worker } from 'node:worker_threads'
import { adminLimiter } from '../../middleware/index.js'
import { requireAdminPermission } from '../../middleware/adminAuth.js'
import {
  validate,
  ok,
  fail,
  stressTestSchema,
} from '../../validation/index.js'

const STRESS_LIMITS = Object.freeze({
  maxAgents: 5000,
  maxOrdersPerAgent: 1000,
  maxRequestedOps: 250000,
  maxPersistTrades: 100000,
})

export function registerDiagnosticsRoutes(router, context) {
  const { engine, indexRegistry, writeAudit, stressPersistence } = context

  let stressTestRunning = false
  let stressTestResult = null
  let stressTestWorker = null

  router.get('/orderbook/diagnostics', requireAdminPermission('admin:diagnostics'), (req, res) => {
    const result = {}
    for (const [id, state] of indexRegistry.indexes) {
      const ob = state.orderBook
      const eng = ob.engine
      const spread = eng.getSpread()
      const metrics = eng.metrics.getSummary()
      const triggerCount = ob.triggerBook.size

      result[id] = {
        symbol: state.symbol,
        status: state.status,
        bidTree: {
          levelCount: eng.bidTree.levelCount,
          totalOrders: eng.bidTree.totalOrders(),
          totalVolume: Math.round(eng.bidTree.totalVolume() * 1e4) / 1e4,
          bestPrice: spread.bestBid,
        },
        askTree: {
          levelCount: eng.askTree.levelCount,
          totalOrders: eng.askTree.totalOrders(),
          totalVolume: Math.round(eng.askTree.totalVolume() * 1e4) / 1e4,
          bestPrice: spread.bestAsk === Infinity ? null : spread.bestAsk,
        },
        spread: {
          bestBid: spread.bestBid,
          bestAsk: spread.bestAsk === Infinity ? null : spread.bestAsk,
          spread: spread.spread === Infinity ? null : Math.round(spread.spread * 1e6) / 1e6,
          mid: spread.mid,
        },
        orderIndex: {
          totalOrders: eng.orderIndex.totalOrders,
          uniqueAgents: eng.orderIndex.byAgent.size,
        },
        recentTrades: {
          length: eng.trades.length,
          capacity: eng.trades.capacity,
          fillPct: eng.trades.capacity > 0
            ? Math.round((eng.trades.length / eng.trades.capacity) * 100)
            : 0,
        },
        allTrades: {
          length: eng.allTrades.length,
          capacity: eng.allTrades.capacity,
        },
        triggers: {
          total: triggerCount,
          sellStops: ob.triggerBook.sellStopTree.size,
          buyStops: ob.triggerBook.buyStopTree.size,
          trailingStops: ob.triggerBook.trailingStops.size,
        },
        metrics,
        stats: { ...eng.stats },
        lastPrice: eng.lastPrice,
      }
    }
    ok(res, result)
  })

  router.post('/orderbook/stress-test', adminLimiter, requireAdminPermission('admin:diagnostics'), validate(stressTestSchema), (req, res) => {
    if (stressTestRunning) {
      return fail(res, 'Stress test already running', 409)
    }

    const realAgents = Array.from(engine.agents.values())
      .filter((agent) => agent.status === 'active' && !String(agent.id).startsWith('__'))
      .map((agent) => ({
        id: agent.id,
        riskLevel: agent.riskLevel || 'medium',
        virtualBalance: agent.virtualBalance || 1000,
      }))

    const realIndexes = Array.from(indexRegistry.indexes.values())
      .filter((state) => state.status === 'active')
      .map((state) => ({
        id: state.id,
        symbol: state.symbol,
        oraclePrice: state.oraclePrice || 1,
        bandLow: state.bandLow || (state.oraclePrice || 1) * 0.9,
        bandHigh: state.bandHigh || (state.oraclePrice || 1) * 1.1,
      }))

    if (realAgents.length === 0) {
      return fail(res, 'No active real agents available for stress testing', 400)
    }

    if (realIndexes.length === 0) {
      return fail(res, 'No active indexes available for stress testing', 400)
    }

    const requestedAgents = Math.max(1, parseInt(req.body.agents || 50, 10) || 50)
    const maxAgents = Math.min(realAgents.length, STRESS_LIMITS.maxAgents)
    const effectiveAgents = Math.min(requestedAgents, maxAgents)
    const requestedOrdersPerAgent = Math.max(1, parseInt(req.body.ordersPerAgent || 40, 10) || 40)
    const maxOrdersPerAgent = Math.max(1, Math.min(
      STRESS_LIMITS.maxOrdersPerAgent,
      Math.floor(STRESS_LIMITS.maxRequestedOps / effectiveAgents),
    ))
    const effectiveOrdersPerAgent = Math.min(requestedOrdersPerAgent, maxOrdersPerAgent)
    const requestedOps = effectiveAgents * effectiveOrdersPerAgent
    const persistTradesMax = Math.max(1000, Math.min(requestedOps, STRESS_LIMITS.maxPersistTrades))

    const config = {
      agents: effectiveAgents,
      ordersPerAgent: effectiveOrdersPerAgent,
      persistTrades: Math.min(Math.max(parseInt(req.body.persistTrades || 50000, 10) || 50000, 1000), persistTradesMax),
      basePrice: req.body.basePrice || 1,
      priceRange: req.body.priceRange || 0.1,
      enableMarket: req.body.enableMarket !== false,
      enableIOC: req.body.enableIOC !== false,
      enableFOK: req.body.enableFOK !== false,
      enableStop: req.body.enableStop !== false,
      enableTrailing: req.body.enableTrailing !== false,
      enableSTP: req.body.enableSTP !== false,
      enableCancel: req.body.enableCancel !== false,
    }

    stressTestRunning = true
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    stressTestResult = {
      status: 'running',
      startedAt: Date.now(),
      config,
      mode: 'real-db',
      sessionId,
      context: {
        realAgents: realAgents.length,
        realIndexes: realIndexes.length,
        requestedAgents,
        requestedOrdersPerAgent,
        requestedOps,
      },
    }

    const workerUrl = new URL('../../workers/stressTestWorker.js', import.meta.url)
    stressTestWorker = new Worker(workerUrl, {
      workerData: {
        mode: 'real-db',
        sessionId,
        config,
        agents: realAgents,
        indexes: realIndexes,
      },
    })

    stressTestWorker.once('message', (payload) => {
      if (payload?.ok) {
        const result = payload.result || {}
        const trades = result.dbTrades || []
        let inserted = 0
        let deleted = 0
        try {
          if (stressPersistence.insertBatch && trades.length > 0) {
            stressPersistence.insertBatch(trades)
            inserted = trades.length
            const info = stressPersistence.deleteByPrefix?.run(`stress-${sessionId}-%`)
            deleted = info?.changes || 0
          }
        } catch (error) {
          stressTestResult = { status: 'error', error: `DB write/cleanup failed: ${error.message}` }
          stressTestRunning = false
          stressTestWorker = null
          return
        }

        stressTestResult = {
          status: 'completed',
          mode: 'real-db',
          sessionId,
          requestedOps: result.requestedOps,
          effectiveOps: result.effectiveOps,
          durationMs: result.durationMs,
          persistedTrades: inserted,
          cleanedTrades: deleted,
          perIndex: result.perIndex || [],
        }
      } else {
        stressTestResult = { status: 'error', error: payload?.error || 'Unknown worker error' }
      }
      stressTestRunning = false
      stressTestWorker = null
    })

    stressTestWorker.once('error', (error) => {
      stressTestResult = { status: 'error', error: error.message }
      stressTestRunning = false
      stressTestWorker = null
    })

    stressTestWorker.once('exit', (code) => {
      if (code !== 0 && stressTestRunning) {
        stressTestResult = { status: 'error', error: `Stress worker exited with code ${code}` }
        stressTestRunning = false
      }
      stressTestWorker = null
    })

    ok(res, {
      message: 'Real-data stress test started',
      mode: 'real-db',
      sessionId,
      config,
      context: {
        realAgents: realAgents.length,
        realIndexes: realIndexes.length,
        requestedAgents,
        requestedOrdersPerAgent,
        requestedOps,
      },
    })

    writeAudit(req, 'diagnostics.stress.start', 'diagnostics', sessionId, {
      summary: `Started stress test with ${config.agents} agents and ${config.ordersPerAgent} orders per agent`,
      requestedAgents,
      requestedOrdersPerAgent,
      requestedOps,
      config,
    })
  })

  router.get('/orderbook/stress-test', requireAdminPermission('admin:diagnostics'), (req, res) => {
    if (!stressTestResult) {
      return ok(res, { status: 'idle', message: 'No stress test has been run' })
    }
    ok(res, stressTestResult)
  })

  router.delete('/orderbook/stress-test', adminLimiter, requireAdminPermission('admin:diagnostics'), (req, res) => {
    if (!stressTestRunning || !stressTestWorker) {
      return ok(res, { status: 'idle', message: 'No running stress test' })
    }

    const activeSessionId = stressTestResult?.sessionId || 'stress-test'

    stressTestWorker.terminate()
      .then((code) => {
        stressTestResult = { status: 'cancelled', finishedAt: Date.now(), workerExitCode: code }
        stressTestRunning = false
        stressTestWorker = null
        writeAudit(req, 'diagnostics.stress.cancel', 'diagnostics', activeSessionId, {
          summary: 'Cancelled running stress test',
          workerExitCode: code,
          lastStatus: stressTestResult?.status || 'running',
        })
        ok(res, { cancelled: true, workerExitCode: code })
      })
      .catch((error) => {
        fail(res, `Failed to cancel stress test: ${error.message}`, 500)
      })
  })
}
