// === ODROB Mock Data Generator ===
// Generates realistic trading data for UI development

const INDEXES = [
  { id: 'FLOOR', name: 'Floor Index', symbol: 'FLOOR', supply: 10_000_000, decimals: 9, basePrice: 0.0342 },
  { id: 'GHOLD', name: 'GHold Index', symbol: 'GHOLD', supply: 100_000_000, decimals: 9, basePrice: 0.0087 },
]

function rand(min, max) {
  return Math.random() * (max - min) + min
}

function randomWalk(start, steps, volatility = 0.002) {
  const data = [start]
  for (let i = 1; i < steps; i++) {
    const change = data[i - 1] * (1 + (Math.random() - 0.5) * 2 * volatility)
    data.push(Math.max(change, start * 0.7))
  }
  return data
}

// Generate OHLC candles
export function generateOHLC(basePrice, count = 96, intervalMinutes = 15) {
  const now = Date.now()
  const data = []
  let price = basePrice

  for (let i = count; i >= 0; i--) {
    const time = now - i * intervalMinutes * 60 * 1000
    const open = price
    const high = open * (1 + rand(0, 0.015))
    const low = open * (1 - rand(0, 0.015))
    const close = rand(low, high)
    const volume = rand(5000, 50000)
    price = close
    data.push({ time, open, high, low, close, volume })
  }
  return data
}

// Generate corridor boundaries over time
export function generateCorridorData(ohlcData, corridorPercent = 0.03) {
  return ohlcData.map((candle) => {
    const oraclePrice = (candle.open + candle.close) / 2
    return {
      time: candle.time,
      oraclePrice,
      upperBound: oraclePrice * (1 + corridorPercent),
      lowerBound: oraclePrice * (1 - corridorPercent),
      price: candle.close,
    }
  })
}

// Generate order book
export function generateOrderBook(currentPrice, depth = 15) {
  const asks = []
  const bids = []

  for (let i = 0; i < depth; i++) {
    const askPrice = currentPrice * (1 + (i + 1) * rand(0.001, 0.003))
    const bidPrice = currentPrice * (1 - (i + 1) * rand(0.001, 0.003))
    const askVol = rand(500, 15000)
    const bidVol = rand(500, 15000)

    asks.push({
      price: askPrice,
      volume: askVol,
      total: askVol * askPrice,
      count: Math.floor(rand(1, 8)),
    })
    bids.push({
      price: bidPrice,
      volume: bidVol,
      total: bidVol * bidPrice,
      count: Math.floor(rand(1, 8)),
    })
  }

  // Sort: asks ascending, bids descending
  asks.sort((a, b) => a.price - b.price)
  bids.sort((a, b) => b.price - a.price)

  // Cumulative volumes
  let cumAsk = 0
  asks.forEach((a) => { cumAsk += a.volume; a.cumVolume = cumAsk })
  let cumBid = 0
  bids.forEach((b) => { cumBid += b.volume; b.cumVolume = cumBid })

  return { asks, bids, spread: asks[0].price - bids[0].price, spreadPercent: ((asks[0].price - bids[0].price) / currentPrice) * 100 }
}

// Agent definitions
const AGENT_TYPES = [
  { type: 'market_maker', name: 'Market Maker', icon: '🏦', description: 'Provides liquidity by placing bid+ask around oracle price' },
  { type: 'corridor_bounce', name: 'Corridor Bounce', icon: '📐', description: 'Buys at lower corridor bound, sells at upper' },
  { type: 'mean_reversion', name: 'Mean Reversion', icon: '🎯', description: 'Trades reversion to oracle price on deviations' },
  { type: 'momentum', name: 'Momentum', icon: '🚀', description: 'Follows trend on consecutive corridor shifts' },
  { type: 'arbitrage', name: 'Arbitrage', icon: '⚡', description: 'Exploits price differences across order books' },
  { type: 'cashback_opt', name: 'Cashback Optimizer', icon: '💎', description: 'Maximizes 10% cashback yield in index tokens' },
]

export function generateAgents() {
  const statuses = ['active', 'active', 'active', 'paused', 'active', 'stopped']
  return AGENT_TYPES.map((agentType, i) => {
    const status = statuses[i]
    const pnl = rand(-120, 850)
    const trades = Math.floor(rand(12, 340))
    const winRate = rand(0.45, 0.78)
    const equity = rand(800, 5000)
    const allocated = rand(500, 3000)

    return {
      id: `agent-${i + 1}`,
      ...agentType,
      status,
      index: i % 2 === 0 ? 'FLOOR' : 'GHOLD',
      pnl,
      pnlPercent: (pnl / allocated) * 100,
      trades,
      winRate,
      equity,
      allocated,
      uptime: status === 'active' ? `${Math.floor(rand(1, 72))}h ${Math.floor(rand(0, 59))}m` : '—',
      lastTrade: status !== 'stopped' ? `${Math.floor(rand(1, 120))}m ago` : '—',
      openPositions: status === 'active' ? Math.floor(rand(0, 5)) : 0,
      equityHistory: randomWalk(allocated, 48, 0.005),
    }
  })
}

// Recent trades
export function generateRecentTrades(count = 20, basePrice = 0.0342) {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => ({
    id: `trade-${i}`,
    time: now - i * rand(30000, 300000),
    side: Math.random() > 0.5 ? 'buy' : 'sell',
    price: basePrice * (1 + (Math.random() - 0.5) * 0.02),
    volume: rand(100, 5000),
    agent: AGENT_TYPES[Math.floor(Math.random() * AGENT_TYPES.length)].name,
    agentType: AGENT_TYPES[Math.floor(Math.random() * AGENT_TYPES.length)].type,
  })).sort((a, b) => b.time - a.time)
}

// P&L equity curve
export function generateEquityCurve(days = 30, startEquity = 10000) {
  const data = []
  let equity = startEquity
  const now = Date.now()

  for (let i = days; i >= 0; i--) {
    const time = now - i * 24 * 60 * 60 * 1000
    equity = equity * (1 + (Math.random() - 0.45) * 0.03)
    data.push({
      time,
      equity: Math.round(equity * 100) / 100,
      drawdown: Math.round(rand(0, 5) * 100) / 100,
    })
  }
  return data
}

// KPI metrics
export function generateKPIs() {
  return {
    totalEquity: rand(10000, 25000),
    totalPnl: rand(-500, 3500),
    totalPnlPercent: rand(-5, 25),
    dailyPnl: rand(-200, 500),
    dailyPnlPercent: rand(-2, 5),
    activeAgents: 4,
    totalAgents: 6,
    openPositions: Math.floor(rand(3, 12)),
    totalTrades24h: Math.floor(rand(50, 300)),
    winRate: rand(0.52, 0.68),
    sharpeRatio: rand(0.8, 2.5),
    maxDrawdown: rand(3, 12),
    gasSpent24h: rand(0.5, 3),
    corridorWidth: 3.0,
    oraclePrice: { FLOOR: 0.0342, GHOLD: 0.0087 },
    lastOracleUpdate: Date.now() - rand(60000, 600000),
  }
}

export { INDEXES, AGENT_TYPES }
