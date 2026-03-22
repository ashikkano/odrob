export function getStrategySourceLabel(source) {
  if (source === 'marketplace_seed') return 'Seed marketplace'
  if (source === 'custom_public') return 'Опубликованная custom strategy'
  if (source === 'marketplace') return 'Marketplace strategy'
  if (source === 'custom') return 'Custom strategy'
  return 'Classic engine'
}

export function getAgentStrategyRuntimeSummary(agent) {
  const rotation = agent?.lastSubscriptionRotationSummary || null
  const mode = agent?.activeStrategyMode || null
  const source = agent?.strategySource || null
  const executionOwner = agent?.executionOwner || (mode === 'direct' ? 'custom' : 'classic')
  const subscriptionOwner = agent?.subscriptionOwner || (mode === 'direct' ? 'custom' : 'classic')
  const hasCustomStrategy = Boolean(agent?.activeStrategyInstanceId || source || mode)

  const sourceLabel = getStrategySourceLabel(source)

  let modeLabel = 'classic'
  if (mode === 'direct') modeLabel = 'direct'

  let rotationHeadline = 'No managed rotation summary yet.'
  let rotationTone = 'neutral'

  if (!rotation && subscriptionOwner === 'custom') {
    rotationHeadline = 'Custom strategy owns subscription selection.'
    rotationTone = 'neutral'
  } else if (rotation?.skippedReason === 'shared_llm_scope' || subscriptionOwner === 'llm_scope') {
    const goalMode = rotation?.goalMode || 'balanced'
    rotationHeadline = `Shared LLM scope owns subscriptions${goalMode ? ` · ${goalMode}` : ''}.`
    rotationTone = 'neutral'
  } else if (rotation?.skippedReason === 'churn_budget_reached') {
    rotationHeadline = 'Rotation paused: daily churn budget reached.'
    rotationTone = 'warning'
  } else if (rotation) {
    const rotatedIn = Number(rotation.rotatedIn || 0)
    const rotatedOut = Number(rotation.rotatedOut || 0)
    const goalMode = rotation.goalMode || 'balanced'
    rotationHeadline = `${goalMode} rotation · +${rotatedIn} / -${rotatedOut}`
    rotationTone = rotatedIn > 0 || rotatedOut > 0 ? 'positive' : 'neutral'
  }

  return {
    hasCustomStrategy,
    sourceLabel,
    modeLabel,
    fitLabel: hasCustomStrategy
      ? `${sourceLabel} · ${executionOwner === 'custom' ? 'custom owns execution' : executionOwner === 'llm' ? 'llm owns execution' : modeLabel}`
      : 'Classic strategy only',
    rotationHeadline,
    rotationTone,
    executionOwner,
    subscriptionOwner,
    goalMode: rotation?.goalMode || null,
    rotatedIn: Number(rotation?.rotatedIn || 0),
    rotatedOut: Number(rotation?.rotatedOut || 0),
    rotatedInIds: Array.isArray(rotation?.rotatedInIds) ? rotation.rotatedInIds : [],
    rotatedOutIds: Array.isArray(rotation?.rotatedOutIds) ? rotation.rotatedOutIds : [],
    activeSubscriptions: Number(rotation?.activeSubscriptions || 0),
    skippedReason: rotation?.skippedReason || null,
    lastRotationAt: agent?.lastSubscriptionRotationAt || null,
  }
}

export function formatRotationIds(ids, limit = 3) {
  const safe = Array.isArray(ids) ? ids.filter(Boolean) : []
  if (safe.length === 0) return '—'
  if (safe.length <= limit) return safe.join(', ')
  return `${safe.slice(0, limit).join(', ')} +${safe.length - limit}`
}

export function getRotationReasonLabel(reasonCode) {
  switch (reasonCode) {
    case 'rebalance': return 'Rebalanced into a stronger candidate'
    case 'expand': return 'Expanded into a high-fit candidate'
    case 'prune': return 'Pruned a weaker subscription'
    case 'churn_budget_reached': return 'Paused by churn budget'
    default: return reasonCode ? String(reasonCode).replace(/_/g, ' ') : 'Rotation update'
  }
}

export function formatRotationScore(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—'
}

export function formatScoreDelta(value) {
  if (!Number.isFinite(Number(value))) return '—'
  const numeric = Number(value)
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)}`
}

export function formatFactorValue(value) {
  if (!Number.isFinite(Number(value))) return '—'
  const numeric = Number(value)
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)}`
}

function getFactorGroupMeta(factor) {
  const key = String(factor?.key || '')

  if (key.startsWith('filter_')) return { key: 'risk', label: 'Risk & filters' }
  if (
    key.startsWith('goal_mode_')
    || key.startsWith('custom_goal_')
    || key.startsWith('weight_')
    || key === 'current_subscription'
    || key === 'creation_bias'
  ) {
    return { key: 'policy', label: 'Rotation policy' }
  }
  if (key === 'formula_fit' || key.startsWith('strategy_')) return { key: 'fit', label: 'Strategy fit' }
  if (key.startsWith('channel_')) return { key: 'signals', label: 'Signals & channels' }
  if (
    key.startsWith('base_')
    || key.includes('volume')
    || key.includes('trades')
    || key.includes('holders')
    || key.includes('band')
  ) {
    return { key: 'liquidity', label: 'Liquidity & activity' }
  }

  return { key: 'other', label: 'Other factors' }
}

export function summarizeFactorGroups(factors, options = {}) {
  const { factorLimit = 2, groupLimit = null } = options
  const safeFactors = Array.isArray(factors) ? factors.filter((factor) => Number.isFinite(Number(factor?.value))) : []
  const groupMap = new Map()

  for (const factor of safeFactors) {
    const meta = getFactorGroupMeta(factor)
    const entry = groupMap.get(meta.key) || {
      key: meta.key,
      label: meta.label,
      total: 0,
      factors: [],
    }

    entry.total += Number(factor.value)
    entry.factors.push({
      key: factor.key,
      label: factor.label,
      value: Number(factor.value),
    })

    groupMap.set(meta.key, entry)
  }

  const groups = [...groupMap.values()]
    .map((group) => ({
      ...group,
      total: Math.round(group.total * 100) / 100,
      factors: group.factors
        .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
        .slice(0, factorLimit),
    }))
    .sort((left, right) => Math.abs(right.total) - Math.abs(left.total))

  return Number.isFinite(groupLimit) ? groups.slice(0, groupLimit) : groups
}
