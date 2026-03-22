import { parentPort, workerData } from 'node:worker_threads'
import { OrderBookV2 } from '../engine/orderbook-v2/index.js'
import { TimeInForce } from '../engine/orderbook-v2/order.js'

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function riskMult(riskLevel) {
  if (riskLevel === 'aggressive' || riskLevel === 'high') return 1.8
  if (riskLevel === 'conservative' || riskLevel === 'low') return 0.6
  return 1.0
}

function runRealDbSimulation({ config, agents, indexes, sessionId }) {
  const usableAgents = (agents || []).filter(a => a?.id)
  const usableIndexes = (indexes || []).filter(i => i?.id)
  if (usableAgents.length === 0) throw new Error('No active real agents available for real-db stress mode')
  if (usableIndexes.length === 0) throw new Error('No active indexes available for real-db stress mode')

  const perIndex = new Map()
  for (const idx of usableIndexes) {
    const ob = new OrderBookV2({ recentTradesSize: 20000, allTradesSize: 100000 })
    const center = Math.max(0.0001, idx.oraclePrice || 1)
    for (let i = 1; i <= 25; i++) {
      const pBuy = Math.max(0.000001, center * (1 - i * 0.0012))
      const pSell = center * (1 + i * 0.0012)
      const size = 1000 + i * 25
      ob.placeOrder({ agentId: `__stress_mm_buy_${idx.id}`, side: 'buy', price: Math.round(pBuy * 1e6) / 1e6, size })
      ob.placeOrder({ agentId: `__stress_mm_sell_${idx.id}`, side: 'sell', price: Math.round(pSell * 1e6) / 1e6, size })
    }
    perIndex.set(idx.id, {
      ...idx,
      book: ob,
      tradeCount: 0,
      volume: 0,
    })
  }

  const requestedOps = (config.agents || 0) * (config.ordersPerAgent || 0)
  const effectiveOps = Math.max(1000, Math.min(requestedOps || 10000, 500000))
  const persistTradesTarget = Math.max(1000, Math.min(config.persistTrades || Math.floor(effectiveOps * 0.2), 200000))

  const dbTrades = []
  let seq = 0
  const startedAt = Date.now()

  for (let i = 0; i < effectiveOps; i++) {
    const a = pick(usableAgents)
    const idx = perIndex.get(pick(usableIndexes).id)
    const side = Math.random() < 0.5 ? 'buy' : 'sell'

    const spread = idx.book.getSpread()
    const center = spread.mid || idx.oraclePrice || 1
    const bandLow = idx.bandLow || center * 0.9
    const bandHigh = idx.bandHigh || center * 1.1
    const r = (Math.random() - 0.5) * 0.02
    const rawPrice = center * (1 + r)
    const price = Math.round(Math.min(bandHigh, Math.max(bandLow, rawPrice)) * 1e6) / 1e6

    const sizeBase = Math.max(1, Math.min(250, (a.virtualBalance || 1000) * 0.01))
    const size = Math.round((sizeBase * (0.5 + Math.random()) * riskMult(a.riskLevel)) * 100) / 100

    const useMarket = config.enableMarket !== false && Math.random() < 0.2
    let result
    if (useMarket) {
      result = idx.book.placeMarketOrder({ agentId: a.id, side, size })
    } else {
      const tif = (config.enableIOC !== false && Math.random() < 0.12) ? TimeInForce.IOC : undefined
      result = idx.book.placeOrder({ agentId: a.id, side, price, size, timeInForce: tif })
    }

    if (result?.fills?.length) {
      for (const f of result.fills) {
        idx.tradeCount++
        idx.volume += (f.price || 0) * (f.size || 0)

        if (dbTrades.length < persistTradesTarget) {
          seq++
          dbTrades.push({
            id: `stress-${sessionId}-${seq}`,
            indexId: idx.id,
            buyerId: f.buyAgentId || (side === 'buy' ? a.id : `__stress_liq_${idx.id}`),
            sellerId: f.sellAgentId || (side === 'sell' ? a.id : `__stress_liq_${idx.id}`),
            side,
            price: f.price,
            size: f.size,
            value: (f.price || 0) * (f.size || 0),
            isMint: false,
            isBurn: false,
            timestamp: startedAt + seq,
          })
        }
      }
    }
  }

  const finishedAt = Date.now()
  const perIndexSummary = Array.from(perIndex.values()).map(i => ({
    indexId: i.id,
    symbol: i.symbol,
    oraclePrice: i.oraclePrice,
    trades: i.tradeCount,
    volume: Math.round(i.volume * 100) / 100,
  }))

  return {
    mode: 'real-db',
    requestedOps,
    effectiveOps,
    persistedTradesPlanned: dbTrades.length,
    durationMs: finishedAt - startedAt,
    perIndex: perIndexSummary,
    dbTrades,
  }
}

function runStressTest(cfg) {
  const book = new OrderBookV2({ recentTradesSize: 5000, allTradesSize: 20000 })
  const errors = []
  const typeStats = {
    limit:    { placed: 0, filled: 0, partial: 0, resting: 0 },
    market:   { placed: 0, filled: 0, partial: 0, noFill: 0 },
    ioc:      { placed: 0, filled: 0, partial: 0, cancelled: 0 },
    fok:      { placed: 0, filled: 0, rejected: 0 },
    stop:     { placed: 0, triggered: 0 },
    trailing: { placed: 0, triggered: 0 },
    stp:      { tested: 0, cancelled: 0, allowed: 0 },
    cancel:   { attempted: 0, success: 0, fail: 0 },
  }

  const agents = Array.from({ length: cfg.agents }, (_, i) => `stress-agent-${i}`)
  const startNs = process.hrtime.bigint()
  let totalOps = 0

  const phase1Start = process.hrtime.bigint()
  for (const agent of agents) {
    for (let i = 0; i < Math.floor(cfg.ordersPerAgent * 0.4); i++) {
      const side = Math.random() < 0.5 ? 'buy' : 'sell'
      const offset = (Math.random() - 0.5) * cfg.priceRange
      const price = Math.round((cfg.basePrice + offset) * 1e6) / 1e6
      const size = Math.round((10 + Math.random() * 200) * 100) / 100

      const r = book.placeOrder({ agentId: agent, side, price, size })
      typeStats.limit.placed++
      if (r.fills.length > 0) {
        if (r.order.remaining <= 1e-10) typeStats.limit.filled++
        else typeStats.limit.partial++
      } else {
        typeStats.limit.resting++
      }
      totalOps++
    }
  }
  const phase1Ms = Number(process.hrtime.bigint() - phase1Start) / 1e6

  const phase2Start = process.hrtime.bigint()
  if (cfg.enableMarket) {
    for (let i = 0; i < cfg.agents * 2; i++) {
      const agent = agents[Math.floor(Math.random() * agents.length)]
      const side = Math.random() < 0.5 ? 'buy' : 'sell'
      const size = Math.round((5 + Math.random() * 50) * 100) / 100

      const r = book.placeMarketOrder({ agentId: agent, side, size })
      typeStats.market.placed++
      if (r.fills.length > 0) {
        if (r.order.remaining <= 1e-10) typeStats.market.filled++
        else typeStats.market.partial++
      } else {
        typeStats.market.noFill++
      }
      totalOps++
    }
  }
  const phase2Ms = Number(process.hrtime.bigint() - phase2Start) / 1e6

  const phase3Start = process.hrtime.bigint()
  if (cfg.enableIOC) {
    for (let i = 0; i < cfg.agents; i++) {
      const agent = agents[Math.floor(Math.random() * agents.length)]
      const side = Math.random() < 0.5 ? 'buy' : 'sell'
      const spr = book.getSpread()
      const price = side === 'buy'
        ? (spr.bestAsk === Infinity ? cfg.basePrice : spr.bestAsk * 1.001)
        : (spr.bestBid === 0 ? cfg.basePrice : spr.bestBid * 0.999)
      const size = Math.round((5 + Math.random() * 30) * 100) / 100

      const r = book.placeOrder({
        agentId: agent,
        side,
        price: Math.round(price * 1e6) / 1e6,
        size,
        timeInForce: TimeInForce.IOC,
      })
      typeStats.ioc.placed++
      if (r.fills.length > 0) {
        if (r.order.remaining <= 1e-10) typeStats.ioc.filled++
        else typeStats.ioc.partial++
      } else {
        typeStats.ioc.cancelled++
      }
      totalOps++
    }
  }
  const phase3Ms = Number(process.hrtime.bigint() - phase3Start) / 1e6

  const totalMs = Number(process.hrtime.bigint() - startNs) / 1e6
  const finalSnap = book.getSnapshot(10)
  const finalSpread = book.getSpread()
  const finalMetrics = book.engine.metrics.getSummary()

  return {
    totalOps,
    totalTimeMs: Math.round(totalMs * 100) / 100,
    opsPerSec: Math.round(totalOps / (totalMs / 1000)),
    errors: errors.length,
    phases: {
      seedLimits: { ms: Math.round(phase1Ms * 100) / 100, ops: typeStats.limit.placed },
      market: { ms: Math.round(phase2Ms * 100) / 100, ops: typeStats.market.placed },
      ioc: { ms: Math.round(phase3Ms * 100) / 100, ops: typeStats.ioc.placed },
    },
    typeStats,
    finalState: {
      spread: {
        bestBid: finalSpread.bestBid,
        bestAsk: finalSpread.bestAsk === Infinity ? null : finalSpread.bestAsk,
        mid: finalSpread.mid,
      },
      bidLevels: finalSnap.bids.length,
      askLevels: finalSnap.asks.length,
      totalTrades: book.stats.totalTrades,
      totalVolume: Math.round(book.stats.totalVolume * 100) / 100,
      lastPrice: book.lastPrice,
      triggersPending: book.triggerBook.size,
    },
    engineMetrics: finalMetrics,
  }
}

try {
  const mode = workerData?.mode || 'synthetic'
  let result
  if (mode === 'real-db') {
    result = runRealDbSimulation({
      config: workerData?.config || {},
      agents: workerData?.agents || [],
      indexes: workerData?.indexes || [],
      sessionId: workerData?.sessionId || `sess-${Date.now()}`,
    })
  } else {
    const cfg = workerData?.config || {}
    result = runStressTest(cfg)
  }
  parentPort.postMessage({ ok: true, result })
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message })
}
