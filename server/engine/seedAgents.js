// ═══════════════════════════════════════════════════════════════════════
// Agent Seeder — Creates 20 diverse agents on startup
// Each has unique strategy, config, and virtual balance
// ═══════════════════════════════════════════════════════════════════════

const AGENT_SEED = [
  // Market Makers (3)
  { name: 'Marcus Webb',     strategy: 'market_maker',   icon: '👨‍💼', virtualBalance: 5000,  bio: 'Ex-Goldman quant. 12 years providing institutional liquidity. Believes tight spreads win.', config: { minSpreadPct: 0.2, spreadMultiplier: 0.7, orderSizePct: 5, maxInventory: 15, cooldownMs: 3000, initialPositionPct: 30 }},
  { name: 'Elena Vasquez',   strategy: 'market_maker',   icon: '👩‍💻', virtualBalance: 8000,  bio: 'Former Citadel market maker. Runs deep book strategies with minimal risk.', config: { minSpreadPct: 0.4, spreadMultiplier: 1.0, orderSizePct: 4, maxInventory: 10, cooldownMs: 5000, initialPositionPct: 25 }},
  { name: 'Dmitri Volkov',   strategy: 'market_maker',   icon: '🧔',  virtualBalance: 3000,  bio: 'Moscow-born algo trader. Aggressive tight-spread specialist with high turnover.', config: { minSpreadPct: 0.15, spreadMultiplier: 0.5, orderSizePct: 6, maxInventory: 20, cooldownMs: 2000, initialPositionPct: 35 }},

  // Trend Followers (3)
  { name: 'Sarah Chen',      strategy: 'trend_follower', icon: '👩‍🔬', virtualBalance: 4000, bio: 'Stanford PhD in statistical learning. Rides momentum with surgical precision.', config: { lookback: 12, momentumThreshold: 0.3, orderSizePct: 8, cooldownMs: 8000 }},
  { name: 'James Okoro',     strategy: 'trend_follower', icon: '👨‍🎓', virtualBalance: 6000, bio: 'Nigerian fintech pioneer. Patient trend follower — waits for confirmed breakouts.', config: { lookback: 20, momentumThreshold: 0.6, orderSizePct: 6, cooldownMs: 12000 }},
  { name: 'Yuki Tanaka',     strategy: 'trend_follower', icon: '🧑‍💻', virtualBalance: 2000, bio: 'Tokyo day-trader turned algo dev. Micro-trend hunter with fast reactions.', config: { lookback: 5, momentumThreshold: 0.15, orderSizePct: 10, cooldownMs: 4000 }},

  // Mean Reversion (3)
  { name: 'Olivia Park',     strategy: 'mean_reversion', icon: '👩‍⚕️', virtualBalance: 5000, bio: 'Former actuary. "Everything returns to the mean" is her trading mantra.', config: { lookback: 20, entryZScore: 1.5, exitZScore: 0.3, orderSizePct: 6, cooldownMs: 10000 }},
  { name: 'Leo Fischer',     strategy: 'mean_reversion', icon: '🧑‍🏫', virtualBalance: 3000, bio: 'Berlin-based math teacher who codes. Tight z-score bands, quick exits.', config: { lookback: 10, entryZScore: 1.0, exitZScore: 0.2, orderSizePct: 8, cooldownMs: 6000 }},
  { name: 'Amara Osei',      strategy: 'mean_reversion', icon: '👩‍🏫', virtualBalance: 7000, bio: 'Accra hedge fund veteran. Deep value player — waits for extreme deviations.', config: { lookback: 30, entryZScore: 2.0, exitZScore: 0.5, orderSizePct: 5, cooldownMs: 15000 }},

  // Momentum (2)
  { name: 'Ryan Mitchell',   strategy: 'momentum', icon: '🏃‍♂️', virtualBalance: 4000, bio: 'Chicago prop trader. Fast MA crosses, aggressive entries. Lives for breakouts.', config: { fastPeriod: 3, slowPeriod: 10, crossThreshold: 0.15, orderSizePct: 10, cooldownMs: 6000 }},
  { name: 'Nina Kowalski',   strategy: 'momentum', icon: '🏋️‍♀️', virtualBalance: 6000, bio: 'Warsaw quant. Slow-burn momentum — filters noise, catches the big moves.', config: { fastPeriod: 8, slowPeriod: 25, crossThreshold: 0.3, orderSizePct: 7, cooldownMs: 15000 }},

  // Grid Traders (2)
  { name: 'Hassan Ali',      strategy: 'grid_trader', icon: '🧮', virtualBalance: 5000, bio: 'Dubai-based systematic trader. Tight grids, constant rebalancing.', config: { gridSizePct: 0.3, gridLevels: 4, orderSizePct: 3, cooldownMs: 20000, maxPositionPct: 50 }},
  { name: 'Sofia Müller',    strategy: 'grid_trader', icon: '📐', virtualBalance: 8000, bio: 'Swiss banker turned algo trader. Wide grids for volatile markets.', config: { gridSizePct: 0.8, gridLevels: 6, orderSizePct: 2, cooldownMs: 30000, maxPositionPct: 60 }},

  // Scalpers (3)
  { name: 'Jake Reeves',     strategy: 'scalper', icon: '⚡', virtualBalance: 2000, bio: 'NYC scalper, "Flash" on Wall St. Ultra-fast entries, razor-thin profits.', config: { microThreshold: 0.05, orderSizePct: 4, randomTradePct: 20, cooldownMs: 2000 }},
  { name: 'Priya Sharma',    strategy: 'scalper', icon: '🎯', virtualBalance: 3000, bio: 'Mumbai HFT engineer. Steady scalping with calculated risk management.', config: { microThreshold: 0.1,  orderSizePct: 3, randomTradePct: 10, cooldownMs: 4000 }},
  { name: 'Kai Nakamura',    strategy: 'scalper', icon: '🥷', virtualBalance: 1500, bio: 'Osaka gaming prodigy turned trader. Lightning reflexes, chaotic style.', config: { microThreshold: 0.08, orderSizePct: 5, randomTradePct: 25, cooldownMs: 1500 }},

  // Contrarians (2)
  { name: 'Viktor Petrov',   strategy: 'contrarian', icon: '🔄', virtualBalance: 4000, bio: 'St. Petersburg contrarian. "When everyone buys, I sell." Fades every rally.', config: { lookback: 8, fadeThreshold: 0.5, orderSizePct: 7, cooldownMs: 8000, maxPositionPct: 25 }},
  { name: 'Lena Björk',      strategy: 'contrarian', icon: '❄️', virtualBalance: 5000, bio: 'Stockholm ice-cold contrarian. Patience of a glacier, conviction of steel.', config: { lookback: 15, fadeThreshold: 1.0, orderSizePct: 5, cooldownMs: 12000, maxPositionPct: 20 }},

  // VWAP (2)
  { name: 'David Kim',       strategy: 'vwap', icon: '📊', virtualBalance: 5000, bio: 'Seoul institutional algo specialist. VWAP execution is his art form.', config: { deviationPct: 0.3, orderSizePct: 6, cooldownMs: 10000 }},
  { name: 'Isabella Torres',  strategy: 'vwap', icon: '📈', virtualBalance: 3500, bio: 'São Paulo fund manager. Uses VWAP deviation to time entries like clockwork.', config: { deviationPct: 0.6, orderSizePct: 8, cooldownMs: 8000 }},
]

export function seedAgents(manager) {
  console.log(`🌱 Seeding ${AGENT_SEED.length} agents...`)

  for (const seed of AGENT_SEED) {
    const agent = manager.addAgent(seed)
    console.log(`  ✓ ${agent.icon} ${agent.name} (${agent.strategyName}) — $${agent.virtualBalance}`)
  }

  console.log(`🌱 Done. ${manager.getAllAgents().length} agents ready.`)
}

export { AGENT_SEED }
