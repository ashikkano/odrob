// ═══════════════════════════════════════════════════════════════════════
// Index Price Formulas — Oracle calculation logic for each index type
//
// Each formula receives an `inputs` object and returns:
//   { price, inputs }  — the calculated fair price + snapshot of inputs
//
// SECURITY: formulas are pure functions, no side effects, no DB access
// ═══════════════════════════════════════════════════════════════════════

// ─── Helpers ─────────────────────────────────────────────────────────

const ln = Math.log      // natural log
const sqrt = Math.sqrt
const max = Math.max
const min = Math.min
const exp = Math.exp

/**
 * Clamp a value between min and max
 */
function clamp(v, lo, hi) { return max(lo, min(hi, v)) }

// ═══════════════════════════════════════════════════════════════════════
// AI TRADE INDEX (AIDX)
//
// Growing formula that reflects network health & activity.
// Price = P0 × NetworkFactor × ActivityFactor × TimeFactor × HolderFactor
//
// Where:
//   NetworkFactor  = 1 + 0.15 × ln(1 + N/5)
//     N = active agents → more agents = higher price (network effect)
//
//   ActivityFactor = 1 + 0.10 × ln(1 + V/5000) + 0.05 × ln(1 + T/100)
//     V = rolling 24h volume, T = rolling 24h trade count
//
//   TimeFactor     = 1 + α × sqrt(daysSinceLaunch)
//     α = 0.005 → gradual time appreciation (sqrt prevents explosion)
//
//   HolderFactor   = 1 + 0.08 × ln(1 + H/3)
//     H = unique holders → more distribution = higher value
//
// Properties:
//   ✓ Always positive (ln(1+x) ≥ 0 for x ≥ 0)
//   ✓ Monotonically growing with each input
//   ✓ Logarithmic scaling prevents exponential blow-up
//   ✓ Sqrt time factor ensures sustainable growth
//   ✓ All factors ≥ 1 → price ≥ P0
//   ✓ Auditable — all inputs are snapshotted per oracle tick
// ═══════════════════════════════════════════════════════════════════════

export function aiTradeIndex(inputs) {
  const {
    P0 = 1.0,             // initial price
    activeAgents = 0,     // N — number of active trading agents
    volume24h = 0,        // V — rolling 24h volume ($)
    trades24h = 0,        // T — rolling 24h trade count
    daysSinceLaunch = 0,  // t — days since index creation
    holderCount = 0,      // H — unique holders with balance > 0
    circulatingSupply = 0,// S — circulating supply (for supply pressure)
    maxSupply = 1000000,  // M — max supply cap
    // Tuning weights (can be overridden in index params)
    wNetwork = 0.15,
    wVolume = 0.10,
    wTrades = 0.05,
    wTime = 0.005,
    wHolders = 0.08,
    wSupplyPressure = 0.03,
  } = inputs

  // ── Factor calculations ──
  const networkFactor  = 1 + wNetwork * ln(1 + activeAgents / 5)
  const volumeFactor   = 1 + wVolume * ln(1 + volume24h / 5000)
  const tradesFactor   = 1 + wTrades * ln(1 + trades24h / 100)
  const activityFactor = volumeFactor * tradesFactor
  const timeFactor     = 1 + wTime * sqrt(max(0, daysSinceLaunch))
  const holderFactor   = 1 + wHolders * ln(1 + holderCount / 3)

  // Supply pressure: as more supply is in circulation, slight upward pressure
  // (demand absorbing supply means price is supported)
  const supplyRatio    = maxSupply > 0 ? circulatingSupply / maxSupply : 0
  const supplyFactor   = 1 + wSupplyPressure * ln(1 + supplyRatio * 10)

  const price = P0 * networkFactor * activityFactor * timeFactor * holderFactor * supplyFactor

  return {
    price: Math.round(price * 1e6) / 1e6,  // 6 decimal precision
    factors: {
      networkFactor:  Math.round(networkFactor * 1e4) / 1e4,
      activityFactor: Math.round(activityFactor * 1e4) / 1e4,
      timeFactor:     Math.round(timeFactor * 1e4) / 1e4,
      holderFactor:   Math.round(holderFactor * 1e4) / 1e4,
      supplyFactor:   Math.round(supplyFactor * 1e4) / 1e4,
    },
    inputs: {
      P0, activeAgents, volume24h, trades24h,
      daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      holderCount, circulatingSupply, maxSupply,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FLOOR MIRROR INDEX (future — mirrors GiftIndex floor price)
// ═══════════════════════════════════════════════════════════════════════

export function floorMirrorIndex(inputs) {
  const { floorPrice = 0.034, premium = 1.0 } = inputs
  const price = floorPrice * premium
  return {
    price: Math.round(price * 1e6) / 1e6,
    factors: { premium },
    inputs: { floorPrice, premium },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VOLATILITY INDEX (future — tracks volatility of floor index)
// ═══════════════════════════════════════════════════════════════════════

export function volatilityIndex(inputs) {
  const {
    P0 = 10.0,
    realizedVol = 0,      // realized volatility (annualized)
    impliedVol = 0,       // from order book spread
    vixMultiplier = 100,
  } = inputs
  const price = P0 + realizedVol * vixMultiplier
  return {
    price: Math.round(price * 1e4) / 1e4,
    factors: { realizedVol, impliedVol },
    inputs,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AGENT MOMENTUM INDEX (AMOM)
//
// Tracks aggregate "momentum" of the fleet — how many agents are in
// profit, their average win rate, and cumulative equity growth.
// The index rises when agents perform well collectively, falls when
// the fleet hits drawdowns.
//
// Price = P0 × ProfitFactor × WinRateFactor × EquityGrowthFactor
//         × ParticipationFactor × VolumeMomentumFactor
//
// Where:
//   ProfitFactor       = 1 + 0.20 × tanh(avgPnlPct / 10)
//     Agents' average PnL % drives index; tanh bounds it [-1, +1]
//     → Index can DROP when fleet loses money (unlike AIDX)
//
//   WinRateFactor      = 0.85 + 0.30 × avgWinRate
//     Average win rate across all agents (0–1)
//     → Ranges from 0.85 (0% WR) to 1.15 (100% WR)
//
//   EquityGrowthFactor = 1 + 0.10 × ln(1 + totalEquity / 100000)
//     Sum of all agents' equity (virtual balance + positions)
//     → Logarithmic, grows with fleet wealth
//
//   ParticipationFactor = 1 + 0.12 × (tradingAgentsPct) ^ 0.5
//     What % of agents actually traded (vs holding/idle)
//     → Rewards active participation
//
//   VolumeMomentumFactor = 1 + 0.06 × ln(1 + recentVolume / 10000)
//     Recent trading volume shows momentum conviction
//
// KEY DIFFERENCE from AIDX:
//   ✓ Can DECREASE when agents lose money (ProfitFactor via tanh)
//   ✓ Reflects performance, not just network growth
//   ✓ More volatile → more interesting to trade
// ═══════════════════════════════════════════════════════════════════════

export function agentMomentumIndex(inputs) {
  const {
    P0 = 0.50,                // initial price ($0.50)
    avgPnlPct = 0,            // fleet average PnL %
    avgWinRate = 0.5,         // fleet average win rate (0–1)
    totalEquity = 0,          // sum of all agents' equity
    tradingAgentsPct = 0,     // % of agents that traded (0–1)
    recentVolume = 0,         // recent 24h volume
    daysSinceLaunch = 0,      // for time component
    holderCount = 0,          // index holders
    circulatingSupply = 0,
    maxSupply = 1000000,
    // Tuning weights
    wProfit = 0.20,
    wWinRate = 0.30,
    wEquity = 0.10,
    wParticipation = 0.12,
    wVolMomentum = 0.06,
    wTime = 0.002,
    wHolders = 0.05,
  } = inputs

  // ── Factor calculations ──
  // tanh: bounds [-1, +1], allows index to decline!
  const profitFactor       = 1 + wProfit * Math.tanh(avgPnlPct / 10)
  const winRateFactor      = (1 - wWinRate / 2) + wWinRate * clamp(avgWinRate, 0, 1)
  const equityGrowthFactor = 1 + wEquity * ln(1 + totalEquity / 100000)
  const participationFactor = 1 + wParticipation * sqrt(clamp(tradingAgentsPct, 0, 1))
  const volMomentumFactor  = 1 + wVolMomentum * ln(1 + recentVolume / 10000)
  const timeFactor         = 1 + wTime * sqrt(max(0, daysSinceLaunch))
  const holderFactor       = 1 + wHolders * ln(1 + holderCount / 3)

  const price = P0 * profitFactor * winRateFactor * equityGrowthFactor
    * participationFactor * volMomentumFactor * timeFactor * holderFactor

  return {
    price: max(0.001, Math.round(price * 1e6) / 1e6),  // floor at $0.001
    factors: {
      profitFactor:        Math.round(profitFactor * 1e4) / 1e4,
      winRateFactor:       Math.round(winRateFactor * 1e4) / 1e4,
      equityGrowthFactor:  Math.round(equityGrowthFactor * 1e4) / 1e4,
      participationFactor: Math.round(participationFactor * 1e4) / 1e4,
      volMomentumFactor:   Math.round(volMomentumFactor * 1e4) / 1e4,
      timeFactor:          Math.round(timeFactor * 1e4) / 1e4,
      holderFactor:        Math.round(holderFactor * 1e4) / 1e4,
    },
    inputs: {
      P0, avgPnlPct: Math.round(avgPnlPct * 100) / 100,
      avgWinRate: Math.round(avgWinRate * 1000) / 1000,
      totalEquity: Math.round(totalEquity), tradingAgentsPct: Math.round(tradingAgentsPct * 1000) / 1000,
      recentVolume: Math.round(recentVolume), daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      holderCount, circulatingSupply, maxSupply,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// EXTERNAL WEIGHTED INDEX — Uses external data feeds + internal metrics
//
// Price = P₀ × ExternalFactor × ActivityFactor × HolderFactor × TimeFactor
//
// ExternalFactor is computed from registered external data providers,
// allowing the index to track real-world data like crypto prices,
// DeFi TVL, API data, etc.
//
// params.externalWeights = { providerId: weight, ... }
//   e.g. { 'btc_price': 0.6, 'eth_price': 0.4 }
//
// ExternalFactor = Σ(normalize(provider_value) × weight)
// Normalization uses the provider's base value (stored in params.externalBases)
// ═══════════════════════════════════════════════════════════════════════

export function externalWeightedIndex(inputs) {
  const {
    P0 = 1.0,
    external = {},              // { providerId: currentValue }
    externalWeights = {},       // { providerId: weight }
    externalBases = {},         // { providerId: baseValue } — normalization anchor
    activeAgents = 0,
    volume24h = 0,
    daysSinceLaunch = 0,
    holderCount = 0,
    circulatingSupply = 0,
    maxSupply = 1000000,
    wActivity = 0.05,
    wHolders = 0.05,
    wTime = 0.002,
  } = inputs

  // Compute external factor from weighted providers
  let externalFactor = 1.0
  const providerDetails = {}
  const weights = Object.entries(externalWeights)

  if (weights.length > 0) {
    let weightedSum = 0
    let totalWeight = 0

    for (const [providerId, weight] of weights) {
      const currentVal = external[providerId] ?? 0
      const baseVal = externalBases[providerId] ?? (currentVal || 1)
      const normalized = baseVal > 0 ? currentVal / baseVal : 1
      weightedSum += normalized * weight
      totalWeight += weight
      providerDetails[providerId] = {
        current: currentVal,
        base: baseVal,
        normalized: Math.round(normalized * 10000) / 10000,
        weight,
      }
    }

    if (totalWeight > 0) {
      externalFactor = weightedSum / totalWeight
    }
  }

  const activityFactor = 1 + wActivity * ln(1 + volume24h / 5000)
  const holderFactor = 1 + wHolders * ln(1 + holderCount / 3)
  const timeFactor = 1 + wTime * sqrt(max(0, daysSinceLaunch))

  const price = P0 * externalFactor * activityFactor * holderFactor * timeFactor

  return {
    price: max(0.001, Math.round(price * 1e6) / 1e6),
    factors: {
      externalFactor: Math.round(externalFactor * 1e4) / 1e4,
      activityFactor: Math.round(activityFactor * 1e4) / 1e4,
      holderFactor: Math.round(holderFactor * 1e4) / 1e4,
      timeFactor: Math.round(timeFactor * 1e4) / 1e4,
    },
    inputs: {
      P0, external: providerDetails,
      activeAgents, volume24h,
      daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      holderCount, circulatingSupply, maxSupply,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PURE EXTERNAL — Price = external data source value, no modifiers
//
// The simplest formula: takes the first (or weighted) external data feed
// and uses it directly as the oracle price. Zero platform-side modifiers.
//
// Use case: commodity tracking (Oil, Gold), crypto mirrors, forex pairs.
// The oracle price IS the external price.
// ═══════════════════════════════════════════════════════════════════════

export function pureExternalIndex(inputs) {
  const {
    external = {},              // { providerId: currentValue }
    externalSource = null,      // primary provider ID (shortcut for single-source)
    externalWeights = {},       // { providerId: weight } — for multi-source
    externalBases = {},         // not used for normalization here, just for reference
    P0 = 1.0,                  // fallback if no external data available
  } = inputs

  let price = P0
  const providerDetails = {}
  const weights = Object.entries(externalWeights)

  if (externalSource && external[externalSource] != null) {
    // Single source mode — price = external value directly
    price = Number(external[externalSource]) || P0
    providerDetails[externalSource] = {
      current: price,
      weight: 1.0,
      mode: 'direct',
    }
  } else if (weights.length > 0) {
    // Multi-source weighted average (still no modifiers)
    let weightedSum = 0
    let totalWeight = 0
    for (const [providerId, weight] of weights) {
      const val = Number(external[providerId]) || 0
      if (val > 0) {
        weightedSum += val * weight
        totalWeight += weight
        providerDetails[providerId] = { current: val, weight, mode: 'weighted' }
      }
    }
    if (totalWeight > 0) {
      price = weightedSum / totalWeight
    }
  } else {
    // Fallback: use first available external value
    for (const [providerId, val] of Object.entries(external)) {
      if (val != null && Number(val) > 0) {
        price = Number(val)
        providerDetails[providerId] = { current: price, weight: 1.0, mode: 'fallback' }
        break
      }
    }
  }

  return {
    price: max(0.001, Math.round(price * 1e6) / 1e6),
    factors: {
      externalPrice: Math.round(price * 1e4) / 1e4,
      source: externalSource || Object.keys(providerDetails)[0] || 'none',
    },
    inputs: {
      P0,
      external: providerDetails,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CREATOR PNL TRACKER — Price tracks creator agent's PnL performance
//
// Price = P₀ × (1 + pnlFactor) × timeFactor × holderFactor
// pnlFactor = 0.3 × tanh(creatorPnlPct / 15)   — bounded [-1,+1]
//
// Can go DOWN if creator loses money. Directly rewards picking a good creator.
// ═══════════════════════════════════════════════════════════════════════

export function creatorPnlIndex(inputs) {
  const {
    P0 = 1.0,
    creatorPnlPct = 0,          // creator's current PnL %
    creatorWinRate = 0.5,       // creator's win rate (0–1)
    creatorTotalTrades = 0,     // number of trades by creator
    daysSinceLaunch = 0,
    holderCount = 0,
    volume24h = 0,
    circulatingSupply = 0,
    maxSupply = 200000,
    wPnl = 0.30,
    wWinRate = 0.15,
    wActivity = 0.05,
    wTime = 0.003,
    wHolders = 0.06,
  } = inputs

  const pnlFactor = 1 + wPnl * Math.tanh(creatorPnlPct / 15)
  const winRateFactor = (1 - wWinRate / 2) + wWinRate * clamp(creatorWinRate, 0, 1)
  const activityFactor = 1 + wActivity * ln(1 + creatorTotalTrades / 50)
  const timeFactor = 1 + wTime * sqrt(max(0, daysSinceLaunch))
  const holderFactor = 1 + wHolders * ln(1 + holderCount / 3)

  const price = P0 * pnlFactor * winRateFactor * activityFactor * timeFactor * holderFactor

  return {
    price: max(0.001, Math.round(price * 1e6) / 1e6),
    factors: {
      pnlFactor: Math.round(pnlFactor * 1e4) / 1e4,
      winRateFactor: Math.round(winRateFactor * 1e4) / 1e4,
      activityFactor: Math.round(activityFactor * 1e4) / 1e4,
      timeFactor: Math.round(timeFactor * 1e4) / 1e4,
      holderFactor: Math.round(holderFactor * 1e4) / 1e4,
    },
    inputs: {
      P0, creatorPnlPct: Math.round(creatorPnlPct * 100) / 100,
      creatorWinRate: Math.round(creatorWinRate * 1000) / 1000,
      creatorTotalTrades, daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      holderCount, volume24h: Math.round(volume24h), circulatingSupply, maxSupply,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CREATOR EQUITY INDEX — Tracks creator agent's total equity growth
//
// Price = P₀ × equityGrowthFactor × participationFactor × holderFactor
// equityGrowthFactor = 1 + 0.25 × ln(1 + equity / initialBalance)
//
// Always positive, grows with creator's total wealth accumulation.
// ═══════════════════════════════════════════════════════════════════════

export function creatorEquityIndex(inputs) {
  const {
    P0 = 1.0,
    creatorEquity = 1000,       // creator's current total equity
    creatorInitialBalance = 1000,
    creatorPositionValue = 0,   // value of all index holdings
    daysSinceLaunch = 0,
    holderCount = 0,
    volume24h = 0,
    circulatingSupply = 0,
    maxSupply = 200000,
    wEquity = 0.25,
    wPositions = 0.10,
    wTime = 0.003,
    wHolders = 0.06,
  } = inputs

  const equityRatio = creatorInitialBalance > 0 ? creatorEquity / creatorInitialBalance : 1
  const equityGrowthFactor = 1 + wEquity * ln(1 + max(0, equityRatio - 1) * 5)
  const positionFactor = 1 + wPositions * ln(1 + creatorPositionValue / 1000)
  const timeFactor = 1 + wTime * sqrt(max(0, daysSinceLaunch))
  const holderFactor = 1 + wHolders * ln(1 + holderCount / 3)

  const price = P0 * equityGrowthFactor * positionFactor * timeFactor * holderFactor

  return {
    price: max(0.001, Math.round(price * 1e6) / 1e6),
    factors: {
      equityGrowthFactor: Math.round(equityGrowthFactor * 1e4) / 1e4,
      positionFactor: Math.round(positionFactor * 1e4) / 1e4,
      timeFactor: Math.round(timeFactor * 1e4) / 1e4,
      holderFactor: Math.round(holderFactor * 1e4) / 1e4,
    },
    inputs: {
      P0, creatorEquity: Math.round(creatorEquity * 100) / 100,
      creatorInitialBalance, creatorPositionValue: Math.round(creatorPositionValue * 100) / 100,
      daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      holderCount, volume24h: Math.round(volume24h), circulatingSupply, maxSupply,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY ALPHA — Excess return of creator vs fleet average
//
// Price = P₀ × alphaFactor × consistencyFactor × holderFactor
// alphaFactor = 1 + 0.35 × tanh((creatorPnlPct - fleetAvgPnlPct) / 10)
//
// Can go negative if creator underperforms! Pure skill tracking.
// ═══════════════════════════════════════════════════════════════════════

export function strategyAlphaIndex(inputs) {
  const {
    P0 = 1.0,
    creatorPnlPct = 0,
    fleetAvgPnlPct = 0,
    creatorWinRate = 0.5,
    fleetAvgWinRate = 0.5,
    creatorSharpe = 0,         // creator's risk-adjusted returns
    daysSinceLaunch = 0,
    holderCount = 0,
    volume24h = 0,
    circulatingSupply = 0,
    maxSupply = 200000,
    wAlpha = 0.35,
    wWinRateAlpha = 0.15,
    wSharpe = 0.10,
    wTime = 0.002,
    wHolders = 0.05,
  } = inputs

  const alpha = creatorPnlPct - fleetAvgPnlPct
  const alphaFactor = 1 + wAlpha * Math.tanh(alpha / 10)

  const wrAlpha = creatorWinRate - fleetAvgWinRate
  const winRateAlphaFactor = 1 + wWinRateAlpha * Math.tanh(wrAlpha * 5)

  const sharpeFactor = 1 + wSharpe * Math.tanh(creatorSharpe / 2)
  const timeFactor = 1 + wTime * sqrt(max(0, daysSinceLaunch))
  const holderFactor = 1 + wHolders * ln(1 + holderCount / 3)

  const price = P0 * alphaFactor * winRateAlphaFactor * sharpeFactor * timeFactor * holderFactor

  return {
    price: max(0.001, Math.round(price * 1e6) / 1e6),
    factors: {
      alphaFactor: Math.round(alphaFactor * 1e4) / 1e4,
      winRateAlphaFactor: Math.round(winRateAlphaFactor * 1e4) / 1e4,
      sharpeFactor: Math.round(sharpeFactor * 1e4) / 1e4,
      timeFactor: Math.round(timeFactor * 1e4) / 1e4,
      holderFactor: Math.round(holderFactor * 1e4) / 1e4,
    },
    inputs: {
      P0, alpha: Math.round(alpha * 100) / 100,
      creatorPnlPct: Math.round(creatorPnlPct * 100) / 100,
      fleetAvgPnlPct: Math.round(fleetAvgPnlPct * 100) / 100,
      creatorWinRate: Math.round(creatorWinRate * 1000) / 1000,
      fleetAvgWinRate: Math.round(fleetAvgWinRate * 1000) / 1000,
      creatorSharpe: Math.round(creatorSharpe * 100) / 100,
      daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      holderCount, circulatingSupply, maxSupply,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MULTI-AGENT BASKET — Warm-up wild basket of top-N agents
//
// Price = P₀ × (1 + Warmup × CorePumpScore)^Exponent
//
// Shape:
//   • Starts anchored near P₀, then unlocks gradually over the warm-up window
//   • Basket PnL and win rate provide the quality signal
//   • Volume, holders, and unique traders provide the crowd/mania signal
//   • Positive synergy and momentum keep the post-warm-up profile pumpy without day-0 blow-ups
//
// Example feel (P₀ = $1.00):
//   Launch  → ~$1.00
//   Early   → mild lift while warm-up is still damping the core score
//   Mania   → aggressive upside once quality + crowd + momentum align
//   Crash   → sharp downside remains possible when quality and crowd collapse
// ═══════════════════════════════════════════════════════════════════════

export function multiAgentBasketIndex(inputs) {
  const {
    P0 = 1.0,
    basketAgentPnls = [],       // array of top-N agents' PnL%
    basketAvgPnlPct = 0,        // pre-computed average
    basketAvgWinRate = 0.5,
    basketSize = 5,
    totalAgents = 0,
    daysSinceLaunch = 0,
    holderCount = 0,
    volume24h = 0,
    volumeGrowthRate = 0,       // % change in volume vs prior period
    uniqueTraders = 0,
    circulatingSupply = 0,
    maxSupply = 200000,
    // --- Wild mode weights (tunable via params) ---
    warmupTauMin = 90,
    pnlScale = 150,
    pumpVolScale = 15000,
    pumpHolderScale = 8,
    pumpTraderScale = 6,
    pumpBias = 1.15,
    wPnl = 0.48,
    wWinRate = 0.18,
    wPump = 0.22,
    wMomentum = 0.16,
    wSynergy = 0.70,
    wTime = 0.08,
    exponent = 2.35,
    coreMin = -0.60,
    coreMax = 2.40,
  } = inputs

  const safeBasketAvgPnlPct = clamp(basketAvgPnlPct, -100, 10_000)

  // Start glued to P0, then gradually release into wild mode over ~90 minutes.
  const minutesSinceLaunch = max(0, daysSinceLaunch) * 24 * 60
  const warmupFactor = warmupTauMin > 0
    ? (1 - exp(-minutesSinceLaunch / warmupTauMin))
    : 1

  // Bounded performance signal: still reactive, but one monster agent can't send price to infinity.
  const pnlSignal = Math.tanh(safeBasketAvgPnlPct / max(1, pnlScale))
  const winRateSignal = clamp((clamp(basketAvgWinRate, 0, 1) - 0.5) * 2, -1, 1)

  // Crowd signal: volume + holders + unique traders. Keeps the pump feel without exploding on day 0.
  const pumpRaw =
    ln(1 + max(0, volume24h) / max(1, pumpVolScale)) +
    0.7 * ln(1 + max(0, holderCount) / max(1, pumpHolderScale)) +
    0.5 * ln(1 + max(0, uniqueTraders) / max(1, pumpTraderScale)) -
    pumpBias
  const pumpSignal = Math.tanh(pumpRaw)

  // Momentum signal: accelerating volume should still feel explosive in wild mode.
  const momentumSignal = Math.tanh(volumeGrowthRate / 120)
  const timeSignal = Math.tanh(daysSinceLaunch / 14)

  // Positive feedback only when both quality and crowd are hot.
  const positiveSynergy = max(0, pnlSignal) * max(0, pumpSignal)
  const maniaSynergy = max(0, momentumSignal) * max(0, pumpSignal)

  const core = clamp(
    (wPnl * pnlSignal)
    + (wWinRate * winRateSignal)
    + (wPump * pumpSignal)
    + (wMomentum * momentumSignal)
    + (wSynergy * positiveSynergy)
    + (wPump * 0.8 * maniaSynergy)
    + (wTime * timeSignal),
    coreMin,
    coreMax,
  )

  const launchBase = max(0.15, 1 + warmupFactor * core)
  let price = P0 * Math.pow(launchBase, max(1, exponent))
  if (!Number.isFinite(price)) price = P0

  return {
    price: max(0.0001, Math.round(price * 1e6) / 1e6),
    factors: {
      warmupFactor: Math.round(warmupFactor * 1e4) / 1e4,
      pnlSignal: Math.round(pnlSignal * 1e4) / 1e4,
      winRateSignal: Math.round(winRateSignal * 1e4) / 1e4,
      pumpSignal: Math.round(pumpSignal * 1e4) / 1e4,
      momentumSignal: Math.round(momentumSignal * 1e4) / 1e4,
      positiveSynergy: Math.round(positiveSynergy * 1e4) / 1e4,
      maniaSynergy: Math.round(maniaSynergy * 1e4) / 1e4,
      core: Math.round(core * 1e4) / 1e4,
      exponent: Math.round(exponent * 100) / 100,
    },
    inputs: {
      P0, basketAvgPnlPct: Math.round(safeBasketAvgPnlPct * 100) / 100,
      basketAvgWinRate: Math.round(basketAvgWinRate * 1000) / 1000,
      basketSize: basketAgentPnls.length || basketSize, totalAgents,
      holderCount, volume24h: Math.round(volume24h),
      volumeGrowthRate: Math.round(volumeGrowthRate * 100) / 100,
      uniqueTraders,
      daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      circulatingSupply, maxSupply,
      warmupTauMin,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VOLUME FLYWHEEL — Price grows with trading volume (viral attractor)
//
// Price = P₀ × volumeFactor × accelerationFactor × holderFactor × time
// volumeFactor = 1 + 0.20 × ln(1 + totalVolume / 10000)
// accelerationFactor = 1 + 0.15 × tanh(volumeGrowthRate / 50)
//
// Key insight: more volume → higher price → more interest → more volume.
// ═══════════════════════════════════════════════════════════════════════

export function volumeFlywheelIndex(inputs) {
  const {
    P0 = 1.0,
    totalVolume = 0,
    volume24h = 0,
    volumeGrowthRate = 0,       // % change in volume vs prior period
    totalTrades = 0,
    uniqueTraders = 0,          // distinct agents that traded
    daysSinceLaunch = 0,
    holderCount = 0,
    circulatingSupply = 0,
    maxSupply = 200000,
    wVolume = 0.20,
    wAcceleration = 0.15,
    wTraders = 0.08,
    wTime = 0.003,
    wHolders = 0.06,
  } = inputs

  const volumeFactor = 1 + wVolume * ln(1 + totalVolume / 10000)
  const accelerationFactor = 1 + wAcceleration * Math.tanh(volumeGrowthRate / 50)
  const traderFactor = 1 + wTraders * ln(1 + uniqueTraders / 5)
  const timeFactor = 1 + wTime * sqrt(max(0, daysSinceLaunch))
  const holderFactor = 1 + wHolders * ln(1 + holderCount / 3)

  const price = P0 * volumeFactor * accelerationFactor * traderFactor * timeFactor * holderFactor

  return {
    price: max(0.001, Math.round(price * 1e6) / 1e6),
    factors: {
      volumeFactor: Math.round(volumeFactor * 1e4) / 1e4,
      accelerationFactor: Math.round(accelerationFactor * 1e4) / 1e4,
      traderFactor: Math.round(traderFactor * 1e4) / 1e4,
      timeFactor: Math.round(timeFactor * 1e4) / 1e4,
      holderFactor: Math.round(holderFactor * 1e4) / 1e4,
    },
    inputs: {
      P0, totalVolume: Math.round(totalVolume),
      volume24h: Math.round(volume24h),
      volumeGrowthRate: Math.round(volumeGrowthRate * 100) / 100,
      totalTrades, uniqueTraders,
      daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      holderCount, circulatingSupply, maxSupply,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HYBRID EXTERNAL + AGENT — Blends external data with creator metrics
//
// Price = P₀ × (externalW × externalFactor + agentW × agentFactor)
//         × holderFactor × timeFactor
//
// Allows combining real-world data feeds with agent performance.
// ═══════════════════════════════════════════════════════════════════════

export function hybridExternalIndex(inputs) {
  const {
    P0 = 1.0,
    external = {},
    externalWeights = {},
    externalBases = {},
    creatorPnlPct = 0,
    creatorEquity = 1000,
    creatorInitialBalance = 1000,
    externalWeight = 0.6,       // how much external data matters
    agentWeight = 0.4,          // how much agent performance matters
    daysSinceLaunch = 0,
    holderCount = 0,
    volume24h = 0,
    circulatingSupply = 0,
    maxSupply = 200000,
    wTime = 0.002,
    wHolders = 0.05,
  } = inputs

  // External component (same logic as external_weighted)
  let externalFactor = 1.0
  const providerDetails = {}
  const weights = Object.entries(externalWeights)
  if (weights.length > 0) {
    let weightedSum = 0
    let totalWeight = 0
    for (const [providerId, weight] of weights) {
      const currentVal = external[providerId] ?? 0
      const baseVal = externalBases[providerId] ?? (currentVal || 1)
      const normalized = baseVal > 0 ? currentVal / baseVal : 1
      weightedSum += normalized * weight
      totalWeight += weight
      providerDetails[providerId] = { current: currentVal, base: baseVal, normalized: Math.round(normalized * 1e4) / 1e4, weight }
    }
    if (totalWeight > 0) externalFactor = weightedSum / totalWeight
  }

  // Agent performance component
  const equityRatio = creatorInitialBalance > 0 ? creatorEquity / creatorInitialBalance : 1
  const agentFactor = (1 + 0.25 * Math.tanh(creatorPnlPct / 15)) * (1 + 0.15 * ln(1 + max(0, equityRatio - 1) * 5))

  // Weighted blend
  const wExt = clamp(externalWeight, 0, 1)
  const wAgt = clamp(agentWeight, 0, 1)
  const totalW = wExt + wAgt || 1
  const blendedFactor = (wExt * externalFactor + wAgt * agentFactor) / totalW

  const timeFactor = 1 + wTime * sqrt(max(0, daysSinceLaunch))
  const holderFactor = 1 + wHolders * ln(1 + holderCount / 3)

  const price = P0 * blendedFactor * timeFactor * holderFactor

  return {
    price: max(0.001, Math.round(price * 1e6) / 1e6),
    factors: {
      externalFactor: Math.round(externalFactor * 1e4) / 1e4,
      agentFactor: Math.round(agentFactor * 1e4) / 1e4,
      blendedFactor: Math.round(blendedFactor * 1e4) / 1e4,
      timeFactor: Math.round(timeFactor * 1e4) / 1e4,
      holderFactor: Math.round(holderFactor * 1e4) / 1e4,
    },
    inputs: {
      P0, external: providerDetails,
      creatorPnlPct: Math.round(creatorPnlPct * 100) / 100,
      creatorEquity: Math.round(creatorEquity * 100) / 100,
      externalWeight: wExt, agentWeight: wAgt,
      daysSinceLaunch: Math.round(daysSinceLaunch * 100) / 100,
      holderCount, circulatingSupply, maxSupply,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Formula Registry — maps formula_id → function
// ═══════════════════════════════════════════════════════════════════════

export const INDEX_FORMULAS = {
  ai_trade: {
    fn: aiTradeIndex,
    name: 'AI Trade Index',
    desc: 'Price grows with network agents, volume, time, and holder distribution',
    formula: 'P = P₀ × NetworkFactor × ActivityFactor × TimeFactor × HolderFactor × SupplyFactor',
    behavior: 'Always grows — more agents and volume push price up',
    drivers: [
      { icon: '🤖', name: 'Active Agents', effect: 'up', desc: 'More trading agents on the platform → higher price. Network effect — each new agent adds value.' },
      { icon: '📊', name: 'Trading Volume', effect: 'up', desc: 'Higher 24h trading volume signals demand and activity. The index grows logarithmically with volume.' },
      { icon: '💱', name: 'Trade Count', effect: 'up', desc: 'More trades = more activity = higher index. Measures market engagement depth.' },
      { icon: '⏳', name: 'Time Since Launch', effect: 'up', desc: 'The index slowly appreciates over time using √(days). Rewards early holders with gradual growth.' },
      { icon: '👥', name: 'Holder Count', effect: 'up', desc: 'More unique holders = wider distribution = higher value. Measures adoption breadth.' },
      { icon: '🏭', name: 'Supply Ratio', effect: 'up', desc: 'As more tokens are minted and absorbed by demand, slight upward pressure on price.' },
    ],
  },
  agent_momentum: {
    fn: agentMomentumIndex,
    name: 'Agent Momentum',
    desc: 'Tracks fleet performance — rises with profits, drops with losses',
    formula: 'P = P₀ × ProfitFactor × WinRate × EquityGrowth × Participation × VolMomentum',
    behavior: 'Can decrease — uses tanh(avgPnL) which goes negative on losses',
    drivers: [
      { icon: '💰', name: 'Fleet Average PnL', effect: 'both', desc: 'Key driver! Average PnL% of all agents. Positive PnL → price rises. Negative → price DROPS. Uses tanh for smooth bounds.' },
      { icon: '🎯', name: 'Win Rate', effect: 'both', desc: 'Average win rate across fleet (0–100%). Higher win rate pushes index up. Ranges 0.85× to 1.15×.' },
      { icon: '💎', name: 'Total Fleet Equity', effect: 'up', desc: 'Sum of all agents\' equity (cash + positions). Growing fleet wealth = growing index.' },
      { icon: '⚡', name: 'Participation Rate', effect: 'up', desc: 'What % of agents actually traded vs idle. More active agents = higher momentum signal.' },
      { icon: '📈', name: 'Volume Momentum', effect: 'up', desc: 'Recent 24h volume shows conviction. High volume = strong momentum = higher price.' },
      { icon: '👥', name: 'Holder Count', effect: 'up', desc: 'Unique holders with balance > 0. Wider distribution supports price.' },
    ],
  },
  floor_mirror: {
    fn: floorMirrorIndex,
    name: 'Floor Mirror',
    desc: 'Mirrors GiftIndex floor price with configurable premium',
    formula: 'P = FloorPrice × Premium',
    behavior: 'Tracks external price feed',
    drivers: [
      { icon: '🪞', name: 'Floor Price', effect: 'both', desc: 'Directly mirrors the GiftIndex floor price. Price follows the external feed 1:1.' },
      { icon: '📊', name: 'Premium Multiplier', effect: 'both', desc: 'Configurable premium/discount on top of floor price. Default is 1.0× (no premium).' },
    ],
  },
  volatility: {
    fn: volatilityIndex,
    name: 'Volatility Index',
    desc: 'Tracks realized and implied volatility of floor index',
    formula: 'P = P₀ + RealizedVol × VIX_Multiplier',
    behavior: 'Rises with market volatility',
    drivers: [
      { icon: '🌊', name: 'Realized Volatility', effect: 'up', desc: 'Annualized realized price volatility. More market swings = higher index price.' },
      { icon: '📉', name: 'Implied Volatility', effect: 'up', desc: 'Derived from order book spread. Wide spreads signal expected future volatility.' },
      { icon: '⚖️', name: 'VIX Multiplier', effect: 'up', desc: 'Scaling factor (default 100). Amplifies volatility signal into readable price.' },
    ],
  },
  external_weighted: {
    fn: externalWeightedIndex,
    name: 'External Weighted',
    desc: 'Price driven by external data feeds (crypto prices, APIs) with configurable weights',
    formula: 'P = P₀ × ExternalFactor × ActivityFactor × HolderFactor × TimeFactor',
    behavior: 'Tracks external data — can go up or down based on feeds',
    drivers: [
      { icon: '🌐', name: 'External Data Feeds', effect: 'both', desc: 'Weighted combination of external data providers (crypto prices, DeFi metrics, API data). Each feed is normalized to its base value.' },
      { icon: '📊', name: 'Activity Factor', effect: 'up', desc: 'Trading volume on the platform adds small upward pressure.' },
      { icon: '👥', name: 'Holder Count', effect: 'up', desc: 'More unique holders = wider distribution = higher value.' },
      { icon: '⏳', name: 'Time Factor', effect: 'up', desc: 'Slight time-based appreciation using √(days).' },
    ],
  },
  pure_external: {
    fn: pureExternalIndex,
    name: 'Pure External',
    desc: 'Price equals external data source directly — no platform modifiers',
    formula: 'P = ExternalPrice',
    behavior: 'Mirrors external feed exactly — goes up and down with the source',
    drivers: [
      { icon: '🛰️', name: 'External Price Feed', effect: 'both', desc: 'The oracle price IS the external data source price. No normalization, no modifiers. What the feed says — that\'s the price.' },
    ],
  },

  // ── Agent-Created Index Formulas ──────────────────────────────────

  creator_pnl: {
    fn: creatorPnlIndex,
    name: 'Creator PnL Tracker',
    desc: 'Price tracks the creator agent\'s trading PnL — rises with profits, falls with losses',
    formula: 'P = P₀ × PnlFactor × WinRateFactor × ActivityFactor × TimeFactor × HolderFactor',
    behavior: 'Can decrease — tracks creator\'s PnL via tanh. Directly rewards picking a profitable creator.',
    drivers: [
      { icon: '📈', name: 'Creator PnL %', effect: 'both', desc: 'The creator agent\'s current profit/loss percentage. Positive PnL → price rises. Negative → price drops.' },
      { icon: '🎯', name: 'Creator Win Rate', effect: 'both', desc: 'Creator\'s trade win rate (0–100%). Higher win rate supports price.' },
      { icon: '⚡', name: 'Creator Activity', effect: 'up', desc: 'Number of trades by the creator — more activity shows commitment.' },
      { icon: '⏳', name: 'Time Since Launch', effect: 'up', desc: 'Gradual appreciation over time using √(days).' },
      { icon: '👥', name: 'Holder Count', effect: 'up', desc: 'More unique holders = wider distribution = higher value.' },
    ],
  },
  creator_equity: {
    fn: creatorEquityIndex,
    name: 'Creator Equity Index',
    desc: 'Reflects the creator agent\'s total equity growth (cash + positions)',
    formula: 'P = P₀ × EquityGrowthFactor × PositionFactor × TimeFactor × HolderFactor',
    behavior: 'Always positive — grows with creator\'s total wealth. More stable than PnL tracker.',
    drivers: [
      { icon: '💎', name: 'Creator Equity', effect: 'up', desc: 'Creator\'s total equity (cash + index holdings). Growing wealth = growing index.' },
      { icon: '📦', name: 'Position Value', effect: 'up', desc: 'Value of creator\'s index portfolio. Diversified holdings support price.' },
      { icon: '⏳', name: 'Time Since Launch', effect: 'up', desc: 'Gradual time-based appreciation.' },
      { icon: '👥', name: 'Holder Count', effect: 'up', desc: 'Wider holder distribution supports price.' },
    ],
  },
  strategy_alpha: {
    fn: strategyAlphaIndex,
    name: 'Strategy Alpha',
    desc: 'Tracks excess returns (alpha) of the creator relative to fleet average',
    formula: 'P = P₀ × AlphaFactor × WinRateAlpha × SharpeFactor × TimeFactor × HolderFactor',
    behavior: 'Can decrease — pure skill tracking. Price drops if creator underperforms fleet.',
    drivers: [
      { icon: '🎯', name: 'Alpha (Excess Return)', effect: 'both', desc: 'Creator PnL minus fleet average PnL. Positive alpha = outperformance → price rises.' },
      { icon: '📊', name: 'Win Rate Alpha', effect: 'both', desc: 'Creator win rate vs fleet average. Outperforming the crowd raises price.' },
      { icon: '⚡', name: 'Sharpe Ratio', effect: 'both', desc: 'Risk-adjusted return metric. Higher Sharpe = more consistent alpha.' },
      { icon: '⏳', name: 'Time Factor', effect: 'up', desc: 'Slight appreciation over time.' },
      { icon: '👥', name: 'Holders', effect: 'up', desc: 'More holders = more confidence in creator.' },
    ],
  },
  multi_agent_basket: {
    fn: multiAgentBasketIndex,
    name: 'Multi-Agent Basket',
    desc: 'Warm-up pump basket of top-N agents by PnL — starts anchored to P₀, then accelerates on performance + crowd mania.',
    formula: 'P = P₀ × (1 + Warmup × CorePumpScore)^Exponent',
    behavior: 'Starts near initial price, then turns aggressively pumpy once PnL, participation, and crowd signals align.',
    drivers: [
      { icon: '🧺', name: 'Basket Avg PnL', effect: 'both', desc: 'Drives the core signal, but is tanh-bounded so one outlier cannot instantly blow up price.' },
      { icon: '🎯', name: 'Basket Win Rate', effect: 'both', desc: 'Improves conviction and lifts the pump score when the basket is consistently winning.' },
      { icon: '👥', name: 'Crowd Mania', effect: 'up', desc: 'Volume, holders, and unique traders combine into a crowd signal that makes the basket feel pumpy.' },
      { icon: '🚀', name: 'Synergy', effect: 'up', desc: 'When both PnL and crowd signals are hot, the basket accelerates nonlinearly.' },
      { icon: '⏳', name: 'Warm-up', effect: 'up', desc: 'Keeps price anchored near P₀ at launch, then gradually unlocks the pump regime.' },
    ],
  },
  volume_flywheel: {
    fn: volumeFlywheelIndex,
    name: 'Volume Flywheel',
    desc: 'Price grows with trading volume — viral liquidity attractor',
    formula: 'P = P₀ × VolumeFactor × AccelerationFactor × TraderFactor × TimeFactor × HolderFactor',
    behavior: 'Always grows with volume — creates positive feedback loop. More volume → higher price → more interest.',
    drivers: [
      { icon: '📊', name: 'Total Volume', effect: 'up', desc: 'Cumulative trading volume drives price up logarithmically.' },
      { icon: '🚀', name: 'Volume Acceleration', effect: 'both', desc: 'Rate of volume growth. Accelerating volume → price boost. Decelerating → dampening.' },
      { icon: '👤', name: 'Unique Traders', effect: 'up', desc: 'More distinct agents trading = broader demand = higher price.' },
      { icon: '⏳', name: 'Time Factor', effect: 'up', desc: 'Gradual time appreciation.' },
      { icon: '👥', name: 'Holders', effect: 'up', desc: 'More holders support price floor.' },
    ],
  },
  hybrid_external: {
    fn: hybridExternalIndex,
    name: 'Hybrid External + Agent',
    desc: 'Blends external data feed with creator agent metrics — best of both worlds',
    formula: 'P = P₀ × (extW × ExternalFactor + agtW × AgentFactor) × TimeFactor × HolderFactor',
    behavior: 'Follows external data AND agent performance. Configurable weight blend.',
    drivers: [
      { icon: '🌐', name: 'External Data', effect: 'both', desc: 'External feed component (crypto prices, commodities, etc). Weight configurable.' },
      { icon: '🤖', name: 'Agent Performance', effect: 'both', desc: 'Creator agent PnL + equity growth component. Weight configurable.' },
      { icon: '⚖️', name: 'Blend Weights', effect: 'both', desc: 'externalWeight vs agentWeight controls the mix. Default 60/40.' },
      { icon: '⏳', name: 'Time Factor', effect: 'up', desc: 'Slight appreciation over time.' },
      { icon: '👥', name: 'Holders', effect: 'up', desc: 'Holder count supports price.' },
    ],
  },
}
