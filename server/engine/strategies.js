// ═══════════════════════════════════════════════════════════════════════
// Trading Strategies — 8 distinct strategies for autonomous agents
// Each returns [{ action, price, size, reasoning, confidence }]
//
// Actions: 'buy', 'sell', 'hold', 'cancel_all', 'cancel_stale'
//   cancel_all   — cancel all resting orders on this index
//   cancel_stale — cancel orders whose price is outside [bandLow, bandHigh]
//
// ctx fields available:
//   mid, bestBid, bestAsk, spread, currentPrice,
//   priceHistory, volumeHistory, volatility, tickCount,
//   bandLow, bandHigh, bandWidthPct,   ← trading band
//   pendingOrders: [{ id, side, price, remaining, timestamp }]
//
// agent fields available:
//   position, avgEntryPrice, unrealizedPnl, unrealizedPnlPct,
//   virtualBalance, config
// ═══════════════════════════════════════════════════════════════════════

// ─── Helpers ─────────────────────────────────────────────────────────

function rand(min, max) { return Math.random() * (max - min) + min }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }
function diagMetric(label, value) { return { label, value: String(value) } }
function diagFlag(label, ok) { return ok == null ? { label } : { label, ok: !!ok } }
function holdMeta(strategy, mode, metrics = [], flags = [], extra = {}) {
  return { strategy, mode, metrics, flags, ...extra }
}

/** Clamp a price to trading band boundaries; returns clamped price */
function bandClamp(price, ctx) {
  if (!ctx.bandLow || !ctx.bandHigh) return price
  return clamp(price, ctx.bandLow, ctx.bandHigh)
}

/** Check how many resting orders this agent has outside the band */
function staleOrderCount(ctx) {
  if (!ctx.pendingOrders || !ctx.bandLow || !ctx.bandHigh) return 0
  return ctx.pendingOrders.filter(o => o.price < ctx.bandLow || o.price > ctx.bandHigh).length
}

/**
 * Half-width of the trading band as a decimal fraction.
 * bandWidthPct = 3 → returns 0.03 (meaning ±3% from oracle).
 * Falls back to 0.05 if band info unavailable.
 */
function bandHalfWidth(ctx) {
  if (ctx.bandWidthPct > 0) return ctx.bandWidthPct / 100
  if (ctx.bandLow && ctx.bandHigh && ctx.mid > 0) {
    return (ctx.bandHigh - ctx.bandLow) / (2 * ctx.mid)
  }
  return 0.05
}

/**
 * Band-relative price offset (decimal).
 * fraction = 0.03 with 3% band → returns 0.0009 (≈0.09%)
 * Use: mid * (1 + bandOffset(ctx, 0.03)) instead of mid * 1.001
 * This ensures offsets scale with the corridor width.
 */
function bandOffset(ctx, fraction) {
  return bandHalfWidth(ctx) * clamp(fraction, -0.95, 0.95)
}

/** Age of the oldest pending order in seconds */
function oldestOrderAgeSec(ctx) {
  if (!ctx.pendingOrders || ctx.pendingOrders.length === 0) return 0
  const oldest = Math.min(...ctx.pendingOrders.map(o => o.timestamp))
  return (Date.now() - oldest) / 1000
}

// ── Module-level trackers (persist across ticks, shared by all strategies) ──
const _peakPnl = new Map()        // "agentId:indexId" → peak unrealized PnL%
const _lastLossTick = new Map()   // "agentId:indexId" → tickCount of last stop-loss

function _key(agent, ctx) { return `${agent.id}:${ctx.indexId || '_'}` }

/**
 * Trailing-stop overlay — lets profits run, only sells on drawdown from peak.
 * Replaces the old profitTakeCheck which cut winners way too early.
 */
function trailingStopCheck(agent, ctx, opts = {}) {
  const pos = agent.position || 0
  if (pos <= 0) return null

  const minValue = Math.max(2, agent.virtualBalance * 0.001)
  if (pos * ctx.mid < minValue) return null

  const pnlPct = agent.unrealizedPnlPct || 0
  const minProfit = opts.minProfitPct || 5.0   // activate trailing stop after +5%
  const trailPct = opts.trailPct || 3.0        // sell when price drops 3% from peak
  const key = _key(agent, ctx)

  // Update peak tracker
  const curPeak = _peakPnl.get(key) || 0
  if (pnlPct > curPeak) _peakPnl.set(key, pnlPct)
  const peak = _peakPnl.get(key) || 0

  // Not enough profit yet — let it run
  if (peak < minProfit) return null

  const drawdown = peak - pnlPct
  if (drawdown >= trailPct) {
    const fraction = clamp(drawdown / (trailPct * 3), 0.3, 0.8)
    const sellSize = pos * fraction

    // Reset peak after selling
    _peakPnl.set(key, 0)
    _lastLossTick.set(key, ctx.tickCount)

    return {
      action: 'sell',
      price: ctx.mid,
      size: sellSize,
      orderType: 'market',
      reasoning: `TRAIL-STOP: peak +${peak.toFixed(1)}% → now +${pnlPct.toFixed(1)}% (dd=${drawdown.toFixed(1)}%), selling ${(fraction * 100).toFixed(0)}%`,
      confidence: clamp(0.7 + drawdown * 0.03, 0.7, 0.95),
    }
  }
  return null
}

/**
 * Stop-loss overlay — cuts losing positions to prevent deep drawdowns.
 */
function stopLossCheck(agent, ctx, opts = {}) {
  const pos = agent.position || 0
  if (pos <= 0) return null

  const pnlPct = agent.unrealizedPnlPct || 0
  const softStop = opts.softStopPct || -8     // at -8%, sell 40%
  const hardStop = opts.hardStopPct || -15    // at -15%, sell 80%
  const key = _key(agent, ctx)

  if (pnlPct <= hardStop) {
    _lastLossTick.set(key, ctx.tickCount)
    _peakPnl.set(key, 0)
    return {
      action: 'sell', price: ctx.mid, size: pos * 0.8, orderType: 'market',
      reasoning: `HARD-STOP: ${pnlPct.toFixed(1)}% <= ${hardStop}%, liquidating 80%`,
      confidence: 0.95,
    }
  }
  if (pnlPct <= softStop) {
    return {
      action: 'sell', price: ctx.mid, size: pos * 0.4, orderType: 'market',
      reasoning: `SOFT-STOP: ${pnlPct.toFixed(1)}% <= ${softStop}%, reducing 40%`,
      confidence: 0.85,
    }
  }
  return null
}

/**
 * Loss cooldown — returns true if agent recently took a stop-loss on this index.
 * Strategies should skip buying when active to prevent re-entering bad positions.
 */
function lossCooldownActive(agent, ctx, cooldownTicks = 3) {
  const key = _key(agent, ctx)
  const lastLoss = _lastLossTick.get(key)
  if (!lastLoss) return false
  return (ctx.tickCount - lastLoss) < cooldownTicks
}

/**
 * Volatility scaling — reduces order size when volatility is high.
 * Returns multiplier [0.3, 1.0].
 */
function volScale(ctx) {
  const v = ctx.volatility || 0
  if (v < 0.005) return 1.0    // low vol: full size
  if (v > 0.05) return 0.3     // very high vol: 30% size
  return 1.0 - (v - 0.005) / 0.045 * 0.7
}

/**
 * Position weight — how much of the agent's equity is in this index position.
 * Returns a multiplier [0, 1] to scale down buy sizes when already overweight.
 *   weight < 50%  → 1.0 (full buying power)
 *   weight 50-80% → linearly reduces to 0
 *   weight > 80%  → 0 (stop buying)
 */
function positionWeight(agent, ctx) {
  const pos = agent.position || 0
  if (pos <= 0) return 1.0
  const posValue = pos * ctx.mid
  const totalEquity = agent.virtualBalance + posValue
  if (totalEquity <= 0) return 0
  const weight = posValue / totalEquity
  if (weight > 0.8) return 0
  if (weight > 0.5) return 1 - (weight - 0.5) / 0.3
  return 1.0
}

// ═══════════════════════════════════════════════════════════════════════
// 1. MARKET MAKER — places bid+ask around mid price for spread capture
//    Band logic: clamps levels to [bandLow, bandHigh], cancels stale
//    every 5 ticks to keep book clean
// ═══════════════════════════════════════════════════════════════════════

export function marketMaker(agent, ctx) {
  const { mid, spread, volatility } = ctx
  const cfg = agent.config
  const orders = []

  // ── Trailing stop only (MM manages risk via inventory skew, not stop-loss) ──
  const ts = trailingStopCheck(agent, ctx, { minProfitPct: 8, trailPct: 4 })
  if (ts) return [ts]

  // Every 5 ticks, cancel stale orders outside the band
  if (ctx.tickCount % 5 === 0 && staleOrderCount(ctx) > 0) {
    orders.push({ action: 'cancel_stale', reasoning: `MM: cancelling ${staleOrderCount(ctx)} out-of-band orders` })
  }

  // If too many resting orders (>6), cancel all and requote
  if (ctx.pendingOrders && ctx.pendingOrders.length > 6) {
    orders.push({ action: 'cancel_all', reasoning: `MM: ${ctx.pendingOrders.length} resting orders, requoting` })
  }

  const rawSpread = Math.max(
    mid * (cfg.minSpreadPct || 0.5) / 100,
    spread * (cfg.spreadMultiplier || 1.0)
  )
  // Cap spread to 35% of band half-width so bid/ask always have room
  const maxSpread = bandHalfWidth(ctx) * mid * 0.35
  const halfSpread = Math.min(rawSpread, maxSpread)

  let bidPrice = bandClamp(mid - halfSpread, ctx)
  let askPrice = bandClamp(mid + halfSpread, ctx)
  const baseSize = (agent.virtualBalance * (cfg.orderSizePct || 3) / 100) / mid * volScale(ctx)

  // Inventory skew: if holding too much, favor selling aggressively
  const pos = agent.position || 0
  const maxPos = baseSize * (cfg.maxInventory || 6)
  const skew = maxPos > 0 ? clamp(pos / maxPos, -1, 1) : 0
  const buyWeight = positionWeight(agent, ctx)

  // ── Oracle trend detection: if price rising, reduce buys, increase sells ──
  const ph = ctx.priceHistory || []
  let oracleTrend = 0
  if (ph.length >= 5) {
    oracleTrend = (ph[ph.length - 1] - ph[ph.length - 5]) / ph[ph.length - 5]
  }
  const trendBuyDamper = oracleTrend > 0.01 ? clamp(1 - oracleTrend * 10, 0.1, 1.0) : 1.0

  // ── Force sell when heavily overweight (>60% of equity in position) ──
  const posValue = pos * mid
  const totalEq = agent.virtualBalance + posValue
  const posWeight = totalEq > 0 ? posValue / totalEq : 0
  if (posWeight > 0.6 && pos > 0) {
    const urgentSell = pos * clamp((posWeight - 0.6) / 0.2, 0.3, 0.8)
    orders.push({
      action: 'sell', price: mid, size: urgentSell, orderType: 'market',
      reasoning: `MM REBALANCE MKT: posWeight=${(posWeight * 100).toFixed(0)}% >60%, selling ${urgentSell.toFixed(0)}`,
      confidence: 0.9,
    })
    return orders
  }

  const diagnosticMeta = holdMeta(
    'market_maker',
    'watching',
    [
      diagMetric('Half spread', `${((halfSpread / mid) * 100).toFixed(2)}%`),
      diagMetric('Inventory', `${(posWeight * 100).toFixed(0)}%`),
      diagMetric('Buy power', `${(buyWeight * trendBuyDamper * 100).toFixed(0)}%`),
    ],
    [
      diagFlag(pos > 0 ? 'Inventory available' : 'No inventory to sell', pos > 0),
      diagFlag(trendBuyDamper > 0.1 ? 'Buys enabled' : 'Buys damped', trendBuyDamper > 0.1),
    ],
    {
      halfSpreadPct: (halfSpread / mid) * 100,
      inventoryPct: posWeight * 100,
      buyPowerPct: buyWeight * trendBuyDamper * 100,
      oracleTrendPct: oracleTrend * 100,
    }
  )

  // Buy side — damped by inventory skew AND oracle trend
  if (skew < 0.5 && buyWeight > 0 && trendBuyDamper > 0.1) {
    const size = baseSize * buyWeight * trendBuyDamper
    let buyPrice = bandClamp(bidPrice * (1 - skew * 0.005), ctx)
    orders.push({
      action: 'buy', price: buyPrice,
      size: size * (1 - skew * 0.5),
      orderType: 'limit',
      reasoning: `MM bid at ${buyPrice.toFixed(5)}, skew=${skew.toFixed(2)}, trendDamp=${trendBuyDamper.toFixed(2)}`,
      confidence: 0.6 + Math.random() * 0.2,
    })
  }

  // Sell side — always sell when holding, use market when overweight
  if (pos > 0) {
    const sellSize = Math.min(baseSize * (1 + skew * 0.5), pos)
    if (sellSize > 0) {
      const useMarket = skew > 0.2 || oracleTrend > 0.02
      let sellPrice = bandClamp(askPrice, ctx)
      orders.push({
        action: 'sell', price: sellPrice,
        size: sellSize,
        orderType: useMarket ? 'market' : 'ioc',
        reasoning: `MM ${useMarket ? 'MKT' : 'IOC'} ask at ${sellPrice.toFixed(5)}, skew=${skew.toFixed(2)}, pos=${pos.toFixed(0)}`,
        confidence: 0.7 + Math.random() * 0.2,
      })
    }
  }

  if (!orders.some(order => order.action === 'buy' || order.action === 'sell')) {
    const reason = posWeight > 0.55
      ? `MM: inventory ${(posWeight * 100).toFixed(0)}% is heavy, waiting to lighten position`
      : buyWeight <= 0
        ? 'MM: inventory is full, waiting before placing new bids'
        : trendBuyDamper <= 0.1
          ? `MM: oracle trend ${(oracleTrend * 100).toFixed(2)}% too strong for fresh bids`
          : 'MM: waiting for the next clean market-making quote'
    orders.push({ action: 'hold', reasoning: reason, confidence: 0.2, meta: diagnosticMeta })
  }

  return orders
}

// ═══════════════════════════════════════════════════════════════════════
// 2. TREND FOLLOWER — follows momentum of floor index
//    Band logic: clamps entry prices, cancels if trend reverses and
//    resting orders are now on wrong side
// ═══════════════════════════════════════════════════════════════════════

export function trendFollower(agent, ctx) {
  const { mid, priceHistory, volatility } = ctx
  const cfg = agent.config
  const lookback = cfg.lookback || 10
  const threshold = (cfg.momentumThreshold || 2.0) / 100

  // ── Stop-loss: very wide — trends need room (only bail on catastrophic loss) ──
  const sl = stopLossCheck(agent, ctx, { softStopPct: -15, hardStopPct: -30 })
  if (sl) return [sl]
  // ── Trailing stop (let trends ride, take profit on big reversal from peak) ──
  const ts = trailingStopCheck(agent, ctx, { minProfitPct: 15, trailPct: 8 })
  if (ts) return [ts]

  if (priceHistory.length < lookback + 1) {
    return [{
      action: 'hold',
      reasoning: 'Not enough price history',
      confidence: 0,
      meta: holdMeta(
        'trend_follower',
        'warming_up',
        [
          diagMetric('History', `${priceHistory.length}/${lookback + 1}`),
          diagMetric('Threshold', `±${(threshold * 100).toFixed(2)}%`),
          diagMetric('Lookback', `${lookback} bars`),
        ],
        [],
        {
          lookback,
          historyBars: priceHistory.length,
          thresholdPct: threshold * 100,
        }
      ),
    }]
  }

  const recent = priceHistory.slice(-lookback)
  const sma = recent.reduce((s, p) => s + p, 0) / recent.length
  const momentum = (mid - sma) / sma

  // ── Longer-term trend confirmation: 30-bar SMA must also be rising ──
  let longTrendUp = true
  if (priceHistory.length >= 30) {
    const long30 = priceHistory.slice(-30)
    const longSma = long30.reduce((s, p) => s + p, 0) / 30
    longTrendUp = mid > longSma
  }

  const buyWeight = positionWeight(agent, ctx)
  const baseSize = (agent.virtualBalance * (cfg.orderSizePct || 2) / 100) / mid * volScale(ctx)
  const orders = []
  const diagnosticMeta = holdMeta(
    'trend_follower',
    'watching',
    [
      diagMetric('Momentum', `${momentum >= 0 ? '+' : ''}${(momentum * 100).toFixed(2)}%`),
      diagMetric('Threshold', `±${(threshold * 100).toFixed(2)}%`),
      diagMetric('Lookback', `${lookback} bars`),
    ],
    [diagFlag(longTrendUp ? 'Long trend confirmed' : 'Long trend not confirmed', longTrendUp)],
    {
      lookback,
      momentumPct: momentum * 100,
      thresholdPct: threshold * 100,
      longTrendUp,
      volatilityPct: volatility * 100,
    }
  )

  // Cancel stale orders outside band
  if (staleOrderCount(ctx) > 0) {
    orders.push({ action: 'cancel_stale', reasoning: `TF: ${staleOrderCount(ctx)} out-of-band orders` })
  }

  // Cancel resting buy orders if trend just reversed to DOWN
  if (momentum < -threshold && ctx.pendingOrders) {
    const staleBuys = ctx.pendingOrders.filter(o => o.side === 'buy')
    if (staleBuys.length > 0) {
      orders.push({ action: 'cancel_all', reasoning: `TF: trend reversed DOWN, cancelling ${staleBuys.length} buy orders` })
    }
  }
  // Cancel resting sell orders if trend reversed UP
  if (momentum > threshold && ctx.pendingOrders) {
    const staleSells = ctx.pendingOrders.filter(o => o.side === 'sell')
    if (staleSells.length > 0) {
      orders.push({ action: 'cancel_all', reasoning: `TF: trend reversed UP, cancelling ${staleSells.length} sell orders` })
    }
  }

  if (momentum > threshold) {
    if (lossCooldownActive(agent, ctx, 5)) {
      orders.push({ action: 'hold', reasoning: 'TF: loss cooldown active', confidence: 0.1, meta: { ...diagnosticMeta, mode: 'cooldown' } })
      return orders
    }
    // Only buy if long-term trend also confirms
    if (!longTrendUp) {
      orders.push({ action: 'hold', reasoning: `TF: short UP but long SMA not confirmed`, confidence: 0.2, meta: { ...diagnosticMeta, mode: 'long_trend_unconfirmed' } })
      return orders
    }
    const strong = momentum > threshold * 2
    const price = bandClamp(mid * (1 + bandOffset(ctx, 0.03)), ctx)
    const buySize = baseSize * buyWeight
    if (buySize > 0) {
      orders.push({
        action: 'buy', price,
        size: buySize,
        orderType: strong ? 'market' : 'ioc',
        reasoning: `Trend UP${strong ? ' (MKT)' : ' (IOC)'}: mom=${(momentum * 100).toFixed(2)}% > ${(threshold * 100).toFixed(1)}%, longOK`,
        confidence: clamp(0.5 + momentum * 5, 0.5, 0.90),
      })
    }
    return orders
  }

  if (momentum < -threshold && (agent.position || 0) > 0) {
    const sellSize = Math.min(baseSize * clamp(Math.abs(momentum) / threshold, 1, 2), agent.position)
    const price = bandClamp(mid * (1 - bandOffset(ctx, 0.03)), ctx)
    orders.push({
      action: 'sell', price,
      size: sellSize,
      orderType: 'market',  // always market for trend sells — ensure fill
      reasoning: `Trend DOWN MKT: momentum=${(momentum * 100).toFixed(3)}% < -${(threshold * 100).toFixed(2)}%`,
      confidence: clamp(0.5 + Math.abs(momentum) * 10, 0.5, 0.95),
    })
    return orders
  }

  orders.push({
    action: 'hold',
    reasoning: `Momentum ${(momentum * 100).toFixed(3)}% within threshold ±${(threshold * 100).toFixed(2)}%`,
    confidence: 0.3,
    meta: { ...diagnosticMeta, mode: 'within_threshold' },
  })
  return orders
}

// ═══════════════════════════════════════════════════════════════════════
// 3. MEAN REVERSION — buys dips, sells rips relative to moving average
//    Band logic: clamps to band, cancels if mean shifted and old
//    orders are far from new mean
// ═══════════════════════════════════════════════════════════════════════

export function meanReversion(agent, ctx) {
  const { mid, priceHistory } = ctx
  const cfg = agent.config
  const lookback = cfg.lookback || 20

  // ── Stop-loss (protect capital) ──
  const sl = stopLossCheck(agent, ctx, { softStopPct: -8, hardStopPct: -15 })
  if (sl) return [sl]
  // ── Trailing stop (let profits run to the mean) ──
  const ts = trailingStopCheck(agent, ctx, { minProfitPct: 5, trailPct: 3 })
  if (ts) return [ts]

  if (priceHistory.length < lookback) {
    return [{
      action: 'hold',
      reasoning: 'Building price history',
      confidence: 0,
      meta: holdMeta(
        'mean_reversion',
        'warming_up',
        [
          diagMetric('History', `${priceHistory.length}/${lookback}`),
          diagMetric('Entry Z', `${(cfg.entryZScore || 1.5).toFixed(2)}`),
          diagMetric('Lookback', `${lookback} bars`),
        ],
        [],
        {
          lookback,
          historyBars: priceHistory.length,
          entryZScore: cfg.entryZScore || 1.5,
        }
      ),
    }]
  }

  const recent = priceHistory.slice(-lookback)
  const mean = recent.reduce((s, p) => s + p, 0) / recent.length
  const std = Math.sqrt(recent.reduce((s, p) => s + (p - mean) ** 2, 0) / recent.length)
  const zScore = std > 0 ? (mid - mean) / std : 0

  const entryZ = cfg.entryZScore || 1.5
  const exitZ = cfg.exitZScore || 0.3
  const buyWeight = positionWeight(agent, ctx)
  const baseSize = (agent.virtualBalance * (cfg.orderSizePct || 6) / 100) / mid
  const orders = []

  // ── Treasury backing bias: well-backed indexes are safer for dip buying ──
  const backingRatio = ctx.treasury?.backingRatio || 0
  const treasuryBias = backingRatio > 0.8 ? 1.15 : backingRatio > 0.5 ? 1.0 : backingRatio > 0.2 ? 0.7 : 0.4
  const diagnosticMeta = holdMeta(
    'mean_reversion',
    'within_band',
    [
      diagMetric('Z-Score', zScore.toFixed(2)),
      diagMetric('Entry band', `±${entryZ.toFixed(2)}`),
      diagMetric('Exit band', `±${exitZ.toFixed(2)}`),
    ],
    [diagFlag(zScore <= 0 ? 'Below mean' : 'Above mean')],
    {
      lookback,
      zScore,
      entryZScore: entryZ,
      exitZScore: exitZ,
      treasuryBias,
    }
  )

  // Cancel resting orders that drifted outside the band
  if (staleOrderCount(ctx) > 0) {
    orders.push({ action: 'cancel_stale', reasoning: `MR: ${staleOrderCount(ctx)} out-of-band orders` })
  }

  // Cancel old resting orders that are far from current mean (>2 std)
  if (ctx.pendingOrders && std > 0) {
    const farOrders = ctx.pendingOrders.filter(o => Math.abs(o.price - mean) > 2 * std)
    if (farOrders.length > 0) {
      orders.push({ action: 'cancel_all', reasoning: `MR: ${farOrders.length} orders >2σ from mean, requoting` })
    }
  }

  if (zScore < -entryZ) {
    const extreme = Math.abs(zScore) > entryZ * 2
    const price = bandClamp(mid * (1 + bandOffset(ctx, 0.015)), ctx)
    const buySize = baseSize * buyWeight * treasuryBias
    if (buySize > 0) {
      orders.push({
        action: 'buy', price,
        size: buySize * clamp(Math.abs(zScore) / entryZ, 1, 2),
        orderType: extreme ? 'market' : 'ioc',
        reasoning: `MR BUY${extreme ? ' MKT' : ' IOC'}: z=${zScore.toFixed(2)} < -${entryZ} (oversold) tBias=${treasuryBias.toFixed(2)}`,
        confidence: clamp(0.5 + Math.abs(zScore) * 0.15, 0.5, 0.92),
      })
    }
    return orders
  }

  if (zScore > entryZ && (agent.position || 0) > 0) {
    const extreme = zScore > entryZ * 2
    const sellSize = Math.min(baseSize * clamp(zScore / entryZ, 1, 2), agent.position)
    const price = bandClamp(mid * (1 - bandOffset(ctx, 0.015)), ctx)
    orders.push({
      action: 'sell', price,
      size: sellSize,
      orderType: extreme ? 'market' : 'ioc',
      reasoning: `MR SELL${extreme ? ' MKT' : ' IOC'}: z=${zScore.toFixed(2)} > ${entryZ} (overbought)`,
      confidence: clamp(0.5 + zScore * 0.15, 0.5, 0.92),
    })
    return orders
  }

  // Exit long positions towards mean — use IOC to ensure fill
  const pos = agent.position || 0
  if (Math.abs(zScore) < exitZ && pos > 0) {
    const price = bandClamp(mid, ctx)
    orders.push({
      action: 'sell', price,
      size: pos * 0.5,
      orderType: 'ioc',
      reasoning: `MR EXIT IOC: z=${zScore.toFixed(2)} near mean, closing 50% of ${pos.toFixed(0)} position`,
      confidence: 0.65,
    })
    return orders
  }

  orders.push({ action: 'hold', reasoning: `MR: z=${zScore.toFixed(2)}, within band [${(-entryZ).toFixed(1)}, ${entryZ.toFixed(1)}]`, confidence: 0.2, meta: diagnosticMeta })
  return orders
}

// ═══════════════════════════════════════════════════════════════════════
// 4. MOMENTUM — follows short-term price breaks (fast/slow MA cross)
//    Band logic: clamps to band, cancels on cross reversal
// ═══════════════════════════════════════════════════════════════════════

export function momentum(agent, ctx) {
  const { mid, priceHistory } = ctx
  const cfg = agent.config
  const fast = cfg.fastPeriod || 5
  const slow = cfg.slowPeriod || 15

  // ── NO stop-loss for momentum (oracle-driven prices cause whipsaw) ──
  // ── Trailing stop only: wide, let momentum ride ──
  const ts = trailingStopCheck(agent, ctx, { minProfitPct: 12, trailPct: 6 })
  if (ts) return [ts]

  if (priceHistory.length < slow + 1) {
    return [{
      action: 'hold',
      reasoning: 'Waiting for enough bars',
      confidence: 0,
      meta: holdMeta(
        'momentum',
        'warming_up',
        [
          diagMetric('History', `${priceHistory.length}/${slow + 1}`),
          diagMetric('Fast / Slow', `${fast}/${slow}`),
          diagMetric('Threshold', `±${(((cfg.crossThreshold || 1.0) / 100) * 100).toFixed(2)}%`),
        ],
        [],
        {
          fastPeriod: fast,
          slowPeriod: slow,
          historyBars: priceHistory.length,
          thresholdPct: (cfg.crossThreshold || 1.0),
        }
      ),
    }]
  }

  const fastMA = priceHistory.slice(-fast).reduce((s, p) => s + p, 0) / fast
  const slowMA = priceHistory.slice(-slow).reduce((s, p) => s + p, 0) / slow
  const cross = (fastMA - slowMA) / slowMA
  const buyWeight = positionWeight(agent, ctx)
  const baseSize = (agent.virtualBalance * (cfg.orderSizePct || 2) / 100) / mid * volScale(ctx)
  const threshold = (cfg.crossThreshold || 1.0) / 100
  const orders = []
  const diagnosticMeta = holdMeta(
    'momentum',
    'watching',
    [
      diagMetric('Cross', `${cross >= 0 ? '+' : ''}${(cross * 100).toFixed(3)}%`),
      diagMetric('Entry', `±${(threshold * 200).toFixed(2)}%`),
      diagMetric('Fast / Slow', `${fast}/${slow}`),
    ],
    [diagFlag(cross > 0 ? 'Bullish bias' : cross < 0 ? 'Bearish bias' : 'Flat cross')],
    {
      fastPeriod: fast,
      slowPeriod: slow,
      crossPct: cross * 100,
      thresholdPct: threshold * 100,
      strongEntryPct: threshold * 200,
    }
  )

  // Cancel stale (out-of-band) orders
  if (staleOrderCount(ctx) > 0) {
    orders.push({ action: 'cancel_stale', reasoning: `MOM: cancelling out-of-band orders` })
  }

  // If cross direction flipped and we still have resting orders, cancel them
  if (ctx.pendingOrders && ctx.pendingOrders.length > 0) {
    const hasBuys = ctx.pendingOrders.some(o => o.side === 'buy')
    const hasSells = ctx.pendingOrders.some(o => o.side === 'sell')
    if (cross < -threshold && hasBuys) {
      orders.push({ action: 'cancel_all', reasoning: `MOM: bearish cross, cancelling stale buys` })
    } else if (cross > threshold && hasSells) {
      orders.push({ action: 'cancel_all', reasoning: `MOM: bullish cross, cancelling stale sells` })
    }
  }

  if (cross > threshold) {
    if (lossCooldownActive(agent, ctx, 5)) {
      orders.push({ action: 'hold', reasoning: 'MOM: loss cooldown active', confidence: 0.1, meta: { ...diagnosticMeta, mode: 'cooldown' } })
      return orders
    }
    // Only enter on strong cross (>2x threshold) to avoid noise
    const strong = cross > threshold * 2
    if (!strong) {
      orders.push({ action: 'hold', reasoning: `MOM: cross ${(cross*100).toFixed(2)}% not strong enough (need >${(threshold*200).toFixed(1)}%)`, confidence: 0.2, meta: { ...diagnosticMeta, mode: 'cross_too_weak' } })
      return orders
    }
    const price = bandClamp(mid * (1 + bandOffset(ctx, 0.03)), ctx)
    const buySize = baseSize * buyWeight
    if (buySize > 0) {
      orders.push({
        action: 'buy', price,
        size: buySize * 0.5,  // half size to limit exposure
        orderType: 'ioc',
        reasoning: `MOM BUY IOC: fast(${fast})=${fastMA.toFixed(4)} > slow(${slow})=${slowMA.toFixed(4)}, cross=${(cross * 100).toFixed(2)}%`,
        confidence: clamp(0.5 + cross * 10, 0.5, 0.85),
      })
    }
    return orders
  }

  if (cross < -threshold && (agent.position || 0) > 0) {
    const strong = Math.abs(cross) > threshold * 3
    const sellSize = Math.min(baseSize, agent.position)
    const price = bandClamp(mid * (1 - bandOffset(ctx, 0.03)), ctx)
    orders.push({
      action: 'sell', price,
      size: sellSize,
      orderType: strong ? 'market' : 'ioc',
      reasoning: `MOM SELL${strong ? ' MKT' : ' IOC'}: fast < slow, cross=${(cross * 100).toFixed(3)}%`,
      confidence: clamp(0.55 + Math.abs(cross) * 20, 0.55, 0.9),
    })
    return orders
  }

  orders.push({ action: 'hold', reasoning: `MOM: cross=${(cross * 100).toFixed(3)}%, threshold=±${(threshold * 100).toFixed(2)}%`, confidence: 0.2, meta: { ...diagnosticMeta, mode: 'within_threshold' } })
  return orders
}

// ═══════════════════════════════════════════════════════════════════════
// 5. GRID TRADER — places orders at fixed price intervals
//    Band logic: skips levels outside band, cancels all and requotes
//    every 10 ticks to refresh the grid around new mid
// ═══════════════════════════════════════════════════════════════════════

export function gridTrader(agent, ctx) {
  const { mid } = ctx
  const cfg = agent.config
  const levels = cfg.gridLevels || 3
  // Adapt gridSize to band: each level uses at most 80%/levels of the band half-width
  const maxGridSize = bandHalfWidth(ctx) * 0.8 / levels
  const gridSize = Math.min((cfg.gridSizePct || 0.8) / 100, maxGridSize)
  const buyWeight = positionWeight(agent, ctx)
  const sizePerLevel = (agent.virtualBalance * (cfg.orderSizePct || 2) / 100) / mid / levels * volScale(ctx)

  const orders = []
  const pos = agent.position || 0
  let remainingSell = pos

  // ── NO stop-loss for grid (it breaks grid pattern) ──
  // ── Only trailing stop with very wide tolerance ──
  const ts = trailingStopCheck(agent, ctx, { minProfitPct: 10, trailPct: 6 })
  if (ts) return [ts]

  // ── Oracle trend: if price rising, put MORE on sell side, LESS on buy side ──
  const ph = ctx.priceHistory || []
  let trendBias = 0  // positive = rising
  if (ph.length >= 5) {
    trendBias = (ph[ph.length - 1] - ph[ph.length - 5]) / ph[ph.length - 5]
  }
  const buyDamper = trendBias > 0.01 ? clamp(1 - trendBias * 8, 0.1, 1.0) : 1.0

  // ── Force rebalance: if >50% equity in position, dump excess at market ──
  const posValue = pos * mid
  const totalEq = agent.virtualBalance + posValue
  const posWt = totalEq > 0 ? posValue / totalEq : 0
  if (posWt > 0.5 && pos > 0) {
    const dumpSize = pos * clamp((posWt - 0.5) / 0.3, 0.2, 0.7)
    orders.push({
      action: 'sell', price: mid, size: dumpSize, orderType: 'market',
      reasoning: `GRID REBALANCE: posWt=${(posWt*100).toFixed(0)}%>50%, selling ${dumpSize.toFixed(0)}`,
      confidence: 0.9,
    })
    return orders
  }

  // Every 10 ticks, cancel all and rebuild grid
  if (ctx.tickCount % 10 === 0 && ctx.pendingOrders && ctx.pendingOrders.length > 0) {
    orders.push({ action: 'cancel_all', reasoning: `GRID: requoting around mid=${mid.toFixed(5)}` })
  }
  if (staleOrderCount(ctx) > 0) {
    orders.push({ action: 'cancel_stale', reasoning: `GRID: cancelling ${staleOrderCount(ctx)} out-of-band levels` })
  }

  const diagnosticMeta = holdMeta(
    'grid_trader',
    'watching',
    [
      diagMetric('Levels', `${levels}`),
      diagMetric('Grid step', `${(gridSize * 100).toFixed(2)}%`),
      diagMetric('Position', `${(posWt * 100).toFixed(0)}%`),
    ],
    [
      diagFlag(buyDamper > 0.1 ? 'Bids enabled' : 'Bids damped', buyDamper > 0.1),
      diagFlag(remainingSell > 0 ? 'Sell inventory ready' : 'No inventory to sell', remainingSell > 0),
    ],
    {
      gridLevels: levels,
      gridSizePct: gridSize * 100,
      positionPct: posWt * 100,
      trendBiasPct: trendBias * 100,
      buyDamperPct: buyDamper * 100,
    }
  )

  for (let i = 1; i <= levels; i++) {
    // Buy side — damped by trend and position weight
    if (buyWeight > 0 && buyDamper > 0.1) {
      const buyPrice = mid * (1 - gridSize * i)
      const clampedBuy = bandClamp(buyPrice, ctx)
      if (!(ctx.bandLow && clampedBuy <= ctx.bandLow * 1.0001)) {
        orders.push({
          action: 'buy', price: clampedBuy,
          size: sizePerLevel * buyWeight * buyDamper,
          reasoning: `GRID BUY L${i}: ${clampedBuy.toFixed(5)}, buyDamp=${buyDamper.toFixed(2)}`,
          confidence: 0.5,
        })
      }
    }

    // Sell side — always sell when holding, first level IOC
    if (remainingSell > 0) {
      const sellPrice = i === 1
        ? mid * (1 + gridSize * 0.2)
        : mid * (1 + gridSize * i)
      const clampedSell = bandClamp(sellPrice, ctx)
      if (ctx.bandHigh && clampedSell >= ctx.bandHigh * 0.9999 && i > 1) continue
      const sellSize = Math.min(sizePerLevel * 1.5, remainingSell)  // sell side 50% bigger
      orders.push({
        action: 'sell', price: clampedSell,
        size: sellSize,
        orderType: 'ioc',
        reasoning: `GRID SELL IOC L${i}: ${clampedSell.toFixed(5)}, pos=${pos.toFixed(0)}`,
        confidence: 0.65,
      })
      remainingSell -= sellSize
    }
  }

  if (!orders.some(order => order.action === 'buy' || order.action === 'sell')) {
    const reason = buyWeight <= 0
      ? 'GRID: position is already full, waiting before adding new bids'
      : buyDamper <= 0.1 && remainingSell <= 0
        ? `GRID: uptrend ${(trendBias * 100).toFixed(2)}% is suppressing fresh bids`
        : 'GRID: waiting for the next grid level to become actionable'
    orders.push({ action: 'hold', reasoning: reason, confidence: 0.2, meta: diagnosticMeta })
  }

  return orders
}

// ═══════════════════════════════════════════════════════════════════════
// 6. SCALPER — tiny frequent trades capturing small moves
//    Band logic: clamps prices, cancels orders older than 30s
//    (scalper wants fresh fills, not stale resting orders)
// ═══════════════════════════════════════════════════════════════════════

export function scalper(agent, ctx) {
  const { mid, priceHistory, volatility } = ctx
  const cfg = agent.config
  const orders = []

  // ── NO stop-loss for scalper (tiny positions, fast turnover) ──
  // ── Instead: if position value >30% of equity, force sell (position too heavy for a scalper) ──
  const pos = agent.position || 0
  const posValue = pos * mid
  const totalEq = agent.virtualBalance + posValue
  const posWt = totalEq > 0 ? posValue / totalEq : 0
  if (posWt > 0.3 && pos > 0) {
    orders.push({
      action: 'sell', price: mid, size: pos * 0.7, orderType: 'market',
      reasoning: `SCALP DUMP: posWt=${(posWt*100).toFixed(0)}%>30%, selling 70% at market`,
      confidence: 0.9,
    })
    return orders
  }

  // Scalper cancels all orders older than 20 seconds
  if (ctx.pendingOrders && ctx.pendingOrders.length > 0) {
    const ageLimit = cfg.maxOrderAgeSec || 20
    if (oldestOrderAgeSec(ctx) > ageLimit) {
      orders.push({ action: 'cancel_all', reasoning: `SCALP: oldest order >${ageLimit}s, refreshing` })
    }
  }
  if (staleOrderCount(ctx) > 0) {
    orders.push({ action: 'cancel_stale', reasoning: `SCALP: cancelling out-of-band orders` })
  }

  if (priceHistory.length < 5) {
    orders.push({
      action: 'hold',
      reasoning: 'Scalper warming up',
      confidence: 0,
      meta: holdMeta(
        'scalper',
        'warming_up',
        [
          diagMetric('History', `${priceHistory.length}/5`),
          diagMetric('Threshold', `±${(cfg.microThreshold || 0.2).toFixed(2)}%`),
          diagMetric('Volatility', `${(volatility * 100).toFixed(2)}%`),
        ],
        [],
        {
          historyBars: priceHistory.length,
          thresholdPct: cfg.microThreshold || 0.2,
          volatilityPct: volatility * 100,
        }
      ),
    })
    return orders
  }

  const last5 = priceHistory.slice(-5)
  const microTrend = (last5[4] - last5[0]) / last5[0]
  const buyWeight = positionWeight(agent, ctx)
  const baseSize = (agent.virtualBalance * (cfg.orderSizePct || 1.5) / 100) / mid * volScale(ctx)
  const threshold = (cfg.microThreshold || 0.2) / 100
  const diagnosticMeta = holdMeta(
    'scalper',
    'watching',
    [
      diagMetric('Micro trend', `${microTrend >= 0 ? '+' : ''}${(microTrend * 100).toFixed(3)}%`),
      diagMetric('Threshold', `±${(threshold * 100).toFixed(3)}%`),
      diagMetric('Position', `${(posWt * 100).toFixed(0)}%`),
    ],
    [diagFlag(pos > 0 ? 'Position loaded' : 'Flat book', pos > 0)],
    {
      microTrendPct: microTrend * 100,
      thresholdPct: threshold * 100,
      positionPct: posWt * 100,
      volatilityPct: volatility * 100,
    }
  )

  // ── Always prefer selling existing position (scalper shouldn't accumulate) ──
  if (pos > 0) {
    // Sell on ANY downtick or at small profit
    if (microTrend < 0 || (agent.unrealizedPnlPct || 0) > 0.3) {
      const reason = microTrend < 0 ? `micro down ${(microTrend*100).toFixed(3)}%` : `profit +${(agent.unrealizedPnlPct||0).toFixed(1)}%`
      orders.push({
        action: 'sell', price: mid, size: Math.min(baseSize * 2, pos),
        orderType: 'market',
        reasoning: `SCALP SELL MKT: ${reason}`,
        confidence: 0.6,
      })
      return orders
    }
  }

  // Buy only on clear uptick AND when not already holding
  if (microTrend > threshold && pos <= 0 && buyWeight > 0) {
    const buySize = baseSize * buyWeight
    if (buySize > 0) {
      orders.push({
        action: 'buy', price: bandClamp(mid * (1 + bandOffset(ctx, 0.003)), ctx),
        size: buySize,
        orderType: 'market',
        reasoning: `SCALP BUY MKT: micro=${(microTrend * 100).toFixed(3)}% up, no pos`,
        confidence: 0.55,
      })
    }
    return orders
  }

  // Random liquidity (reduced frequency)
  if (Math.random() < (cfg.randomTradePct || 5) / 100) {
    if (pos > 0) {
      orders.push({
        action: 'sell', price: bandClamp(mid * (1 + bandOffset(ctx, 0.01)), ctx),
        size: Math.min(baseSize * 0.5, pos), orderType: 'ioc',
        reasoning: `SCALP random sell IOC`, confidence: 0.4,
      })
      return orders
    }
  }

  orders.push({ action: 'hold', reasoning: `SCALP: micro=${(microTrend * 100).toFixed(3)}%, waiting`, confidence: 0.2, meta: diagnosticMeta })
  return orders
}

// ═══════════════════════════════════════════════════════════════════════
// 7. CONTRARIAN — fades short-term moves, bets on reversal
//    Band logic: clamps prices, cancels if price returned to mid
//    (contrarian profits from reversion, stale orders = missed exit)
// ═══════════════════════════════════════════════════════════════════════

export function contrarian(agent, ctx) {
  const { mid, priceHistory } = ctx
  const cfg = agent.config
  const lookback = cfg.lookback || 8

  // ── Stop-loss (contrarian can be wrong about reversal) ──
  const sl = stopLossCheck(agent, ctx, { softStopPct: -8, hardStopPct: -15 })
  if (sl) return [sl]
  // ── Trailing stop (let mean-reversion play out) ──
  const ts = trailingStopCheck(agent, ctx, { minProfitPct: 5, trailPct: 3 })
  if (ts) return [ts]

  if (priceHistory.length < lookback + 1) {
    return [{
      action: 'hold',
      reasoning: 'Contrarian warming up',
      confidence: 0,
      meta: holdMeta(
        'contrarian',
        'warming_up',
        [
          diagMetric('History', `${priceHistory.length}/${lookback + 1}`),
          diagMetric('Threshold', `±${(cfg.fadeThreshold || 0.8).toFixed(2)}%`),
          diagMetric('Lookback', `${lookback} bars`),
        ],
        [],
        {
          lookback,
          historyBars: priceHistory.length,
          thresholdPct: cfg.fadeThreshold || 0.8,
        }
      ),
    }]
  }

  const recent = priceHistory.slice(-lookback)
  const change = (recent[recent.length - 1] - recent[0]) / recent[0]
  const threshold = (cfg.fadeThreshold || 0.8) / 100
  const buyWeight = positionWeight(agent, ctx)
  const baseSize = (agent.virtualBalance * (cfg.orderSizePct || 7) / 100) / mid
  const pos = agent.position || 0
  const orders = []

  // ── Treasury backing bias: contrarians need strong treasury to justify fading ──
  const backingRatio = ctx.treasury?.backingRatio || 0
  const treasuryBias = backingRatio > 0.8 ? 1.15 : backingRatio > 0.5 ? 1.0 : backingRatio > 0.2 ? 0.7 : 0.4
  const diagnosticMeta = holdMeta(
    'contrarian',
    'within_threshold',
    [
      diagMetric('Change', `${change >= 0 ? '+' : ''}${(change * 100).toFixed(3)}%`),
      diagMetric('Threshold', `±${(threshold * 100).toFixed(2)}%`),
      diagMetric('Lookback', `${lookback} bars`),
    ],
    [diagFlag(change >= 0 ? 'Fading rally watch' : 'Dip-buy watch')],
    {
      lookback,
      changePct: change * 100,
      thresholdPct: threshold * 100,
      treasuryBias,
    }
  )

  // Cancel stale out-of-band orders
  if (staleOrderCount(ctx) > 0) {
    orders.push({ action: 'cancel_stale', reasoning: `CONTRA: cancelling out-of-band orders` })
  }

  // Cancel all if price reverted to near-zero change (our thesis played out)
  if (Math.abs(change) < threshold * 0.3 && ctx.pendingOrders && ctx.pendingOrders.length > 0) {
    orders.push({ action: 'cancel_all', reasoning: `CONTRA: price reverted, cancelling ${ctx.pendingOrders.length} stale orders` })
  }

  // Fade the move — use IOC for quick entry, no stale resting orders
  if (change > threshold && pos > 0) {
    const bigMove = change > threshold * 2.5
    const sellSize = Math.min(baseSize * clamp(change / threshold, 1, 2), pos)
    const price = bandClamp(mid * (1 - bandOffset(ctx, 0.007)), ctx)
    orders.push({
      action: 'sell', price,
      size: sellSize,
      orderType: bigMove ? 'market' : 'ioc',
      reasoning: `CONTRA SELL${bigMove ? ' MKT' : ' IOC'}: price up ${(change * 100).toFixed(3)}%, fading rally, pos=${pos.toFixed(0)}`,
      confidence: clamp(0.5 + change * 5, 0.5, 0.85),
    })
    return orders
  }

  if (change < -threshold) {
    const bigMove = Math.abs(change) > threshold * 2.5
    const price = bandClamp(mid * (1 + bandOffset(ctx, 0.007)), ctx)
    const buySize = baseSize * buyWeight * treasuryBias
    if (buySize > 0) {
      orders.push({
        action: 'buy', price,
        size: buySize * clamp(Math.abs(change) / threshold, 1, 2),
        orderType: bigMove ? 'market' : 'ioc',
        reasoning: `CONTRA BUY${bigMove ? ' MKT' : ' IOC'}: price down ${(change * 100).toFixed(3)}%, fading sell-off, tBias=${treasuryBias.toFixed(2)}`,
        confidence: clamp(0.5 + Math.abs(change) * 5, 0.5, 0.85),
      })
    }
    return orders
  }

  orders.push({ action: 'hold', reasoning: `CONTRA: change=${(change * 100).toFixed(3)}%, threshold=±${(threshold * 100).toFixed(2)}%`, confidence: 0.2, meta: diagnosticMeta })
  return orders
}

// ═══════════════════════════════════════════════════════════════════════
// 8. VWAP — tracks volume-weighted average and trades deviations
//    Band logic: clamps prices, cancels stale every 8 ticks
// ═══════════════════════════════════════════════════════════════════════

export function vwapTrader(agent, ctx) {
  const { mid, priceHistory, volumeHistory } = ctx
  const cfg = agent.config
  const orders = []

  // ── Stop-loss (protect capital) ──
  const sl = stopLossCheck(agent, ctx, { softStopPct: -8, hardStopPct: -15 })
  if (sl) return [sl]
  // ── Trailing stop (let VWAP trades run) ──
  const ts = trailingStopCheck(agent, ctx, { minProfitPct: 4, trailPct: 2.5 })
  if (ts) return [ts]

  // Periodic stale order cleanup
  if (ctx.tickCount % 8 === 0 && staleOrderCount(ctx) > 0) {
    orders.push({ action: 'cancel_stale', reasoning: `VWAP: cancelling out-of-band orders` })
  }

  if (priceHistory.length < 10 || !volumeHistory || volumeHistory.length < 10) {
    orders.push({
      action: 'hold',
      reasoning: 'VWAP: need more data',
      confidence: 0,
      meta: holdMeta(
        'vwap',
        'warming_up',
        [
          diagMetric('Price bars', `${priceHistory.length}/10`),
          diagMetric('Volume bars', `${volumeHistory?.length || 0}/10`),
          diagMetric('Window', '20 bars'),
        ],
        [],
        {
          priceBars: priceHistory.length,
          volumeBars: volumeHistory?.length || 0,
        }
      ),
    })
    return orders
  }

  // Calculate VWAP from last 20 data points
  const len = Math.min(priceHistory.length, volumeHistory.length, 20)
  const prices = priceHistory.slice(-len)
  const volumes = volumeHistory.slice(-len)

  let sumPV = 0, sumV = 0
  for (let i = 0; i < len; i++) {
    sumPV += prices[i] * volumes[i]
    sumV += volumes[i]
  }

  const vwap = sumV > 0 ? sumPV / sumV : mid
  const deviation = (mid - vwap) / vwap
  const threshold = (cfg.deviationPct || 0.5) / 100
  const buyWeight = positionWeight(agent, ctx)
  const baseSize = (agent.virtualBalance * (cfg.orderSizePct || 6) / 100) / mid
  const diagnosticMeta = holdMeta(
    'vwap',
    'within_threshold',
    [
      diagMetric('Deviation', `${deviation >= 0 ? '+' : ''}${(deviation * 100).toFixed(3)}%`),
      diagMetric('Threshold', `±${(threshold * 100).toFixed(2)}%`),
      diagMetric('VWAP', vwap.toFixed(5)),
    ],
    [diagFlag(deviation >= 0 ? 'Above VWAP' : 'Below VWAP')],
    {
      deviationPct: deviation * 100,
      thresholdPct: threshold * 100,
      vwap,
      buyWeightPct: buyWeight * 100,
    }
  )

  // Cancel resting orders if VWAP shifted significantly (deviation flipped sign)
  if (ctx.pendingOrders && ctx.pendingOrders.length > 0) {
    const hasBuys = ctx.pendingOrders.some(o => o.side === 'buy')
    const hasSells = ctx.pendingOrders.some(o => o.side === 'sell')
    if (deviation > threshold && hasBuys) {
      orders.push({ action: 'cancel_all', reasoning: `VWAP: price above VWAP, cancelling stale buys` })
    } else if (deviation < -threshold && hasSells) {
      orders.push({ action: 'cancel_all', reasoning: `VWAP: price below VWAP, cancelling stale sells` })
    }
  }

  if (deviation < -threshold) {
    const price = bandClamp(mid * (1 + bandOffset(ctx, 0.01)), ctx)
    const buySize = baseSize * buyWeight
    if (buySize > 0) {
      orders.push({
        action: 'buy', price,
        size: buySize,
        orderType: 'ioc',
        reasoning: `VWAP BUY IOC: price ${(deviation * 100).toFixed(3)}% below VWAP(${vwap.toFixed(5)})`,
        confidence: clamp(0.5 + Math.abs(deviation) * 10, 0.5, 0.88),
      })
    }
    return orders
  }

  if (deviation > threshold && (agent.position || 0) > 0) {
    const sellSize = Math.min(baseSize > 0 ? baseSize : agent.position * 0.5, agent.position)
    const price = bandClamp(mid * (1 - bandOffset(ctx, 0.01)), ctx)
    orders.push({
      action: 'sell', price,
      size: sellSize,
      orderType: 'ioc',  // IOC to ensure fill instead of stale limit
      reasoning: `VWAP SELL IOC: price ${(deviation * 100).toFixed(3)}% above VWAP(${vwap.toFixed(5)})`,
      confidence: clamp(0.5 + deviation * 10, 0.5, 0.88),
    })
    return orders
  }

  orders.push({ action: 'hold', reasoning: `VWAP: dev=${(deviation * 100).toFixed(3)}%, vwap=${vwap.toFixed(5)}`, confidence: 0.2, meta: diagnosticMeta })
  return orders
}

// ═══════════════════════════════════════════════════════════════════════
// Strategy registry
// ═══════════════════════════════════════════════════════════════════════

import { llmTrader } from './llm/llmStrategy.js'

export const STRATEGIES = {
  market_maker:   { fn: marketMaker,   name: 'Market Maker',    icon: '🏦', desc: 'Provides liquidity with bid/ask spread' },
  trend_follower: { fn: trendFollower, name: 'Trend Follower',  icon: '📈', desc: 'Follows floor index momentum' },
  mean_reversion: { fn: meanReversion, name: 'Mean Reversion',  icon: '🎯', desc: 'Buys dips, sells rips to moving average' },
  momentum:       { fn: momentum,      name: 'Momentum',        icon: '🚀', desc: 'Trades fast/slow MA crossovers' },
  grid_trader:    { fn: gridTrader,    name: 'Grid Trader',     icon: '📐', desc: 'Places orders at fixed price intervals' },
  scalper:        { fn: scalper,       name: 'Scalper',         icon: '⚡', desc: 'Tiny frequent trades on micro-moves' },
  contrarian:     { fn: contrarian,    name: 'Contrarian',      icon: '🔄', desc: 'Fades short-term moves, bets on reversal' },
  vwap:           { fn: vwapTrader,    name: 'VWAP Trader',     icon: '📊', desc: 'Trades deviations from volume-weighted avg' },
  llm_trader:     { fn: llmTrader,     name: 'LLM Trader',      icon: '🧠', desc: 'AI-driven decisions via LLM (GPT/Claude/Ollama)', isAsync: true },
}
