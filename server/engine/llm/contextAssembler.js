// ═══════════════════════════════════════════════════════════════════════
// Context Assembler — Builds structured context for LLM from engine data
//
// Takes the same (agent, ctx) that every strategy receives
// and produces a rich, structured object the PrePrompter can template into text.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build full structured context for an LLM trading decision.
 *
 * @param {object} agent - Engine agent object (balance, position, config, decisions, trades, etc.)
 * @param {object} ctx   - Engine context (mid, bestBid, bestAsk, spread, volatility, priceHistory, etc.)
 * @returns {object} Structured context ready for PrePrompter
 */
export function buildContext(agent, ctx) {
  const agentCtx  = assembleAgent(agent)
  const marketCtx = assembleMarket(ctx)
  const orderBook = assembleOrderBook(ctx)
  const indexCtx  = assembleIndexes(ctx, agent)
  const techCtx   = assembleTechnicals(ctx)
  const metaCtx   = assembleMeta(ctx)
  const summary   = buildSummary(agentCtx, marketCtx, techCtx, indexCtx)

  return {
    agent:      agentCtx,
    market:     marketCtx,
    orderBook,
    indexes:    indexCtx,
    technicals: techCtx,
    meta:       metaCtx,
    summary,
  }
}

// ─── Agent section ─────────────────────────────────────────────────

function assembleAgent(agent) {
  const equity = (agent.virtualBalance || 0) + (agent.positionValue || 0)
  const totalTrades = agent.totalTrades || 0
  const winRate = totalTrades > 0
    ? ((agent.winningTrades || 0) / totalTrades * 100).toFixed(1) + '%'
    : 'N/A'

  // Recent trade history (last 5)
  const recentTrades = (agent.trades || []).slice(-5).map(t => ({
    side:  t.side,
    price: round(t.price),
    size:  round(t.size),
    pnl:   round(t.pnl || 0),
    time:  t.timestamp,
  }))

  // Open orders
  const openOrders = (agent.openOrders || []).length

  return {
    name:           agent.name || 'Unnamed',
    strategy:       agent.strategy || 'llm_trader',
    riskLevel:      agent.riskLevel || 'medium',
    bio:            agent.bio || '',
    balance:        round(agent.virtualBalance || 0),
    position:       round(agent.position || 0),
    avgEntryPrice:  round(agent.avgEntryPrice || 0),
    equity:         round(equity),
    realizedPnl:    round(agent.realizedPnl || 0),
    unrealizedPnl:  round(agent.unrealizedPnl || 0),
    maxDrawdown:    round(agent.maxDrawdown || 0),
    totalTrades,
    winRate,
    openOrders,
    recentTrades,
  }
}

// ─── Market section ────────────────────────────────────────────────

function assembleMarket(ctx) {
  const ph = ctx.priceHistory || []
  const mid = ctx.mid || ctx.currentPrice || 0
  const vh = ctx.volumeHistory || []

  // Recent market trades (from order book fills)
  const trades = (ctx.recentTrades || []).slice(0, 10).map(t => ({
    side:  t.side || t.aggressorSide || 'unknown',
    price: round(t.price),
    size:  round(t.size || t.remaining || 0),
    time:  t.timestamp,
  }))

  // 24h stats
  const stats = ctx.stats || {}

  return {
    mid:            round(mid),
    bestBid:        round(ctx.bestBid || 0),
    bestAsk:        round(ctx.bestAsk || 0),
    spread:         round(ctx.spread || 0),
    spreadPct:      mid > 0 ? round((ctx.spread || 0) / mid * 100) : 0,
    volatility:     round(ctx.volatility || 0, 6),
    bandLow:        round(ctx.bandLow || 0),
    bandHigh:       round(ctx.bandHigh || 0),
    bandWidthPct:   round(ctx.bandWidthPct || 0),
    recentPrices:   ph.slice(-20).map(p => round(p)),
    candles:        aggregateCandles(ph, 5),
    imbalance:      computeImbalance(ctx),
    trend:          detectTrend(ph),
    // ── New enriched data ──
    recentTrades:   trades,
    high24h:        round(stats.high24h || 0),
    low24h:         round(stats.low24h === Infinity ? 0 : (stats.low24h || 0)),
    totalVolume:    round(stats.totalVolume || 0),
    totalTrades:    stats.totalTrades || 0,
    avgVolume:      vh.length > 0 ? round(vh.reduce((s, v) => s + v, 0) / vh.length) : 0,
  }
}

// ─── Order Book depth ──────────────────────────────────────────────

function assembleOrderBook(ctx) {
  const snap = ctx.orderBookSnapshot
  if (!snap) return { bids: [], asks: [], totalBidVol: 0, totalAskVol: 0, depth: 0 }

  const bids = (snap.bids || []).slice(0, 5).map(l => ({ price: round(l.price), volume: round(l.volume) }))
  const asks = (snap.asks || []).slice(0, 5).map(l => ({ price: round(l.price), volume: round(l.volume) }))
  const totalBidVol = bids.reduce((s, b) => s + b.volume, 0)
  const totalAskVol = asks.reduce((s, a) => s + a.volume, 0)

  return {
    bids,
    asks,
    totalBidVol: round(totalBidVol),
    totalAskVol: round(totalAskVol),
    depth: bids.length + asks.length,
    imbalanceRatio: (totalBidVol + totalAskVol) > 0
      ? round(totalBidVol / (totalBidVol + totalAskVol))
      : 0.5,
  }
}

// ─── Index section ─────────────────────────────────────────────────

function assembleIndexes(ctx, agent = null) {
  if (!ctx.allIndexContexts) return []

  // Build a map of agent's trades per index for quick lookup
  const agentIndexTrades = {}
  if (agent?.trades?.length) {
    for (const t of agent.trades) {
      if (!t.indexId) continue
      if (!agentIndexTrades[t.indexId]) agentIndexTrades[t.indexId] = []
      agentIndexTrades[t.indexId].push(t)
    }
  }

  return Object.entries(ctx.allIndexContexts).map(([indexId, ixCtx]) => {
    const ph = ixCtx.priceHistory || []
    const mid = ixCtx.orderBook?.mid || ixCtx.oraclePrice || 0
    const formula = ixCtx.formula || {}
    const factors = ixCtx.oracleFactors || {}
    const inputs  = ixCtx.oracleInputs || {}
    const treasury = ixCtx.treasury || {}

    // Per-index technicals (EMA, RSI)
    let indexTechnicals = {}
    if (ph.length >= 10) {
      const ema10 = computeEMA(ph, 10)
      const ema20 = computeEMA(ph, Math.min(20, ph.length))
      const rsi14 = computeRSI(ph, 14)
      indexTechnicals = {
        ema10: round(ema10),
        ema20: round(ema20),
        emaSignal: ema10 > ema20 ? 'bullish' : ema10 < ema20 ? 'bearish' : 'neutral',
        rsi14: round(rsi14, 1),
        rsiSignal: rsi14 > 70 ? 'overbought' : rsi14 < 30 ? 'oversold' : 'neutral',
        momentum: ph.length >= 10
          ? round((ph[ph.length - 1] - ph[ph.length - 10]) / ph[ph.length - 10] * 100)
          : 0,
      }
    }

    // Find strongest/weakest oracle factors
    const factorEntries = Object.entries(factors).filter(([_, v]) => typeof v === 'number')
    const sortedFactors = factorEntries.sort((a, b) => b[1] - a[1])
    const strongestFactor = sortedFactors[0] ? { name: sortedFactors[0][0], value: sortedFactors[0][1] } : null
    const weakestFactor = sortedFactors[sortedFactors.length - 1] ? { name: sortedFactors[sortedFactors.length - 1][0], value: sortedFactors[sortedFactors.length - 1][1] } : null

    // Price history changes
    const priceChange10 = ph.length >= 10
      ? round((ph[ph.length - 1] - ph[ph.length - 10]) / ph[ph.length - 10] * 100)
      : 0

    return {
      indexId,
      symbol:      ixCtx.symbol || indexId,
      name:        ixCtx.name || indexId,
      description: ixCtx.description || '',
      oraclePrice: round(ixCtx.oraclePrice || 0),
      prevOraclePrice: round(ixCtx.prevOraclePrice || 0),
      oracleChangePct: round(ixCtx.oracleChangePct || 0),
      mid:         round(mid),
      bandLow:     round(ixCtx.bandLow || 0),
      bandHigh:    round(ixCtx.bandHigh || 0),
      bandWidthPct: round(ixCtx.bandWidthPct || 0),
      spread:      round(ixCtx.orderBook?.spread || 0),
      priceVsOracle: ixCtx.oraclePrice && mid
        ? round((mid - ixCtx.oraclePrice) / ixCtx.oraclePrice * 100)
        : 0,
      trend:       detectTrend(ph),
      priceChange10,

      // ── Formula info — HOW the price is calculated ──
      formula: {
        id:          formula.id || '',
        name:        formula.name || '',
        description: formula.description || '',
        formulaStr:  formula.formulaString || '',
        behavior:    formula.behavior || '',
        drivers:     (formula.drivers || []).map(d => ({
          name: d.name, effect: d.effect, desc: d.desc,
        })),
      },

      // ── Oracle factors — current multiplicative components ──
      factors,
      strongestFactor,
      weakestFactor,

      // ── Oracle inputs — actual values used to compute factors ──
      inputs: {
        activeAgents:    inputs.activeAgents || 0,
        volume24h:       round(inputs.volume24h || 0),
        trades24h:       inputs.trades24h || 0,
        daysSinceLaunch: round(inputs.daysSinceLaunch || 0, 2),
        holderCount:     inputs.holderCount || 0,
        circulatingSupply: round(inputs.circulatingSupply || 0),
        maxSupply:       inputs.maxSupply || 0,
        // Momentum-specific inputs
        avgPnlPct:       inputs.avgPnlPct != null ? round(inputs.avgPnlPct, 2) : undefined,
        avgWinRate:      inputs.avgWinRate != null ? round(inputs.avgWinRate, 3) : undefined,
        totalEquity:     inputs.totalEquity != null ? round(inputs.totalEquity) : undefined,
        tradingAgentsPct: inputs.tradingAgentsPct != null ? round(inputs.tradingAgentsPct, 3) : undefined,
      },

      // ── Supply economics ──
      supply: {
        circulating: round(ixCtx.circulatingSupply || 0),
        max:         ixCtx.maxSupply || 0,
        pct:         round(ixCtx.supplyPct || 0, 1),
      },

      // ── Treasury ──
      treasury: {
        balance:            round(treasury.balance || 0),
        totalCollected:     round(treasury.totalCollected || 0),
        totalRedistributed: round(treasury.totalRedistributed || 0),
        totalBurned:        round(treasury.totalBurned || 0),
        hwmPrice:           round(treasury.hwmPrice || 0),
        backingRatio:       round(treasury.backingRatio || 0),
        redistributionCount: treasury.redistributionCount || 0,
      },

      // ── Holders & volume ──
      holderCount: ixCtx.holderCount || 0,
      totalVolume: round(ixCtx.totalVolume || 0),
      totalTrades: ixCtx.totalTrades || 0,

      // ── Per-index technicals ──
      technicals: indexTechnicals,

      // ── Order book summary ──
      orderBook: {
        bestBid:  round(ixCtx.orderBook?.bestBid || 0),
        bestAsk:  round(ixCtx.orderBook?.bestAsk === Infinity ? 0 : (ixCtx.orderBook?.bestAsk || 0)),
        spread:   round(ixCtx.orderBook?.spread || 0),
      },

      // ── Recent trades ──
      recentTrades: (ixCtx.recentTrades || []).slice(0, 5).map(t => ({
        side:  t.side || 'unknown',
        price: round(t.price),
        size:  round(t.size),
        isMint: !!t.isMint,
      })),

      // ── Agent's own activity on this index ──
      agentActivity: buildAgentIndexActivity(agentIndexTrades[indexId] || []),
    }
  })
}

// ─── Agent's per-index activity (trades, position, PnL) ────────────

function buildAgentIndexActivity(trades) {
  if (!trades || trades.length === 0) {
    return { position: 0, realizedPnl: 0, totalBought: 0, totalSold: 0, tradeCount: 0, avgBuyPrice: 0, avgSellPrice: 0, recentTrades: [] }
  }

  let totalBought = 0, totalSold = 0
  let buyValue = 0, sellValue = 0
  let realizedPnl = 0

  for (const t of trades) {
    if (t.side === 'buy') {
      totalBought += t.size || 0
      buyValue += (t.price || 0) * (t.size || 0)
    } else if (t.side === 'sell') {
      totalSold += t.size || 0
      sellValue += (t.price || 0) * (t.size || 0)
    }
    realizedPnl += t.pnl || 0
  }

  const position = round(totalBought - totalSold)
  const avgBuyPrice = totalBought > 0 ? round(buyValue / totalBought) : 0
  const avgSellPrice = totalSold > 0 ? round(sellValue / totalSold) : 0

  // Last 5 agent trades on this index
  const recentTrades = trades.slice(0, 5).map(t => ({
    side:  t.side || '?',
    price: round(t.price),
    size:  round(t.size),
    pnl:   round(t.pnl || 0),
  }))

  return {
    position: round(position),
    realizedPnl: round(realizedPnl),
    totalBought: round(totalBought),
    totalSold: round(totalSold),
    tradeCount: trades.length,
    avgBuyPrice,
    avgSellPrice,
    recentTrades,
  }
}

// ─── Meta section ──────────────────────────────────────────────────

function assembleMeta(ctx) {
  return {
    tickCount:    ctx.tickCount || 0,
    timestamp:    new Date().toISOString(),
    engineUptime: ctx.tickCount ? `${Math.floor(ctx.tickCount * 3 / 60)} min` : '0 min',
  }
}

// ─── Technical Indicators ──────────────────────────────────────────

function assembleTechnicals(ctx) {
  const ph = ctx.priceHistory || []
  if (ph.length < 10) {
    return { ema10: 0, ema20: 0, rsi14: 50, momentum: 0, priceChange5: 0, priceChange20: 0, support: 0, resistance: 0 }
  }

  const mid = ctx.mid || ctx.currentPrice || 0

  // EMA
  const ema10 = computeEMA(ph, 10)
  const ema20 = computeEMA(ph, 20)

  // RSI (14 periods)
  const rsi14 = computeRSI(ph, 14)

  // Momentum: current vs N ticks ago
  const momentum = ph.length >= 10
    ? round((ph[ph.length - 1] - ph[ph.length - 10]) / ph[ph.length - 10] * 100)
    : 0

  // Short-term price change
  const priceChange5 = ph.length >= 5
    ? round((ph[ph.length - 1] - ph[ph.length - 5]) / ph[ph.length - 5] * 100)
    : 0
  const priceChange20 = ph.length >= 20
    ? round((ph[ph.length - 1] - ph[ph.length - 20]) / ph[ph.length - 20] * 100)
    : 0

  // Simple support / resistance from recent min/max
  const recent50 = ph.slice(-50)
  const support    = round(Math.min(...recent50))
  const resistance = round(Math.max(...recent50))

  return {
    ema10: round(ema10),
    ema20: round(ema20),
    emaSignal: ema10 > ema20 ? 'bullish' : ema10 < ema20 ? 'bearish' : 'neutral',
    rsi14: round(rsi14, 1),
    rsiSignal: rsi14 > 70 ? 'overbought' : rsi14 < 30 ? 'oversold' : 'neutral',
    momentum,
    priceChange5,
    priceChange20,
    support,
    resistance,
    priceVsSupport: support > 0 ? round((mid - support) / support * 100) : 0,
    priceVsResistance: resistance > 0 ? round((mid - resistance) / resistance * 100) : 0,
  }
}

// ─── Summary (short text for memory store) ─────────────────────────

function buildSummary(agentCtx, marketCtx, techCtx, indexes) {
  const parts = [
    `mid=$${marketCtx.mid}`,
    `spread=${marketCtx.spreadPct}%`,
    `vol=${marketCtx.volatility}`,
    `trend=${marketCtx.trend}`,
    `rsi=${techCtx?.rsi14 || '?'}`,
    `ema=${techCtx?.emaSignal || '?'}`,
    `bal=$${agentCtx.balance}`,
    `pos=${agentCtx.position}`,
    `eq=$${agentCtx.equity}`,
  ]
  // Add index summaries
  if (indexes?.length) {
    for (const ix of indexes.slice(0, 3)) {
      parts.push(`${ix.symbol}=$${ix.oraclePrice}(${ix.oracleChangePct >= 0 ? '+' : ''}${ix.oracleChangePct}%)`)
    }
    // Average treasury backing ratio across indexes
    const avgBacking = indexes.reduce((s, ix) => s + (ix.treasury?.backingRatio || 0), 0) / indexes.length
    parts.push(`backing=${(avgBacking * 100).toFixed(1)}%`)
  }
  return parts.join(' | ').substring(0, 280)
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Aggregate tick prices into candle-like objects.
 * @param {number[]} prices
 * @param {number} period - Number of ticks per candle
 * @returns {{ open, high, low, close }[]}
 */
export function aggregateCandles(prices, period = 5) {
  if (!prices || prices.length < period) return []
  const candles = []
  // Take last 60 prices max
  const src = prices.slice(-60)
  for (let i = 0; i <= src.length - period; i += period) {
    const slice = src.slice(i, i + period)
    candles.push({
      open:  round(slice[0]),
      high:  round(Math.max(...slice)),
      low:   round(Math.min(...slice)),
      close: round(slice[slice.length - 1]),
    })
  }
  return candles
}

/**
 * Compute bid/ask volume imbalance from pending orders.
 * @returns {{ bidVol, askVol, ratio, signal }}
 */
export function computeImbalance(ctx) {
  const orders = ctx.pendingOrders || []
  const bidVol = orders.filter(o => o.side === 'buy').reduce((s, o) => s + (o.remaining || o.size || 0), 0)
  const askVol = orders.filter(o => o.side === 'sell').reduce((s, o) => s + (o.remaining || o.size || 0), 0)
  const total = bidVol + askVol
  const ratio = total > 0 ? round(bidVol / total) : 0.5

  let signal = 'neutral'
  if (ratio > 0.65) signal = 'buy_pressure'
  else if (ratio < 0.35) signal = 'sell_pressure'

  return { bidVol: round(bidVol), askVol: round(askVol), ratio, signal }
}

/**
 * Detect recent price trend from history.
 * @param {number[]} priceHistory
 * @returns {'up' | 'down' | 'sideways'}
 */
export function detectTrend(priceHistory) {
  if (!priceHistory || priceHistory.length < 10) return 'sideways'

  const recent = priceHistory.slice(-20)
  const firstHalf  = recent.slice(0, Math.floor(recent.length / 2))
  const secondHalf = recent.slice(Math.floor(recent.length / 2))

  const avgFirst  = firstHalf.reduce((s, p) => s + p, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((s, p) => s + p, 0) / secondHalf.length

  const changePct = avgFirst > 0 ? (avgSecond - avgFirst) / avgFirst * 100 : 0

  if (changePct > 0.3) return 'up'
  if (changePct < -0.3) return 'down'
  return 'sideways'
}

function round(v, decimals = 4) {
  if (typeof v !== 'number' || isNaN(v)) return 0
  const f = Math.pow(10, decimals)
  return Math.round(v * f) / f
}

/**
 * Compute Exponential Moving Average.
 */
function computeEMA(prices, period) {
  if (!prices || prices.length < period) return prices?.length ? prices[prices.length - 1] : 0
  const k = 2 / (period + 1)
  let ema = prices.slice(0, period).reduce((s, p) => s + p, 0) / period
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k)
  }
  return ema
}

/**
 * Compute RSI (Relative Strength Index).
 */
function computeRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50
  const changes = []
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1])
  }
  const recent = changes.slice(-period)
  let gains = 0, losses = 0
  for (const c of recent) {
    if (c > 0) gains += c
    else losses += Math.abs(c)
  }
  if (losses === 0) return 100
  if (gains === 0) return 0
  const rs = (gains / period) / (losses / period)
  return 100 - (100 / (1 + rs))
}

export default { buildContext, aggregateCandles, computeImbalance, detectTrend }
