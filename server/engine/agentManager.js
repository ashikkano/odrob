// ═══════════════════════════════════════════════════════════════════════
// Agent Manager — Runs autonomous agents with virtual balances
// All trading happens on Index order books (AIDX, AMOM, OIL, etc.)
// No main/FLOOR order book — agents subscribe to indexes and trade there.
// ═══════════════════════════════════════════════════════════════════════

import { STRATEGIES } from './strategies.js'
import { randomUUID } from 'crypto'
import { RingBuffer } from '../utils/ringBuffer.js'
import { getStrategyTemplate } from '../runtimeStrategyStore.js'

const TICK_INTERVAL = 3000     // 3 seconds per tick
const MAX_DECISION_LOG = 200
const DEFAULT_AGENT_SAFETY_CONFIG = Object.freeze({
  enabled: true,
  quarantineAgents: true,
  maxAgentBalance: 10_000_000,
  maxAgentEquity: 10_000_000,
  maxIndexPrice: 1_000_000,
  maxHoldingValue: 10_000_000,
})

const DEFAULT_BOOTSTRAP_SUBSCRIPTIONS = Object.freeze({
  allocationPct: 5,
  maxSystemIndexes: 3,
  maxAgentIndexes: 0,
})

const DEFAULT_SEED_INDEX_FANOUT = 24
const DEFAULT_SUBSCRIPTION_ROTATION = Object.freeze({
  enabled: true,
  intervalTicks: 40,
  maxActiveSubscriptions: 4,
  allocationPct: 5,
  minSubLifetimeTicks: 20,
  maxCandidateIndexes: 12,
})

const ROTATION_MANAGED_SOURCES = new Set(['bootstrap', 'seed_fanout', 'rotation'])
const STRATEGY_FORMULA_PREFERENCES = Object.freeze({
  market_maker: ['ai_trade', 'agent_momentum', 'volume_flywheel', 'creator_equity'],
  trend_follower: ['agent_momentum', 'strategy_alpha', 'multi_agent_basket', 'volume_flywheel'],
  mean_reversion: ['creator_equity', 'creator_pnl', 'hybrid_external', 'ai_trade'],
  momentum: ['agent_momentum', 'strategy_alpha', 'multi_agent_basket', 'volume_flywheel'],
  grid_trader: ['volume_flywheel', 'ai_trade', 'creator_equity', 'hybrid_external'],
  scalper: ['volume_flywheel', 'agent_momentum', 'strategy_alpha', 'ai_trade'],
  contrarian: ['creator_pnl', 'creator_equity', 'hybrid_external', 'ai_trade'],
  vwap: ['volume_flywheel', 'ai_trade', 'agent_momentum', 'creator_equity'],
  llm_trader: ['agent_momentum', 'strategy_alpha', 'volume_flywheel', 'multi_agent_basket', 'creator_equity', 'creator_pnl', 'hybrid_external', 'ai_trade'],
})

const CUSTOM_STRATEGY_DAY_MS = 24 * 60 * 60 * 1000

function normalizeWalletAddress(value) {
  return String(value || '').trim().toLowerCase()
}

export class AgentManager {
  constructor(opts = {}) {
    this.agents = new Map()      // id → agent state
    this.decisionLog = new RingBuffer(500)    // global decision log (last 500)
    this.tradeLog = new RingBuffer(500)       // global trade log with agent info
    this.equitySnapshots = []    // periodic snapshots for equity curve
    this.running = false
    this.tickTimer = null
    this.tickCount = 0
    this.startTime = null

    // Persistence callbacks (injected from server)
    this._persist = opts.persist || null   // { saveTrade, saveDecision, saveEquity, saveAgent, saveAgentsBatch, saveSubscription, deleteSubscription }
    this.customStrategyRuntime = opts.customStrategyRuntime || null
    this._strategyRuntime = opts.strategyRuntime || null
    this._sharedLlmScopeSnapshot = { scopes: new Map(), byAgent: new Map() }

    // Index registry (set after construction via setIndexRegistry)
    this.indexRegistry = null
    this.safetyConfig = { ...DEFAULT_AGENT_SAFETY_CONFIG, ...(opts.safetyConfig || {}) }
    this.safetyEvents = []
  }

  getSafetyConfig() {
    return { ...this.safetyConfig }
  }

  updateSafetyConfig(patch = {}) {
    const next = { ...this.safetyConfig }
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in DEFAULT_AGENT_SAFETY_CONFIG)) continue
      if (typeof DEFAULT_AGENT_SAFETY_CONFIG[key] === 'boolean') {
        next[key] = Boolean(value)
        continue
      }
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) continue
      next[key] = numeric
    }
    this.safetyConfig = next
    return this.getSafetyConfig()
  }

  getSafetyEvents(limit = 50) {
    if (!limit || limit <= 0) return [...this.safetyEvents]
    return this.safetyEvents.slice(0, limit)
  }

  _recordSafetyEvent(event) {
    this.safetyEvents.unshift({
      id: randomUUID(),
      timestamp: Date.now(),
      source: 'agent',
      ...event,
    })
    if (this.safetyEvents.length > 200) this.safetyEvents = this.safetyEvents.slice(0, 200)
  }

  // ─── Start the engine ──────────────────────────────────────────────
  async start() {
    if (this.running) return
    this.running = true
    this.startTime = Date.now()

    console.log('🚀 AgentManager starting...')

    // Start tick loop — all trading is index-based
    this.tickTimer = setInterval(() => this._tick(), TICK_INTERVAL)

    // Start all active agents
    for (const [id, agent] of this.agents) {
      if (agent.status === 'active') {
        console.log(`  ▸ Agent ${agent.name} (${agent.strategy}) active`)
      }
    }

    console.log(`✅ Engine running. ${this.agents.size} agents loaded, tick=${TICK_INTERVAL}ms`)
  }

  stop() {
    this.running = false
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    console.log('⏹ AgentManager stopped')
  }

  /** Wire up index registry (called after both are constructed) */
  setIndexRegistry(registry) {
    this.indexRegistry = registry
  }

  // ─── Manage agents ─────────────────────────────────────────────────

  addAgent(params) {
    const id = params.id || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const strategyDef = STRATEGIES[params.strategy]
    if (!strategyDef) throw new Error(`Unknown strategy: ${params.strategy}`)

    const agent = {
      id,
      name: params.name,
      strategy: params.strategy,
      strategyName: strategyDef.name,
      icon: params.icon || strategyDef.icon,
      bio: params.bio || '',
      isUserAgent: params.isUserAgent || false,
      walletAddress: params.walletAddress || null,
      riskLevel: params.riskLevel || 'medium',
      status: params.status || 'active',
      virtualBalance: params.virtualBalance || 1000,
      initialBalance: params.virtualBalance || 1000,
      position: 0,           // legacy — kept for compat, real positions are in index holders
      positionValue: 0,
      avgEntryPrice: 0,
      pnl: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      feeIncome: 0,
      dividendIncome: 0,
      royaltyIncome: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalVolume: 0,
      maxDrawdown: 0,
      peakEquity: params.virtualBalance || 1000,
      config: params.config || {},
      indexSubscriptions: params.indexSubscriptions || [],  // [{indexId, allocationPct, status}]
      openOrders: [],
      decisions: [],          // last N decisions
      trades: [],             // last N trades
      equityCurve: [{ time: Date.now(), equity: params.virtualBalance || 1000 }],
      createdAt: Date.now(),
      lastTickAt: null,
      lastDecisionAt: Date.now() - Math.random() * (params.config?.cooldownMs || 5000),
      tickCount: 0,
    }

    this.agents.set(id, agent)
    return agent
  }

  removeAgent(id) {
    const agent = this.agents.get(id)
    if (!agent) return false
    // Cancel all orders on all indexes
    if (this.indexRegistry) {
      for (const [indexId] of this.indexRegistry.indexes) {
        try { this.indexRegistry.cancelOrdersForAgent(indexId, id) } catch {}
      }
    }
    this.agents.delete(id)
    return true
  }

  // ─── Index subscriptions ─────────────────────────────────────────

  subscribeAgentToIndex(agentId, indexId, allocationPct = 5, options = {}) {
    const agent = this.agents.get(agentId)
    if (!agent) return { error: 'Agent not found' }
    if (allocationPct < 1 || allocationPct > 50) return { error: 'Allocation must be 1-50%' }

    const existing = (agent.indexSubscriptions || []).find(s => s.indexId === indexId)
    const existingAllocation = existing?.allocationPct || 0

    // Check total allocation
    const totalAlloc = (agent.indexSubscriptions || []).reduce((s, sub) => s + sub.allocationPct, 0)
    if ((totalAlloc - existingAllocation) + allocationPct > 60) return { error: 'Total allocation would exceed 60%' }

    if (existing) {
      existing.allocationPct = allocationPct
      existing.status = 'active'
      if (options.source) existing.source = options.source
      if (options.rotatedAt) existing.rotatedAt = options.rotatedAt
      if (options.sharedLlmTemplateId) existing.sharedLlmTemplateId = options.sharedLlmTemplateId
      if (options.sharedLlmScopeId) existing.sharedLlmScopeId = options.sharedLlmScopeId
      if (options.sharedLlmLeaderAgentId) existing.sharedLlmLeaderAgentId = options.sharedLlmLeaderAgentId
      if (options.sharedLlmControllerAgentId) existing.sharedLlmControllerAgentId = options.sharedLlmControllerAgentId
      if (options.sharedLlmScopeKey) existing.sharedLlmScopeKey = options.sharedLlmScopeKey
      if (!existing.subscribedTick) existing.subscribedTick = this.tickCount
      if (agent.isUserAgent && this._persist?.saveSubscription) {
        try {
          this._persist.saveSubscription({
            agentId,
            indexId,
            allocationPct,
            status: 'active',
            subscribedAt: existing.subscribedAt || Date.now(),
          })
        } catch {}
      }
      return { ok: true, subscription: existing }
    }

    const sub = {
      indexId,
      allocationPct,
      status: 'active',
      subscribedAt: Date.now(),
      subscribedTick: this.tickCount,
      ...(options.source ? { source: options.source } : {}),
      ...(options.rotatedAt ? { rotatedAt: options.rotatedAt } : {}),
      ...(options.sharedLlmTemplateId ? { sharedLlmTemplateId: options.sharedLlmTemplateId } : {}),
      ...(options.sharedLlmScopeId ? { sharedLlmScopeId: options.sharedLlmScopeId } : {}),
      ...(options.sharedLlmLeaderAgentId ? { sharedLlmLeaderAgentId: options.sharedLlmLeaderAgentId } : {}),
      ...(options.sharedLlmControllerAgentId ? { sharedLlmControllerAgentId: options.sharedLlmControllerAgentId } : {}),
      ...(options.sharedLlmScopeKey ? { sharedLlmScopeKey: options.sharedLlmScopeKey } : {}),
    }
    if (!agent.indexSubscriptions) agent.indexSubscriptions = []
    agent.indexSubscriptions.push(sub)
    if (agent.isUserAgent && this._persist?.saveSubscription) {
      try {
        this._persist.saveSubscription({
          agentId,
          indexId,
          allocationPct,
          status: 'active',
          subscribedAt: sub.subscribedAt,
        })
      } catch {}
    }
    return { ok: true, subscription: sub }
  }

  unsubscribeAgentFromIndex(agentId, indexId) {
    const agent = this.agents.get(agentId)
    if (!agent || !agent.indexSubscriptions) return { error: 'Agent not found' }
    agent.indexSubscriptions = agent.indexSubscriptions.filter(s => s.indexId !== indexId)
    if (agent.isUserAgent && this._persist?.deleteSubscription) {
      try { this._persist.deleteSubscription(agentId, indexId) } catch {}
    }
    return { ok: true }
  }

  getBootstrapIndexCandidates(options = {}) {
    if (!this.indexRegistry) return []

    const {
      maxSystemIndexes = DEFAULT_BOOTSTRAP_SUBSCRIPTIONS.maxSystemIndexes,
      maxAgentIndexes = DEFAULT_BOOTSTRAP_SUBSCRIPTIONS.maxAgentIndexes,
    } = options

    const indexes = Array.from(this.indexRegistry.indexes.values())
      .filter(state => state?.status === 'active')

    const byPriority = (left, right) => {
      const volumeDelta = (right.totalVolume || 0) - (left.totalVolume || 0)
      if (volumeDelta !== 0) return volumeDelta
      return (left.createdAt || 0) - (right.createdAt || 0)
    }

    const systemIndexes = indexes
      .filter(state => state.creationType !== 'agent')
      .sort(byPriority)
      .slice(0, Math.max(0, maxSystemIndexes))

    const agentIndexes = indexes
      .filter(state => state.creationType === 'agent')
      .sort(byPriority)
      .slice(0, Math.max(0, maxAgentIndexes))

    return [...systemIndexes, ...agentIndexes]
  }

  subscribeAgentToBootstrapIndexes(agentId, options = {}) {
    const allocationPct = options.allocationPct || DEFAULT_BOOTSTRAP_SUBSCRIPTIONS.allocationPct
    const candidates = this.getBootstrapIndexCandidates(options)
    const subscribedIds = []

    for (const state of candidates) {
      const result = this.subscribeAgentToIndex(agentId, state.id, allocationPct, { source: 'bootstrap' })
      if (result?.ok) subscribedIds.push(state.id)
    }

    return { count: subscribedIds.length, indexIds: subscribedIds }
  }

  /**
   * Auto-subscribe all seed agents to an index with small allocation.
   * Called once when index is first registered.
   */
  autoSubscribeSeedAgents(indexId, allocationPct = 5, maxAgents = DEFAULT_SEED_INDEX_FANOUT) {
    const candidates = Array.from(this.agents.entries())
      .filter(([id, agent]) => id !== '__seed__' && !agent.isUserAgent && agent.status === 'active')
      .sort((left, right) => {
        const leftSubCount = left[1].indexSubscriptions?.length || 0
        const rightSubCount = right[1].indexSubscriptions?.length || 0
        if (leftSubCount !== rightSubCount) return leftSubCount - rightSubCount
        return (right[1].totalTrades || 0) - (left[1].totalTrades || 0)
      })
      .slice(0, Math.max(0, maxAgents))

    let count = 0
    for (const [id] of candidates) {
      const result = this.subscribeAgentToIndex(id, indexId, allocationPct, { source: 'seed_fanout' })
      if (result?.ok) count++
    }
    console.log(`  🔗 Auto-subscribed ${count}/${candidates.length} seed agent(s) to ${indexId} @ ${allocationPct}% allocation`)
    return count
  }

  getSubscriptionRotationConfig(agent) {
    const base = { ...DEFAULT_SUBSCRIPTION_ROTATION }
    const overrides = agent?.config || {}
    const persistedPolicy = this._strategyRuntime?.getAgentRotationPolicy?.(agent?.id) || null

    const persistedEnabled = typeof persistedPolicy?.enabled === 'boolean' ? persistedPolicy.enabled : null
    const runtimeEnabled = typeof overrides.enableSubscriptionRotation === 'boolean'
      ? overrides.enableSubscriptionRotation
      : persistedEnabled

    if (agent?.isUserAgent && runtimeEnabled !== true) {
      return { ...base, enabled: false }
    }

    if (typeof overrides.enableSubscriptionRotation === 'boolean') {
      base.enabled = overrides.enableSubscriptionRotation
    } else if (persistedEnabled !== null) {
      base.enabled = persistedEnabled
    }

    const numericKeys = ['intervalTicks', 'maxActiveSubscriptions', 'allocationPct', 'minSubLifetimeTicks', 'maxCandidateIndexes']
    for (const key of numericKeys) {
      const numeric = Number(overrides[key])
      if (Number.isFinite(numeric) && numeric > 0) base[key] = numeric
    }

    if (persistedPolicy) {
      const persistedNumericMapping = {
        intervalTicks: 'intervalTicks',
        maxActiveChannels: 'maxActiveSubscriptions',
        minChannelLifetimeTicks: 'minSubLifetimeTicks',
        maxCandidateChannels: 'maxCandidateIndexes',
      }
      for (const [policyKey, configKey] of Object.entries(persistedNumericMapping)) {
        const numeric = Number(persistedPolicy[policyKey])
        if (Number.isFinite(numeric) && numeric > 0 && !Number.isFinite(Number(overrides[configKey]))) {
          base[configKey] = numeric
        }
      }
      base.goalMode = persistedPolicy.goalMode || overrides.rotationGoalMode || 'balanced'
      base.profileName = persistedPolicy.profileName || overrides.rotationProfileName || 'balanced'
      base.scoreWeights = persistedPolicy.scoreWeights || {}
      base.filters = persistedPolicy.filters || {}
      base.churnBudgetPerDay = Number.isFinite(Number(persistedPolicy.churnBudgetPerDay))
        ? Number(persistedPolicy.churnBudgetPerDay)
        : null
      base.policyId = persistedPolicy.id || null
      base.strategyInstanceId = persistedPolicy.strategyInstanceId || agent?.config?.activeStrategyInstanceId || null
    } else {
      base.goalMode = overrides.rotationGoalMode || 'balanced'
      base.profileName = overrides.rotationProfileName || 'balanced'
      base.scoreWeights = overrides.rotationScoreWeights || {}
      base.filters = overrides.rotationFilters || {}
      base.churnBudgetPerDay = Number.isFinite(Number(overrides.rotationChurnBudgetPerDay))
        ? Number(overrides.rotationChurnBudgetPerDay)
        : null
      base.policyId = null
      base.strategyInstanceId = agent?.config?.activeStrategyInstanceId || null
    }

    base.intervalTicks = Math.max(5, Math.round(base.intervalTicks))
    base.maxActiveSubscriptions = Math.max(1, Math.min(8, Math.round(base.maxActiveSubscriptions)))
    base.allocationPct = Math.max(1, Math.min(50, base.allocationPct))
    base.minSubLifetimeTicks = Math.max(5, Math.round(base.minSubLifetimeTicks))
    base.maxCandidateIndexes = Math.max(base.maxActiveSubscriptions, Math.round(base.maxCandidateIndexes))
    return base
  }

  _recordRotationEvent(agent, config, details = {}) {
    if (!this._strategyRuntime?.saveAgentRotationEvent) return
    try {
      this._strategyRuntime.saveAgentRotationEvent({
        id: randomUUID(),
        agentId: agent.id,
        strategyInstanceId: config?.strategyInstanceId || agent?.config?.activeStrategyInstanceId || null,
        policyId: config?.policyId || null,
        rotatedOutChannelId: details.rotatedOutIndexId || null,
        rotatedInChannelId: details.rotatedInIndexId || null,
        reasonCode: details.reasonCode || 'rotation',
        beforeScore: details.beforeScore ?? null,
        afterScore: details.afterScore ?? null,
        details: {
          targetType: 'index_subscription',
          goalMode: config?.goalMode || 'balanced',
          profileName: config?.profileName || 'balanced',
          activeSubscriptions: details.activeSubscriptions ?? null,
          ...details,
        },
        createdAt: Date.now(),
      })
    } catch {}
  }

  _getIndexHoldingBalance(agentId, indexId) {
    const state = this.indexRegistry?.indexes?.get(indexId)
    const holding = state?.holders?.get(agentId)
    return holding?.balance || 0
  }

  _canRotateOutSubscription(agent, sub, config) {
    if (!sub) return false
    if (agent.isUserAgent && !ROTATION_MANAGED_SOURCES.has(sub.source)) return false

    const ageTicks = Number.isFinite(sub.subscribedTick)
      ? (this.tickCount - sub.subscribedTick)
      : Math.floor(Math.max(0, Date.now() - (sub.subscribedAt || 0)) / TICK_INTERVAL)

    if (ageTicks < config.minSubLifetimeTicks) return false
    if (this._getIndexHoldingBalance(agent.id, sub.indexId) > 0) return false
    const pendingOrders = this.indexRegistry?.getAgentPendingOrders(sub.indexId, agent.id) || []
    return pendingOrders.length === 0
  }

  _getCustomStrategyState(agent) {
    const strategyProfile = this.customStrategyRuntime?.getActiveStrategyProfile?.(agent.id) || null
    const instanceId = strategyProfile?.instance?.id
      || agent?.config?.activeStrategyInstanceId
      || agent?._activeStrategyInstanceId
      || null
    const templateId = strategyProfile?.instance?.strategyTemplateId
      || agent?.config?.strategyTemplateId
      || agent?._activeStrategyTemplateId
      || null
    const template = templateId ? getStrategyTemplate(templateId) : null
    const templateType = template?.type || null
    const instance = strategyProfile?.instance || null
    const customParams = instance?.customParams || {}
    const declaredScopeId = customParams.__llmSharedScopeId || null
    const declaredScopeKey = customParams.__llmSharedScopeKey || customParams.__llmSharedMemoryKey || null
    let sharedScope = declaredScopeId
      ? (this._persist?.getLlmSharedScope?.(declaredScopeId) || null)
      : (declaredScopeKey ? (this._persist?.getLlmSharedScope?.(declaredScopeKey) || null) : null)
    const declaredCreatorWalletAddress = customParams.__llmSharedOwnerWallet || template?.ownerUserAddress || null
    const declaredCreatorAgentId = customParams.__llmSharedCreatorAgentId || null
    const derivedScopeKey = declaredScopeKey || (templateId && declaredCreatorWalletAddress
      ? `llm-template:${templateId}:owner:${normalizeWalletAddress(declaredCreatorWalletAddress)}`
      : null)
    const creatorWalletAddress = declaredCreatorWalletAddress || sharedScope?.ownerUserAddress || template?.ownerUserAddress || null
    const creatorAgentId = declaredCreatorAgentId || sharedScope?.creatorAgentId || null
    const creatorAgent = creatorAgentId
      ? (this.getAgent(creatorAgentId) || null)
      : Array.from(this.agents.values()).find((candidate) => (
          candidate?.isUserAgent
          && normalizeWalletAddress(candidate.walletAddress) === normalizeWalletAddress(creatorWalletAddress)
        )) || null
    const hasCustomStrategy = Boolean(instanceId)
    const mode = hasCustomStrategy ? 'direct' : null
    const llmOwnsExecution = hasCustomStrategy && mode === 'direct' && templateType === 'llm'

    if (!sharedScope && llmOwnsExecution && Boolean(customParams.__llmSharedExecution) && templateId && creatorWalletAddress && derivedScopeKey && this._persist?.ensureLlmSharedScope) {
      try {
        sharedScope = this._persist.ensureLlmSharedScope({
          id: randomUUID(),
          scopeKey: derivedScopeKey,
          strategyTemplateId: templateId,
          ownerUserAddress: creatorWalletAddress,
          creatorAgentId: creatorAgent?.id || creatorAgentId || null,
          creatorAgentName: creatorAgent?.name || customParams.__llmSharedCreatorAgentName || null,
          executionMode: customParams.__llmSharedExecutionMode || 'strategy_scope',
          memoryKey: customParams.__llmSharedMemoryKey || derivedScopeKey,
          stateKey: customParams.__llmSharedStateKey || customParams.__llmSharedMemoryKey || derivedScopeKey,
          status: 'active',
          subscriptionPlan: [],
          metadata: {
            migratedFromInstanceId: instanceId || null,
            templateName: template?.name || null,
          },
          createdAt: instance?.createdAt || Date.now(),
          updatedAt: Date.now(),
        })
      } catch {}
    }

    return {
      strategyProfile,
      instance,
      instanceId,
      templateId,
      template,
      templateType,
      mode,
      hasCustomStrategy,
      llmSharedScope: sharedScope,
      llmSharedScopeId: sharedScope?.id || declaredScopeId || null,
      llmSharedScopeKey: sharedScope?.scopeKey || derivedScopeKey || null,
      creatorAgent,
      creatorAgentId: creatorAgent?.id || creatorAgentId || null,
      creatorWalletAddress: creatorWalletAddress || sharedScope?.ownerUserAddress || null,
      llmSharedExecution: Boolean(customParams.__llmSharedExecution),
      llmSharedExecutionMode: customParams.__llmSharedExecutionMode || sharedScope?.executionMode || null,
      llmSharedMemoryKey: customParams.__llmSharedMemoryKey || sharedScope?.memoryKey || null,
      llmSharedStateKey: customParams.__llmSharedStateKey || customParams.__llmSharedMemoryKey || sharedScope?.stateKey || sharedScope?.memoryKey || null,
      llmOwnsExecution,
      customOwnsExecution: hasCustomStrategy && mode === 'direct' && !llmOwnsExecution,
    }
  }

  _buildSharedLlmScopeSnapshot() {
    const scopes = new Map()
    const byAgent = new Map()
    const persistedScopes = this._persist?.listLlmSharedScopes?.() || []
    const scopeByKey = new Map()

    for (const persisted of persistedScopes) {
      const scope = {
        id: persisted.id,
        scopeKey: persisted.scopeKey,
        templateId: persisted.strategyTemplateId,
        templateName: persisted.metadata?.templateName || null,
        creatorAgentId: persisted.creatorAgentId || null,
        creatorAgentName: persisted.creatorAgentName || null,
        creatorWalletAddress: persisted.ownerUserAddress || null,
        executionMode: persisted.executionMode || 'strategy_scope',
        subscriptionPlan: Array.isArray(persisted.subscriptionPlan) ? persisted.subscriptionPlan : [],
        metadata: persisted.metadata || {},
        lastSyncedAt: persisted.lastSyncedAt || null,
        members: [],
        controllerEntry: null,
        controllerAgentId: null,
        controllerAgentName: null,
      }
      scopes.set(scope.id, scope)
      if (scope.scopeKey) scopeByKey.set(scope.scopeKey, scope)
    }

    for (const [id, agent] of this.agents) {
      if (id === '__seed__' || agent?.status !== 'active') continue
      const state = this._getCustomStrategyState(agent)
      if (!state.llmOwnsExecution || !state.llmSharedExecution || !state.templateId) continue

      const scopeKey = state.llmSharedScopeKey || state.llmSharedMemoryKey || state.llmSharedStateKey || `llm-template:${state.templateId}`
      let scope = (state.llmSharedScopeId ? scopes.get(state.llmSharedScopeId) : null) || scopeByKey.get(scopeKey)
      if (!scope) {
        scope = {
          id: state.llmSharedScopeId || scopeKey,
          scopeKey,
          templateId: state.templateId,
          templateName: state.template?.name || null,
          creatorAgentId: state.creatorAgentId || null,
          creatorAgentName: state.creatorAgent?.name || null,
          creatorWalletAddress: state.creatorWalletAddress || null,
          executionMode: state.llmSharedExecutionMode || 'strategy_scope',
          subscriptionPlan: state.llmSharedScope?.subscriptionPlan || [],
          metadata: state.llmSharedScope?.metadata || {},
          lastSyncedAt: state.llmSharedScope?.lastSyncedAt || null,
          members: [],
          controllerEntry: null,
          controllerAgentId: null,
          controllerAgentName: null,
        }
        scopes.set(scope.id, scope)
        scopeByKey.set(scope.scopeKey, scope)
      }

      scope.members.push({ agent, state })
    }

    for (const scope of scopes.values()) {
      const controllerEntry = scope.members.find((entry) => entry.agent.id === scope.creatorAgentId)
        || [...scope.members].sort((left, right) => {
          const leftTs = Number(left.state.instance?.createdAt || left.agent.createdAt || 0)
          const rightTs = Number(right.state.instance?.createdAt || right.agent.createdAt || 0)
          if (leftTs !== rightTs) return leftTs - rightTs
          return String(left.agent.id).localeCompare(String(right.agent.id))
        })[0]

      scope.controllerEntry = controllerEntry || null
      scope.controllerAgentId = controllerEntry?.agent?.id || scope.creatorAgentId || null
      scope.controllerAgentName = controllerEntry?.agent?.name || scope.creatorAgentName || null

      for (const entry of scope.members) {
        byAgent.set(entry.agent.id, {
          scope,
          state: entry.state,
          role: 'member',
        })
      }
    }

    return { scopes, byAgent }
  }

  _getSharedLlmScopeRotationConfig(scope) {
    const controllerAgent = scope?.controllerEntry?.agent || scope?.members?.[0]?.agent || null
    const base = controllerAgent
      ? { ...this.getSubscriptionRotationConfig(controllerAgent) }
      : { ...DEFAULT_SUBSCRIPTION_ROTATION }
    const rotationPolicy = scope?.metadata?.rotationPolicy && typeof scope.metadata.rotationPolicy === 'object'
      ? scope.metadata.rotationPolicy
      : null

    base.enabled = true
    if (rotationPolicy) {
      if (typeof rotationPolicy.enabled === 'boolean') base.enabled = rotationPolicy.enabled !== false
      if (Number.isFinite(Number(rotationPolicy.intervalTicks)) && Number(rotationPolicy.intervalTicks) > 0) {
        base.intervalTicks = Number(rotationPolicy.intervalTicks)
      }
      if (Number.isFinite(Number(rotationPolicy.maxActiveChannels)) && Number(rotationPolicy.maxActiveChannels) > 0) {
        base.maxActiveSubscriptions = Number(rotationPolicy.maxActiveChannels)
      }
      if (Number.isFinite(Number(rotationPolicy.minChannelLifetimeTicks)) && Number(rotationPolicy.minChannelLifetimeTicks) > 0) {
        base.minSubLifetimeTicks = Number(rotationPolicy.minChannelLifetimeTicks)
      }
      if (Number.isFinite(Number(rotationPolicy.maxCandidateChannels)) && Number(rotationPolicy.maxCandidateChannels) > 0) {
        base.maxCandidateIndexes = Number(rotationPolicy.maxCandidateChannels)
      }
      if (Number.isFinite(Number(rotationPolicy.churnBudgetPerDay)) && Number(rotationPolicy.churnBudgetPerDay) >= 0) {
        base.churnBudgetPerDay = Number(rotationPolicy.churnBudgetPerDay)
      }
      if (rotationPolicy.goalMode) base.goalMode = rotationPolicy.goalMode
      if (rotationPolicy.profileName) base.profileName = rotationPolicy.profileName
      if (rotationPolicy.scoreWeights && typeof rotationPolicy.scoreWeights === 'object') base.scoreWeights = rotationPolicy.scoreWeights
      if (rotationPolicy.filters && typeof rotationPolicy.filters === 'object') base.filters = rotationPolicy.filters
    }
    base.goalMode = base.goalMode || 'balanced'
    base.profileName = base.profileName || 'shared_llm_scope'
    base.strategyInstanceId = base.strategyInstanceId || scope?.controllerEntry?.state?.instanceId || null
    return base
  }

  _canDetachSharedLlmSubscription(agent, sub) {
    if (!agent || !sub) return false
    if (this._getIndexHoldingBalance(agent.id, sub.indexId) > 0) return false
    const pendingOrders = this.indexRegistry?.getAgentPendingOrders?.(sub.indexId, agent.id) || []
    return pendingOrders.length === 0
  }

  _reconcileSharedLlmScopePlans(ctx) {
    if (!this.indexRegistry || !this._sharedLlmScopeSnapshot?.scopes?.size) return

    for (const scope of this._sharedLlmScopeSnapshot.scopes.values()) {
      const controllerAgent = scope.controllerEntry?.agent || scope.members?.[0]?.agent || null
      if (!controllerAgent) continue

      const config = this._getSharedLlmScopeRotationConfig(scope)
      if (!config.enabled) continue

      const lastRotationTick = Number(scope.metadata?.lastRotationTick)
      if (Number.isFinite(lastRotationTick)
        && Array.isArray(scope.subscriptionPlan)
        && scope.subscriptionPlan.length > 0
        && (this.tickCount - lastRotationTick) < config.intervalTicks) {
        continue
      }

      const candidates = this._getRotationCandidatesForAgent(controllerAgent, ctx, config)
      if (candidates.length === 0) continue

      const currentPlan = Array.isArray(scope.subscriptionPlan)
        ? scope.subscriptionPlan.filter((entry) => entry?.status === 'active')
        : []
      const currentByIndexId = new Map(currentPlan.map((entry) => [entry.indexId, entry]))
      const now = Date.now()
      const nextPlan = candidates
        .slice(0, config.maxActiveSubscriptions)
        .map((entry) => {
          const existing = currentByIndexId.get(entry.ictx.indexId)
          return {
            indexId: entry.ictx.indexId,
            symbol: entry.ictx.symbol || entry.ictx.indexSymbol || null,
            allocationPct: existing?.allocationPct || config.allocationPct,
            status: 'active',
            source: 'shared_llm_scope',
            scopeId: scope.id,
            scopeKey: scope.scopeKey,
            templateId: scope.templateId,
            subscribedAt: existing?.subscribedAt || now,
            subscribedTick: Number.isFinite(existing?.subscribedTick) ? existing.subscribedTick : this.tickCount,
            updatedAt: now,
            score: Number.isFinite(entry.score) ? Math.round(entry.score * 100) / 100 : null,
          }
        })

      const metadata = {
        ...(scope.metadata || {}),
        templateName: scope.templateName || scope.metadata?.templateName || null,
        executionMode: scope.executionMode || 'strategy_scope',
        lastRotationTick: this.tickCount,
        lastRotationAt: now,
        controllerAgentId: scope.controllerAgentId || null,
        controllerAgentName: scope.controllerAgentName || null,
        memberCount: scope.members.length,
        goalMode: config.goalMode || 'balanced',
        profileName: config.profileName || 'shared_llm_scope',
        topCandidates: candidates.slice(0, Math.min(3, candidates.length)).map((entry) => ({
          indexId: entry.ictx.indexId,
          symbol: entry.ictx.symbol || entry.ictx.indexSymbol || null,
          score: Number.isFinite(entry.score) ? Math.round(entry.score * 100) / 100 : null,
          factors: (entry.breakdown || []).slice(0, 5),
        })),
      }

      const saved = this._persist?.saveLlmSharedScopePlan
        ? this._persist.saveLlmSharedScopePlan(scope.id, {
            subscriptionPlan: nextPlan,
            metadata,
            status: 'active',
            lastSyncedAt: now,
          })
        : null

      scope.subscriptionPlan = saved?.subscriptionPlan || nextPlan
      scope.metadata = saved?.metadata || metadata
      scope.lastSyncedAt = saved?.lastSyncedAt || now
    }
  }

  _syncSharedLlmScopeSubscriptions() {
    if (!this.indexRegistry || !this._sharedLlmScopeSnapshot?.scopes?.size) return

    for (const scope of this._sharedLlmScopeSnapshot.scopes.values()) {
      const desiredSubs = Array.isArray(scope.subscriptionPlan)
        ? scope.subscriptionPlan.filter((sub) => sub?.status === 'active')
        : []
      const desiredMap = new Map(desiredSubs.map((sub) => [sub.indexId, sub]))
      const controllerAgent = scope.controllerEntry?.agent || null

      for (const entry of scope.members) {
        const memberAgent = entry.agent
        if (!memberAgent) continue

        const activeSubs = (memberAgent.indexSubscriptions || []).filter((sub) => sub?.status === 'active')
        const blocked = []

        for (const [indexId, desiredSub] of desiredMap.entries()) {
          this.subscribeAgentToIndex(memberAgent.id, indexId, desiredSub.allocationPct || 5, {
            source: 'shared_llm_scope',
            rotatedAt: Date.now(),
            sharedLlmTemplateId: scope.templateId,
            sharedLlmScopeId: scope.id,
            sharedLlmLeaderAgentId: controllerAgent?.id || null,
            sharedLlmControllerAgentId: controllerAgent?.id || null,
            sharedLlmScopeKey: scope.scopeKey,
          })
        }

        for (const sub of activeSubs) {
          if (desiredMap.has(sub.indexId)) continue
          if (!this._canDetachSharedLlmSubscription(memberAgent, sub)) {
            blocked.push(sub.indexId)
            continue
          }
          this.unsubscribeAgentFromIndex(memberAgent.id, sub.indexId)
        }

        memberAgent._llmSharedScopeId = scope.id
        memberAgent._llmSharedScopeKey = scope.scopeKey
        memberAgent._llmSharedControllerAgentId = controllerAgent?.id || null
        memberAgent._llmSharedControllerAgentName = controllerAgent?.name || null
        memberAgent._llmSharedScopeMemberCount = scope.members.length
        memberAgent._llmSharedPlanIndexIds = desiredSubs.map((sub) => sub.indexId)
        memberAgent._sharedLlmLeaderAgentId = controllerAgent?.id || null
        memberAgent._sharedLlmLeaderAgentName = controllerAgent?.name || null
        memberAgent._sharedLlmFollowerCount = Math.max(0, scope.members.length - 1)
        memberAgent._sharedLlmMirroredIndexIds = desiredSubs.map((sub) => sub.indexId)
        memberAgent._sharedLlmBlockedIndexIds = blocked
        memberAgent._sharedLlmLastSyncAt = Date.now()
      }
    }
  }

  _scoreIndexBaseMarketFitness(ictx) {
    if (!ictx) return { score: Number.NEGATIVE_INFINITY, breakdown: [] }

    const breakdown = []
    const addFactor = (key, label, value) => {
      if (!Number.isFinite(value) || value === 0) return
      breakdown.push({ key, label, value: Math.round(value * 100) / 100 })
    }

    const volumeScore = Math.log10(1 + Math.max(0, ictx.totalVolume || 0))
    const tradeScore = Math.log10(1 + Math.max(0, ictx.totalTrades || 0))
    const holderScore = Math.log10(1 + Math.max(0, ictx.holderCount || 0))

    let score = 0
    const baseVolume = volumeScore * 2
    const baseTrades = tradeScore * 1.5
    const baseHolders = holderScore
    score += baseVolume + baseTrades + baseHolders
    addFactor('base_volume', 'Volume depth', baseVolume)
    addFactor('base_trades', 'Trade activity', baseTrades)
    addFactor('base_holders', 'Holder breadth', baseHolders)

    return { score, breakdown }
  }

  _scoreIndexForStrategy(agent, ictx) {
    if (!ictx) return Number.NEGATIVE_INFINITY

    const breakdown = []
    const addFactor = (key, label, value) => {
      if (!Number.isFinite(value) || value === 0) return
      breakdown.push({ key, label, value: Math.round(value * 100) / 100 })
    }

    const preferredFormulas = STRATEGY_FORMULA_PREFERENCES[agent.strategy] || []
    const formulaRank = preferredFormulas.indexOf(ictx.formula?.id)
    const volumeScore = Math.log10(1 + Math.max(0, ictx.totalVolume || 0))
    const tradeScore = Math.log10(1 + Math.max(0, ictx.totalTrades || 0))
    const moveScore = Math.abs(ictx.oracleChangePct || 0)
    const bandScore = Math.max(0, Math.min(8, ictx.bandWidthPct || 0))
    const isAgentIndex = ictx.creationType === 'agent'

    let score = 0

    if (formulaRank >= 0) {
      const formulaBoost = (preferredFormulas.length - formulaRank) * 3
      score += formulaBoost
      addFactor('formula_fit', 'Strategy formula fit', formulaBoost)
    }
    if (!isAgentIndex) {
      score += 1.5
      addFactor('creation_bias', 'System index preference', 1.5)
    }

    switch (agent.strategy) {
      case 'market_maker':
        addFactor('strategy_market_maker', 'Band stability fit', Math.max(0, 5 - Math.abs(bandScore - 3)) * 1.4)
        score += Math.max(0, 5 - Math.abs(bandScore - 3)) * 1.4
        break
      case 'trend_follower':
      case 'momentum':
        addFactor('strategy_momentum_move', 'Momentum move strength', moveScore * 1.8)
        addFactor('strategy_momentum_band', 'Momentum corridor width', bandScore * 0.6)
        score += moveScore * 1.8 + bandScore * 0.6
        break
      case 'mean_reversion':
      case 'contrarian':
        addFactor('strategy_mean_reversion_move', 'Mean-reversion move fit', Math.max(0, 6 - moveScore) * 1.2)
        addFactor('strategy_mean_reversion_band', 'Mean-reversion band fit', Math.max(0, 5 - bandScore))
        score += Math.max(0, 6 - moveScore) * 1.2 + Math.max(0, 5 - bandScore)
        break
      case 'grid_trader':
        addFactor('strategy_grid_band', 'Grid band width', bandScore * 1.4)
        addFactor('strategy_grid_volume', 'Grid liquidity support', volumeScore)
        score += bandScore * 1.4 + volumeScore
        break
      case 'scalper':
        addFactor('strategy_scalper_trades', 'Scalping trade cadence', tradeScore * 2)
        addFactor('strategy_scalper_band', 'Tight-band opportunity', Math.max(0, 4 - bandScore))
        score += tradeScore * 2 + Math.max(0, 4 - bandScore)
        break
      case 'vwap':
        addFactor('strategy_vwap_volume', 'VWAP volume support', volumeScore * 2.2)
        addFactor('strategy_vwap_trades', 'VWAP trade support', tradeScore * 1.2)
        score += volumeScore * 2.2 + tradeScore * 1.2
        break
      case 'llm_trader':
        addFactor('strategy_llm_move', 'Narrative move signal', moveScore)
        addFactor('strategy_llm_band', 'Narrative band context', bandScore)
        addFactor('strategy_llm_holders', 'Narrative participation', holderScore)
        score += moveScore + bandScore + holderScore
        break
      default:
        break
    }

    return { score, breakdown }
  }

  _scoreIndexForCustomStrategyProfile(ictx, strategyProfile) {
    if (!ictx || !strategyProfile) return { score: 0, breakdown: [] }

    const breakdown = []
    const addFactor = (key, label, value) => {
      if (!Number.isFinite(value) || value === 0) return
      breakdown.push({ key, label, value: Math.round(value * 100) / 100 })
    }

    const requiredChannels = Array.isArray(strategyProfile.requiredChannels) ? strategyProfile.requiredChannels : []
    const feedItems = Array.isArray(ictx.feed) ? ictx.feed : []
    const feedTags = new Set(feedItems.flatMap((item) => Array.isArray(item?.topicTags) ? item.topicTags : []).filter(Boolean))
    let score = 0

    for (const channel of requiredChannels) {
      switch (channel?.channelType) {
        case 'index':
          score += 1.5
          addFactor('channel_index', 'Required index channel', 1.5)
          if (channel?.subscriptionKind === 'trading') {
            score += 0.5
            addFactor('channel_index_trading', 'Trading-ready index channel', 0.5)
          }
          break
        case 'strategy_signal': {
          const tradeScore = Math.log10(1 + Math.max(0, ictx.totalTrades || 0))
          const volumeScore = Math.log10(1 + Math.max(0, ictx.totalVolume || 0))
          score += tradeScore * 2.2 + volumeScore * 0.8
          addFactor('channel_strategy_signal_trades', 'Signal-channel trade support', tradeScore * 2.2)
          addFactor('channel_strategy_signal_volume', 'Signal-channel volume support', volumeScore * 0.8)
          if ((ictx.totalTrades || 0) < 8) {
            score -= 3.5
            addFactor('channel_strategy_signal_penalty', 'Signal-channel low activity penalty', -3.5)
          }
          break
        }
        case 'feed': {
          const feedCount = feedItems.length
          const feedBoost = Math.min(4.5, feedCount * 1.15)
          score += feedBoost
          addFactor('channel_feed', 'Feed coverage', feedBoost)
          if (feedCount === 0) {
            score -= 6
            addFactor('channel_feed_penalty', 'Missing feed penalty', -6)
          }
          break
        }
        case 'creator':
          if (ictx.creationType === 'agent' || ictx.creatorAgentId) {
            score += 4.5
            addFactor('channel_creator', 'Creator-linked index fit', 4.5)
          } else {
            score -= 5.5
            addFactor('channel_creator_penalty', 'Creator-channel mismatch', -5.5)
          }
          break
        default:
          break
      }

      if (Array.isArray(channel?.topicTags) && channel.topicTags.length > 0) {
        const matches = channel.topicTags.filter((tag) => feedTags.has(tag)).length
        const tagScore = matches > 0 ? matches * 1.5 : -1
        score += tagScore
        addFactor('channel_topic_fit', 'Topic tag fit', tagScore)
      }
    }

    const customRotation = strategyProfile.customRotation || {}
    const rotationDefaults = strategyProfile.rotationDefaults || {}
    const goalMode = customRotation.goalMode || rotationDefaults.goalMode || null
    if (goalMode === 'conservative') {
      const conservativeBoost = Math.max(0, 4 - Math.abs(ictx.oracleChangePct || 0)) * 0.8
      score += conservativeBoost
      addFactor('custom_goal_conservative', 'Conservative goal fit', conservativeBoost)
    }
    if (goalMode === 'aggressive') {
      const aggressiveMove = Math.abs(ictx.oracleChangePct || 0) * 1.2
      const aggressiveTrades = Math.log10(1 + Math.max(0, ictx.totalTrades || 0))
      score += aggressiveMove + aggressiveTrades
      addFactor('custom_goal_aggressive_move', 'Aggressive move fit', aggressiveMove)
      addFactor('custom_goal_aggressive_trades', 'Aggressive activity fit', aggressiveTrades)
    }
    if (goalMode === 'sticky') {
      const stickyBoost = Math.max(0, 3 - Math.abs(ictx.oracleChangePct || 0)) * 0.35
      score += stickyBoost
      addFactor('custom_goal_sticky', 'Sticky goal fit', stickyBoost)
    }

    return { score, breakdown }
  }

  _getRotationCandidatesForAgent(agent, ctx, config) {
    const currentIds = new Set((agent.indexSubscriptions || []).map(sub => sub.indexId))
    const customState = this._getCustomStrategyState(agent)
    const strategyProfile = customState.strategyProfile
    const candidateEntries = Object.values(ctx.indexes || {})
      .filter(ictx => ictx?.indexId && Number.isFinite(ictx.oraclePrice) && ictx.oraclePrice > 0)
      .map((ictx) => {
        const baseScore = this._scoreIndexBaseMarketFitness(ictx)
        const strategyScore = customState.customOwnsExecution
          ? { score: 0, breakdown: [] }
          : this._scoreIndexForStrategy(agent, ictx)
        const customScore = this._scoreIndexForCustomStrategyProfile(ictx, strategyProfile)
        const currentBonus = currentIds.has(ictx.indexId) ? 2.5 : 0
        const breakdown = [
          ...baseScore.breakdown,
          ...strategyScore.breakdown,
          ...customScore.breakdown,
        ]
        if (currentBonus) breakdown.push({ key: 'current_subscription', label: 'Current subscription continuity', value: 2.5 })

        return {
          ictx,
          breakdown,
          score: baseScore.score + strategyScore.score + customScore.score + currentBonus,
        }
      })
      .map((entry) => {
        let score = entry.score
        const breakdown = [...(entry.breakdown || [])]
        const addFactor = (key, label, value) => {
          if (!Number.isFinite(value) || value === 0) return
          breakdown.push({ key, label, value: Math.round(value * 100) / 100 })
        }
        const weights = config?.scoreWeights || {}
        if (Number.isFinite(Number(weights.volume))) {
          const value = Math.log10(1 + Math.max(0, entry.ictx.totalVolume || 0)) * Number(weights.volume)
          score += value
          addFactor('weight_volume', 'Rotation volume weight', value)
        }
        if (Number.isFinite(Number(weights.trades))) {
          const value = Math.log10(1 + Math.max(0, entry.ictx.totalTrades || 0)) * Number(weights.trades)
          score += value
          addFactor('weight_trades', 'Rotation trades weight', value)
        }
        if (Number.isFinite(Number(weights.holders))) {
          const value = Math.log10(1 + Math.max(0, entry.ictx.holderCount || 0)) * Number(weights.holders)
          score += value
          addFactor('weight_holders', 'Rotation holders weight', value)
        }
        if (Number.isFinite(Number(weights.oracleMove))) {
          const value = Math.abs(entry.ictx.oracleChangePct || 0) * Number(weights.oracleMove)
          score += value
          addFactor('weight_oracle_move', 'Rotation move weight', value)
        }
        if (Number.isFinite(Number(weights.bandWidth))) {
          const value = Math.max(0, entry.ictx.bandWidthPct || 0) * Number(weights.bandWidth)
          score += value
          addFactor('weight_band_width', 'Rotation band-width weight', value)
        }

        if (config?.goalMode === 'conservative') {
          const value = Math.max(0, 6 - Math.abs(entry.ictx.oracleChangePct || 0)) * 0.6
          score += value
          addFactor('goal_mode_conservative', 'Conservative rotation preference', value)
        }
        if (config?.goalMode === 'aggressive') {
          const value = Math.abs(entry.ictx.oracleChangePct || 0) * 1.1
          score += value
          addFactor('goal_mode_aggressive', 'Aggressive rotation preference', value)
        }
        if (config?.goalMode === 'sticky' && currentIds.has(entry.ictx.indexId)) {
          score += 3.5
          addFactor('goal_mode_sticky', 'Sticky rotation continuity', 3.5)
        }

        const filters = config?.filters || {}
        if (filters.creationType && entry.ictx.creationType !== filters.creationType) {
          score -= 1000
          addFactor('filter_creation_type', 'Creation-type filter penalty', -1000)
        }
        if (Number.isFinite(Number(filters.minVolume)) && (entry.ictx.totalVolume || 0) < Number(filters.minVolume)) {
          score -= 1000
          addFactor('filter_min_volume', 'Minimum-volume filter penalty', -1000)
        }
        if (Number.isFinite(Number(filters.maxVolatility)) && (entry.ictx.volatility || 0) > Number(filters.maxVolatility)) {
          score -= 1000
          addFactor('filter_max_volatility', 'Max-volatility filter penalty', -1000)
        }

        const sortedBreakdown = breakdown.sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
        return { ...entry, score, breakdown: sortedBreakdown }
      })
      .filter(entry => Number.isFinite(entry.score) && entry.score > -500)
      .sort((left, right) => right.score - left.score)
      .slice(0, config.maxCandidateIndexes)

    return candidateEntries
  }

  _rotateAgentSubscriptions(agent, ctx) {
    if (!this.indexRegistry) return

    const sharedScopeEntry = this._sharedLlmScopeSnapshot?.byAgent?.get(agent.id)
    if (sharedScopeEntry) {
      const scopeConfig = this._getSharedLlmScopeRotationConfig(sharedScopeEntry.scope)
      agent._lastSubscriptionRotationSummary = {
        rotatedIn: 0,
        rotatedOut: 0,
        rotatedInIds: [],
        rotatedOutIds: [],
        skippedReason: 'shared_llm_scope',
        goalMode: scopeConfig.goalMode || 'balanced',
        profileName: scopeConfig.profileName || 'shared_llm_scope',
        activeSubscriptions: (agent.indexSubscriptions || []).filter(sub => sub.status === 'active').length,
        controllerAgentId: sharedScopeEntry.scope?.controllerAgentId || null,
        scopeId: sharedScopeEntry.scope?.id || null,
        templateId: sharedScopeEntry.scope?.templateId || null,
      }
      return
    }

    const config = this.getSubscriptionRotationConfig(agent)
    if (!config.enabled) return
    if (agent._lastSubscriptionRotationTick && (this.tickCount - agent._lastSubscriptionRotationTick) < config.intervalTicks) return

    const activeSubs = (agent.indexSubscriptions || []).filter(sub => sub.status === 'active')
    const candidates = this._getRotationCandidatesForAgent(agent, ctx, config)
    if (candidates.length === 0) return

    const desiredIds = new Set(candidates.slice(0, config.maxActiveSubscriptions).map(entry => entry.ictx.indexId))
    const scoredIds = new Map(candidates.map(entry => [entry.ictx.indexId, entry.score]))
    const scoreBreakdowns = new Map(candidates.map(entry => [entry.ictx.indexId, entry.breakdown || []]))
    const protectedIds = new Set(
      activeSubs
        .filter(sub => this._getIndexHoldingBalance(agent.id, sub.indexId) > 0 || (this.indexRegistry.getAgentPendingOrders(sub.indexId, agent.id) || []).length > 0)
        .map(sub => sub.indexId)
    )

    const removableSubs = activeSubs
      .filter(sub => !desiredIds.has(sub.indexId) && !protectedIds.has(sub.indexId) && this._canRotateOutSubscription(agent, sub, config))
      .sort((left, right) => (scoredIds.get(left.indexId) || 0) - (scoredIds.get(right.indexId) || 0))

    const desiredNewIds = candidates
      .map(entry => entry.ictx.indexId)
      .filter(indexId => desiredIds.has(indexId) && !activeSubs.some(sub => sub.indexId === indexId))

    const churnBudgetPerDay = Number.isFinite(config?.churnBudgetPerDay) ? config.churnBudgetPerDay : null
    const recentRotationEvents = churnBudgetPerDay != null && this._strategyRuntime?.getAgentRotationEvents
      ? (this._strategyRuntime.getAgentRotationEvents(agent.id, Math.max(50, churnBudgetPerDay * 3)) || []).filter((event) => (event?.createdAt || 0) >= (Date.now() - CUSTOM_STRATEGY_DAY_MS)).length
      : 0
    const availableChurn = churnBudgetPerDay == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, churnBudgetPerDay - recentRotationEvents)

    if (availableChurn <= 0) {
      agent._lastSubscriptionRotationTick = this.tickCount
      agent._lastSubscriptionRotationAt = Date.now()
      agent._lastSubscriptionRotationSummary = {
        rotatedIn: 0,
        rotatedOut: 0,
        rotatedInIds: [],
        rotatedOutIds: [],
        policyId: config.policyId || null,
        goalMode: config.goalMode || 'balanced',
        activeSubscriptions: activeSubs.length,
        skippedReason: 'churn_budget_reached',
      }
      return
    }

    const freeSlots = Math.max(0, config.maxActiveSubscriptions - (activeSubs.length - removableSubs.length))
    const targetNewIds = desiredNewIds.slice(0, Math.min(freeSlots, availableChurn))
    const removableNow = removableSubs.slice(0, Math.min(targetNewIds.length || removableSubs.length, availableChurn))

    const rotatedOut = []

    for (const sub of removableNow) {
      rotatedOut.push(sub.indexId)
      this.unsubscribeAgentFromIndex(agent.id, sub.indexId)
    }

    let rotatedIn = 0
    const rotatedInIds = []
    for (const indexId of targetNewIds) {
      const result = this.subscribeAgentToIndex(agent.id, indexId, config.allocationPct, {
        source: 'rotation',
        rotatedAt: Date.now(),
      })
      if (result?.ok) {
        rotatedIn++
        rotatedInIds.push(indexId)
      }
    }

    const topCandidates = candidates.slice(0, Math.min(3, candidates.length)).map((entry) => ({
      indexId: entry.ictx.indexId,
      symbol: entry.ictx.symbol || entry.ictx.indexSymbol || null,
      score: Number.isFinite(entry.score) ? Math.round(entry.score * 100) / 100 : null,
      factors: (entry.breakdown || []).slice(0, 5),
    }))

    const pairCount = Math.max(rotatedOut.length, rotatedInIds.length)
    for (let i = 0; i < pairCount; i++) {
      const beforeScore = rotatedOut[i] ? (scoredIds.get(rotatedOut[i]) || null) : null
      const afterScore = rotatedInIds[i] ? (scoredIds.get(rotatedInIds[i]) || null) : null
      this._recordRotationEvent(agent, config, {
        rotatedOutIndexId: rotatedOut[i] || null,
        rotatedInIndexId: rotatedInIds[i] || null,
        beforeScore,
        afterScore,
        reasonCode: rotatedOut[i] && rotatedInIds[i] ? 'rebalance' : rotatedInIds[i] ? 'expand' : 'prune',
        activeSubscriptions: (agent.indexSubscriptions || []).filter(sub => sub.status === 'active').length,
        scoreDelta: Number.isFinite(afterScore) && Number.isFinite(beforeScore)
          ? Math.round((afterScore - beforeScore) * 100) / 100
          : null,
        topCandidates,
        rotatedInBreakdown: rotatedInIds[i] ? (scoreBreakdowns.get(rotatedInIds[i]) || []).slice(0, 8) : [],
        rotatedOutBreakdown: rotatedOut[i] ? (scoreBreakdowns.get(rotatedOut[i]) || []).slice(0, 8) : [],
      })
    }

    agent._lastSubscriptionRotationTick = this.tickCount
    agent._lastSubscriptionRotationAt = Date.now()
    agent._lastSubscriptionRotationSummary = {
      rotatedIn,
      rotatedOut: removableNow.length,
      rotatedInIds,
      rotatedOutIds: rotatedOut,
      policyId: config.policyId || null,
      goalMode: config.goalMode || 'balanced',
      activeSubscriptions: (agent.indexSubscriptions || []).filter(sub => sub.status === 'active').length,
    }
  }

  startAgent(id) {
    const agent = this.agents.get(id)
    if (agent) { agent.status = 'active'; agent.pauseReason = null; return agent }
    return null
  }

  pauseAgent(id) {
    const agent = this.agents.get(id)
    if (agent) {
      agent.status = 'paused'
      if (this.indexRegistry) {
        for (const [indexId] of this.indexRegistry.indexes) {
          try { this.indexRegistry.cancelOrdersForAgent(indexId, id) } catch {}
        }
      }
      return agent
    }
    return null
  }

  stopAgent(id) {
    const agent = this.agents.get(id)
    if (agent) {
      agent.status = 'stopped'
      if (this.indexRegistry) {
        for (const [indexId] of this.indexRegistry.indexes) {
          try { this.indexRegistry.cancelOrdersForAgent(indexId, id) } catch {}
        }
      }
      return agent
    }
    return null
  }

  getAgent(id) { return this.agents.get(id) || null }

  /** Restore an agent with full state (position, P&L, trades, etc.) from DB */
  restoreAgent(saved) {
    const strategyDef = STRATEGIES[saved.strategy]
    if (!strategyDef) throw new Error(`Unknown strategy: ${saved.strategy}`)

    const agent = {
      id: saved.id,
      name: saved.name,
      strategy: saved.strategy,
      strategyName: saved.strategyName || strategyDef.name,
      icon: saved.icon || strategyDef.icon,
      bio: saved.bio || '',
      isUserAgent: saved.isUserAgent || false,
      walletAddress: saved.walletAddress || null,
      riskLevel: saved.riskLevel || 'medium',
      status: saved.status || 'active',
      // ── Restored runtime state ──
      virtualBalance: saved.virtualBalance ?? 1000,
      initialBalance: saved.initialBalance ?? 1000,
      position: saved.position ?? 0,
      positionValue: saved.positionValue ?? 0,
      avgEntryPrice: saved.avgEntryPrice ?? 0,
      pnl: saved.pnl ?? 0,
      realizedPnl: saved.realizedPnl ?? 0,
      unrealizedPnl: saved.unrealizedPnl ?? 0,
      feeIncome: saved.feeIncome ?? 0,
      dividendIncome: saved.dividendIncome ?? 0,
      royaltyIncome: saved.royaltyIncome ?? 0,
      totalTrades: saved.totalTrades ?? 0,
      winningTrades: saved.winningTrades ?? 0,
      losingTrades: saved.losingTrades ?? 0,
      totalVolume: saved.totalVolume ?? 0,
      maxDrawdown: saved.maxDrawdown ?? 0,
      peakEquity: saved.peakEquity ?? (saved.initialBalance ?? 1000),
      config: saved.config || {},
      indexSubscriptions: saved.indexSubscriptions || [],
      openOrders: [],  // open orders are transient — can't restore order book state
      // ── Arrays restored from DB separately ──
      decisions: saved.decisions || [],
      trades: saved.trades || [],
      equityCurve: saved.equityCurve || [{ time: Date.now(), equity: saved.virtualBalance ?? 1000 }],
      createdAt: saved.createdAt || Date.now(),
      lastTickAt: saved.lastTickAt || null,
      lastDecisionAt: saved.lastDecisionAt || Date.now() - Math.random() * (saved.config?.cooldownMs || 5000),
      tickCount: saved.tickCount || 0,
    }

    this.agents.set(agent.id, agent)
    return agent
  }

  getAllAgents() {
    return Array.from(this.agents.values())
      .filter(a => a.id !== '__seed__')
      .map(a => this._sanitizeAgent(a))
  }

  /** Raw agent objects (for internal use like auto-subscribe on startup) */
  getAllAgentsRaw() {
    return Array.from(this.agents.values()).filter(a => a.id !== '__seed__')
  }

  // ─── Market context (index-only) ─────────────────────────────────────

  _buildContext() {
    // Gather all index contexts — this is the ONLY market data source now
    const allIndexContexts = this.indexRegistry
      ? this.indexRegistry.getAllIndexContexts()
      : {}

    return {
      tickCount: this.tickCount,
      // ── Index data feed — the sole market data ──
      indexes: allIndexContexts,       // backward-compat key
      allIndexContexts,                // key that contextAssembler expects
    }
  }

  // ─── Main tick loop ────────────────────────────────────────────────

  _tick() {
    if (!this.running) return
    this.tickCount++

    const ctx = this._buildContext()
    this._sharedLlmScopeSnapshot = this._buildSharedLlmScopeSnapshot()

    if (this.indexRegistry && this.tickCount % 5 === 0) {
      this._reconcileSharedLlmScopePlans(ctx)

      for (const [id, agent] of this.agents) {
        if (agent.status !== 'active' || id === '__seed__') continue
        try {
          this._rotateAgentSubscriptions(agent, ctx)
        } catch (err) {
          console.error(`[Rotation] ${agent.name}:`, err.message)
        }
      }

      this._syncSharedLlmScopeSubscriptions()
    }

    // ── Index trading pass (every 5 ticks ≈ 15s) ──
    // This is the ONLY trading path now — all agents trade on indexes
    if (this.indexRegistry && this.tickCount % 5 === 0) {
      this._tickIndexTrading(ctx)
    }

    // Periodic equity snapshot (every 20 ticks ≈ 1 min)
    if (this.tickCount % 20 === 0) {
      this._snapshotEquity()
    }

    // Autosave user agent state to DB (every 10 ticks ≈ 30s)
    if (this.tickCount % 10 === 0) {
      this._autosaveUserAgents()
    }
  }

  // ─── Decision logging ──────────────────────────────────────────────

  _logDecision(agent, signal) {
    const entry = {
      id: randomUUID(),
      agentId: agent.id,
      agentName: agent.name,
      strategy: agent.strategy,
      action: signal.action,
      orderType: signal.orderType || 'limit',
      price: signal.price,
      size: signal.size,
      reasoning: signal.reasoning,
      thinking: signal.thinking || null,
      confidence: signal.confidence || 0,
      equity: this._getAgentEquity(agent),
      position: agent.position,
      timestamp: Date.now(),
    }

    agent.decisions.unshift(entry)
    if (agent.decisions.length > MAX_DECISION_LOG) agent.decisions = agent.decisions.slice(0, MAX_DECISION_LOG)

    this.decisionLog.push(entry)

    // Persist decision to DB for user agents
    if (agent.isUserAgent && this._persist?.saveDecision) {
      try { this._persist.saveDecision(entry) } catch {}
    }
  }

  _createHoldSignal(reasoning, confidence = 0.3, extra = {}) {
    return {
      action: 'hold',
      reasoning,
      confidence,
      ...extra,
    }
  }

  _getRecentTrades(agent, windowMs = CUSTOM_STRATEGY_DAY_MS) {
    const cutoff = Date.now() - windowMs
    return (agent?.trades || []).filter((trade) => (trade?.timestamp || 0) >= cutoff)
  }

  _applyCustomStrategyRiskGuards(agent, sub, signals, ictx, allocatedBal, subAgent, customExecution) {
    if (!Array.isArray(signals) || signals.length === 0) return signals

    const risk = customExecution?.instance?.customRisk || {}
    const maxPositionAgeMs = Number(risk.maxPositionAgeMs ?? risk.stalePositionMs)
    const maxPositionAgeTicks = Number(risk.maxPositionAgeTicks ?? risk.stalePositionTicks)
    const positionAgeMs = Number(subAgent?.positionAgeMs)
    const positionAgeTicks = Number(subAgent?.positionAgeTicks)

    if ((subAgent?.position || 0) > 0) {
      const staleByMs = Number.isFinite(maxPositionAgeMs) && maxPositionAgeMs > 0 && Number.isFinite(positionAgeMs) && positionAgeMs >= maxPositionAgeMs
      const staleByTicks = Number.isFinite(maxPositionAgeTicks) && maxPositionAgeTicks > 0 && Number.isFinite(positionAgeTicks) && positionAgeTicks >= maxPositionAgeTicks
      if (staleByMs || staleByTicks) {
        const ageParts = []
        if (Number.isFinite(positionAgeTicks)) ageParts.push(`${Math.round(positionAgeTicks)} ticks`)
        if (Number.isFinite(positionAgeMs)) ageParts.push(`~${Math.round(positionAgeMs / 1000)}s`)
        return [{
          action: 'sell',
          orderType: 'market',
          price: ictx?.oraclePrice || ictx?.mid || 0,
          size: subAgent.position,
          reasoning: `Custom risk stale-position exit after ${ageParts.join(' / ') || 'extended hold'}, closing the position.`,
          confidence: 0.96,
          meta: {
            source: 'custom_strategy_risk',
            reasonCode: staleByMs ? 'max_position_age_ms' : 'max_position_age_ticks',
            strategyInstanceId: customExecution?.instance?.id || null,
          },
        }]
      }
    }

    const stopLossPct = Number(risk.stopLossPct)
    if (
      Number.isFinite(stopLossPct)
      && stopLossPct > 0
      && (subAgent?.position || 0) > 0
      && Number.isFinite(subAgent?.unrealizedPnlPct)
      && subAgent.unrealizedPnlPct <= -Math.abs(stopLossPct)
    ) {
      return [{
        action: 'sell',
        orderType: 'market',
        price: ictx?.oraclePrice || ictx?.mid || 0,
        size: subAgent.position,
        reasoning: `Custom risk stop-loss hit at ${subAgent.unrealizedPnlPct.toFixed(2)}% (limit ${Math.abs(stopLossPct).toFixed(2)}%), exiting position.`,
        confidence: 0.98,
        meta: {
          source: 'custom_strategy_risk',
          reasonCode: 'stop_loss_pct',
          strategyInstanceId: customExecution?.instance?.id || null,
        },
      }]
    }

    const maxDailyTrades = Number(risk.maxDailyTrades)
    if (Number.isFinite(maxDailyTrades) && maxDailyTrades > 0) {
      const recentTradeCount = this._getRecentTrades(agent).length
      if (recentTradeCount >= maxDailyTrades) {
        return [this._createHoldSignal(
          `Custom risk daily trade limit reached (${recentTradeCount}/${Math.round(maxDailyTrades)} in the last 24h).`,
          0.2,
          {
            meta: {
              source: 'custom_strategy_risk',
              reasonCode: 'max_daily_trades',
              strategyInstanceId: customExecution?.instance?.id || null,
            },
          }
        )]
      }
    }

    const cooldownMs = Number(risk.cooldownMs)
    const cooldownTicks = Number(risk.cooldownTicks)
    const lastTradeAt = agent?.trades?.[0]?.timestamp || 0
    const lastDecisionAt = agent?.lastDecisionAt || 0
    const msFromTicks = Number.isFinite(cooldownTicks) && cooldownTicks > 0
      ? cooldownTicks * TICK_INTERVAL
      : 0
    const effectiveCooldownMs = Math.max(
      Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 0,
      msFromTicks
    )

    if (effectiveCooldownMs > 0) {
      const elapsedMs = Date.now() - Math.max(lastTradeAt, lastDecisionAt)
      if (elapsedMs < effectiveCooldownMs) {
        const waitSeconds = Math.max(1, Math.ceil((effectiveCooldownMs - elapsedMs) / 1000))
        return [this._createHoldSignal(
          `Custom risk cooldown active, next execution window in ~${waitSeconds}s.`,
          0.2,
          {
            meta: {
              source: 'custom_strategy_risk',
              reasonCode: 'cooldown',
              strategyInstanceId: customExecution?.instance?.id || null,
            },
          }
        )]
      }
    }

    const maxPositionPct = Number(risk.maxPositionPct)
    return signals.map((signal) => {
      if (!signal || signal.action !== 'buy') return signal
      if (!Number.isFinite(maxPositionPct) || maxPositionPct <= 0) return signal

      const price = Number(signal.price || ictx?.oraclePrice || ictx?.mid || 0)
      if (!Number.isFinite(price) || price <= 0) return signal

      const maxPositionValue = allocatedBal * (maxPositionPct / 100)
      const currentPositionValue = (subAgent?.position || 0) * price
      const availablePositionValue = Math.max(0, maxPositionValue - currentPositionValue)
      if (availablePositionValue <= 0) {
        return this._createHoldSignal(
          `Custom risk max position reached (${maxPositionPct}% of allocated balance).`,
          0.25,
          {
            meta: {
              source: 'custom_strategy_risk',
              reasonCode: 'max_position_pct',
              strategyInstanceId: customExecution?.instance?.id || null,
            },
          }
        )
      }

      const maxSize = availablePositionValue / price
      if (signal.size <= maxSize) return signal

      if (maxSize <= 0) {
        return this._createHoldSignal(
          `Custom risk max position reached (${maxPositionPct}% of allocated balance).`,
          0.25,
          {
            meta: {
              source: 'custom_strategy_risk',
              reasonCode: 'max_position_pct',
              strategyInstanceId: customExecution?.instance?.id || null,
            },
          }
        )
      }

      return {
        ...signal,
        size: maxSize,
        reasoning: `${signal.reasoning} Size clipped by max position ${maxPositionPct}% risk guard.`,
        meta: {
          ...(signal.meta || {}),
          source: signal.meta?.source || 'custom_strategy',
          riskAdjusted: true,
          reasonCode: 'max_position_pct',
          strategyInstanceId: customExecution?.instance?.id || null,
        },
      }
    })
  }

  // ─── Equity snapshots ─────────────────────────────────────────────

  _snapshotEquity() {
    const now = Date.now()
    for (const [id, agent] of this.agents) {
      const equity = this._getAgentEquity(agent)
      agent.equityCurve.push({ time: now, equity })
      if (agent.equityCurve.length > 500) agent.equityCurve.shift()

      // Track peak equity and max drawdown
      if (equity > (agent.peakEquity || agent.initialBalance)) {
        agent.peakEquity = equity
      }
      if (agent.peakEquity > 0) {
        const drawdown = ((agent.peakEquity - equity) / agent.peakEquity) * 100
        if (drawdown > (agent.maxDrawdown || 0)) {
          agent.maxDrawdown = drawdown
        }
      }

      // Persist equity point for user agents
      if (agent.isUserAgent && this._persist?.saveEquity) {
        try { this._persist.saveEquity(id, equity, now) } catch {}
      }
    }

    // Global snapshot
    const totalEquity = this._getTotalEquity()
    this.equitySnapshots.push({ time: now, equity: totalEquity })
    if (this.equitySnapshots.length > 1000) this.equitySnapshots.shift()
  }

  // ─── Autosave user agents to SQLite ────────────────────────────────

  _autosaveUserAgents() {
    if (!this._persist?.saveAgentsBatch) return
    const userAgents = []
    for (const [id, agent] of this.agents) {
      if (agent.isUserAgent) userAgents.push(agent)
    }
    if (userAgents.length === 0) return
    try {
      this._persist.saveAgentsBatch(userAgents)
    } catch (err) {
      console.error('Autosave error:', err.message)
    }
  }

  // ─── Index trading: agents trade subscribed indexes ────────────────

  _tickIndexTrading(ctx) {
    if (!this.indexRegistry) return
    const cfg = this.getSafetyConfig()

    for (const [id, agent] of this.agents) {
      if (agent.status !== 'active' || id === '__seed__') continue
      if (cfg.enabled && this._isAgentCorrupted(agent)) {
        this._quarantineAgent(agent, `Runtime balance/equity exceeded safety bounds (${agent.virtualBalance})`)
        continue
      }
      if (!agent.indexSubscriptions || agent.indexSubscriptions.length === 0) continue

      for (const sub of agent.indexSubscriptions) {
        if (sub.status !== 'active') continue

        const ictx = ctx.indexes[sub.indexId]
        if (!ictx) continue

        try {
          this._tickAgentOnIndex(agent, sub, ictx)
        } catch (err) {
          // Silently ignore individual index trading errors
        }
      }
    }
  }

  /**
   * Run an agent's strategy on an index, translating signals to index orders.
   * Builds a full context identical to what the LLM contextAssembler expects.
   */
  _tickAgentOnIndex(agent, sub, ictx) {
    const customState = this._getCustomStrategyState(agent)
    const strategyDef = customState.llmOwnsExecution
      ? (STRATEGIES.llm_trader || null)
      : (STRATEGIES[agent.strategy] || null)
    const cfg = this.getSafetyConfig()
    if (!Number.isFinite(ictx?.oraclePrice) || ictx.oraclePrice <= 0 || (cfg.enabled && ictx.oraclePrice > cfg.maxIndexPrice)) return

    // ── Per-index cooldown check — prevent spamming (especially for LLM agents) ──
    const cooldown = agent.config.cooldownMs || 5000
    if (!agent._indexLastDecision) agent._indexLastDecision = {}
    const lastForIndex = agent._indexLastDecision[sub.indexId] || 0
    if (lastForIndex && Date.now() - lastForIndex < cooldown) return

    agent.lastTickAt = Date.now()
    agent.tickCount++

    // ── Get agent's pending (resting) orders on this index ──
    const pendingOrders = this.indexRegistry.getAgentPendingOrders(sub.indexId, agent.id)

    // ── Get order book snapshot for this index ──
    const indexState = this.indexRegistry.indexes.get(sub.indexId)
    const orderBookSnapshot = indexState?.orderBook
      ? indexState.orderBook.getSnapshot(10)
      : { bids: [], asks: [], mid: ictx.oraclePrice, spreadPercent: 0 }

    // ── Get recent trades for this index ──
    const recentTrades = indexState?.orderBook
      ? indexState.orderBook.getRecentTrades(20)
      : []

    // ── Get stats from this index's order book ──
    const stats = indexState?.orderBook?.stats
      ? { ...indexState.orderBook.stats }
      : {}

    // ── Gather all index contexts (for cross-index analysis by LLM) ──
    const allIndexContexts = this.indexRegistry
      ? this.indexRegistry.getAllIndexContexts()
      : {}

    // Build context compatible with both simple strategies AND the LLM pipeline
    // The LLM contextAssembler expects: mid, bestBid, orderBookSnapshot, allIndexContexts, etc.
    const indexCtx = {
      // ── Core market data (from this index) ──
      mid: ictx.orderBook.mid || ictx.oraclePrice,
      bestBid: ictx.orderBook.bestBid,
      bestAsk: ictx.orderBook.bestAsk,
      spread: ictx.orderBook.spread,
      currentPrice: ictx.oraclePrice,
      priceHistory: ictx.priceHistory,
      volumeHistory: ictx.volumeHistory || [],
      volatility: 0,
      tickCount: this.tickCount,
      // ── Band info for strategies to make smart decisions ──
      bandLow: ictx.bandLow,
      bandHigh: ictx.bandHigh,
      bandWidthPct: ictx.bandWidthPct,
      // ── Agent's resting orders so strategies can cancel stale ones ──
      pendingOrders,
      // ── Order book depth (needed by LLM contextAssembler.assembleOrderBook) ──
      orderBookSnapshot,
      // ── Recent fills (needed by LLM contextAssembler) ──
      recentTrades,
      // ── 24h stats (needed by LLM contextAssembler) ──
      stats,
      // ── All index data (needed by LLM contextAssembler.assembleIndexes) ──
      indexes: allIndexContexts,
      allIndexContexts,
      // ── Index identity (so LLM knows which instrument it's trading) ──
      indexId: sub.indexId,
      indexSymbol: ictx.symbol,
      oracleChangePct: ictx.oracleChangePct || 0,
      holderCount: ictx.holderCount || 0,
      totalVolume: ictx.totalVolume || 0,
      totalTrades: ictx.totalTrades || 0,
      feed: ictx.feed || [],
    }

    // Compute volatility from index price history
    if (ictx.priceHistory.length > 5) {
      const returns = []
      for (let i = 1; i < ictx.priceHistory.length; i++) {
        returns.push((ictx.priceHistory[i] - ictx.priceHistory[i - 1]) / ictx.priceHistory[i - 1])
      }
      indexCtx.volatility = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length)
    }

    // Allocation: agent uses sub.allocationPct of their balance for this index
    const allocatedBal = cfg.enabled
      ? Math.max(0, Math.min(agent.virtualBalance * (sub.allocationPct / 100), cfg.maxAgentBalance))
      : Math.max(0, agent.virtualBalance * (sub.allocationPct / 100))

    // Create a virtual "sub-agent" view for the strategy
    const subAgent = {
      ...agent,
      virtualBalance: allocatedBal,
      position: 0,  // position in this index (from holder state)
      realizedPnl: Number(agent.realizedPnl || 0),
      equity: 0,
      pnl: 0,
      pnlPercent: 0,
      peakEquity: Number(agent.peakEquity || agent.initialBalance || 0),
      maxDrawdown: Number(agent.maxDrawdown || 0),
      positionAgeMs: 0,
      positionAgeTicks: 0,
      positionOpenedAt: null,
    }

    const agentEquity = this._getAgentEquity(agent)
    const totalPnl = agentEquity - Number(agent.initialBalance || 0)
    subAgent.equity = agentEquity
    subAgent.pnl = totalPnl
    subAgent.pnlPercent = agent.initialBalance > 0
      ? (totalPnl / agent.initialBalance) * 100
      : 0

    // Get actual holding from index registry (position + P&L context for strategies)
    const state = this.indexRegistry.indexes.get(sub.indexId)
    if (state) {
      const holding = state.holders.get(agent.id)
      if (holding) {
        subAgent.position = holding.balance
        subAgent.avgEntryPrice = holding.avgEntryPrice || 0
        subAgent.unrealizedPnl = holding.avgEntryPrice > 0
          ? (ictx.oraclePrice - holding.avgEntryPrice) * holding.balance
          : 0
        subAgent.unrealizedPnlPct = holding.avgEntryPrice > 0
          ? ((ictx.oraclePrice / holding.avgEntryPrice) - 1) * 100
          : 0
        subAgent.positionOpenedAt = holding.openedAt || null
        subAgent.positionAgeMs = holding.openedAt ? Math.max(0, Date.now() - holding.openedAt) : 0
        subAgent.positionAgeTicks = Number.isFinite(holding.openedTick)
          ? Math.max(0, this.tickCount - Number(holding.openedTick))
          : 0
      }
    }

    if (customState.llmOwnsExecution) {
      const creatorConfig = customState.creatorAgent?.config || {}
      const strategyParams = customState.instance?.customParams || {}
      const strategyRisk = customState.instance?.customRisk || {}
      subAgent.config = {
        ...(subAgent.config || {}),
        llmTemplateName: customState.template?.name || null,
        llmTemplateGuidance: {
          entryThreshold: Number.isFinite(Number(strategyParams.entryThreshold)) ? Number(strategyParams.entryThreshold) : null,
          exitThreshold: Number.isFinite(Number(strategyParams.exitThreshold)) ? Number(strategyParams.exitThreshold) : null,
          maxSpreadPct: Number.isFinite(Number(strategyParams.maxSpreadPct)) ? Number(strategyParams.maxSpreadPct) : null,
          buySizePct: Number.isFinite(Number(strategyParams.buySizePct)) ? Number(strategyParams.buySizePct) : null,
          sellSizePct: Number.isFinite(Number(strategyParams.sellSizePct)) ? Number(strategyParams.sellSizePct) : null,
          confidence: Number.isFinite(Number(strategyParams.confidence)) ? Number(strategyParams.confidence) : null,
          minVolume: Number.isFinite(Number(strategyParams.minVolume)) ? Number(strategyParams.minVolume) : null,
          highSeverityCount: Number.isFinite(Number(strategyParams.highSeverityCount)) ? Number(strategyParams.highSeverityCount) : null,
        },
        llmTemplateRiskDefaults: {
          maxPositionPct: Number.isFinite(Number(strategyRisk.maxPositionPct)) ? Number(strategyRisk.maxPositionPct) : null,
          stopLossPct: Number.isFinite(Number(strategyRisk.stopLossPct)) ? Number(strategyRisk.stopLossPct) : null,
          maxDailyTrades: Number.isFinite(Number(strategyRisk.maxDailyTrades)) ? Number(strategyRisk.maxDailyTrades) : null,
          maxPositionAgeMs: Number.isFinite(Number(strategyRisk.maxPositionAgeMs)) ? Number(strategyRisk.maxPositionAgeMs) : null,
        },
        ...(customState.llmSharedExecution ? {
          llmSharedExecution: true,
          llmSharedExecutionMode: customState.llmSharedExecutionMode || 'strategy_scope',
          llmSharedScopeId: customState.llmSharedScopeId || null,
          llmSharedScopeKey: customState.llmSharedScopeKey || null,
          llmSharedMemoryKey: customState.llmSharedMemoryKey || null,
          llmSharedStateKey: customState.llmSharedStateKey || customState.llmSharedMemoryKey || null,
          llmSharedCreatorAgentId: customState.creatorAgent?.id || customState.creatorAgentId || null,
          llmSharedCreatorAgentName: customState.creatorAgent?.name || null,
          llmSharedTemplateId: customState.templateId || null,
          llmSharedTemplateName: customState.template?.name || null,
          llmSharedOwnerWallet: customState.creatorWalletAddress || null,
        } : {}),
      }
      if (creatorConfig.llmProvider) subAgent.config.llmProvider = creatorConfig.llmProvider
      if (creatorConfig.llmModel) subAgent.config.llmModel = creatorConfig.llmModel
      if (creatorConfig.llmApiKey) subAgent.config.llmApiKey = creatorConfig.llmApiKey
      subAgent._llmExecutionOwnerAgentId = customState.creatorAgent?.id || customState.creatorAgentId || null
      subAgent._llmExecutionOwnerAgentName = customState.creatorAgent?.name || null
    }

    const customExecution = customState.llmOwnsExecution
      ? null
      : this.customStrategyRuntime?.evaluate(subAgent, indexCtx, {
          allocatedBalance: allocatedBal,
          subscription: sub,
        })

    if (!customExecution && customState.customOwnsExecution) {
      agent.lastIdleReason = 'Direct custom strategy is configured, but no active custom runtime instance is available.'
      agent.lastIdleAt = Date.now()
      agent.lastIdleIndexId = sub.indexId
      agent.lastIdleIndexSymbol = ictx.symbol
      agent.lastIdleMeta = {
        source: 'custom_strategy_runtime',
        reasonCode: 'missing_active_instance',
        strategyInstanceId: customState.instanceId,
      }
      agent._indexLastDecision[sub.indexId] = Date.now()
      agent.lastDecisionAt = Date.now()
      return
    }

    if (customExecution?.signals?.length > 0) {
      const guardedCustomSignals = this._applyCustomStrategyRiskGuards(
        agent,
        sub,
        customExecution.signals,
        ictx,
        allocatedBal,
        subAgent,
        customExecution
      )

      this._processIndexSignals(agent, sub, guardedCustomSignals, ictx, allocatedBal, subAgent, pendingOrders)
      agent._indexLastDecision[sub.indexId] = Date.now()
      agent.lastDecisionAt = Date.now()
      agent._activeStrategyInstanceId = customExecution.instance?.id || null
      agent._activeStrategyTemplateId = customExecution.instance?.strategyTemplateId || null
      agent._activeStrategyMode = 'direct'
      agent._activeStrategyMatchedRules = customExecution.matchedRules || []
      return
    }

    if (!strategyDef) return

    // Run strategy (support async strategies like llm_trader)
    if (strategyDef.isAsync) {
      // Set per-index cooldown BEFORE async call to prevent concurrent LLM calls
      agent._indexLastDecision[sub.indexId] = Date.now()
      strategyDef.fn(subAgent, indexCtx).then(sigs => {
        const guardedSignals = customState.llmOwnsExecution && customState.instance
          ? this._applyCustomStrategyRiskGuards(
              agent,
              sub,
              sigs,
              ictx,
              allocatedBal,
              subAgent,
              { instance: customState.instance }
            )
          : sigs
        this._processIndexSignals(agent, sub, guardedSignals, ictx, allocatedBal, subAgent, pendingOrders)
        agent._indexLastDecision[sub.indexId] = Date.now()  // update after completion
        agent.lastDecisionAt = Date.now()
        if (customState.llmOwnsExecution) {
          agent._activeStrategyInstanceId = customState.instanceId || null
          agent._activeStrategyTemplateId = customState.templateId || null
          agent._activeStrategyMode = 'direct'
          agent._activeStrategyMatchedRules = []
        }
        // Copy LLM annotations from subAgent back to the real agent (llmStrategy sets these on the agent it receives)
        if (subAgent._llmLastThinking !== undefined)  agent._llmLastThinking  = subAgent._llmLastThinking
        if (subAgent._llmLastReasoning !== undefined) agent._llmLastReasoning = subAgent._llmLastReasoning
        if (subAgent._llmLastConfidence !== undefined) agent._llmLastConfidence = subAgent._llmLastConfidence
        if (subAgent._llmLastAction !== undefined)    agent._llmLastAction    = subAgent._llmLastAction
        if (subAgent._llmLatencyMs !== undefined)     agent._llmLatencyMs     = subAgent._llmLatencyMs
        if (subAgent._llmProvider !== undefined)      agent._llmProvider      = subAgent._llmProvider
        if (subAgent._llmModel !== undefined)         agent._llmModel         = subAgent._llmModel
        if (subAgent._llmExecutionOwnerAgentId !== undefined) agent._llmExecutionOwnerAgentId = subAgent._llmExecutionOwnerAgentId
        if (subAgent._llmExecutionOwnerAgentName !== undefined) agent._llmExecutionOwnerAgentName = subAgent._llmExecutionOwnerAgentName
      }).catch(err => {
        console.error(`[Async/Index] ${agent.name} strategy error on ${sub.indexId}:`, err.message)
      })
      return
    }
    const signals = strategyDef.fn(subAgent, indexCtx)
    const guardedSignals = customState.llmOwnsExecution && customState.instance
      ? this._applyCustomStrategyRiskGuards(
          agent,
          sub,
          signals,
          ictx,
          allocatedBal,
          subAgent,
          { instance: customState.instance }
        )
      : signals

    this._processIndexSignals(agent, sub, guardedSignals, ictx, allocatedBal, subAgent, pendingOrders)
    agent._indexLastDecision[sub.indexId] = Date.now()
    agent.lastDecisionAt = Date.now()
    if (customState.llmOwnsExecution) {
      agent._activeStrategyInstanceId = customState.instanceId || null
      agent._activeStrategyTemplateId = customState.templateId || null
      agent._activeStrategyMode = 'direct'
      agent._activeStrategyMatchedRules = []
    }
  }

  _processIndexSignals(agent, sub, signals, ictx, allocatedBal, subAgent, pendingOrders) {
    for (const signal of signals) {
      // ── Handle cancel signals ──
      if (signal.action === 'cancel_all') {
        const cancelled = this.indexRegistry.cancelOrdersForAgent(sub.indexId, agent.id)
        if (cancelled > 0) {
          agent.decisions.unshift({
            id: randomUUID(), agentId: agent.id, agentName: agent.name,
            strategy: agent.strategy, action: 'cancel_all',
            reasoning: signal.reasoning || `Cancelled ${cancelled} orders on ${ictx.symbol}`,
            confidence: 1, timestamp: Date.now(),
          })
          if (agent.decisions.length > MAX_DECISION_LOG) agent.decisions = agent.decisions.slice(0, MAX_DECISION_LOG)
        }
        continue
      }

      if (signal.action === 'cancel_stale') {
        // Cancel only orders whose price is outside the trading band
        if (pendingOrders.length > 0 && ictx.bandLow && ictx.bandHigh) {
          const staleIds = pendingOrders
            .filter(o => o.price < ictx.bandLow || o.price > ictx.bandHigh)
            .map(o => o.id)
          if (staleIds.length > 0) {
            this.indexRegistry.cancelOrders(sub.indexId, staleIds)
            agent.decisions.unshift({
              id: randomUUID(), agentId: agent.id, agentName: agent.name,
              strategy: agent.strategy, action: 'cancel_stale',
              reasoning: signal.reasoning || `Cancelled ${staleIds.length} out-of-band orders on ${ictx.symbol}`,
              confidence: 1, timestamp: Date.now(),
            })
            if (agent.decisions.length > MAX_DECISION_LOG) agent.decisions = agent.decisions.slice(0, MAX_DECISION_LOG)
          }
        }
        continue
      }

      if (signal.action === 'hold') {
        agent.lastIdleReason = signal.reasoning || 'Waiting for the next valid signal'
        agent.lastIdleAt = Date.now()
        agent.lastIdleIndexId = sub.indexId
        agent.lastIdleIndexSymbol = ictx.symbol
        agent.lastIdleMeta = signal.meta ? { ...signal.meta } : null
        continue
      }

      agent.lastIdleReason = null
      agent.lastIdleAt = null
      agent.lastIdleIndexId = null
      agent.lastIdleIndexSymbol = null
      agent.lastIdleMeta = null

      // Clamp size
      let size = signal.size || 0
      if (size <= 0) continue

      if (signal.action === 'sell') {
        // Subtract pending resting sell orders to prevent overselling
        const pendingSellSize = pendingOrders
          .filter(o => o.side === 'sell')
          .reduce((s, o) => s + o.remaining, 0)
        const availablePosition = subAgent.position - pendingSellSize
        size = Math.min(size, availablePosition)
        if (size <= 0) continue
      }

      if (signal.action === 'buy') {
        // Subtract pending resting buy orders to prevent overbooking
        const pendingBuyCash = pendingOrders
          .filter(o => o.side === 'buy')
          .reduce((s, o) => s + o.remaining * o.price, 0)
        const availableCash = allocatedBal - pendingBuyCash
        const maxBuy = availableCash / (signal.price || ictx.oraclePrice)
        size = Math.min(size, maxBuy)
        if (size <= 0) continue
      }

      // ── Final safety: clamp price to band boundaries ──
      let price = signal.price || ictx.oraclePrice
      if (ictx.bandLow && ictx.bandHigh) {
        price = Math.max(ictx.bandLow, Math.min(ictx.bandHigh, price))
      }
      if (!Number.isFinite(price) || price <= 0 || (this.safetyConfig.enabled && price > this.safetyConfig.maxIndexPrice)) continue

      // ── Capture avg entry price BEFORE order (resets to 0 if position fully sold) ──
      let preAvgEntry = 0
      if (signal.action === 'sell') {
        const holder = this.indexRegistry.indexes.get(sub.indexId)?.holders.get(agent.id)
        preAvgEntry = holder?.avgEntryPrice || 0
      }

      // ── Route by orderType ──
      // Strategies can set signal.orderType = 'market' | 'ioc' | 'fok' | 'limit' (default)
      const orderType = signal.orderType || 'limit'
      let result

      if (orderType === 'market') {
        result = this.indexRegistry.placeMarketOrder(sub.indexId, {
          agentId: agent.id,
          side: signal.action,
          size,
          reasoning: `[${ictx.symbol}] ${signal.reasoning || ''}`,
        })
      } else if (orderType === 'ioc') {
        result = this.indexRegistry.placeIOCOrder(sub.indexId, {
          agentId: agent.id,
          side: signal.action,
          price,
          size,
          reasoning: `[${ictx.symbol}] ${signal.reasoning || ''}`,
        })
      } else if (orderType === 'fok') {
        result = this.indexRegistry.placeFOKOrder(sub.indexId, {
          agentId: agent.id,
          side: signal.action,
          price,
          size,
          reasoning: `[${ictx.symbol}] ${signal.reasoning || ''}`,
        })
      } else {
        // Default: limit GTC
        result = this.indexRegistry.placeOrder(sub.indexId, {
          agentId: agent.id,
          side: signal.action,
          price,
          size,
          reasoning: `[${ictx.symbol}] ${signal.reasoning || ''}`,
        })
      }

      // Log the decision (for decision feed + persistence)
      this._logDecision(agent, { ...signal, price, size, reasoning: `[${ictx.symbol}] ${signal.reasoning || ''}` })

      // Deduct/credit agent's main balance for index trades
      if (result.fills && result.fills.length > 0) {
        const indexState = this.indexRegistry?.indexes.get(sub.indexId)
        for (const fill of result.fills) {
          const cost = fill.price * fill.size
          if (!Number.isFinite(cost) || cost < 0 || (this.safetyConfig.enabled && cost > this.safetyConfig.maxHoldingValue)) {
            this._quarantineAgent(agent, `Fill notional exceeded safety bounds on ${sub.indexId}`)
            return
          }
          const feePreview = signal.action === 'sell' && this.indexRegistry?.agentIndexFactory
            ? this.indexRegistry.agentIndexFactory.getFeePreview(sub.indexId, cost, 'trade')
            : null
          const payableFee = feePreview?.payableFee || 0
          if (signal.action === 'buy') {
            agent.virtualBalance -= cost
          } else {
            agent.virtualBalance += cost - payableFee
          }

          // ── PnL calculation on sells ──
          let tradePnl = 0
          if (signal.action === 'sell' && preAvgEntry > 0) {
            tradePnl = ((fill.price - preAvgEntry) * fill.size) - payableFee
            if (tradePnl > 0)      agent.winningTrades++
            else if (tradePnl < 0) agent.losingTrades++
            agent.realizedPnl += tradePnl
          }

          // Count index trades in agent stats
          agent.totalTrades++
          agent.totalVolume += cost

          // Record fill in agent's trade history
          const tradeEntry = {
            id: fill.id || `idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            side: signal.action,
            orderType: orderType,
            price: fill.price,
            size: fill.size,
            value: cost,
            feePaid: Math.round(payableFee * 10000) / 10000,
            pnl: Math.round(tradePnl * 10000) / 10000,
            indexId: sub.indexId,
            indexSymbol: ictx.symbol,
            position: subAgent.position,
            balance: Math.round(agent.virtualBalance * 100) / 100,
            timestamp: Date.now(),
          }
          agent.trades.unshift(tradeEntry)
          if (agent.trades.length > 100) agent.trades = agent.trades.slice(0, 100)

          // Global trade log (for GET /api/engine/trades) — RingBuffer, O(1)
          this.tradeLog.push({ ...tradeEntry, agentId: agent.id, agentName: agent.name })

          if (this._isAgentCorrupted(agent)) {
            this._quarantineAgent(agent, `Post-trade balance/equity exceeded safety bounds on ${sub.indexId}`)
            return
          }
        }
      }
    }
  }

  // ─── Helper: compute agent equity from index holdings ──────────────

  _getAgentEquity(agent) {
    let indexHoldingsValue = 0
    if (this.indexRegistry) {
      for (const [indexId, state] of this.indexRegistry.indexes) {
        if (state.status !== 'active') continue
        const holding = state.holders.get(agent.id)
        if (holding && holding.balance > 0) {
          indexHoldingsValue += this._getSafeHoldingValue(holding.balance, state)
        }
      }
    }
    const equity = agent.virtualBalance + indexHoldingsValue
    return this.safetyConfig.enabled
      ? Math.max(0, Math.min(this.safetyConfig.maxAgentEquity, equity))
      : Math.max(0, equity)
  }

  // ─── Metrics ───────────────────────────────────────────────────────

  _getTotalEquity() {
    let total = 0
    for (const [id, agent] of this.agents) {
      if (id === '__seed__') continue
      total += this._getAgentEquity(agent)
    }
    return total
  }

  getMetrics() {
    const agents = Array.from(this.agents.values()).filter(a => a.id !== '__seed__')
    const active = agents.filter(a => a.status === 'active')
    const totalEquity = this._getTotalEquity()
    const totalInitial = agents.reduce((s, a) => s + a.initialBalance, 0)
    const totalPnl = totalEquity - totalInitial
    const totalTrades = agents.reduce((s, a) => s + a.totalTrades, 0)
    const totalWins = agents.reduce((s, a) => s + a.winningTrades, 0)
    const totalLosses = agents.reduce((s, a) => s + a.losingTrades, 0)
    const totalVolume = agents.reduce((s, a) => s + a.totalVolume, 0)
    const maxDD = agents.length > 0 ? Math.max(...agents.map(a => a.maxDrawdown)) : 0
    const totalClosedTrades = totalWins + totalLosses
    const winRate = totalClosedTrades > 0 ? totalWins / totalClosedTrades : 0

    // Sharpe ratio approximation
    const returns = this.equitySnapshots.length > 1
      ? this.equitySnapshots.slice(1).map((s, i) =>
          (s.equity - this.equitySnapshots[i].equity) / this.equitySnapshots[i].equity
        )
      : []
    const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0
    const stdReturn = returns.length > 1
      ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
      : 1
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(returns.length) : 0

    return {
      totalEquity,
      totalInitial,
      totalPnl,
      totalPnlPercent: totalInitial > 0 ? (totalPnl / totalInitial) * 100 : 0,
      dailyPnl: totalPnl,
      dailyPnlPercent: totalInitial > 0 ? (totalPnl / totalInitial) * 100 : 0,
      activeAgents: active.length,
      totalAgents: agents.length,
      totalTrades,
      totalVolume,
      winRate,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      tickCount: this.tickCount,
    }
  }

  /**
   * Expose full internal context (same as what strategies receive).
   * Used by debug endpoints to build LLM prompts accurately.
   */
  getEngineContext() {
    return this._buildContext()
  }

  getRecentTrades(limit) {
    return this.tradeLog.slice(limit || 50)
  }

  getDecisionLog(agentId, limit = 50) {
    if (agentId) {
      const agent = this.agents.get(agentId)
      return agent ? agent.decisions.slice(0, limit) : []
    }
    return this.decisionLog.slice(limit)
  }

  getEquityCurve() {
    return this.equitySnapshots.slice(-200)
  }

  // ─── Sanitize agent for API response ───────────────────────────────

  _sanitizeAgent(agent) {
    // Compute index holdings: total value, unrealized PnL, total contracts
    let indexHoldingsValue = 0
    let unrealizedPnl = 0
    let totalContracts = 0
    if (this.indexRegistry) {
      for (const [indexId, state] of this.indexRegistry.indexes) {
        if (state.status !== 'active') continue
        const holding = state.holders.get(agent.id)
        if (holding && holding.balance > 0) {
          const holdingValue = this._getSafeHoldingValue(holding.balance, state)
          if (holdingValue <= 0) continue
          indexHoldingsValue += holdingValue
          unrealizedPnl += (state.oraclePrice - holding.avgEntryPrice) * holding.balance
          totalContracts += holding.balance
        }
      }
    }

    const equity = this.safetyConfig.enabled
      ? Math.max(0, Math.min(this.safetyConfig.maxAgentEquity, agent.virtualBalance + indexHoldingsValue))
      : Math.max(0, agent.virtualBalance + indexHoldingsValue)
    const totalPnl = equity - agent.initialBalance

    // Creator fields — pull from agentIndexFactory if available
    let createdIndexes = []
    let creatorRevenue = 0
    if (this.indexRegistry?.agentIndexFactory) {
      const factory = this.indexRegistry.agentIndexFactory
      for (const [indexId, state] of this.indexRegistry.indexes) {
        if (state.creatorAgentId === agent.id) {
          createdIndexes.push(indexId)
          creatorRevenue += (state.creatorFees?.totalEarned || 0)
        }
      }
    }

    const recentRotationEvents = this._strategyRuntime?.getAgentRotationEvents
      ? (this._strategyRuntime.getAgentRotationEvents(agent.id, 3) || [])
      : []
    const customState = this._getCustomStrategyState(agent)
    const activeStrategyInstanceId = agent.config?.activeStrategyInstanceId || agent._activeStrategyInstanceId || null
    const activeStrategyTemplateId = agent.config?.strategyTemplateId || agent._activeStrategyTemplateId || null
    const activeStrategyTemplate = activeStrategyTemplateId ? getStrategyTemplate(activeStrategyTemplateId) : null
    const activeStrategyMode = activeStrategyInstanceId ? 'direct' : null
    const activeStrategyType = activeStrategyTemplate?.type || null
    const activeStrategyRuntime = activeStrategyInstanceId
      ? (activeStrategyType === 'llm' ? 'llm_trader' : 'custom_strategy_runtime')
      : agent.strategy
    const hasCustomStrategy = Boolean(activeStrategyInstanceId)
    const rotationEnabled = Boolean(agent.config?.enableSubscriptionRotation)

    let executionOwner = 'classic'
    let subscriptionOwner = rotationEnabled ? 'classic' : 'manual'
    if (hasCustomStrategy) {
      executionOwner = activeStrategyType === 'llm' ? 'llm' : 'custom'
      subscriptionOwner = customState.llmOwnsExecution && customState.llmSharedExecution && (customState.llmSharedScopeId || customState.llmSharedScopeKey)
        ? 'llm_scope'
        : (rotationEnabled ? 'custom' : 'manual')
    }

    return {
      id: agent.id,
      name: agent.name,
      strategy: agent.strategy,
      strategyName: agent.strategyName,
      icon: agent.icon,
      bio: agent.bio || '',
      isUserAgent: agent.isUserAgent || false,
      walletAddress: agent.walletAddress || null,
      riskLevel: agent.riskLevel || 'medium',
      status: agent.status,
      pauseReason: agent.pauseReason || null,
      virtualBalance: Math.round(agent.virtualBalance * 100) / 100,
      initialBalance: agent.initialBalance,
      position: Math.round(totalContracts * 100) / 100,
      positionValue: Math.round(indexHoldingsValue * 100) / 100,
      avgEntryPrice: 0,
      equity: Math.round(equity * 100) / 100,
      pnl: Math.round(totalPnl * 100) / 100,
      realizedPnl: Math.round(agent.realizedPnl * 100) / 100,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      feeIncome: Math.round((agent.feeIncome || 0) * 10000) / 10000,
      dividendIncome: Math.round((agent.dividendIncome || 0) * 10000) / 10000,
      royaltyIncome: Math.round((agent.royaltyIncome || 0) * 10000) / 10000,
      otherIncome: Math.round(((agent.feeIncome || 0) + (agent.dividendIncome || 0) + (agent.royaltyIncome || 0)) * 10000) / 10000,
      pnlPercent: agent.initialBalance > 0
        ? Math.round(totalPnl / agent.initialBalance * 10000) / 100
        : 0,
      totalTrades: agent.totalTrades,
      winRate: (agent.winningTrades + agent.losingTrades) > 0
        ? Math.round(agent.winningTrades / (agent.winningTrades + agent.losingTrades) * 1000) / 10
        : 0,
      winningTrades: agent.winningTrades,
      losingTrades: agent.losingTrades,
      totalVolume: Math.round(agent.totalVolume * 100) / 100,
      maxDrawdown: Math.round((agent.maxDrawdown || 0) * 100) / 100,
      indexSubscriptions: (agent.indexSubscriptions || []).map(sub => ({ ...sub })),
      activeStrategyInstanceId,
      activeStrategyTemplateId,
      activeStrategyType,
      activeStrategyName: activeStrategyTemplate?.name || null,
      activeStrategyDescription: activeStrategyTemplate?.shortDescription || null,
      activeStrategyMode,
      activeStrategyRuntime,
      strategySource: agent.config?.strategySource || null,
      executionOwner,
      subscriptionOwner,
      lastSubscriptionRotationSummary: agent._lastSubscriptionRotationSummary || null,
      lastSubscriptionRotationAt: agent._lastSubscriptionRotationAt || null,
      recentRotationEvents,
      lastIdleReason: agent.lastIdleReason || null,
      lastIdleAt: agent.lastIdleAt || null,
      lastIdleIndexId: agent.lastIdleIndexId || null,
      lastIdleIndexSymbol: agent.lastIdleIndexSymbol || null,
      lastIdleMeta: agent.lastIdleMeta || null,
      openOrders: this.indexRegistry
        ? Array.from(this.indexRegistry.indexes.keys()).reduce((n, iid) => {
            try { return n + this.indexRegistry.getAgentPendingOrders(iid, agent.id).length } catch { return n }
          }, 0)
        : 0,
      config: agent.config ? { ...agent.config, llmApiKey: undefined } : {},
      lastTickAt: agent.lastTickAt,
      tickCount: agent.tickCount,
      createdAt: agent.createdAt,
      decisions: (agent.decisions || []).slice(0, 20),
      trades: (agent.trades || []).slice(0, 20),
      equityCurve: (agent.equityCurve || []).slice(-50),

      // LLM-specific fields (only set for llm_trader agents by llmStrategy)
      ...((agent.strategy === 'llm_trader' || activeStrategyRuntime === 'llm_trader') ? {
        lastThinking:   agent._llmLastThinking || null,
        lastReasoning:  agent._llmLastReasoning || null,
        lastConfidence: agent._llmLastConfidence || null,
        lastAction:     agent._llmLastAction || (agent.decisions?.[0]?.action) || null,
        llmLatencyMs:   agent._llmLatencyMs || null,
        llmProvider:    agent._llmProvider || null,
        llmModel:       agent._llmModel || null,
        llmExecutionOwnerAgentId: agent._llmExecutionOwnerAgentId || null,
        llmExecutionOwnerAgentName: agent._llmExecutionOwnerAgentName || null,
        llmSharedExecution: Boolean(agent._llmSharedExecution || customState.llmSharedExecution || agent.config?.llmSharedExecution),
        llmSharedExecutionMode: agent._llmSharedExecutionMode || customState.llmSharedExecutionMode || agent.config?.llmSharedExecutionMode || null,
        llmSharedTemplateId: agent._llmSharedTemplateId || customState.templateId || agent.config?.llmSharedTemplateId || null,
        llmSharedScopeId: agent._llmSharedScopeId || customState.llmSharedScopeId || agent.config?.llmSharedScopeId || null,
        llmSharedScopeKey: agent._llmSharedScopeKey || customState.llmSharedScopeKey || agent.config?.llmSharedScopeKey || null,
        llmSharedControllerAgentId: agent._llmSharedControllerAgentId || null,
        llmSharedControllerAgentName: agent._llmSharedControllerAgentName || null,
        llmSharedScopeMemberCount: agent._llmSharedScopeMemberCount || 0,
        llmSharedPlanIndexIds: agent._llmSharedPlanIndexIds || [],
        llmSharedLeaderAgentId: agent._sharedLlmLeaderAgentId || agent._llmSharedControllerAgentId || null,
        llmSharedLeaderAgentName: agent._sharedLlmLeaderAgentName || agent._llmSharedControllerAgentName || null,
        llmSharedFollowerCount: agent._sharedLlmFollowerCount || Math.max(0, (agent._llmSharedScopeMemberCount || 1) - 1),
        llmSharedMirroredIndexIds: agent._sharedLlmMirroredIndexIds || agent._llmSharedPlanIndexIds || [],
        llmSharedBlockedIndexIds: agent._sharedLlmBlockedIndexIds || [],
        llmSharedLastSyncAt: agent._sharedLlmLastSyncAt || null,
      } : {}),

      // Creator fields (live from factory data)
      createdIndexes,
      creatorRevenue: Math.round(creatorRevenue * 10000) / 10000,
      isCreator: createdIndexes.length > 0,
    }
  }

  _getSafeHoldingValue(balance, state) {
    const price = Number(state?.oraclePrice)
    if (!Number.isFinite(price) || price <= 0 || (this.safetyConfig.enabled && price > this.safetyConfig.maxIndexPrice)) return 0
    const holdingValue = balance * price
    if (!Number.isFinite(holdingValue) || holdingValue < 0 || (this.safetyConfig.enabled && holdingValue > this.safetyConfig.maxHoldingValue)) return 0
    return holdingValue
  }

  _isAgentCorrupted(agent) {
    const virtualBalance = Number(agent?.virtualBalance)
    if (!Number.isFinite(virtualBalance) || virtualBalance < 0) return true
    if (this.safetyConfig.enabled && virtualBalance > this.safetyConfig.maxAgentBalance) return true
    const equity = this._getAgentEquity(agent)
    if (!Number.isFinite(equity) || equity < 0) return true
    return this.safetyConfig.enabled ? equity > this.safetyConfig.maxAgentEquity : false
  }

  _quarantineAgent(agent, reason) {
    if (this.safetyConfig.enabled && !this.safetyConfig.quarantineAgents) return
    if (!agent) return
    if (agent.status !== 'paused') {
      console.warn(`🚨 Pausing agent ${agent.name} (${agent.id}): ${reason}`)
    }
    agent.status = 'paused'
    agent.pauseReason = reason
    this._recordSafetyEvent({
      targetType: 'agent',
      targetId: agent.id,
      label: agent.name,
      reason,
      status: agent.status,
    })
    if (this.indexRegistry) {
      for (const [indexId] of this.indexRegistry.indexes) {
        try { this.indexRegistry.cancelOrdersForAgent(indexId, agent.id) } catch {}
      }
    }
  }
}
