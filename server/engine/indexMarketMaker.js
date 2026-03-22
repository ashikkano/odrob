// ═══════════════════════════════════════════════════════════════════════
// Index Market Maker — System agent providing index liquidity
//
// Architecture:
//   One IndexMarketMaker per index. It is a PROTOCOL-LEVEL agent, not a
//   regular trading agent. It does NOT compete with user/seed agents for
//   profit — its job is to ensure there's always liquidity in the order
//   book so other agents can trade.
//
// Design principles:
//   1. PASSIVE ONLY — never crosses the spread to take
//   2. ORACLE-ANCHORED — all orders are priced relative to oracle price
//   3. PROFIT-NEUTRAL — gives back excess profit by tightening spreads
//   4. INVENTORY-AWARE — automatically rebalances toward neutral
//   5. MINT PRIVILEGES — can mint new contracts when needed (emission)
//   6. CONFIGURABLE LIMITS — all thresholds are tunable per index
//
// How it avoids stealing profit from other agents:
//   • Wide minimum spread (wider than aggressive MMs)
//   • Only places limit orders, never market orders
//   • Profit cap: when realized PnL exceeds threshold, it WIDENS the
//     spread and donates margin to the order book depth
//   • Max inventory: won't accumulate more than % of circulating supply
//   • Fade-out: reduces order size when other agents provide enough
//     liquidity (depth-aware sizing)
//   • All parameters are transparent and queryable via API
// ═══════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto'
import { AGENT_INDEX_CONFIG } from './agentIndexFactory.js'

// ─── Default Configuration ───────────────────────────────────────────

const DEFAULT_CONFIG = {
  // Spread settings
  minSpreadBps: 40,          // minimum spread: 40 bps (0.40%) — wider than aggressive MMs
  maxSpreadBps: 200,         // max spread: 200 bps (2%) — widens under stress
  spreadAnchor: 'oracle',    // price anchor: 'oracle' | 'mid' (oracle is safer)

  // Inventory
  maxInventoryPct: 8,        // max 8% of maxSupply (higher than normal 5% cap)
  targetInventoryPct: 2,     // target: hold ~2% of supply for immediate sells
  inventorySkewFactor: 1.5,  // how aggressively to skew when off-target

  // Order sizing
  baseSizePct: 0.3,          // base order size: 0.3% of maxSupply per level
  maxLevels: 8,              // number of price levels each side
  levelSpacingBps: 15,       // spacing between levels: 15 bps
  minOrderSize: 5,           // minimum order size in contracts

  // Profit control — THE KEY anti-extraction mechanism
  profitCapPct: 0.5,         // max profit as % of total circulating value
  profitDonateRatio: 0.8,    // when over cap, donate 80% of excess via tighter spreads
  profitCheckInterval: 10,   // check every N ticks

  // Depth awareness — reduce size when others provide liquidity
  depthFadeThreshold: 500,   // if existing depth > N contracts, start fading
  depthFadeMinPct: 20,       // fade down to 20% of base size at most

  // Mint settings
  mintEnabled: true,         // can mint new contracts (acts as protocol emitter)
  mintPriceDiscount: 0.002,  // mint at oracle - 0.2% (tiny discount for protocol)

  // Timing
  tickIntervalMs: 15_000,    // refresh orders every 15s
  cooldownAfterOracleMs: 2000, // wait 2s after oracle update before requoting
}

// ─── System Agent ID format ──────────────────────────────────────────

function makeSystemAgentId(indexId) {
  return `__sys_mm_${indexId}__`
}

// ═══════════════════════════════════════════════════════════════════════
// IndexMarketMaker class
// ═══════════════════════════════════════════════════════════════════════

export class IndexMarketMaker {
  constructor(opts = {}) {
    this.indexId = opts.indexId
    this.registry = opts.registry           // IndexRegistry reference
    this.config = { ...DEFAULT_CONFIG, ...opts.config }
    this.agentId = makeSystemAgentId(this.indexId)

    // Runtime state
    this.running = false
    this.timer = null
    this.tickCount = 0
    this.lastOraclePrice = 0

    // Stats
    this.stats = {
      totalMinted: 0,
      totalBought: 0,
      totalSold: 0,
      totalVolume: 0,
      ordersPlaced: 0,
      ordersCancelled: 0,
      realizedPnl: 0,
      spreadsPosted: 0,
      profitDonated: 0,       // amount "given back" via tighter spreads
      lastTickAt: null,
      startedAt: null,
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  start() {
    if (this.running) return
    this.running = true
    this.stats.startedAt = Date.now()

    const state = this.registry.indexes.get(this.indexId)
    if (!state) throw new Error(`Index ${this.indexId} not found`)

    // Ensure system agent exists as a holder with mint-granted inventory
    this._ensureHolder(state)

    // Initial quote
    this._tick()

    // Start periodic requoting
    this.timer = setInterval(() => this._tick(), this.config.tickIntervalMs)
    console.log(`  🏛  System MM started for ${state.symbol} [${this.agentId}] spread=${this.config.minSpreadBps}bps`)
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    // Cancel all outstanding orders
    const state = this.registry.indexes.get(this.indexId)
    if (state) {
      state.orderBook.cancelAllForAgent(this.agentId)
    }
  }

  // ─── Main tick — requote all orders ──────────────────────────────

  _tick() {
    if (!this.running) return
    this.tickCount++
    this.stats.lastTickAt = Date.now()

    const state = this.registry.indexes.get(this.indexId)
    if (!state || state.status !== 'active') return

    // Cooldown after oracle update
    if (state.lastOracleAt && Date.now() - state.lastOracleAt < this.config.cooldownAfterOracleMs) {
      return
    }

    // Cancel stale orders before requoting
    state.orderBook.cancelAllForAgent(this.agentId)
    this.stats.ordersCancelled++

    // Compute dynamic parameters
    const oracle = state.oraclePrice
    if (!Number.isFinite(oracle) || oracle <= 0) return  // safety: skip if oracle is NaN/0
    const inventory = this._getInventory(state)
    const spread = this._computeSpread(state, inventory)
    const sizes = this._computeSizes(state, inventory)

    // Place bid (buy) ladder
    for (let level = 0; level < this.config.maxLevels; level++) {
      const offset = spread / 2 + level * (this.config.levelSpacingBps / 10000) * oracle
      const price = oracle - offset
      const size = sizes.bid * (1 - level * 0.08) // slightly smaller at further levels

      if (price <= 0 || size < this.config.minOrderSize) continue
      if (price < state.bandLow) continue  // respect trading band

      state.orderBook.placeOrder({
        agentId: this.agentId,
        side: 'buy',
        price,
        size,
        reasoning: `SysMM bid L${level} spread=${(spread / oracle * 10000).toFixed(0)}bps`,
      })
      this.stats.ordersPlaced++
    }

    // Place ask (sell) ladder
    const holdingBalance = inventory.balance
    let remainingSellCapacity = holdingBalance

    for (let level = 0; level < this.config.maxLevels; level++) {
      const offset = spread / 2 + level * (this.config.levelSpacingBps / 10000) * oracle
      const price = oracle + offset
      let size = sizes.ask * (1 - level * 0.08)

      if (price <= 0 || size < this.config.minOrderSize) continue
      if (price > state.bandHigh) continue  // respect trading band

      // Can only sell what we hold
      size = Math.min(size, remainingSellCapacity)
      if (size < this.config.minOrderSize) continue

      state.orderBook.placeOrder({
        agentId: this.agentId,
        side: 'sell',
        price,
        size,
        reasoning: `SysMM ask L${level} inv=${holdingBalance.toFixed(0)}`,
      })
      this.stats.ordersPlaced++
      remainingSellCapacity -= size
    }

    this.stats.spreadsPosted++

    // ── Aggressive IOC rebalance when heavily skewed ──
    // If inventory is more than 3× target, use IOC sell to lighten position
    // If inventory is near zero, use IOC buy to rebuild
    this._iocRebalance(state, inventory, oracle)

    // ── Periodic profit check ──
    if (this.tickCount % this.config.profitCheckInterval === 0) {
      this._checkProfitCap(state, inventory)
    }

    // ── Inventory rebalance: mint if below target ──
    this._rebalanceInventory(state, inventory)
  }

  // ─── Spread Calculation ──────────────────────────────────────────

  _computeSpread(state, inventory) {
    const oracle = state.oraclePrice
    let spreadBps = this.config.minSpreadBps

    // 1. Widen spread when inventory is skewed
    const targetPct = this.config.targetInventoryPct / 100
    const actualPct = state.maxSupply > 0 ? inventory.balance / state.maxSupply : 0
    const skew = Math.abs(actualPct - targetPct) / targetPct
    if (skew > 0.5) {
      spreadBps += skew * 30  // extra 30bps per 100% skew
    }

    // 2. Widen spread if MM is too profitable (donate margin back)
    if (inventory.realizedPnl > 0) {
      const circulatingValue = state.circulatingSupply * oracle
      const profitCap = circulatingValue * (this.config.profitCapPct / 100)
      if (inventory.realizedPnl > profitCap && profitCap > 0) {
        const excessRatio = (inventory.realizedPnl - profitCap) / profitCap
        const widen = Math.min(excessRatio * 50, this.config.maxSpreadBps - this.config.minSpreadBps)
        spreadBps += widen
        this.stats.profitDonated += widen * 0.01  // track rough donation metric
      }
    }

    // 3. Widen if oracle just changed significantly (more than 1%)
    if (this.lastOraclePrice > 0) {
      const oracleChange = Math.abs(oracle - this.lastOraclePrice) / this.lastOraclePrice
      if (oracleChange > 0.01) {
        spreadBps += oracleChange * 500  // 5bps per 0.01% change
      }
    }
    this.lastOraclePrice = oracle

    // Clamp to configured range
    spreadBps = Math.max(this.config.minSpreadBps, Math.min(this.config.maxSpreadBps, spreadBps))

    return oracle * spreadBps / 10000
  }

  // ─── Size Calculation (depth-aware) ──────────────────────────────

  _computeSizes(state, inventory) {
    const baseSize = state.maxSupply * (this.config.baseSizePct / 100)

    // Depth awareness: reduce size when there's already enough liquidity
    const ob = state.orderBook.getSnapshot(20)
    const existingBidDepth = ob.bids.reduce((s, o) => s + (o.volume || 0), 0)
    const existingAskDepth = ob.asks.reduce((s, o) => s + (o.volume || 0), 0)

    let bidFade = 1.0
    let askFade = 1.0

    if (existingBidDepth > this.config.depthFadeThreshold) {
      const excess = (existingBidDepth - this.config.depthFadeThreshold) / this.config.depthFadeThreshold
      bidFade = Math.max(this.config.depthFadeMinPct / 100, 1 - excess * 0.5)
    }
    if (existingAskDepth > this.config.depthFadeThreshold) {
      const excess = (existingAskDepth - this.config.depthFadeThreshold) / this.config.depthFadeThreshold
      askFade = Math.max(this.config.depthFadeMinPct / 100, 1 - excess * 0.5)
    }

    // Inventory skew: buy more when low, sell more when high
    const targetPct = this.config.targetInventoryPct / 100
    const actualPct = state.maxSupply > 0 ? inventory.balance / state.maxSupply : 0
    const invSkew = (actualPct - targetPct) / Math.max(targetPct, 0.001)
    const skewFactor = this.config.inventorySkewFactor

    return {
      bid: Math.max(this.config.minOrderSize, baseSize * bidFade * (1 - invSkew * skewFactor * 0.3)),
      ask: Math.max(this.config.minOrderSize, baseSize * askFade * (1 + invSkew * skewFactor * 0.3)),
    }
  }

  // ─── Inventory Management ────────────────────────────────────────

  _getInventory(state) {
    const h = state.holders.get(this.agentId) || {
      balance: 0, avgEntryPrice: 0, realizedPnl: 0, totalBought: 0, totalSold: 0,
    }
    return h
  }

  _ensureHolder(state) {
    if (!state.holders.has(this.agentId)) {
      state.holders.set(this.agentId, {
        balance: 0,
        avgEntryPrice: state.oraclePrice,
        realizedPnl: 0,
        totalBought: 0,
        totalSold: 0,
      })
    }
  }

  /**
   * Rebalance inventory toward target.
   * If below target → mint new contracts (protocol privilege).
   * Minting is capped and logged as emission event.
   */
  _rebalanceInventory(state, inventory) {
    if (!this.config.mintEnabled) return
    const accountingPolicy = {
      ...(AGENT_INDEX_CONFIG.accountingPolicy || {}),
      ...((state?.policyOverrides?.accountingPolicy) || {}),
    }

    const targetBalance = state.maxSupply * (this.config.targetInventoryPct / 100)
    const deficit = targetBalance - inventory.balance

    // Only mint if significantly below target (>30% deficit)
    if (deficit < targetBalance * 0.3) return

    // Can't exceed max inventory
    const maxBalance = state.maxSupply * (this.config.maxInventoryPct / 100)
    const canMint = maxBalance - inventory.balance
    if (canMint <= 0) return

    // Can't exceed total supply cap
    const supplyRoom = state.maxSupply - state.circulatingSupply
    if (supplyRoom <= 0) return

    const mintSize = Math.min(deficit, canMint, supplyRoom, targetBalance * 0.5) // max 50% of target per tick
    if (mintSize < this.config.minOrderSize) return

    const mintPrice = state.oraclePrice * (1 - this.config.mintPriceDiscount)

    // Direct mint: add to circulating supply and holder balance
    state.circulatingSupply += mintSize
    inventory.balance += mintSize
    inventory.totalBought += mintSize
    inventory.avgEntryPrice = inventory.balance > 0
      ? ((inventory.avgEntryPrice * (inventory.balance - mintSize)) + (mintPrice * mintSize)) / inventory.balance
      : mintPrice

    state.holders.set(this.agentId, inventory)
    this.stats.totalMinted += mintSize

    // ── Treasury credit: MM mints MUST back the treasury ──
    const mintValue = mintPrice * mintSize
    const mintFeePreview = this.registry.agentIndexFactory
      ? this.registry.agentIndexFactory.getFeePreview(state.id, mintValue, 'mint')
      : null
    const creditTreasury = accountingPolicy?.mmInventoryMintCreditsTreasury !== false
    const captureFees = accountingPolicy?.mmInventoryMintCapturesPlatformFees !== false
    const persistSyntheticTrade = accountingPolicy?.mmInventoryMintPersistsSyntheticTrade !== false
    const treasuryCredit = mintFeePreview ? mintValue - mintFeePreview.payableFee : mintValue
    if (state.treasury && creditTreasury) {
      state.treasury.balance += treasuryCredit
      state.treasury.totalCollected += treasuryCredit
    }

    if (this.registry.agentIndexFactory && captureFees) {
      this.registry.agentIndexFactory.applyFees(state.id, mintValue, 'mint', mintFeePreview)
      if (state.creationType === 'agent') {
        this.registry.agentIndexFactory.accrueCreatorStakeOnMint(state.id, mintSize, mintPrice)
      }
    }

    // Persist
    if (persistSyntheticTrade && this.registry.db?.saveIndexTrade) {
      this.registry.db.saveIndexTrade({
        id: randomUUID(),
        indexId: this.indexId,
        buyerId: this.agentId,
        sellerId: '__mint__',
        side: 'buy',
        price: mintPrice,
        size: mintSize,
        value: mintPrice * mintSize,
        isMint: true,
        isBurn: false,
        timestamp: Date.now(),
      })
    }

    if (this.registry.db?.upsertHolder) {
      this.registry.db.upsertHolder({
        indexId: this.indexId,
        agentId: this.agentId,
        holderType: 'system',
        balance: inventory.balance,
        avgEntryPrice: inventory.avgEntryPrice,
        realizedPnl: inventory.realizedPnl,
        totalBought: inventory.totalBought,
        totalSold: inventory.totalSold,
      })
    }

    // Emit feed event
    this.registry._emitFeed(state, {
      eventType: 'emission',
      severity: 'info',
      title: `SysMM minted ${mintSize.toFixed(0)} ${state.symbol} for liquidity`,
      detail: {
        mintSize,
        price: mintPrice,
        agentId: this.agentId,
        newCirculating: state.circulatingSupply,
        inventoryBalance: inventory.balance,
        treasuryCredited: creditTreasury,
        feeAccountingApplied: captureFees,
      },
    })
  }

  // ─── IOC Rebalance — aggressive inventory correction ──────────

  /**
   * When inventory is extremely skewed, place IOC orders to correct it.
   * IOC fills what it can immediately and cancels the rest — no stale orders.
   * Only triggers when inventory is >3× or <0.2× target.
   */
  _iocRebalance(state, inventory, oracle) {
    const targetBalance = state.maxSupply * (this.config.targetInventoryPct / 100)
    const ratio = targetBalance > 0 ? inventory.balance / targetBalance : 0

    // Over-inventoried: IOC sell a portion
    if (ratio > 3 && inventory.balance > this.config.minOrderSize * 2) {
      const excess = inventory.balance - targetBalance
      const sellSize = Math.min(excess * 0.15, inventory.balance * 0.05)  // conservative: 15% of excess, max 5% of holdings
      if (sellSize >= this.config.minOrderSize) {
        const price = oracle * (1 - this.config.minSpreadBps / 10000 * 0.5)  // slight discount for fill
        state.orderBook.placeIOCOrder({
          agentId: this.agentId,
          side: 'sell',
          price: Math.max(price, state.bandLow || 0),
          size: sellSize,
          reasoning: `SysMM IOC-rebal SELL: inv=${ratio.toFixed(1)}× target`,
        })
        this.stats.ordersPlaced++
      }
    }

    // Under-inventoried: IOC buy a portion
    if (ratio < 0.2 && targetBalance > 0) {
      const deficit = targetBalance - inventory.balance
      const buySize = Math.min(deficit * 0.2, targetBalance * 0.1)  // 20% of deficit, max 10% of target
      if (buySize >= this.config.minOrderSize) {
        const price = oracle * (1 + this.config.minSpreadBps / 10000 * 0.5)  // slight premium for fill
        state.orderBook.placeIOCOrder({
          agentId: this.agentId,
          side: 'buy',
          price: Math.min(price, state.bandHigh || Infinity),
          size: buySize,
          reasoning: `SysMM IOC-rebal BUY: inv=${ratio.toFixed(1)}× target`,
        })
        this.stats.ordersPlaced++
      }
    }
  }

  // ─── Profit Cap Enforcement ──────────────────────────────────────

  /**
   * If MM profit exceeds cap, redistribute by:
   *   1. Widening spread (gives better prices to other agents)
   *   2. Burning excess inventory (reducing supply = helping holders)
   *
   * This ensures the system MM is a NET NEUTRAL participant,
   * not a profit-extracting whale.
   */
  _checkProfitCap(state, inventory) {
    const oracle = state.oraclePrice
    const circulatingValue = state.circulatingSupply * oracle
    if (circulatingValue <= 0) return

    const profitCap = circulatingValue * (this.config.profitCapPct / 100)
    const excess = inventory.realizedPnl - profitCap

    if (excess <= 0) return

    // Strategy 1: Spread widening is already done in _computeSpread
    // (checks realizedPnl each tick)

    // Strategy 2: Burn excess inventory to reduce supply pressure
    const burnAmount = Math.min(
      excess / oracle * this.config.profitDonateRatio,  // convert $ excess to contracts
      inventory.balance * 0.1,                           // max 10% of holdings per check
    )

    if (burnAmount >= this.config.minOrderSize) {
      inventory.balance -= burnAmount
      state.circulatingSupply -= burnAmount
      state.holders.set(this.agentId, inventory)

      // Track burn value in treasury
      const burnValue = burnAmount * oracle
      if (state.treasury) {
        state.treasury.totalBurned += burnValue
      }

      // Log the burn
      if (this.registry.db?.saveIndexTrade) {
        this.registry.db.saveIndexTrade({
          id: randomUUID(),
          indexId: this.indexId,
          buyerId: '__burn__',
          sellerId: this.agentId,
          side: 'sell',
          price: oracle,
          size: burnAmount,
          value: burnAmount * oracle,
          isMint: false,
          isBurn: true,
          timestamp: Date.now(),
        })
      }

      this.registry._emitFeed(state, {
        eventType: 'burn',
        severity: 'info',
        title: `SysMM burned ${burnAmount.toFixed(0)} ${state.symbol} (profit redistribution)`,
        detail: {
          burnAmount,
          excessProfit: excess,
          profitCap,
          newCirculating: state.circulatingSupply,
        },
      })

      this.stats.profitDonated += burnAmount * oracle
    }
  }

  // ─── Runtime config update ────────────────────────────────────────

  updateConfig(newConfig) {
    if (!newConfig || typeof newConfig !== 'object') return
    for (const [key, val] of Object.entries(newConfig)) {
      if (key in this.config && typeof val === typeof this.config[key]) {
        this.config[key] = val
      }
    }
    // Restart tick interval if changed
    if (newConfig.tickIntervalMs && this.running) {
      this.stop()
      this.start()
    }
  }

  // ─── API snapshot ────────────────────────────────────────────────

  getSnapshot() {
    const state = this.registry.indexes.get(this.indexId)
    const inventory = state ? this._getInventory(state) : { balance: 0, realizedPnl: 0 }
    const oracle = state?.oraclePrice || 0

    return {
      agentId: this.agentId,
      indexId: this.indexId,
      symbol: state?.symbol || '???',
      running: this.running,
      tickCount: this.tickCount,

      // Config (transparent)
      config: { ...this.config },

      // Inventory
      inventory: {
        balance: Math.round(inventory.balance * 100) / 100,
        avgEntryPrice: Math.round((inventory.avgEntryPrice || 0) * 1e6) / 1e6,
        holdingValue: Math.round(inventory.balance * oracle * 100) / 100,
        realizedPnl: Math.round(inventory.realizedPnl * 100) / 100,
        inventoryPct: state?.maxSupply > 0
          ? Math.round(inventory.balance / state.maxSupply * 10000) / 100
          : 0,
        targetPct: this.config.targetInventoryPct,
        maxPct: this.config.maxInventoryPct,
      },

      // Spread info
      currentSpreadBps: this.lastOraclePrice > 0
        ? Math.round(this._computeSpread(state, inventory) / this.lastOraclePrice * 10000)
        : this.config.minSpreadBps,

      // Stats
      stats: { ...this.stats },

      // Profit cap status
      profitStatus: (() => {
        const circulatingValue = (state?.circulatingSupply || 0) * oracle
        const profitCap = circulatingValue * (this.config.profitCapPct / 100)
        return {
          realized: Math.round(inventory.realizedPnl * 100) / 100,
          cap: Math.round(profitCap * 100) / 100,
          utilizationPct: profitCap > 0
            ? Math.round(inventory.realizedPnl / profitCap * 10000) / 100
            : 0,
          isOverCap: inventory.realizedPnl > profitCap,
        }
      })(),
    }
  }
}

export { DEFAULT_CONFIG as INDEX_MM_DEFAULT_CONFIG, makeSystemAgentId }
