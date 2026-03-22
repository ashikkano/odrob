// ═══════════════════════════════════════════════════════════════════════
// Agent Index Factory — Lets agents create their own custom indexes
//
// Architecture:
//   Agent → canCreate?  (balance, trades, limits check)
//         → createAgentIndex() → register + seed + MM + gradual creator stake
//         → fees flow: creator + protocol/global pool + direct platform revenue
//         → getCreatorStats() → revenue dashboard
//
// Tiers:
//   BASIC   — $500 min balance, $50 fee, max 2 indexes
//   PREMIUM — $2000 min balance, $100 fee, max 5 indexes (TODO: future)
//
// Fee Split:
//   Trading fee 0.30%  → 0.15% creator + 0.15% protocol (→ global pool)
//   Mint fee    1.00%  → 0.50% creator + 0.50% protocol
//   Performance 10%    → 10% of treasury dividends going to creator's index holders
//
// Protection:
//   • Max indexes per agent (default 2)
//   • Max total agent indexes (default 10)
//   • Min balance / min trades / creation fee
//   • Creator stake accrues from future mint events until 5% target is reached
//   • Auto-delist if no volume for 30 min
// ═══════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto'
import {
  createStrategyRevenueEvent,
  getActiveStrategyInstanceForAgent,
  getStrategyTemplate,
  loadSystemState,
  saveSystemState,
} from '../runtimeStrategyStore.js'
import { normalizeAddr } from '../utils/tonAddress.js'

// ─── Default Configuration (all editable via admin) ──────────────────

export const AGENT_INDEX_CONFIG = {
  // Creation requirements
  minBalance: 500,            // $500 minimum agent balance
  minTrades: 5,               // 5 trades minimum to prove agent is active
  creationFee: 50,            // $50 flat creation fee
  maxIndexesPerAgent: 2,      // max indexes each agent can create
  maxTotalAgentIndexes: 10,   // max agent-created indexes system-wide

  // Creator stake — accrued gradually on each public mint until target share is reached
  creatorStakePct: 0.05,      // creator target = 5% of maxSupply
  creatorStakeMaxBalancePct: 0.30, // legacy field kept for admin-config compatibility
  stakeLockMs: 10 * 60_000,   // 10 min lock on creator's initial stake

  // Fee rates
  tradingFeePct: 0.003,       // 0.30% on each matched trade
  creatorTradingShare: 0.50,  // creator gets 50% of trading fee (0.15%)
  strategyCreatorRoyaltyShare: 0.25, // strategy author gets 25% of protocol trade fee when others use their public strategy
  mintFeePct: 0.01,           // 1.0% on minted contracts
  creatorMintShare: 0.50,     // creator gets 50% of mint fee (0.5%)
  performanceFeePct: 0.10,    // 10% of treasury dividends on creator's index

  // Default index params
  defaultMaxSupply: 200_000,
  defaultBandWidthPct: 4.0,
  defaultOracleIntervalMs: 25_000,
  defaultInitialPrice: 1.0,

  // Default MM config for agent indexes (wider spreads)
  defaultMM: {
    minSpreadBps: 80,
    maxSpreadBps: 300,
    maxInventoryPct: 8,
    targetInventoryPct: 2,
    baseSizePct: 0.3,
    maxLevels: 5,
    levelSpacingBps: 25,
    profitCapPct: 0.5,
    profitDonateRatio: 0.8,
    tickIntervalMs: 15_000,
    mintEnabled: true,
  },

  // Auto-delist
  autoDelistNoVolumeMs: 30 * 60_000,  // 30 min no volume → auto-pause
  autoDelistCheckIntervalMs: 60_000,   // check every 1 min

  // Global pool redistribution
  globalPoolRedistIntervalMs: 5 * 60_000, // every 5 min
  globalPoolSplits: {
    allTreasuries: 0.30,    // 30% → redistributed to ALL index treasuries
    topByVolume: 0.30,      // 30% → top-3 indexes by volume
    creatorRewards: 0.20,   // 20% → creator revenue pool
    reserve: 0.20,          // 20% → held in reserve (protocol buffer)
  },

  treasuryPolicy: {
    redistributionIntervalTicks: 5,
    redistributionPct: 0.02,
    minTreasuryBalanceUsd: 10,
    minDistributionUsd: 1,
    enableBackingGate: false,
    minBackingRatioPct: 0,
  },

  globalPoolPolicy: {
    redistributionSharePerCycle: 0.50,
    minBalanceToRedistributeUsd: 5,
  },

  accountingPolicy: {
    mmInventoryMintCreditsTreasury: true,
    mmInventoryMintCapturesPlatformFees: true,
    mmInventoryMintPersistsSyntheticTrade: true,
  },

  marketplacePolicy: {
    enableInstallFee: false,
    installFeeUsd: 0,
    enableSubscriptionFee: false,
    subscriptionFeeMonthlyUsd: 0,
    operatorRevenueSharePct: 0,
  },
}

const GLOBAL_POOL_GUARD_DEFAULTS = Object.freeze({
  maxBalance: 50_000_000,
  maxLifetimeTotal: 250_000_000,
  maxSingleCredit: 1_000_000,
  maxRedistributionPerCycle: 5_000_000,
})

const PLATFORM_REVENUE_GUARD_DEFAULTS = Object.freeze({
  maxBalance: 50_000_000,
  maxLifetimeTotal: 250_000_000,
  maxSingleCredit: 1_000_000,
})

const FINANCIAL_HISTORY_LIMIT = 600

// ─── Formula templates available for agent-created indexes ───────────

export const AGENT_FORMULA_TEMPLATES = [
  {
    id: 'creator_pnl',
    name: 'Creator PnL Tracker',
    desc: 'Price tracks the creator agent\'s trading performance (PnL)',
    category: 'performance',
    icon: '📈',
    defaultParams: {},
  },
  {
    id: 'creator_equity',
    name: 'Creator Equity Index',
    desc: 'Price reflects the creator agent\'s total equity growth',
    category: 'performance',
    icon: '💎',
    defaultParams: {},
  },
  {
    id: 'strategy_alpha',
    name: 'Strategy Alpha',
    desc: 'Tracks excess returns (alpha) of the creator relative to fleet average',
    category: 'performance',
    icon: '🎯',
    defaultParams: {},
  },
  {
    id: 'multi_agent_basket',
    name: 'Multi-Agent Basket',
    desc: 'Warm-up wild basket of top-N agents — starts at P₀, then ramps on basket PnL, crowd mania, and momentum',
    category: 'basket',
    icon: '🚀',
    riskLevel: 'high',
    defaultParams: {
      basketSize: 5,
      warmupTauMin: 90,
      pnlScale: 150,
      pumpVolScale: 15000,
      pumpHolderScale: 8,
      pumpTraderScale: 6,
      pumpBias: 1.15,
      wPnl: 0.48,
      wWinRate: 0.18,
      wPump: 0.22,
      wMomentum: 0.16,
      wSynergy: 0.70,
      wTime: 0.08,
      exponent: 2.35,
      coreMin: -0.60,
      coreMax: 2.40,
    },
  },
  {
    id: 'volume_flywheel',
    name: 'Volume Flywheel',
    desc: 'Price grows with trading volume — viral liquidity attractor',
    category: 'growth',
    icon: '🔄',
    defaultParams: {},
  },
  {
    id: 'hybrid_external',
    name: 'Hybrid External + Agent',
    desc: 'Blends external data feed with creator agent metrics',
    category: 'hybrid',
    icon: '🌐',
    defaultParams: { externalWeight: 0.6, agentWeight: 0.4 },
  },
]

// ═══════════════════════════════════════════════════════════════════════
// Agent Index Factory Class
// ═══════════════════════════════════════════════════════════════════════

export class AgentIndexFactory {
  constructor({ indexRegistry, agentManager, systemMMs, IndexMarketMaker }) {
    this.indexRegistry = indexRegistry
    this.agentManager = agentManager
    this.systemMMs = systemMMs                 // shared systemMMs map
    this.IndexMarketMaker = IndexMarketMaker   // class ref for creating new MMs

    // Track agent-created indexes: agentId → [{ indexId, createdAt, stakeLockUntil }]
    this.creatorMap = new Map()

    // Global Pool — accumulates protocol fees from all agent-created indexes
    this.globalPool = {
      balance: 0,
      totalCollected: 0,
      totalRedistributed: 0,
      lastRedistributionAt: 0,
      redistributionCount: 0,
      // Breakdown
      fromCreationFees: 0,
      fromTradingFees: 0,
      fromMintFees: 0,
    }

    this.platformRevenue = {
      balance: 0,
      totalCollected: 0,
      totalWithdrawn: 0,
      lastCollectedAt: 0,
      fromSystemTradingFees: 0,
      fromSystemMintFees: 0,
    }

    this.financialHistory = []

    // Auto-delist timer
    this._autoDelistTimer = null
    // Global pool redistribution timer
    this._globalPoolTimer = null
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  start() {
    const cfg = AGENT_INDEX_CONFIG

    // ── Restore persisted globalPool from DB ──
    const savedPool = loadSystemState('agentFactory_globalPool')
    if (savedPool && typeof savedPool === 'object') {
      Object.assign(this.globalPool, savedPool)
      this._sanitizeGlobalPool('restore')
      console.log(`🏭 Restored globalPool from DB: $${this.globalPool.balance.toFixed(2)} balance`)
    }

    const savedPlatformRevenue = loadSystemState('agentFactory_platformRevenue')
    if (savedPlatformRevenue && typeof savedPlatformRevenue === 'object') {
      Object.assign(this.platformRevenue, savedPlatformRevenue)
      this._sanitizePlatformRevenue('restore')
      console.log(`🏭 Restored platformRevenue from DB: $${this.platformRevenue.balance.toFixed(2)} balance`)
    }

    const savedFinancialHistory = loadSystemState('agentFactory_financialHistory')
    if (Array.isArray(savedFinancialHistory)) {
      this.financialHistory = savedFinancialHistory
        .filter((item) => item && Number.isFinite(item.timestamp) && Number.isFinite(item.amount) && item.amount >= 0)
        .slice(0, FINANCIAL_HISTORY_LIMIT)
    }

    // ── Rebuild creatorMap from live index states ──
    for (const [indexId, state] of this.indexRegistry.indexes) {
      if (state.creationType !== 'agent' || !state.creatorAgentId) continue
      const agentId = state.creatorAgentId
      const existing = this.creatorMap.get(agentId) || []
      const targetStakeSize = Math.max(0, (state.maxSupply || 0) * cfg.creatorStakePct)
      const stakeAccrued = state.treasury?.creatorStakeAccrued
      const normalizedStake = stakeAccrued == null
        ? targetStakeSize
        : Math.max(0, Math.min(targetStakeSize, stakeAccrued))
      const stakeLockUntil = state.treasury?.creatorStakeLockUntil || 0
      if (state.treasury) {
        state.treasury.creatorStakeTarget = targetStakeSize
        state.treasury.creatorStakeAccrued = normalizedStake
        state.treasury.creatorStakeLockUntil = stakeLockUntil
      }
      // Avoid duplicates on hot-restart
      if (!existing.some(e => e.indexId === indexId)) {
        existing.push({
          indexId,
          createdAt: state.createdAt || Date.now(),
          stakeLockUntil,
          stakeSize: normalizedStake,
          stakeTarget: targetStakeSize,
        })
        this.creatorMap.set(agentId, existing)
      }
      // Restore creatorFees from treasury_json if available
      if (state.treasury?.creatorFees && !state.creatorFees) {
        state.creatorFees = state.treasury.creatorFees
      }
      if (state.treasury?.platformFees && !state.platformFees) {
        state.platformFees = state.treasury.platformFees
      }
      if (!state.platformFees) {
        state.platformFees = {
          totalEarned: 0,
          tradingFees: 0,
          mintFees: 0,
          performanceFees: 0,
        }
      }
      // Ensure hwmPrice exists on treasury
      if (state.treasury && !state.treasury.hwmPrice) {
        state.treasury.hwmPrice = state.oraclePrice || state.initialPrice || 0
      }
    }
    console.log(`🏭 Rebuilt creatorMap: ${this.creatorMap.size} creators, ${Array.from(this.creatorMap.values()).reduce((s, v) => s + v.length, 0)} indexes`)

    // Start auto-delist checker
    this._autoDelistTimer = setInterval(
      () => this._checkAutoDelist(),
      AGENT_INDEX_CONFIG.autoDelistCheckIntervalMs,
    )

    // Start global pool redistribution
    this._globalPoolTimer = setInterval(
      () => this._redistributeGlobalPool(),
      AGENT_INDEX_CONFIG.globalPoolRedistIntervalMs,
    )

    console.log('🏭 AgentIndexFactory started (auto-delist + global pool)')
  }

  stop() {
    if (this._autoDelistTimer) { clearInterval(this._autoDelistTimer); this._autoDelistTimer = null }
    if (this._globalPoolTimer) { clearInterval(this._globalPoolTimer); this._globalPoolTimer = null }
  }

  _getIndexFeePolicy(state) {
    const feePolicy = state?.policyOverrides?.feePolicy || {}
    return {
      tradingFeePct: Number.isFinite(feePolicy.tradingFeePct) ? feePolicy.tradingFeePct : AGENT_INDEX_CONFIG.tradingFeePct,
      creatorTradingShare: Number.isFinite(feePolicy.creatorTradingShare) ? feePolicy.creatorTradingShare : AGENT_INDEX_CONFIG.creatorTradingShare,
      mintFeePct: Number.isFinite(feePolicy.mintFeePct) ? feePolicy.mintFeePct : AGENT_INDEX_CONFIG.mintFeePct,
      creatorMintShare: Number.isFinite(feePolicy.creatorMintShare) ? feePolicy.creatorMintShare : AGENT_INDEX_CONFIG.creatorMintShare,
      strategyCreatorRoyaltyShare: Number.isFinite(feePolicy.strategyCreatorRoyaltyShare) ? feePolicy.strategyCreatorRoyaltyShare : AGENT_INDEX_CONFIG.strategyCreatorRoyaltyShare,
    }
  }

  /** Restart timers with current config values (call after admin updates intervals) */
  restartTimers() {
    this.stop()
    this.start()
    console.log(`🏭 AgentIndexFactory timers restarted (delist: ${AGENT_INDEX_CONFIG.autoDelistCheckIntervalMs}ms, pool: ${AGENT_INDEX_CONFIG.globalPoolRedistIntervalMs}ms)`)
  }

  // ─── Validation ────────────────────────────────────────────────────

  /**
   * Check if an agent is eligible to create an index
   * @returns {{ eligible: boolean, reasons: string[] }}
   */
  canCreateIndex(agentId) {
    const cfg = AGENT_INDEX_CONFIG
    const agent = this.agentManager.getAgent(agentId)
    if (!agent) return { eligible: false, reasons: ['Agent not found'] }

    const reasons = []

    // Balance check
    if (agent.virtualBalance < cfg.minBalance) {
      reasons.push(`Insufficient balance: $${agent.virtualBalance.toFixed(2)} < $${cfg.minBalance} required`)
    }

    // Trade count check
    if ((agent.totalTrades || 0) < cfg.minTrades) {
      reasons.push(`Insufficient trades: ${agent.totalTrades || 0} < ${cfg.minTrades} required`)
    }

    // Per-agent limit
    const created = this.creatorMap.get(agentId) || []
    const activeCount = created.filter(c => {
      const state = this.indexRegistry.indexes.get(c.indexId)
      return state && state.status === 'active'
    }).length
    if (activeCount >= cfg.maxIndexesPerAgent) {
      reasons.push(`Max ${cfg.maxIndexesPerAgent} active indexes per agent reached`)
    }

    // System-wide limit
    let totalAgentIndexes = 0
    for (const [, entries] of this.creatorMap) {
      totalAgentIndexes += entries.filter(c => {
        const state = this.indexRegistry.indexes.get(c.indexId)
        return state && state.status === 'active'
      }).length
    }
    if (totalAgentIndexes >= cfg.maxTotalAgentIndexes) {
      reasons.push(`System limit: ${cfg.maxTotalAgentIndexes} total agent indexes reached`)
    }

    // Can afford creation fee
    if (agent.virtualBalance < cfg.creationFee) {
      reasons.push(`Cannot afford creation fee: $${cfg.creationFee}`)
    }

    // Detailed requirements for UI
    const requirements = {
      balance: {
        label: 'Minimum Balance',
        met: agent.virtualBalance >= cfg.minBalance,
        current: `$${agent.virtualBalance.toFixed(0)}`,
        needed: `$${cfg.minBalance}`,
      },
      trades: {
        label: 'Minimum Trades',
        met: (agent.totalTrades || 0) >= cfg.minTrades,
        current: String(agent.totalTrades || 0),
        needed: String(cfg.minTrades),
      },
      perAgent: {
        label: 'Indexes Created',
        met: activeCount < cfg.maxIndexesPerAgent,
        current: String(activeCount),
        needed: `< ${cfg.maxIndexesPerAgent}`,
      },
      fee: {
        label: 'Creation Fee',
        met: agent.virtualBalance >= cfg.creationFee,
        current: `$${agent.virtualBalance.toFixed(0)}`,
        needed: `$${cfg.creationFee}`,
      },
    }

    return { eligible: reasons.length === 0, reasons, requirements }
  }

  // ─── Create Agent Index ────────────────────────────────────────────

  /**
   * Full creation flow:
   * 1. Validate eligibility
   * 2. Deduct creation fee → global pool
   * 3. Generate index ID & register
   * 4. Seed liquidity
  * 5. Creator stake starts at 0 and accrues on future mint events until target
   * 6. Start system MM
   * 7. Auto-subscribe seed agents
   * 8. Return new index snapshot
   */
  createAgentIndex(agentId, { templateId, name, symbol, description, icon, params } = {}) {
    const cfg = AGENT_INDEX_CONFIG

    // 1. Validate
    const check = this.canCreateIndex(agentId)
    if (!check.eligible) {
      return { error: 'Cannot create index', reasons: check.reasons }
    }

    const agent = this.agentManager.getAgent(agentId)
    if (!agent) return { error: 'Agent not found' }

    // Validate template
    const template = AGENT_FORMULA_TEMPLATES.find(t => t.id === templateId)
    if (!template) {
      return { error: `Unknown template: ${templateId}`, available: AGENT_FORMULA_TEMPLATES.map(t => t.id) }
    }

    // Validate symbol uniqueness
    const symUpper = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    if (!symUpper || symUpper.length < 2) {
      return { error: 'Symbol must be 2-6 alphanumeric characters' }
    }
    for (const [, state] of this.indexRegistry.indexes) {
      if (state.symbol === symUpper) {
        return { error: `Symbol ${symUpper} already in use` }
      }
    }

    // 2. Deduct creation fee
    agent.virtualBalance -= cfg.creationFee
    this._creditGlobalPool(cfg.creationFee, 'fromCreationFees')
    this._saveGlobalPool()

    // 3. Generate index ID & register
    const indexId = `AGT_${symUpper}_${Date.now().toString(36).toUpperCase()}`
    const initialPrice = cfg.defaultInitialPrice
    const maxSupply = cfg.defaultMaxSupply

    const mergedParams = {
      ...template.defaultParams,
      ...(params || {}),
      creatorAgentId: agentId,   // critical: links formula to creator
    }

    const state = this.indexRegistry.registerIndex({
      id: indexId,
      name: name || `${agent.name}'s ${template.name}`,
      symbol: symUpper,
      description: description || template.desc,
      formulaId: templateId,
      icon: icon || template.icon,
      initialPrice,
      maxSupply,
      bandWidthPct: cfg.defaultBandWidthPct,
      oracleIntervalMs: cfg.defaultOracleIntervalMs,
      params: mergedParams,
      // Extended fields for agent-created indexes
      creationType: 'agent',
      creatorAgentId: agentId,
    })

    // Store creator metadata on the index state
    state.creationType = 'agent'
    state.creatorAgentId = agentId
    state.creatorFees = {
      totalEarned: 0,
      tradingFees: 0,
      mintFees: 0,
      performanceFees: 0,
    }
    state.platformFees = {
      totalEarned: 0,
      tradingFees: 0,
      mintFees: 0,
      performanceFees: 0,
    }
    state.feeHistory = []  // per-index fee event log
    state.lastVolumeAt = Date.now()  // for auto-delist tracking
    // Initialize HWM for performance fee gate
    if (state.treasury) state.treasury.hwmPrice = initialPrice

    // 4. Seed liquidity
    this.indexRegistry.seedLiquidity(indexId)

    // 5. Creator stake accrues on future mints until target is reached.
    const creatorStakeTarget = maxSupply * cfg.creatorStakePct
    if (state.treasury) {
      state.treasury.creatorStakeTarget = creatorStakeTarget
      state.treasury.creatorStakeAccrued = 0
      state.treasury.creatorStakeLockUntil = 0
    }
    const creatorEntry = {
      indexId,
      createdAt: Date.now(),
      stakeLockUntil: 0,
      stakeSize: 0,
      stakeTarget: creatorStakeTarget,
    }
    const existing = this.creatorMap.get(agentId) || []
    existing.push(creatorEntry)
    this.creatorMap.set(agentId, existing)

    // 6. Start oracle
    this.indexRegistry._startOracle(state)

    // 7. Start system MM
    const mm = new this.IndexMarketMaker({
      indexId,
      registry: this.indexRegistry,
      config: { ...cfg.defaultMM },
    })
    mm.start()
    this.systemMMs[indexId] = mm

    // 8. Auto-subscribe seed agents (low allocation)
    this.agentManager.autoSubscribeSeedAgents(indexId, 2)

    // Record agent trade for visibility
    if (agent.trades) {
      agent.trades.unshift({
        id: `create-index-${indexId}`,
        side: 'index_creation',
        price: initialPrice,
        size: cfg.creationFee,
        value: cfg.creationFee,
        pnl: 0,
        indexId,
        indexSymbol: symUpper,
        balance: Math.round(agent.virtualBalance * 100) / 100,
        timestamp: Date.now(),
      })
      if (agent.trades.length > 100) agent.trades = agent.trades.slice(0, 100)
    }

    console.log(`🏭 Agent ${agent.name} created index: ${state.name} (${symUpper}) template=${templateId} fee=$${cfg.creationFee}`)

    this._recordFinancialEvent({
      stream: 'global_pool',
      bucket: 'fromCreationFees',
      amount: cfg.creationFee,
      feeType: 'creation',
      creationType: 'agent',
      indexId,
      indexSymbol: symUpper,
      timestamp: Date.now(),
    })

    return {
      ok: true,
      indexId,
      snapshot: this.indexRegistry.getIndexSnapshot(indexId),
    }
  }

  // ─── Fee Calculation (called from IndexRegistry hooks) ─────────────

  /**
   * Preview fee distribution for an agent-created index operation.
   *
   * @param {string} indexId
   * @param {number} value  — trade notional value ($)
   * @param {'trade'|'mint'} feeType
   * @returns {{
   *   totalFee: number,
   *   payableFee: number,
   *   retainedFee: number,
   *   creatorFee: number,
   *   creatorFeePaid: number,
   *   protocolFee: number,
   *   creatorAgent: object | null,
   *   state: object | null,
   * }}
   */
  getFeePreview(indexId, value, feeType) {
    const state = this.indexRegistry.indexes.get(indexId)
    if (!state) {
      return {
        totalFee: 0,
        payableFee: 0,
        retainedFee: 0,
        creatorFee: 0,
        creatorFeePaid: 0,
        protocolFee: 0,
        platformRevenueFee: 0,
        feeModel: 'none',
        creatorAgent: null,
        state: null,
      }
    }

    const feePolicy = this._getIndexFeePolicy(state)
    let totalFee, creatorShare
    if (feeType === 'mint') {
      totalFee = value * feePolicy.mintFeePct
      creatorShare = feePolicy.creatorMintShare
    } else {
      totalFee = value * feePolicy.tradingFeePct
      creatorShare = feePolicy.creatorTradingShare
    }

    const feeModel = state.creationType === 'agent' ? 'creator_protocol' : 'platform_direct'
    const creatorFee = totalFee * creatorShare
    const protocolFee = totalFee - creatorFee
    const creatorAgent = this.agentManager?.getAgent(state.creatorAgentId) || null
    const creatorFeePaid = creatorAgent ? creatorFee : 0
    const retainedFee = creatorFee - creatorFeePaid
    const payableFee = creatorFeePaid + protocolFee

    return {
      totalFee,
      payableFee,
      retainedFee,
      creatorFee,
      creatorFeePaid,
      protocolFee,
      platformRevenueFee: feeModel === 'platform_direct' ? protocolFee : 0,
      feeModel,
      creatorAgent,
      state,
    }
  }

  /**
   * Calculate and distribute fees for a trade on an agent-created index.
   * Called from _onIndexTrade / _tryMint hooks.
   *
   * @param {string} indexId
   * @param {number} value  — trade notional value ($)
   * @param {'trade'|'mint'} feeType
   * @param {ReturnType<AgentIndexFactory['getFeePreview']>=} preview
   * @returns {{ creatorFee: number, protocolFee: number, totalFee: number, payableFee: number, retainedFee: number }}
   */
  applyFees(indexId, value, feeType, preview = null, context = {}) {
    const feePreview = preview || this.getFeePreview(indexId, value, feeType)
    const {
      totalFee,
      payableFee,
      retainedFee,
      creatorFeePaid,
      protocolFee,
      feeModel,
      creatorAgent,
      state,
    } = feePreview
    if (!state) return { creatorFee: 0, protocolFee: 0, totalFee: 0, payableFee: 0, retainedFee: 0 }

    const strategyRoyalty = this._applyStrategyCreatorRoyalty({
      state,
      feeType,
      tradeValue: value,
      protocolFee,
      payerAgentId: context.payerAgentId || null,
      sourceTradeId: context.sourceTradeId || context.tradeId || null,
    })
    const netProtocolFee = Math.max(0, protocolFee - strategyRoyalty)

    // Credit creator agent
    if (creatorAgent && creatorFeePaid > 0) {
      creatorAgent.virtualBalance += creatorFeePaid
      if (!creatorAgent.feeIncome) creatorAgent.feeIncome = 0
      creatorAgent.feeIncome += creatorFeePaid

      // Record fee in agent's trade history (like treasury dividends)
      if (creatorFeePaid > 0.0001) {
        const feeSide = feeType === 'mint' ? 'creator_mint_fee' : 'creator_trade_fee'
        creatorAgent.trades.unshift({
          id: `fee-${state.id}-${Date.now()}-${feeType}`,
          side: feeSide,
          price: state.oraclePrice,
          size: creatorFeePaid,
          value: creatorFeePaid,
          pnl: creatorFeePaid,
          indexId: state.id,
          indexSymbol: state.symbol,
          tradeValue: Math.round(value * 100) / 100,
          balance: Math.round(creatorAgent.virtualBalance * 100) / 100,
          timestamp: Date.now(),
        })
        if (creatorAgent.trades.length > 100) creatorAgent.trades = creatorAgent.trades.slice(0, 100)

        if (creatorAgent.decisions) {
          const feeLabel = feeType === 'mint' ? 'creator fee' : 'trade fee'
          const volumeLabel = feeType === 'mint' ? 'mint volume' : 'trade volume'
          creatorAgent.decisions.unshift({
            action: feeSide,
            price: state.oraclePrice,
            size: creatorFeePaid,
            confidence: 1,
            reasoning: `Earned $${creatorFeePaid.toFixed(4)} ${feeLabel} from ${state.symbol} (${volumeLabel} $${value.toFixed(2)}, protocol retained $${netProtocolFee.toFixed(4)})`,
            timestamp: Date.now(),
          })
          if (creatorAgent.decisions.length > 50) creatorAgent.decisions = creatorAgent.decisions.slice(0, 50)
        }
      }
    }

    // Update creator fee tracking
    if (state.creatorFees) {
      state.creatorFees.totalEarned += creatorFeePaid
      if (feeType === 'mint') state.creatorFees.mintFees += creatorFeePaid
      else state.creatorFees.tradingFees += creatorFeePaid
    }

    if (!state.platformFees) {
      state.platformFees = {
        totalEarned: 0,
        tradingFees: 0,
        mintFees: 0,
        performanceFees: 0,
      }
    }
    state.platformFees.totalEarned += netProtocolFee
    if (feeType === 'mint') state.platformFees.mintFees += netProtocolFee
    else state.platformFees.tradingFees += netProtocolFee

    const platformBucket = feeType === 'mint' ? 'fromSystemMintFees' : 'fromSystemTradingFees'
    const poolBucket = feeType === 'mint' ? 'fromMintFees' : 'fromTradingFees'
    if (state.creationType === 'agent') {
      this._creditGlobalPool(netProtocolFee, poolBucket)
    } else {
      this._creditPlatformRevenue(netProtocolFee, platformBucket)
    }

    // Track last volume time for auto-delist
    state.lastVolumeAt = Date.now()

    const feeEvent = {
      type: feeType === 'mint' ? 'mint_fee' : 'trading_fee',
      feeModel,
      creationType: state.creationType || 'system',
      totalFee: Math.round(totalFee * 10000) / 10000,
      creatorAmount: Math.round(creatorFeePaid * 10000) / 10000,
      protocolAmount: Math.round(netProtocolFee * 10000) / 10000,
      platformAmount: Math.round((state.creationType === 'agent' ? 0 : netProtocolFee) * 10000) / 10000,
      strategyRoyaltyAmount: Math.round(strategyRoyalty * 10000) / 10000,
      tradeValue: Math.round(value * 100) / 100,
      timestamp: Date.now(),
    }
    if (!state.feeHistory) state.feeHistory = []
    state.feeHistory.unshift(feeEvent)
    if (state.feeHistory.length > 100) state.feeHistory = state.feeHistory.slice(0, 100)

    if (creatorFeePaid > 0.0001 || netProtocolFee > 0.0001) {
      this.indexRegistry._emitFeed(state, {
        eventType: creatorFeePaid > 0.0001 ? 'creator_fee' : 'platform_fee',
        severity: 'info',
        title: creatorFeePaid > 0.0001
          ? (feeType === 'mint'
              ? `Creator earned $${creatorFeePaid.toFixed(4)} creator fee on ${state.symbol}`
              : `Creator earned $${creatorFeePaid.toFixed(4)} trade fee on ${state.symbol}`)
          : (feeType === 'mint'
              ? `Platform captured $${netProtocolFee.toFixed(4)} mint fee on ${state.symbol}`
              : `Platform captured $${netProtocolFee.toFixed(4)} trade fee on ${state.symbol}`),
        detail: feeEvent,
      })
    }

    if (creatorFeePaid > 0) {
      this._recordFinancialEvent({
        stream: 'creator_revenue',
        bucket: feeType === 'mint' ? 'creator_mint_fee' : 'creator_trade_fee',
        amount: creatorFeePaid,
        feeType,
        creationType: state.creationType || 'system',
        indexId: state.id,
        indexSymbol: state.symbol,
        timestamp: feeEvent.timestamp,
      })
    }
    if (netProtocolFee > 0) {
      this._recordFinancialEvent({
        stream: state.creationType === 'agent' ? 'global_pool' : 'platform_revenue',
        bucket: state.creationType === 'agent' ? poolBucket : platformBucket,
        amount: netProtocolFee,
        feeType,
        creationType: state.creationType || 'system',
        indexId: state.id,
        indexSymbol: state.symbol,
        timestamp: feeEvent.timestamp,
      })
    }

    // Persist globalPool after fee collection
    this._saveGlobalPool()
    this._savePlatformRevenue()

    return {
      creatorFee: creatorFeePaid,
      protocolFee: netProtocolFee,
      strategyRoyalty,
      totalFee,
      payableFee,
      retainedFee,
    }
  }

  _applyStrategyCreatorRoyalty({ state, feeType, tradeValue, protocolFee, payerAgentId, sourceTradeId }) {
    if (feeType !== 'trade') return 0
    if (!payerAgentId || !Number.isFinite(protocolFee) || protocolFee <= 0) return 0

    const payerAgent = this.agentManager?.getAgent?.(payerAgentId) || null
    if (!payerAgent) return 0

    const strategyTemplateId = payerAgent.config?.strategyTemplateId || payerAgent._activeStrategyTemplateId || null
    const strategyInstanceId = payerAgent.config?.activeStrategyInstanceId || payerAgent._activeStrategyInstanceId || null
    if (!strategyTemplateId || !strategyInstanceId) return 0

    const persistedStrategyInstance = getActiveStrategyInstanceForAgent(payerAgent.id)
    const persistedStrategyInstanceId = persistedStrategyInstance?.strategyTemplateId === strategyTemplateId
      ? persistedStrategyInstance.id
      : null

    const template = getStrategyTemplate(strategyTemplateId)
    if (!template) return 0
    if (template.visibility !== 'public' || !['published', 'verified'].includes(template.status)) return 0

    const ownerUserAddress = normalizeAddr(template.ownerUserAddress || '')
    if (!ownerUserAddress || ownerUserAddress === 'system:marketplace') return 0

    const payerWallet = normalizeAddr(payerAgent.walletAddress || '')
    if (payerWallet && payerWallet === ownerUserAddress) return 0

    const feePolicy = this._getIndexFeePolicy(state)
    const royaltyRate = Number(feePolicy.strategyCreatorRoyaltyShare)
    if (!Number.isFinite(royaltyRate) || royaltyRate <= 0) return 0

    const royaltyAmount = Math.min(protocolFee, protocolFee * royaltyRate)
    if (!Number.isFinite(royaltyAmount) || royaltyAmount <= 0) return 0

    const ownerAgent = this.agentManager?.getAllAgentsRaw?.()
      ?.find?.((candidate) => normalizeAddr(candidate?.walletAddress || '') === ownerUserAddress) || null

    try {
      createStrategyRevenueEvent({
        id: randomUUID(),
        ownerUserAddress,
        strategyTemplateId,
        strategyInstanceId: persistedStrategyInstanceId,
        agentId: payerAgent.id,
        payerAgentId: payerAgent.id,
        sourceIndexId: state.id,
        sourceTradeId: sourceTradeId || null,
        feeType,
        feeValue: tradeValue,
        protocolFeeBefore: protocolFee,
        royaltyRate,
        royaltyAmount,
        createdAt: Date.now(),
      })
    } catch (error) {
      console.error('⚠️ Failed to record strategy revenue event:', error.message)
      return 0
    }

    if (ownerAgent) {
      ownerAgent.virtualBalance += royaltyAmount
      if (!ownerAgent.royaltyIncome) ownerAgent.royaltyIncome = 0
      ownerAgent.royaltyIncome += royaltyAmount

      if (royaltyAmount > 0.0001) {
        ownerAgent.trades.unshift({
          id: `royalty-${state.id}-${Date.now()}`,
          side: 'strategy_royalty',
          price: state.oraclePrice,
          size: royaltyAmount,
          value: royaltyAmount,
          pnl: royaltyAmount,
          indexId: state.id,
          indexSymbol: state.symbol,
          tradeValue: Math.round(tradeValue * 100) / 100,
          balance: Math.round(ownerAgent.virtualBalance * 100) / 100,
          payerAgentId: payerAgent.id,
          payerAgentName: payerAgent.name,
          strategyTemplateId,
          strategyInstanceId: persistedStrategyInstanceId,
          royaltyRate: Math.round(royaltyRate * 10000) / 100,
          timestamp: Date.now(),
        })
        if (ownerAgent.trades.length > 100) ownerAgent.trades = ownerAgent.trades.slice(0, 100)

        if (ownerAgent.decisions) {
          ownerAgent.decisions.unshift({
            action: 'strategy_royalty',
            price: state.oraclePrice,
            size: royaltyAmount,
            confidence: 1,
            reasoning: `Earned $${royaltyAmount.toFixed(4)} marketplace royalty from ${state.symbol} trade volume $${tradeValue.toFixed(2)} via ${template.name || 'public strategy'}${payerAgent.name ? ` used by ${payerAgent.name}` : ''}`,
            timestamp: Date.now(),
          })
          if (ownerAgent.decisions.length > 50) ownerAgent.decisions = ownerAgent.decisions.slice(0, 50)
        }
      }
    }

    this._recordFinancialEvent({
      stream: 'strategy_royalty',
      bucket: 'strategy_royalty',
      amount: royaltyAmount,
      feeType,
      creationType: state.creationType || 'system',
      indexId: state.id,
      indexSymbol: state.symbol,
      timestamp: Date.now(),
    })

    return royaltyAmount
  }

  /**
   * Apply performance fee on treasury dividend for agent-created index.
   * Called from _redistributeTreasury.
   */
  applyPerformanceFee(indexId, dividendPool) {
    const cfg = AGENT_INDEX_CONFIG
    const state = this.indexRegistry.indexes.get(indexId)
    if (!state || state.creationType !== 'agent') return 0

    // ── High-Water Mark gate: only charge fee when price > HWM ──
    const hwm = state.treasury?.hwmPrice || state.initialPrice || 0
    const currentPrice = state.oraclePrice || 0
    if (currentPrice <= hwm) return 0  // no fee below HWM

    // Update HWM to current price
    if (state.treasury) state.treasury.hwmPrice = currentPrice

    const fee = dividendPool * cfg.performanceFeePct
    const creatorAgent = this.agentManager.getAgent(state.creatorAgentId)
    if (creatorAgent) {
      creatorAgent.virtualBalance += fee
      if (!creatorAgent.feeIncome) creatorAgent.feeIncome = 0
      creatorAgent.feeIncome += fee

      // Record performance fee in agent's trade history
      if (fee > 0.0001) {
        creatorAgent.trades.unshift({
          id: `fee-${state.id}-${Date.now()}-perf`,
          side: 'creator_perf_fee',
          price: state.oraclePrice,
          size: fee,
          value: fee,
          pnl: fee,
          indexId: state.id,
          indexSymbol: state.symbol,
          dividendPool: Math.round(dividendPool * 100) / 100,
          balance: Math.round(creatorAgent.virtualBalance * 100) / 100,
          timestamp: Date.now(),
        })
        if (creatorAgent.trades.length > 100) creatorAgent.trades = creatorAgent.trades.slice(0, 100)

        if (creatorAgent.decisions) {
          creatorAgent.decisions.unshift({
            action: 'creator_perf_fee',
            price: state.oraclePrice,
            size: fee,
            confidence: 1,
            reasoning: `Earned $${fee.toFixed(4)} perf fee from ${state.symbol} (10% of dividend pool $${dividendPool.toFixed(2)}, HWM $${hwm.toFixed(4)} → $${currentPrice.toFixed(4)})`,
            timestamp: Date.now(),
          })
          if (creatorAgent.decisions.length > 50) creatorAgent.decisions = creatorAgent.decisions.slice(0, 50)
        }
      }
    }
    if (state.creatorFees) {
      state.creatorFees.totalEarned += fee
      state.creatorFees.performanceFees += fee
    }
    this._recordFinancialEvent({
      stream: 'creator_revenue',
      bucket: 'creator_performance_fee',
      amount: fee,
      feeType: 'performance',
      creationType: 'agent',
      indexId: state.id,
      indexSymbol: state.symbol,
      timestamp: Date.now(),
    })

    // ── Feed event: performance fee ──
    if (fee > 0.0001) {
      const feeEvent = {
        type: 'performance_fee',
        amount: Math.round(fee * 10000) / 10000,
        dividendPool: Math.round(dividendPool * 100) / 100,
        timestamp: Date.now(),
      }
      if (!state.feeHistory) state.feeHistory = []
      state.feeHistory.unshift(feeEvent)
      if (state.feeHistory.length > 100) state.feeHistory = state.feeHistory.slice(0, 100)

      this.indexRegistry._emitFeed(state, {
        eventType: 'creator_fee',
        severity: 'info',
        title: `Creator earned $${fee.toFixed(4)} perf fee on ${state.symbol}`,
        detail: feeEvent,
      })
    }

    return fee
  }

  getCreatorStakeTarget(state) {
    if (!state || state.creationType !== 'agent') return 0
    const explicitTarget = state.treasury?.creatorStakeTarget
    if (Number.isFinite(explicitTarget) && explicitTarget >= 0) return explicitTarget
    return Math.max(0, (state.maxSupply || 0) * AGENT_INDEX_CONFIG.creatorStakePct)
  }

  getCreatorStakeAccrued(state) {
    if (!state || state.creationType !== 'agent') return 0
    const explicitAccrued = state.treasury?.creatorStakeAccrued
    if (Number.isFinite(explicitAccrued) && explicitAccrued >= 0) return explicitAccrued
    const target = this.getCreatorStakeTarget(state)
    return target > 0 ? target : 0
  }

  getRemainingCreatorStake(state) {
    const target = this.getCreatorStakeTarget(state)
    const accrued = this.getCreatorStakeAccrued(state)
    return Math.max(0, target - accrued)
  }

  getReservedCreatorSupply(state) {
    return this.getRemainingCreatorStake(state)
  }

  accrueCreatorStakeOnMint(indexId, buyerMintSize, mintPrice) {
    const cfg = AGENT_INDEX_CONFIG
    const state = this.indexRegistry.indexes.get(indexId)
    if (!state || state.creationType !== 'agent' || !state.creatorAgentId) return 0
    if (!Number.isFinite(buyerMintSize) || buyerMintSize <= 0) return 0

    const remainingTarget = this.getRemainingCreatorStake(state)
    if (remainingTarget <= 0) return 0

    const ratio = cfg.creatorStakePct > 0 && cfg.creatorStakePct < 1
      ? cfg.creatorStakePct / (1 - cfg.creatorStakePct)
      : 0
    if (ratio <= 0) return 0

    const remainingSupply = Math.max(0, (state.maxSupply || 0) - (state.circulatingSupply || 0))
    if (remainingSupply <= 0) return 0

    const accruedSize = Math.min(remainingTarget, remainingSupply, buyerMintSize * ratio)
    if (accruedSize <= 0) return 0

    state.circulatingSupply += accruedSize
    this.indexRegistry._updateHolderOnBuy(state, state.creatorAgentId, accruedSize, mintPrice)

    if (state.treasury) {
      state.treasury.creatorStakeTarget = this.getCreatorStakeTarget(state)
      state.treasury.creatorStakeAccrued = (state.treasury.creatorStakeAccrued || 0) + accruedSize
      state.treasury.creatorStakeLockUntil = Date.now() + cfg.stakeLockMs
    }

    const entries = this.creatorMap.get(state.creatorAgentId) || []
    const entry = entries.find(item => item.indexId === indexId)
    if (entry) {
      entry.stakeSize = state.treasury?.creatorStakeAccrued || accruedSize
      entry.stakeTarget = this.getCreatorStakeTarget(state)
      entry.stakeLockUntil = state.treasury?.creatorStakeLockUntil || 0
    }

    const creatorAgent = this.agentManager.getAgent(state.creatorAgentId)
    if (creatorAgent) {
      creatorAgent.trades.unshift({
        id: `creator-stake-${state.id}-${Date.now()}`,
        side: 'creator_stake_mint',
        price: mintPrice,
        size: accruedSize,
        value: 0,
        pnl: 0,
        indexId: state.id,
        indexSymbol: state.symbol,
        balance: Math.round(creatorAgent.virtualBalance * 100) / 100,
        timestamp: Date.now(),
      })
      if (creatorAgent.trades.length > 100) creatorAgent.trades = creatorAgent.trades.slice(0, 100)
    }

    this.indexRegistry._emitFeed(state, {
      eventType: 'creator_stake',
      severity: 'info',
      title: `Creator stake accrued ${accruedSize.toFixed(4)} ${state.symbol}`,
      detail: {
        accruedSize,
        mintPrice,
        accruedTotal: Math.round((state.treasury?.creatorStakeAccrued || 0) * 1e6) / 1e6,
        target: Math.round(this.getCreatorStakeTarget(state) * 1e6) / 1e6,
      },
    })

    return accruedSize
  }

  // ─── Persistence Helper ────────────────────────────────────────────

  _saveGlobalPool() {
    try {
      this._sanitizeGlobalPool('persist')
      saveSystemState('agentFactory_globalPool', this.globalPool)
    } catch (e) {
      console.error('⚠️  Failed to persist globalPool:', e.message)
    }
  }

  _savePlatformRevenue() {
    try {
      this._sanitizePlatformRevenue('persist')
      saveSystemState('agentFactory_platformRevenue', this.platformRevenue)
    } catch (e) {
      console.error('⚠️  Failed to persist platformRevenue:', e.message)
    }
  }

  _saveFinancialHistory() {
    try {
      saveSystemState('agentFactory_financialHistory', this.financialHistory.slice(0, FINANCIAL_HISTORY_LIMIT))
    } catch (e) {
      console.error('⚠️  Failed to persist financialHistory:', e.message)
    }
  }

  _getGlobalPoolGuards() {
    const safetyCfg = this.indexRegistry?.getSafetyConfig?.() || null
    const maxHoldingValue = Number.isFinite(safetyCfg?.maxHoldingValue) && safetyCfg.maxHoldingValue > 0
      ? safetyCfg.maxHoldingValue
      : 10_000_000

    return {
      maxSingleCredit: Math.max(
        GLOBAL_POOL_GUARD_DEFAULTS.maxSingleCredit,
        maxHoldingValue * AGENT_INDEX_CONFIG.mintFeePct * 10,
      ),
      maxBalance: Math.max(GLOBAL_POOL_GUARD_DEFAULTS.maxBalance, maxHoldingValue * 5),
      maxLifetimeTotal: Math.max(GLOBAL_POOL_GUARD_DEFAULTS.maxLifetimeTotal, maxHoldingValue * 25),
      maxRedistributionPerCycle: Math.max(GLOBAL_POOL_GUARD_DEFAULTS.maxRedistributionPerCycle, maxHoldingValue * 0.5),
    }
  }

  _recordGlobalPoolSafety(message, detail = {}) {
    console.warn(`⚠️  Global pool safeguard: ${message}`)
    if (typeof this.indexRegistry?._recordSafetyEvent === 'function') {
      this.indexRegistry._recordSafetyEvent({
        kind: 'global_pool',
        severity: 'warning',
        message,
        detail,
      })
    }
  }

  _getPlatformRevenueGuards() {
    const safetyCfg = this.indexRegistry?.getSafetyConfig?.() || null
    const maxHoldingValue = Number.isFinite(safetyCfg?.maxHoldingValue) && safetyCfg.maxHoldingValue > 0
      ? safetyCfg.maxHoldingValue
      : 10_000_000

    return {
      maxSingleCredit: Math.max(
        PLATFORM_REVENUE_GUARD_DEFAULTS.maxSingleCredit,
        maxHoldingValue * AGENT_INDEX_CONFIG.mintFeePct * 10,
      ),
      maxBalance: Math.max(PLATFORM_REVENUE_GUARD_DEFAULTS.maxBalance, maxHoldingValue * 5),
      maxLifetimeTotal: Math.max(PLATFORM_REVENUE_GUARD_DEFAULTS.maxLifetimeTotal, maxHoldingValue * 25),
    }
  }

  _recordPlatformRevenueSafety(message, detail = {}) {
    console.warn(`⚠️  Platform revenue safeguard: ${message}`)
    if (typeof this.indexRegistry?._recordSafetyEvent === 'function') {
      this.indexRegistry._recordSafetyEvent({
        kind: 'platform_revenue',
        severity: 'warning',
        message,
        detail,
      })
    }
  }

  _sanitizePlatformRevenue(context = 'runtime') {
    const guards = this._getPlatformRevenueGuards()
    const before = { ...this.platformRevenue }
    const clampMoney = (value, max) => {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < 0) return 0
      return Math.min(numeric, max)
    }

    this.platformRevenue.balance = clampMoney(this.platformRevenue.balance, guards.maxBalance)
    this.platformRevenue.totalCollected = clampMoney(this.platformRevenue.totalCollected, guards.maxLifetimeTotal)
    this.platformRevenue.totalWithdrawn = clampMoney(this.platformRevenue.totalWithdrawn, guards.maxLifetimeTotal)
    this.platformRevenue.fromSystemTradingFees = clampMoney(this.platformRevenue.fromSystemTradingFees, guards.maxLifetimeTotal)
    this.platformRevenue.fromSystemMintFees = clampMoney(this.platformRevenue.fromSystemMintFees, guards.maxLifetimeTotal)
    this.platformRevenue.lastCollectedAt = Number.isFinite(this.platformRevenue.lastCollectedAt) && this.platformRevenue.lastCollectedAt >= 0
      ? this.platformRevenue.lastCollectedAt
      : 0

    const changed = Object.keys(this.platformRevenue).some((key) => this.platformRevenue[key] !== before[key])
    if (changed) {
      this._recordPlatformRevenueSafety(`sanitized ${context} state`, {
        before,
        after: { ...this.platformRevenue },
      })
    }
  }

  _creditPlatformRevenue(amount, bucket) {
    const numeric = Number(amount)
    if (!Number.isFinite(numeric) || numeric <= 0) return 0

    const guards = this._getPlatformRevenueGuards()
    if (numeric > guards.maxSingleCredit) {
      this._recordPlatformRevenueSafety(`rejected anomalous revenue credit $${numeric.toFixed(2)}`, { amount: numeric, bucket, guards })
      return 0
    }

    this._sanitizePlatformRevenue('pre-credit')

    const accepted = Math.min(numeric, Math.max(0, guards.maxBalance - this.platformRevenue.balance))
    if (accepted <= 0) {
      this._recordPlatformRevenueSafety('dropped revenue credit because balance cap was reached', { amount: numeric, bucket, guards })
      return 0
    }
    if (accepted < numeric) {
      this._recordPlatformRevenueSafety(`clipped revenue credit from $${numeric.toFixed(2)} to $${accepted.toFixed(2)}`, { bucket, guards })
    }

    this.platformRevenue.balance += accepted
    this.platformRevenue.totalCollected = Math.min(guards.maxLifetimeTotal, this.platformRevenue.totalCollected + accepted)
    this.platformRevenue.lastCollectedAt = Date.now()
    if (bucket === 'fromSystemTradingFees') this.platformRevenue.fromSystemTradingFees = Math.min(guards.maxLifetimeTotal, this.platformRevenue.fromSystemTradingFees + accepted)
    else if (bucket === 'fromSystemMintFees') this.platformRevenue.fromSystemMintFees = Math.min(guards.maxLifetimeTotal, this.platformRevenue.fromSystemMintFees + accepted)
    return accepted
  }

  _recordFinancialEvent(event = {}) {
    const timestamp = Number(event.timestamp) || Date.now()
    const amount = Number(event.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null

    const entry = {
      id: event.id || `fin-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      stream: event.stream || 'unknown',
      bucket: event.bucket || 'unknown',
      amount: Math.round(amount * 10000) / 10000,
      feeType: event.feeType || 'trade',
      creationType: event.creationType || 'system',
      indexId: event.indexId || null,
      indexSymbol: event.indexSymbol || null,
      timestamp,
    }
    this.financialHistory.unshift(entry)
    if (this.financialHistory.length > FINANCIAL_HISTORY_LIMIT) {
      this.financialHistory = this.financialHistory.slice(0, FINANCIAL_HISTORY_LIMIT)
    }
    this._saveFinancialHistory()
    return entry
  }

  _sanitizeGlobalPool(context = 'runtime') {
    const guards = this._getGlobalPoolGuards()
    const before = { ...this.globalPool }
    const clampMoney = (value, max) => {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < 0) return 0
      return Math.min(numeric, max)
    }

    this.globalPool.balance = clampMoney(this.globalPool.balance, guards.maxBalance)
    this.globalPool.totalCollected = clampMoney(this.globalPool.totalCollected, guards.maxLifetimeTotal)
    this.globalPool.totalRedistributed = clampMoney(this.globalPool.totalRedistributed, guards.maxLifetimeTotal)
    this.globalPool.fromCreationFees = clampMoney(this.globalPool.fromCreationFees, guards.maxLifetimeTotal)
    this.globalPool.fromTradingFees = clampMoney(this.globalPool.fromTradingFees, guards.maxLifetimeTotal)
    this.globalPool.fromMintFees = clampMoney(this.globalPool.fromMintFees, guards.maxLifetimeTotal)
    this.globalPool.lastRedistributionAt = Number.isFinite(this.globalPool.lastRedistributionAt) && this.globalPool.lastRedistributionAt >= 0
      ? this.globalPool.lastRedistributionAt
      : 0
    this.globalPool.redistributionCount = Number.isFinite(this.globalPool.redistributionCount) && this.globalPool.redistributionCount >= 0
      ? Math.floor(this.globalPool.redistributionCount)
      : 0

    const changed = Object.keys(this.globalPool).some(key => this.globalPool[key] !== before[key])
    if (changed) {
      this._recordGlobalPoolSafety(`sanitized ${context} state`, {
        before,
        after: { ...this.globalPool },
      })
    }
  }

  _creditGlobalPool(amount, bucket) {
    const numeric = Number(amount)
    if (!Number.isFinite(numeric) || numeric <= 0) return 0

    const guards = this._getGlobalPoolGuards()
    if (numeric > guards.maxSingleCredit) {
      this._recordGlobalPoolSafety(`rejected anomalous pool credit $${numeric.toFixed(2)}`, { amount: numeric, bucket, guards })
      return 0
    }

    this._sanitizeGlobalPool('pre-credit')

    const accepted = Math.min(numeric, Math.max(0, guards.maxBalance - this.globalPool.balance))
    if (accepted <= 0) {
      this._recordGlobalPoolSafety('dropped pool credit because balance cap was reached', { amount: numeric, bucket, guards })
      return 0
    }
    if (accepted < numeric) {
      this._recordGlobalPoolSafety(`clipped pool credit from $${numeric.toFixed(2)} to $${accepted.toFixed(2)}`, { bucket, guards })
    }

    this.globalPool.balance += accepted
    this.globalPool.totalCollected = Math.min(guards.maxLifetimeTotal, this.globalPool.totalCollected + accepted)
    if (bucket === 'fromCreationFees') this.globalPool.fromCreationFees = Math.min(guards.maxLifetimeTotal, this.globalPool.fromCreationFees + accepted)
    else if (bucket === 'fromMintFees') this.globalPool.fromMintFees = Math.min(guards.maxLifetimeTotal, this.globalPool.fromMintFees + accepted)
    else if (bucket === 'fromTradingFees') this.globalPool.fromTradingFees = Math.min(guards.maxLifetimeTotal, this.globalPool.fromTradingFees + accepted)
    return accepted
  }

  // ─── Auto-Delist ───────────────────────────────────────────────────

  _checkAutoDelist() {
    const cfg = AGENT_INDEX_CONFIG
    const now = Date.now()

    for (const [indexId, state] of this.indexRegistry.indexes) {
      if (state.creationType !== 'agent') continue
      if (state.status !== 'active') continue

      const lastActivity = state.lastVolumeAt || state.createdAt
      if (now - lastActivity > cfg.autoDelistNoVolumeMs) {
        const inactiveMinutes = Math.round((now - lastActivity) / 60000)
        state.status = 'paused'
        state.pauseReason = `Auto-paused: no volume for ${inactiveMinutes} min`
        // Stop MM
        const mm = this.systemMMs[indexId]
        if (mm) { mm.stop(); delete this.systemMMs[indexId] }

        console.log(`⚠️  Auto-paused agent index ${state.symbol}: no volume for ${inactiveMinutes}min`)

        this.indexRegistry._emitFeed(state, {
          eventType: 'auto_delist',
          severity: 'warning',
          title: `Index ${state.symbol} auto-paused due to inactivity`,
          detail: { lastVolumeAt: lastActivity, pausedAt: now },
        })
      }
    }
  }

  // ─── Global Pool Redistribution ────────────────────────────────────

  _redistributeGlobalPool() {
    const cfg = AGENT_INDEX_CONFIG
    const pool = this.globalPool
    const guards = this._getGlobalPoolGuards()
    const poolPolicy = cfg.globalPoolPolicy || {}
    const minBalanceToRedistributeUsd = Number(poolPolicy.minBalanceToRedistributeUsd || 5)
    const redistributionSharePerCycle = Math.max(0, Math.min(1, Number(poolPolicy.redistributionSharePerCycle ?? 0.5)))

    this._sanitizeGlobalPool('redistribution')

    if (pool.balance < minBalanceToRedistributeUsd) return

    const amount = Math.min(pool.balance * redistributionSharePerCycle, guards.maxRedistributionPerCycle)
    if (amount < 1) return
    if (amount < pool.balance * redistributionSharePerCycle) {
      this._recordGlobalPoolSafety(`capped redistribution cycle to $${amount.toFixed(2)}`, { balance: pool.balance, guards })
    }

    const splits = cfg.globalPoolSplits
    let distributed = 0

    // 1. All treasuries (30%) — pro-rata by circulating value
    const allTreasuryAmt = amount * splits.allTreasuries
    if (allTreasuryAmt > 0) {
      let totalCircValue = 0
      const indexEntries = []
      for (const [id, state] of this.indexRegistry.indexes) {
        if (state.status !== 'active') continue
        const cv = state.circulatingSupply * state.oraclePrice
        if (cv > 0) {
          indexEntries.push({ id, circValue: cv, state })
          totalCircValue += cv
        }
      }
      if (totalCircValue > 0) {
        for (const entry of indexEntries) {
          const share = entry.circValue / totalCircValue
          const reward = allTreasuryAmt * share
          entry.state.treasury.balance += reward
          entry.state.treasury.totalCollected += reward
        }
        distributed += allTreasuryAmt
      }
    }

    // 2. Top-3 by volume (30%)
    const topVolumeAmt = amount * splits.topByVolume
    if (topVolumeAmt > 0) {
      const sorted = Array.from(this.indexRegistry.indexes.values())
        .filter(s => s.status === 'active')
        .sort((a, b) => b.totalVolume - a.totalVolume)
        .slice(0, 3)

      const totalVol = sorted.reduce((s, st) => s + st.totalVolume, 0)
      if (totalVol > 0) {
        for (const state of sorted) {
          const share = state.totalVolume / totalVol
          const reward = topVolumeAmt * share
          state.treasury.balance += reward
          state.treasury.totalCollected += reward
        }
        distributed += topVolumeAmt
      }
    }

    // 3. Creator rewards (20%) — split among creators of agent indexes by their index volume
    const creatorAmt = amount * splits.creatorRewards
    if (creatorAmt > 0) {
      const agentIndexes = Array.from(this.indexRegistry.indexes.values())
        .filter(s => s.creationType === 'agent' && s.status === 'active')
      const totalAgentVol = agentIndexes.reduce((s, st) => s + st.totalVolume, 0)
      if (totalAgentVol > 0 && agentIndexes.length > 0) {
        for (const state of agentIndexes) {
          const share = state.totalVolume / totalAgentVol
          const reward = creatorAmt * share
          const creator = this.agentManager.getAgent(state.creatorAgentId)
          if (creator) {
            creator.virtualBalance += reward
            if (!creator.feeIncome) creator.feeIncome = 0
            creator.feeIncome += reward
            if (state.creatorFees) state.creatorFees.totalEarned += reward
            if (!state.platformFees) {
              state.platformFees = { totalEarned: 0, tradingFees: 0, mintFees: 0, performanceFees: 0 }
            }

            // Record pool reward in agent's trade history
            if (reward > 0.0001) {
              creator.trades.unshift({
                id: `fee-${state.id}-${Date.now()}-pool`,
                side: 'creator_pool_reward',
                price: state.oraclePrice,
                size: reward,
                value: reward,
                pnl: reward,
                indexId: state.id,
                indexSymbol: state.symbol,
                poolTotal: Math.round(amount * 100) / 100,
                balance: Math.round(creator.virtualBalance * 100) / 100,
                timestamp: Date.now(),
              })
              if (creator.trades.length > 100) creator.trades = creator.trades.slice(0, 100)

              if (creator.decisions) {
                creator.decisions.unshift({
                  action: 'creator_pool_reward',
                  price: state.oraclePrice,
                  size: reward,
                  confidence: 1,
                  reasoning: `Received $${reward.toFixed(4)} global pool reward for ${state.symbol} (${(share * 100).toFixed(1)}% share of $${amount.toFixed(2)} pool)`,
                  timestamp: Date.now(),
                })
                if (creator.decisions.length > 50) creator.decisions = creator.decisions.slice(0, 50)
              }
            }

            // ── Feed event: pool reward ──
            if (reward > 0.0001) {
              const feeEvent = {
                type: 'pool_reward',
                amount: Math.round(reward * 10000) / 10000,
                poolTotal: Math.round(amount * 100) / 100,
                share: Math.round(share * 10000) / 10000,
                timestamp: Date.now(),
              }
              if (!state.feeHistory) state.feeHistory = []
              state.feeHistory.unshift(feeEvent)
              if (state.feeHistory.length > 100) state.feeHistory = state.feeHistory.slice(0, 100)

              this.indexRegistry._emitFeed(state, {
                eventType: 'creator_fee',
                severity: 'info',
                title: `Creator earned $${reward.toFixed(4)} pool reward for ${state.symbol}`,
                detail: feeEvent,
              })

              this._recordFinancialEvent({
                stream: 'creator_revenue',
                bucket: 'creator_pool_reward',
                amount: reward,
                feeType: 'pool_reward',
                creationType: 'agent',
                indexId: state.id,
                indexSymbol: state.symbol,
                timestamp: feeEvent.timestamp,
              })
            }
          }
        }
        distributed += creatorAmt
      }
    }

    // 4. Reserve (20%) — stays in pool as buffer
    const reserveAmt = amount * splits.reserve
    // Reserve stays in pool, no action needed

    // Debit from pool (only what was actually distributed)
    pool.balance = Math.max(0, pool.balance - distributed)
    pool.totalRedistributed = Math.min(guards.maxLifetimeTotal, pool.totalRedistributed + distributed)
    pool.lastRedistributionAt = Date.now()
    pool.redistributionCount++

    // Persist globalPool to DB
    this._saveGlobalPool()

    if (distributed > 0.01) {
      console.log(`🌊 Global pool redistributed: $${distributed.toFixed(2)} (pool remaining: $${pool.balance.toFixed(2)})`)
    }
  }

  // ─── Creator Stats ─────────────────────────────────────────────────

  /**
   * Get full creator stats for an agent (revenue dashboard data)
   */
  getCreatorStats(agentId) {
    const created = this.creatorMap.get(agentId) || []
    if (created.length === 0) return { agentId, isCreator: false, indexes: [] }

    const indexes = []
    for (const entry of created) {
      const state = this.indexRegistry.indexes.get(entry.indexId)
      if (!state) continue

      indexes.push({
        indexId: entry.indexId,
        symbol: state.symbol,
        name: state.name,
        status: state.status,
        createdAt: entry.createdAt,
        oraclePrice: state.oraclePrice,
        circulatingSupply: state.circulatingSupply,
        maxSupply: state.maxSupply,
        totalVolume: Math.round(state.totalVolume * 100) / 100,
        totalTrades: state.totalTrades,
        holderCount: state.holderCount,
        treasury: {
          balance: Math.round((state.treasury?.balance || 0) * 100) / 100,
          totalCollected: Math.round((state.treasury?.totalCollected || 0) * 100) / 100,
        },
        creatorFees: state.creatorFees || { totalEarned: 0, tradingFees: 0, mintFees: 0, performanceFees: 0 },
        feeHistory: (state.feeHistory || []).slice(0, 50),  // last 50 fee events
        stakeLockUntil: entry.stakeLockUntil,
        stakeSize: entry.stakeSize,
        stakeTarget: entry.stakeTarget ?? this.getCreatorStakeTarget(state),
        stakeProgressPct: (entry.stakeTarget ?? this.getCreatorStakeTarget(state)) > 0
          ? Math.round((entry.stakeSize / (entry.stakeTarget ?? this.getCreatorStakeTarget(state))) * 10000) / 100
          : 0,
        isStakeLocked: Date.now() < entry.stakeLockUntil,
      })
    }

    // Aggregate revenue
    const totalRevenue = indexes.reduce((s, i) => s + (i.creatorFees?.totalEarned || 0), 0)

    // Merge all fee histories into a single chronological feed
    const allFeeEvents = indexes
      .flatMap(i => (i.feeHistory || []).map(f => ({ ...f, indexId: i.indexId, symbol: i.symbol })))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50)

    return {
      agentId,
      isCreator: true,
      totalIndexes: created.length,
      activeIndexes: indexes.filter(i => i.status === 'active').length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      indexes,
      feeHistory: allFeeEvents,
    }
  }

  // ─── Global Pool Snapshot ──────────────────────────────────────────

  getGlobalPoolSnapshot() {
    this._sanitizeGlobalPool('snapshot')
    return {
      balance: Math.round(this.globalPool.balance * 100) / 100,
      totalCollected: Math.round(this.globalPool.totalCollected * 100) / 100,
      totalRedistributed: Math.round(this.globalPool.totalRedistributed * 100) / 100,
      lastRedistributionAt: this.globalPool.lastRedistributionAt,
      redistributionCount: this.globalPool.redistributionCount,
      breakdown: {
        fromCreationFees: Math.round(this.globalPool.fromCreationFees * 100) / 100,
        fromTradingFees: Math.round(this.globalPool.fromTradingFees * 100) / 100,
        fromMintFees: Math.round(this.globalPool.fromMintFees * 100) / 100,
      },
      splits: AGENT_INDEX_CONFIG.globalPoolSplits,
    }
  }

  getPlatformRevenueSnapshot() {
    this._sanitizePlatformRevenue('snapshot')
    return {
      balance: Math.round(this.platformRevenue.balance * 100) / 100,
      totalCollected: Math.round(this.platformRevenue.totalCollected * 100) / 100,
      totalWithdrawn: Math.round(this.platformRevenue.totalWithdrawn * 100) / 100,
      lastCollectedAt: this.platformRevenue.lastCollectedAt,
      breakdown: {
        fromSystemTradingFees: Math.round(this.platformRevenue.fromSystemTradingFees * 100) / 100,
        fromSystemMintFees: Math.round(this.platformRevenue.fromSystemMintFees * 100) / 100,
      },
    }
  }

  getFinancialHistorySnapshot(limit = 250) {
    const safeLimit = Math.min(FINANCIAL_HISTORY_LIMIT, Math.max(1, Number(limit) || 250))
    return this.financialHistory.slice(0, safeLimit)
  }

  // ─── Monitoring Data ───────────────────────────────────────────────

  getMonitoringData() {
    const agentIndexes = []
    const now = Date.now()

    for (const [indexId, state] of this.indexRegistry.indexes) {
      if (state.creationType !== 'agent') continue

      const lastActivity = state.lastVolumeAt || state.createdAt
      const timeSinceActivity = now - lastActivity

      agentIndexes.push({
        indexId,
        symbol: state.symbol,
        name: state.name,
        status: state.status,
        creatorAgentId: state.creatorAgentId,
        oraclePrice: state.oraclePrice,
        totalVolume: Math.round(state.totalVolume * 100) / 100,
        totalTrades: state.totalTrades,
        holderCount: state.holderCount,
        circulatingSupply: state.circulatingSupply,
        treasury: Math.round((state.treasury?.balance || 0) * 100) / 100,
        creatorFees: state.creatorFees || {},
        lastVolumeAt: lastActivity,
        minutesSinceActivity: Math.round(timeSinceActivity / 60000),
        autoDelistRisk: timeSinceActivity > AGENT_INDEX_CONFIG.autoDelistNoVolumeMs * 0.7,
        hasSystemMM: !!this.systemMMs[indexId],
        createdAt: state.createdAt,
      })
    }

    return {
      totalAgentIndexes: agentIndexes.length,
      activeAgentIndexes: agentIndexes.filter(i => i.status === 'active').length,
      pausedAgentIndexes: agentIndexes.filter(i => i.status === 'paused').length,
      globalPool: this.getGlobalPoolSnapshot(),
      platformRevenue: this.getPlatformRevenueSnapshot(),
      indexes: agentIndexes,
      config: { ...AGENT_INDEX_CONFIG },
    }
  }
}
