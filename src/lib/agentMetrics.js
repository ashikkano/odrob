export function getWinRatePercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return numeric <= 1 ? numeric * 100 : numeric
}

export function formatWinRatePercent(value, decimals = 1) {
  return `${getWinRatePercent(value).toFixed(decimals)}%`
}

export function getLatestAgentDecision(agent) {
  const fallbackRecord = Array.isArray(agent?.decisionHistory) ? agent.decisionHistory[0] : null
  const fallbackDecision = fallbackRecord?.decision || {}

  return {
    action: agent?.lastAction || fallbackDecision?.type || fallbackDecision?.action || null,
    confidence: agent?.lastConfidence ?? fallbackDecision?.confidence ?? null,
    reasoning: agent?.lastReasoning || fallbackDecision?.reasoning || null,
    timestamp: fallbackRecord?.timestamp || null,
  }
}

export function getAgentExposurePct(agent) {
  const positionValue = Number(agent?.positionValue || 0)
  const balance = Number(agent?.balance ?? agent?.virtualBalance ?? 0)
  const equity = Number(agent?.equity || (balance + positionValue))
  if (!Number.isFinite(equity) || equity <= 0) return 0
  return (positionValue / equity) * 100
}

export function getAgentCurrentState(agent) {
  const latestDecision = getLatestAgentDecision(agent)
  const positionValue = Number(agent?.positionValue || 0)
  const realizedPnl = Number(agent?.realizedPnl || 0)
  const unrealizedPnl = Number(agent?.unrealizedPnl || 0)
  const exposurePct = getAgentExposurePct(agent)
  const openPosition = Number(agent?.position || 0) > 0 || positionValue > 0
  const activeSubscriptions = Number(agent?.lastSubscriptionRotationSummary?.activeSubscriptions || 0)
    || (Array.isArray(agent?.indexSubscriptions) ? agent.indexSubscriptions.length : 0)

  let healthLabel = 'Idle'
  if (agent?.status === 'active' && latestDecision.action) healthLabel = `Live · ${String(latestDecision.action).toUpperCase()}`
  else if (agent?.status === 'active') healthLabel = 'Live · watching'
  else if (agent?.status) healthLabel = String(agent.status)

  return {
    latestDecision,
    positionValue,
    realizedPnl,
    unrealizedPnl,
    exposurePct,
    openPosition,
    activeSubscriptions,
    healthLabel,
  }
}