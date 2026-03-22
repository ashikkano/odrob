import {
  createStrategyExecutionEvent,
  getActiveStrategyInstanceForAgent,
  getStrategyVersion,
} from '../runtimeStrategyStore.js'
import { randomUUID } from 'crypto'

const SUPPORTED_ACTIONS = new Set(['buy', 'sell', 'hold', 'cancel_all', 'cancel_stale'])

const PREVIOUS_PATH_ALIASES = Object.freeze({
  'market.oraclePrice': 'market.prevOraclePrice',
  'market.oracleChangePct': 'market.prevOracleChangePct',
  'market.mid': 'market.prevMid',
  'market.bestBid': 'market.prevBestBid',
  'market.bestAsk': 'market.prevBestAsk',
  'market.bandWidthPct': 'market.prevBandWidthPct',
  'market.totalVolume': 'market.prevTotalVolume',
  'market.totalTrades': 'market.prevTotalTrades',
  'feed.total': 'feed.prevTotal',
})

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function getPathValue(source, context) {
  if (!source) return undefined
  const normalized = String(source).replace(/^\$+/, '')
  const parts = normalized.split('.').filter(Boolean)
  let current = context
  for (const part of parts) {
    if (current == null) return undefined
    current = current[part]
  }
  return current
}

function resolveRuntimeValue(value, context) {
  if (typeof value === 'string' && value.startsWith('$')) {
    return getPathValue(value, context)
  }
  return value
}

function compareValues(left, operator, right) {
  switch (operator) {
    case 'gt': return Number(left) > Number(right)
    case 'gte': return Number(left) >= Number(right)
    case 'lt': return Number(left) < Number(right)
    case 'lte': return Number(left) <= Number(right)
    case 'eq': return left === right
    case 'neq': return left !== right
    case 'between': {
      const [min, max] = Array.isArray(right) ? right : []
      return Number(left) >= Number(min) && Number(left) <= Number(max)
    }
    case 'contains':
      return Array.isArray(left) ? left.includes(right) : String(left || '').includes(String(right || ''))
    case 'in':
    case 'one_of':
      return Array.isArray(right) ? right.includes(left) : false
    case 'not_in':
      return Array.isArray(right) ? !right.includes(left) : true
    case 'intersects':
      return Array.isArray(left) && Array.isArray(right) ? left.some((item) => right.includes(item)) : false
    case 'starts_with':
      return String(left || '').startsWith(String(right || ''))
    case 'ends_with':
      return String(left || '').endsWith(String(right || ''))
    case 'truthy': return Boolean(left)
    case 'falsy': return !left
    default: return false
  }
}

function getPreviousOperandValue(condition, side, context, fallbackValue) {
  const explicitKey = side === 'left' ? 'previousLeft' : 'previousRight'
  if (condition?.[explicitKey] !== undefined) {
    return resolveRuntimeValue(condition[explicitKey], context)
  }

  const rawOperand = side === 'left'
    ? (condition?.left ?? condition?.source)
    : (condition?.right ?? condition?.value)

  if (typeof rawOperand === 'string' && rawOperand.startsWith('$')) {
    const normalized = String(rawOperand).replace(/^\$+/, '')
    const previousPath = PREVIOUS_PATH_ALIASES[normalized]
    if (previousPath) return getPathValue(previousPath, context)
  }

  return fallbackValue
}

function compareTrendValues(condition, left, right, context) {
  const previousLeft = Number(getPreviousOperandValue(condition, 'left', context, left))
  const previousRight = Number(getPreviousOperandValue(condition, 'right', context, right))
  const currentLeft = Number(left)
  const currentRight = Number(right)
  const operator = condition.op || condition.operator || 'eq'

  if (![previousLeft, previousRight, currentLeft, currentRight].every(Number.isFinite)) return false

  switch (operator) {
    case 'crosses_above':
      return previousLeft <= previousRight && currentLeft > currentRight
    case 'crosses_below':
      return previousLeft >= previousRight && currentLeft < currentRight
    case 'delta_gte':
      return (currentLeft - previousLeft) >= currentRight
    case 'delta_lte':
      return (currentLeft - previousLeft) <= currentRight
    case 'pct_delta_gte': {
      if (previousLeft === 0) return false
      return (((currentLeft - previousLeft) / Math.abs(previousLeft)) * 100) >= currentRight
    }
    case 'pct_delta_lte': {
      if (previousLeft === 0) return false
      return (((currentLeft - previousLeft) / Math.abs(previousLeft)) * 100) <= currentRight
    }
    default:
      return null
  }
}

function evaluateCondition(condition, context) {
  if (!condition) return true
  if (Array.isArray(condition.all)) return condition.all.every((item) => evaluateCondition(item, context))
  if (Array.isArray(condition.any)) return condition.any.some((item) => evaluateCondition(item, context))
  if (condition.not) return !evaluateCondition(condition.not, context)

  const left = resolveRuntimeValue(condition.left ?? condition.source, context)
  const right = resolveRuntimeValue(condition.right ?? condition.value, context)
  const operator = condition.op || condition.operator || 'eq'

  if (['crosses_above', 'crosses_below', 'delta_gte', 'delta_lte', 'pct_delta_gte', 'pct_delta_lte'].includes(operator)) {
    return Boolean(compareTrendValues(condition, left, right, context))
  }

  return compareValues(left, operator, right)
}

function summarizeFeed(feed = []) {
  const severityCounts = {}
  const typeCounts = {}
  for (const item of feed) {
    severityCounts[item.severity || 'info'] = (severityCounts[item.severity || 'info'] || 0) + 1
    typeCounts[item.type || item.eventType || 'event'] = (typeCounts[item.type || item.eventType || 'event'] || 0) + 1
  }
  return {
    total: feed.length,
    severityCounts,
    typeCounts,
    latest: feed[0] || null,
  }
}

function buildExecutionContext(agent, ctx, options = {}) {
  const currentIndex = ctx.allIndexContexts?.[ctx.indexId] || {}
  const latestTrade = (ctx.recentTrades || [])[0] || null
  const spreadPct = ctx.mid > 0 ? ((ctx.spread || 0) / ctx.mid) * 100 : 0
  const feedSummary = summarizeFeed(currentIndex.feed || [])
  const priceHistory = Array.isArray(ctx.priceHistory) ? ctx.priceHistory.filter((value) => Number.isFinite(Number(value))) : []
  const previousOraclePrice = priceHistory.length > 1
    ? Number(priceHistory[priceHistory.length - 2])
    : priceHistory.length === 1
      ? Number(priceHistory[0])
      : Number(ctx.currentPrice || 0)
  const previousMid = priceHistory.length > 1
    ? Number(priceHistory[priceHistory.length - 2])
    : Number(ctx.mid || previousOraclePrice || 0)
  const oracleDeltaPct = previousOraclePrice > 0
    ? (((ctx.currentPrice || 0) - previousOraclePrice) / previousOraclePrice) * 100
    : 0

  return {
    agent: {
      id: agent.id,
      strategy: agent.strategy,
      riskLevel: agent.riskLevel,
      virtualBalance: agent.virtualBalance,
      allocatedBalance: options.allocatedBalance ?? agent.virtualBalance,
      position: agent.position || 0,
      avgEntryPrice: agent.avgEntryPrice || 0,
      unrealizedPnl: agent.unrealizedPnl || 0,
      unrealizedPnlPct: agent.unrealizedPnlPct || 0,
      realizedPnl: agent.realizedPnl || 0,
      equity: agent.equity || 0,
      pnl: agent.pnl || 0,
      pnlPercent: agent.pnlPercent || 0,
      peakEquity: agent.peakEquity || 0,
      maxDrawdown: agent.maxDrawdown || 0,
      positionOpenedAt: agent.positionOpenedAt || null,
      positionAgeMs: agent.positionAgeMs || 0,
      positionAgeTicks: agent.positionAgeTicks || 0,
    },
    params: options.params || {},
    subscription: {
      indexId: ctx.indexId,
      indexSymbol: ctx.indexSymbol,
      allocationPct: options.subscription?.allocationPct || 0,
    },
    market: {
      indexId: ctx.indexId,
      symbol: ctx.indexSymbol,
      mid: ctx.mid,
      prevMid: previousMid,
      bestBid: ctx.bestBid,
      bestAsk: ctx.bestAsk,
      prevBestBid: Number(ctx.bestBid || 0),
      prevBestAsk: Number(ctx.bestAsk || 0),
      spread: ctx.spread,
      spreadPct,
      oraclePrice: ctx.currentPrice,
      prevOraclePrice: previousOraclePrice,
      oracleChangePct: currentIndex.oracleChangePct || 0,
      prevOracleChangePct: currentIndex.oracleChangePct || 0,
      oracleDeltaPct,
      bandLow: ctx.bandLow,
      bandHigh: ctx.bandHigh,
      bandWidthPct: ctx.bandWidthPct,
      prevBandWidthPct: Number(ctx.bandWidthPct || 0),
      holderCount: currentIndex.holderCount || 0,
      totalVolume: currentIndex.totalVolume || 0,
      prevTotalVolume: currentIndex.totalVolume || 0,
      totalTrades: currentIndex.totalTrades || 0,
      prevTotalTrades: currentIndex.totalTrades || 0,
      latestTradePrice: latestTrade?.price || ctx.currentPrice,
      volatility: ctx.volatility || 0,
      priceHistory,
    },
    feed: {
      ...feedSummary,
      prevTotal: feedSummary.total,
      tags: Object.keys(feedSummary.typeCounts || {}),
    },
    orderbook: {
      pendingOrders: ctx.pendingOrders || [],
      bidDepth: (ctx.orderBookSnapshot?.bids || []).reduce((sum, level) => sum + (level.volume || 0), 0),
      askDepth: (ctx.orderBookSnapshot?.asks || []).reduce((sum, level) => sum + (level.volume || 0), 0),
      topBid: ctx.orderBookSnapshot?.bids?.[0] || null,
      topAsk: ctx.orderBookSnapshot?.asks?.[0] || null,
    },
    time: {
      tickCount: ctx.tickCount,
      now: Date.now(),
    },
  }
}

function buildTraceContext(execCtx) {
  return {
    market: {
      indexId: execCtx.market.indexId,
      symbol: execCtx.market.symbol,
      mid: execCtx.market.mid,
      bestBid: execCtx.market.bestBid,
      bestAsk: execCtx.market.bestAsk,
      spreadPct: execCtx.market.spreadPct,
      oraclePrice: execCtx.market.oraclePrice,
      oracleChangePct: execCtx.market.oracleChangePct,
      holderCount: execCtx.market.holderCount,
      totalVolume: execCtx.market.totalVolume,
      totalTrades: execCtx.market.totalTrades,
      volatility: execCtx.market.volatility,
    },
    agent: {
      id: execCtx.agent.id,
      strategy: execCtx.agent.strategy,
      riskLevel: execCtx.agent.riskLevel,
      virtualBalance: execCtx.agent.virtualBalance,
      allocatedBalance: execCtx.agent.allocatedBalance,
      position: execCtx.agent.position,
      unrealizedPnlPct: execCtx.agent.unrealizedPnlPct,
      realizedPnl: execCtx.agent.realizedPnl,
      equity: execCtx.agent.equity,
      pnlPercent: execCtx.agent.pnlPercent,
      positionAgeMs: execCtx.agent.positionAgeMs,
      positionAgeTicks: execCtx.agent.positionAgeTicks,
    },
    feed: execCtx.feed,
    orderbook: {
      bidDepth: execCtx.orderbook.bidDepth,
      askDepth: execCtx.orderbook.askDepth,
      topBid: execCtx.orderbook.topBid,
      topAsk: execCtx.orderbook.topAsk,
      pendingOrders: Array.isArray(execCtx.orderbook.pendingOrders)
        ? execCtx.orderbook.pendingOrders.slice(0, 5)
        : [],
    },
    time: execCtx.time,
  }
}

function resolvePrice(action, execCtx) {
  const priceSource = action.priceSource || (action.action === 'buy' ? 'bestAsk' : action.action === 'sell' ? 'bestBid' : 'mid')
  const sourceMap = {
    mid: execCtx.market.mid,
    bestBid: execCtx.market.bestBid,
    bestAsk: execCtx.market.bestAsk,
    oracle: execCtx.market.oraclePrice,
    bandLow: execCtx.market.bandLow,
    bandHigh: execCtx.market.bandHigh,
    latestTrade: execCtx.market.latestTradePrice,
  }
  const basePrice = Number(sourceMap[priceSource] ?? execCtx.market.mid ?? execCtx.market.oraclePrice ?? 0)
  const offsetPct = Number(resolveRuntimeValue(action.priceOffsetPct ?? 0, execCtx) || 0)
  if (!Number.isFinite(basePrice) || basePrice <= 0) return 0
  return basePrice * (1 + offsetPct / 100)
}

function resolveSize(action, execCtx, price) {
  const explicitContracts = Number(resolveRuntimeValue(action.sizeContracts, execCtx))
  if (Number.isFinite(explicitContracts) && explicitContracts > 0) return explicitContracts

  const sizePct = Number(resolveRuntimeValue(action.sizePct, execCtx))
  if (!Number.isFinite(sizePct) || sizePct <= 0) return 0

  if (action.action === 'sell') {
    return (execCtx.agent.position || 0) * (sizePct / 100)
  }

  const budget = (execCtx.agent.allocatedBalance || 0) * (sizePct / 100)
  return price > 0 ? budget / price : 0
}

function buildSignalFromAction(action, execCtx, matchedRuleId) {
  if (!SUPPORTED_ACTIONS.has(action.action)) return null
  if (action.action === 'hold' || action.action === 'cancel_all' || action.action === 'cancel_stale') {
    return {
      action: action.action,
      reasoning: action.reasoning || `Custom strategy action: ${action.action}`,
      confidence: Number(resolveRuntimeValue(action.confidence, execCtx) || 0.5),
      meta: {
        source: 'custom_strategy',
        matchedRuleId,
      },
    }
  }

  const price = resolvePrice(action, execCtx)
  const size = resolveSize(action, execCtx, price)
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) return null

  return {
    action: action.action,
    orderType: action.orderType || 'limit',
    price,
    size,
    confidence: clamp(Number(resolveRuntimeValue(action.confidence, execCtx) || 0.6), 0, 1),
    reasoning: action.reasoning || `Custom strategy rule ${matchedRuleId || 'matched'}`,
    meta: {
      source: 'custom_strategy',
      matchedRuleId,
    },
  }
}

export class CustomStrategyRuntime {
  constructor({ cacheTtlMs = 5000 } = {}) {
    this.cacheTtlMs = cacheTtlMs
    this.cache = new Map()
    this.ruleCooldowns = new Map()
  }

  _loadActiveInstance(agentId) {
    const cached = this.cache.get(agentId)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const instance = getActiveStrategyInstanceForAgent(agentId)
    if (!instance) {
      this.cache.delete(agentId)
      return null
    }

    const version = getStrategyVersion(instance.strategyVersionId)
    if (!version) {
      this.cache.delete(agentId)
      return null
    }

    const value = { instance, version }
    this.cache.set(agentId, { value, expiresAt: Date.now() + this.cacheTtlMs })
    return value
  }

  invalidate(agentId) {
    this.cache.delete(agentId)
  }

  getActiveStrategyProfile(agentId) {
    const active = this._loadActiveInstance(agentId)
    if (!active) return null
    return {
      instance: active.instance,
      version: active.version,
      requiredChannels: active.version?.requiredChannels || [],
      rotationDefaults: active.version?.rotationDefaults || {},
      customRotation: active.instance?.customRotation || {},
      customRisk: active.instance?.customRisk || {},
      definition: active.version?.definition || {},
    }
  }

  _getRuleCooldownKey(agentId, indexId, ruleId) {
    return `${agentId || 'agent'}:${indexId || 'index'}:${ruleId || 'rule'}`
  }

  _isRuleCoolingDown(agentId, indexId, rule, execCtx) {
    const cooldownTicks = Number(rule?.cooldownTicks)
    const cooldownMs = Number(rule?.cooldownMs)
    if ((!Number.isFinite(cooldownTicks) || cooldownTicks <= 0) && (!Number.isFinite(cooldownMs) || cooldownMs <= 0)) {
      return false
    }

    const ruleKey = this._getRuleCooldownKey(agentId, indexId, rule?.id || rule?.name)
    const state = this.ruleCooldowns.get(ruleKey)
    if (!state) return false

    if (Number.isFinite(cooldownTicks) && cooldownTicks > 0) {
      const tickCount = Number(execCtx?.time?.tickCount)
      if (Number.isFinite(tickCount) && Number.isFinite(state.tickCount) && (tickCount - state.tickCount) < cooldownTicks) {
        return true
      }
    }

    if (Number.isFinite(cooldownMs) && cooldownMs > 0) {
      const now = Number(execCtx?.time?.now || Date.now())
      if (Number.isFinite(state.timestamp) && (now - state.timestamp) < cooldownMs) {
        return true
      }
    }

    return false
  }

  _markRuleTriggered(agentId, indexId, rule, execCtx) {
    const ruleKey = this._getRuleCooldownKey(agentId, indexId, rule?.id || rule?.name)
    this.ruleCooldowns.set(ruleKey, {
      tickCount: Number(execCtx?.time?.tickCount),
      timestamp: Number(execCtx?.time?.now || Date.now()),
    })
  }

  _recordExecution(active, execCtx, signals, matchedRules, outcome) {
    try {
      createStrategyExecutionEvent({
        id: randomUUID(),
        strategyInstanceId: active.instance.id,
        agentId: active.instance.agentId,
        strategyTemplateId: active.instance.strategyTemplateId,
        strategyVersionId: active.instance.strategyVersionId,
        indexId: execCtx.market.indexId,
        mode: 'direct',
        outcome,
        matchedRuleIds: matchedRules,
        signalCount: signals.length,
        signals,
        contextSnapshot: buildTraceContext(execCtx),
        createdAt: Date.now(),
      })
    } catch {}
  }

  evaluate(agent, ctx, options = {}) {
    const active = this._loadActiveInstance(agent.id)
    if (!active) return null

    const definition = active.version.definition || {}
    if ((definition.kind || 'rule_v1') !== 'rule_v1') {
      const unsupportedSignals = [{ action: 'hold', reasoning: `Unsupported custom strategy kind: ${definition.kind}`, confidence: 0.1 }]
      const execCtx = buildExecutionContext(agent, ctx, {
        allocatedBalance: options.allocatedBalance,
        params: active.instance.customParams || {},
        subscription: options.subscription,
      })
      this._recordExecution(active, execCtx, unsupportedSignals, [], 'unsupported_kind')
      return {
        instance: active.instance,
        signals: unsupportedSignals,
      }
    }

    const execCtx = buildExecutionContext(agent, ctx, {
      allocatedBalance: options.allocatedBalance,
      params: active.instance.customParams || {},
      subscription: options.subscription,
    })

    const signals = []
    const matchedRules = []
    for (const rule of definition.rules || []) {
      if (rule?.enabled === false) continue
      if (this._isRuleCoolingDown(agent.id, ctx.indexId, rule, execCtx)) continue
      if (!evaluateCondition(rule.when, execCtx)) continue
      matchedRules.push(rule.id || rule.name || `rule_${matchedRules.length + 1}`)
      const signal = buildSignalFromAction(rule.then || {}, execCtx, matchedRules.at(-1))
      if (signal) {
        signals.push(signal)
        this._markRuleTriggered(agent.id, ctx.indexId, rule, execCtx)
      }
      if (signals.length >= 3) break
    }

    if (signals.length === 0) {
      const fallback = definition.fallback || { action: 'hold', reasoning: 'No custom rule matched' }
      const fallbackSignal = buildSignalFromAction(fallback, execCtx, null)
      if (fallbackSignal) signals.push(fallbackSignal)
    }

    this._recordExecution(active, execCtx, signals, matchedRules, matchedRules.length > 0 ? 'matched' : 'fallback')

    return {
      instance: active.instance,
      version: active.version,
      signals,
      matchedRules,
    }
  }
}

export default CustomStrategyRuntime
