export function getStrategyRiskProfile(version) {
  const risk = version?.riskDefaults || {}
  const maxPositionPct = Number(risk.maxPositionPct || 0)
  const stopLossPct = Number(risk.stopLossPct || 0)
  const maxDailyTrades = Number(risk.maxDailyTrades || 0)

  let label = 'Сбалансированные лимиты'
  let tone = 'balanced'

  if ((maxPositionPct > 0 && maxPositionPct <= 20) && (stopLossPct > 0 && stopLossPct <= 5) && (maxDailyTrades === 0 || maxDailyTrades <= 8)) {
    label = 'Жёсткие лимиты'
    tone = 'conservative'
  } else if (maxPositionPct >= 35 || maxDailyTrades >= 14 || stopLossPct >= 9) {
    label = 'Агрессивные лимиты'
    tone = 'aggressive'
  }

  const detailParts = []
  if (maxPositionPct > 0) detailParts.push(`${maxPositionPct}% макс. позиция`)
  if (stopLossPct > 0) detailParts.push(`${stopLossPct}% stop-loss`)
  if (maxDailyTrades > 0) detailParts.push(`${maxDailyTrades}/день лимит`)

  return {
    label,
    tone,
    detail: detailParts.join(' · ') || 'Явные runtime-лимиты не заданы',
  }
}

export function getStrategyRotationProfile(version, runtimeBehavior) {
  const rotation = version?.rotationDefaults || {}
  const hasManagedRotation = Boolean(runtimeBehavior?.hasManagedRotation)

  if (!hasManagedRotation) {
    return {
      label: 'Ручной universe',
      detail: 'Managed rotation по умолчанию не задан; подписки остаются под контролем оператора.',
    }
  }

  const goalMode = rotation.goalMode || runtimeBehavior?.rotationGoalMode || 'balanced'
  const intervalTicks = Number(rotation.intervalTicks || runtimeBehavior?.rotationIntervalTicks || 0)
  const maxActive = Number(rotation.maxActiveChannels || runtimeBehavior?.rotationMaxActiveChannels || 0)

  return {
    label: `${goalMode} managed rotation`,
    detail: `${intervalTicks > 0 ? `Каждые ${intervalTicks} ticks` : 'Плановая rotation'} · ${maxActive > 0 ? `до ${maxActive} активных каналов` : 'динамический набор каналов'}`,
  }
}

export function getStrategyInstallImpact({ version, runtimeBehavior, agentName = '' }) {
  const riskProfile = getStrategyRiskProfile(version)
  const rotationProfile = getStrategyRotationProfile(version, runtimeBehavior)
  const safeAgent = agentName || 'агент'
  const channelCount = Number(runtimeBehavior?.channelCount || 0)
  const triggerCount = Number(runtimeBehavior?.advancedTriggerCount || 0)

  return [
    `Устанавливает Direct execution ownership на ${safeAgent} с профилем «${riskProfile.label.toLowerCase()}».`,
    channelCount > 0
      ? `Требует ${channelCount} live inputs и проверяет ${triggerCount > 0 ? `${triggerCount} advanced trigger checks` : 'classic rule conditions'}.`
      : `Работает на стандартном market context с ${triggerCount > 0 ? `${triggerCount} advanced trigger checks` : 'classic rule conditions'}.`,
    rotationProfile.detail,
  ]
}