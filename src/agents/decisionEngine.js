// ═══════════════════════════════════════════════════════════════════════
// ODROB Agent Decision Engine
// Evaluates market conditions and generates trading decisions
// ═══════════════════════════════════════════════════════════════════════

import { DECISION_TYPES } from './agentTypes'

/**
 * Build simulated market context (in production: from oracle + on-chain)
 */
export function buildMarketContext(indexId = 'FLOOR') {
  const basePrice = indexId === 'FLOOR' ? 0.0342 : 0.0087
  const noise = (Math.random() - 0.5) * 0.002
  const oraclePrice = basePrice + noise
  const corridorWidth = 0.03
  const marketPrice = oraclePrice * (1 + (Math.random() - 0.5) * 0.04)

  return {
    indexId,
    timestamp: Date.now(),
    oraclePrice,
    marketPrice,
    corridorUpper: oraclePrice * (1 + corridorWidth),
    corridorLower: oraclePrice * (1 - corridorWidth),
    corridorWidth,
    spread: oraclePrice * (Math.random() * 0.005 + 0.001),
    spreadPercent: Math.random() * 0.5 + 0.1,
    volume24h: Math.random() * 50000 + 10000,
    bidDepth: Math.random() * 20000 + 5000,
    askDepth: Math.random() * 20000 + 5000,
    priceChange24h: (Math.random() - 0.5) * 8,
    momentum: (Math.random() - 0.5) * 2,
    volatility: Math.random() * 3 + 0.5,
    consecutiveShiftsUp: Math.floor(Math.random() * 4),
    consecutiveShiftsDown: Math.floor(Math.random() * 4),
  }
}

/**
 * Strategy evaluators — one per strategy type
 */
const strategyEvaluators = {
  mean_reversion(agent, context) {
    const { marketPrice, oraclePrice } = context
    const deviationPct = (marketPrice - oraclePrice) / oraclePrice * 100
    const threshold = agent.config?.deviationThresholdPct || 1.5

    if (deviationPct > threshold) {
      return {
        type: DECISION_TYPES.SELL,
        price: marketPrice,
        size: (agent.balance || 0) * 0.1,
        confidence: Math.min(0.9, 0.5 + Math.abs(deviationPct) / 10),
        reasoning: `Цена ${deviationPct.toFixed(2)}% выше оракула (порог: ${threshold}%). Продажа для возврата.`,
      }
    }
    if (deviationPct < -threshold) {
      return {
        type: DECISION_TYPES.BUY,
        price: marketPrice,
        size: (agent.balance || 0) * 0.1,
        confidence: Math.min(0.9, 0.5 + Math.abs(deviationPct) / 10),
        reasoning: `Цена ${Math.abs(deviationPct).toFixed(2)}% ниже оракула (порог: ${threshold}%). Покупка для возврата.`,
      }
    }
    return { type: DECISION_TYPES.HOLD, confidence: 0.6, reasoning: `Отклонение ${deviationPct.toFixed(2)}% в пределах ±${threshold}%.` }
  },

  corridor_bounce(agent, context) {
    const { marketPrice, corridorUpper, corridorLower } = context
    const corridorRange = corridorUpper - corridorLower
    const posInCorridor = (marketPrice - corridorLower) / corridorRange

    if (posInCorridor < 0.1) {
      return {
        type: DECISION_TYPES.BUY,
        price: marketPrice,
        size: (agent.balance || 0) * 0.15,
        confidence: 0.6 + (1 - posInCorridor) * 0.3,
        reasoning: `Цена у нижней границы коридора (${(posInCorridor * 100).toFixed(1)}%). Покупка на отскок.`,
      }
    }
    if (posInCorridor > 0.9) {
      return {
        type: DECISION_TYPES.SELL,
        price: marketPrice,
        size: (agent.balance || 0) * 0.15,
        confidence: 0.6 + posInCorridor * 0.3,
        reasoning: `Цена у верхней границы коридора (${(posInCorridor * 100).toFixed(1)}%). Продажа на отскок.`,
      }
    }
    return { type: DECISION_TYPES.HOLD, confidence: 0.5, reasoning: `Цена в середине коридора (${(posInCorridor * 100).toFixed(1)}%). Ожидание.` }
  },

  momentum(agent, context) {
    const { momentum, consecutiveShiftsUp, consecutiveShiftsDown } = context
    const conf = agent.config || {}
    const minShifts = conf.consecutiveShifts || 2

    if (consecutiveShiftsUp >= minShifts && momentum > (conf.minMomentumScore || 0.6)) {
      return {
        type: DECISION_TYPES.BUY,
        price: context.marketPrice,
        size: (agent.balance || 0) * 0.2,
        confidence: 0.5 + Math.abs(momentum) * 0.3,
        reasoning: `${consecutiveShiftsUp} сдвигов вверх. Моментум: ${momentum.toFixed(2)}. Следуем тренду.`,
      }
    }
    if (consecutiveShiftsDown >= minShifts && momentum < -(conf.minMomentumScore || 0.6)) {
      return {
        type: DECISION_TYPES.SELL,
        price: context.marketPrice,
        size: (agent.balance || 0) * 0.2,
        confidence: 0.5 + Math.abs(momentum) * 0.3,
        reasoning: `${consecutiveShiftsDown} сдвигов вниз. Моментум: ${momentum.toFixed(2)}. Следуем тренду.`,
      }
    }
    return { type: DECISION_TYPES.HOLD, confidence: 0.4, reasoning: 'Нет чёткого сигнала моментума.' }
  },

  dca(agent, context) {
    const conf = agent.config || {}
    const dipThreshold = conf.dipThresholdPct || 3
    const isDip = context.priceChange24h < -dipThreshold
    const multiplier = isDip ? (conf.dipMultiplier || 1.5) : 1
    const size = (agent.balance || 0) * ((conf.baseAmountPercent || 5) / 100) * multiplier

    return {
      type: DECISION_TYPES.BUY,
      price: context.marketPrice,
      size,
      confidence: 0.7,
      reasoning: isDip
        ? `DCA покупка с ${multiplier}x множителем (24ч: ${context.priceChange24h.toFixed(2)}%).`
        : `Регулярная DCA покупка по ${context.marketPrice.toFixed(5)}.`,
    }
  },
}

/**
 * Risk check — validates decision against risk parameters
 */
export function analyzeRisk(agent, decision, context) {
  const risk = agent.riskParams || {}
  const warnings = []
  let approved = true

  if (decision.size && risk.maxPositionPct) {
    const positionPct = (decision.size / Math.max(agent.balance || 1, 0.001)) * 100
    if (positionPct > risk.maxPositionPct) {
      warnings.push(`Позиция ${positionPct.toFixed(1)}% > лимит ${risk.maxPositionPct}%`)
      decision.size = (agent.balance || 0) * (risk.maxPositionPct / 100)
    }
  }

  if (risk.maxDrawdownPct && (agent.drawdown || 0) > risk.maxDrawdownPct) {
    warnings.push(`Просадка ${(agent.drawdown || 0).toFixed(1)}% > лимит ${risk.maxDrawdownPct}%`)
    approved = false
  }

  if (risk.corridorOnly && context) {
    if (context.marketPrice > context.corridorUpper || context.marketPrice < context.corridorLower) {
      warnings.push('Цена за пределами коридора — торговля запрещена')
      approved = false
    }
  }

  if (risk.cooldownMs && agent.lastTradeTime) {
    const elapsed = Date.now() - agent.lastTradeTime
    if (elapsed < risk.cooldownMs) {
      warnings.push(`Кулдаун: ${((risk.cooldownMs - elapsed) / 1000).toFixed(0)}с`)
      approved = false
    }
  }

  return { approved, warnings, adjustedDecision: decision }
}

/**
 * MAIN: run full decision pipeline for an agent
 */
export function makeDecision(agent, marketContext) {
  const context = marketContext || buildMarketContext(agent.index)

  const evaluator = strategyEvaluators[agent.strategy]
  if (!evaluator) {
    return {
      id: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      decision: { type: DECISION_TYPES.HOLD, confidence: 0, reasoning: 'Неизвестная стратегия.' },
      riskAnalysis: { approved: false, warnings: ['Unknown strategy'] },
      context: { oraclePrice: context.oraclePrice, marketPrice: context.marketPrice },
      timestamp: Date.now(),
      executed: false,
    }
  }

  const rawDecision = evaluator(agent, context)
  const riskAnalysis = analyzeRisk(agent, { ...rawDecision }, context)

  return {
    id: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    agentId: agent.id,
    decision: riskAnalysis.approved
      ? riskAnalysis.adjustedDecision
      : { ...rawDecision, type: DECISION_TYPES.HOLD, reasoning: `⛔ ${riskAnalysis.warnings.join('; ')}` },
    originalDecision: rawDecision,
    riskAnalysis,
    context: {
      oraclePrice: context.oraclePrice,
      marketPrice: context.marketPrice,
      corridorUpper: context.corridorUpper,
      corridorLower: context.corridorLower,
    },
    timestamp: Date.now(),
    executed: riskAnalysis.approved && rawDecision.type !== DECISION_TYPES.HOLD,
  }
}

/**
 * Analyze agent performance history
 */
export function analyzePerformance(agent) {
  const history = agent.decisionHistory || []
  if (history.length < 5) {
    return { suggestions: ['Недостаточно данных. Нужно минимум 5 решений.'], score: 0 }
  }

  const executed = history.filter(d => d.executed)
  const profitable = executed.filter(d => (d.result?.pnl || 0) > 0)
  const winRate = executed.length > 0 ? profitable.length / executed.length : 0
  const avgConfidence = executed.reduce((s, d) => s + (d.decision?.confidence || 0), 0) / Math.max(executed.length, 1)
  const blocked = history.filter(d => !d.riskAnalysis?.approved)

  const suggestions = []
  if (winRate < 0.4) suggestions.push('Win rate ниже 40%. Ужесточите условия входа.')
  if (blocked.length > history.length * 0.4) suggestions.push('Более 40% решений заблокировано рисками.')

  return {
    suggestions,
    metrics: { winRate, avgConfidence, totalDecisions: history.length, executed: executed.length, blocked: blocked.length },
    score: Math.round(winRate * 50 + avgConfidence * 30 + Math.min(executed.length / 50, 1) * 20),
  }
}
