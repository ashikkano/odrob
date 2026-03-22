import { useEffect, useMemo, useState } from 'react'
import {
  X,
  Sparkles,
  TrendingUp,
  Download,
  ShieldCheck,
  Clock3,
  Layers3,
  Activity,
  Bot,
  Lock,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import WalletAuthGate from '@/components/wallet/WalletAuthGate'
import { getListingOriginMeta } from '@/components/marketplace/listingOriginMeta'
import { getStrategyInstallImpact, getStrategyRiskProfile, getStrategyRotationProfile } from '@/lib/strategyProfiles'
import { cn, formatCompact, formatNumber } from '@/lib/utils'

const TABS = [
  { id: 'overview', label: 'Обзор', icon: Sparkles },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'runtime', label: 'Рантайм', icon: Activity },
  { id: 'versions', label: 'Версии', icon: Layers3 },
]

function buildVersionTimeline(versions, listing) {
  const sorted = [...(versions || [])].sort((a, b) => (a.versionNumber || 0) - (b.versionNumber || 0))
  if (sorted.length === 0) {
    return [{
      label: `v${listing?.version?.versionNumber || 1}`,
      createdAt: listing?.version?.publishedAt || Date.now(),
      versionNumber: listing?.version?.versionNumber || 1,
      published: 1,
    }]
  }

  return sorted.map((version) => ({
    label: `v${version.versionNumber}`,
    createdAt: version.publishedAt || version.createdAt || Date.now(),
    versionNumber: version.versionNumber,
    published: version.publishedAt ? 1 : 0,
  }))
}

function stableSerialize(value) {
  try {
    return JSON.stringify(value || {})
  } catch {
    return ''
  }
}

function buildVersionImpactLabels(version, previousVersion) {
  if (!version) return []
  if (!previousVersion) {
    return [
      { label: 'initial release', variant: 'active' },
      { label: 'rules defined', variant: 'outline' },
    ]
  }

  const labels = []
  const currentRisk = stableSerialize(version.riskDefaults)
  const previousRisk = stableSerialize(previousVersion.riskDefaults)
  const currentRotation = stableSerialize(version.rotationDefaults)
  const previousRotation = stableSerialize(previousVersion.rotationDefaults)
  const currentChannels = stableSerialize((version.requiredChannels || []).map((channel) => channel?.channelType || channel))
  const previousChannels = stableSerialize((previousVersion.requiredChannels || []).map((channel) => channel?.channelType || channel))
  const currentParams = stableSerialize(version.parameterSchema?.defaults)
  const previousParams = stableSerialize(previousVersion.parameterSchema?.defaults)
  const currentRules = stableSerialize(version.definition)
  const previousRules = stableSerialize(previousVersion.definition)

  if (currentRules !== previousRules) labels.push({ label: 'rules updated', variant: 'active' })
  if (currentRisk !== previousRisk) labels.push({ label: 'risk changed', variant: 'outline' })
  if (currentRotation !== previousRotation) labels.push({ label: 'rotation changed', variant: 'outline' })
  if (currentChannels !== previousChannels) labels.push({ label: 'inputs changed', variant: 'outline' })
  if (currentParams !== previousParams) labels.push({ label: 'params tuned', variant: 'outline' })

  return labels.length > 0 ? labels.slice(0, 4) : [{ label: 'minor release', variant: 'outline' }]
}

function getBestFitSummary({ template, selectedVersion, runtimeBehavior, riskProfile }) {
  const category = String(template?.category || '').toLowerCase()
  const channels = runtimeBehavior?.channelTypes || []
  const defaults = selectedVersion?.parameterSchema?.defaults || {}
  const fit = []

  if (category.includes('momentum')) fit.push('Агенты, которые любят быстрые тренды и подтверждённые пробои')
  if (category.includes('mean')) fit.push('Агенты, которые предпочитают возврат к средней и контролируемый churn')
  if (category.includes('event')) fit.push('Агенты, которые реагируют на catalyst/feed события, а не на каждый тик')
  if (category.includes('market') || category.includes('liquidity')) fit.push('Агенты, которым важнее качество исполнения и работа со spread')
  if (channels.includes('feed')) fit.push('Сценарии, где есть контекст из feed и важно дождаться подтверждения')
  if (channels.includes('strategy_signal')) fit.push('Рынки, где дисбаланс стакана помогает фильтровать входы')
  if (Number(defaults.maxSpreadPct) > 0 && Number(defaults.maxSpreadPct) <= 1.5) fit.push('Более ликвидные рынки с узким spread')
  if (riskProfile?.label?.toLowerCase().includes('high')) fit.push('Агенты с высоким risk budget и готовностью к более агрессивным входам')

  return fit.slice(0, 4)
}

function getMarketScenarioGuidance({ template, selectedVersion, runtimeBehavior }) {
  const category = String(template?.category || '').toLowerCase()
  const defaults = selectedVersion?.parameterSchema?.defaults || {}
  const scenarios = []

  if (category.includes('momentum')) {
    scenarios.push('Лучше всего выглядит в фазе расширяющегося тренда с растущим участием и чистым directional move.')
    scenarios.push('Слабее выглядит в боковом рынке, где breakout quickly fades и возрастает churn.')
  }

  if (category.includes('mean')) {
    scenarios.push('Лучше всего работает в контролируемых отклонениях, где рынок даёт возврат к средней, а не новый тренд.')
    scenarios.push('Хуже переносит сильный trend continuation без явной остановки импульса.')
  }

  if (category.includes('event')) {
    scenarios.push('Сильнее всего проявляется, когда market move совпадает с catalyst или feed-confirmation.')
    scenarios.push('Без feed intensity стратегия чаще остаётся в наблюдении и даёт меньше лишних входов.')
  }

  if (category.includes('market') || category.includes('liquidity')) {
    scenarios.push('Наиболее уместна в рынках, где есть достаточно depth и можно выбирать момент для аккуратного исполнения.')
    scenarios.push('Менее уместна в хаотичной волатильности с плохим spread discipline.')
  }

  if (scenarios.length === 0) {
    scenarios.push(`Лучше всего ощущается в режимах, где стратегия может соблюдать ${runtimeBehavior?.cooldownRuleCount > 0 ? 'cooldown-логику и ' : ''}свои фильтры spread/объёма без постоянных forced entries.`)
    if (Number(defaults.maxSpreadPct) > 0) scenarios.push(`Если spread стабильно выше ${formatNumber(Number(defaults.maxSpreadPct), 2)}%, стратегия чаще пропускает цикл, чем торгует.`)
  }

  return scenarios.slice(0, 3)
}

function buildTraceMix(traces) {
  const counts = new Map()
  for (const trace of traces || []) {
    for (const signal of trace.signals || []) {
      const key = signal.action || 'hold'
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return Array.from(counts.entries()).map(([name, value]) => ({ name, value }))
}

function ChartTooltip({ active, payload, formatter }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      {payload.map((item) => (
        <div key={item.dataKey} className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{item.name || item.dataKey}</span>
          <span className="font-semibold" style={{ color: item.color }}>{formatter ? formatter(item.value, item.payload) : item.value}</span>
        </div>
      ))}
    </div>
  )
}

function MetricTile({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3.5 backdrop-blur-sm sm:p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-white/60">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-2 text-xl font-semibold tracking-tight text-white sm:text-2xl">{value}</div>
      {sub ? <div className="mt-1 text-xs text-white/60">{sub}</div> : null}
    </div>
  )
}

function QuickFact({ label, value, tone = 'default' }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="text-xs text-white/45">{label}</div>
      <div className={cn(
        'mt-1 text-sm font-semibold',
        tone === 'positive' ? 'text-emerald-300' : 'text-white'
      )}
      >
        {value}
      </div>
    </div>
  )
}

function formatTraceLabel(value, fallback = 'n/a') {
  if (value == null || value === '') return fallback
  return String(value).replace(/[_-]+/g, ' ').trim()
}

function getTraceVariant(trace) {
  const outcome = String(trace?.outcome || '').toLowerCase()
  if (outcome.includes('match')) return 'active'
  if (outcome.includes('error') || outcome.includes('fail')) return 'loss'
  if ((trace?.signals || []).length > 0) return 'profit'
  return 'outline'
}

function buildTraceHeadline(trace) {
  if (!trace) return 'Execution snapshot пока недоступен.'
  const market = trace.contextSnapshot?.market?.symbol || trace.indexId || 'n/a'
  const actions = (trace.signals || []).map((signal) => formatTraceLabel(signal.action)).filter(Boolean)
  return `${formatTraceLabel(trace.outcome, 'runtime')} · ${actions.length ? actions.join(', ') : 'без сигналов'} · ${market}`
}

function getExpectedTempo(selectedVersion, runtimeBehavior) {
  const maxDailyTrades = Number(selectedVersion?.riskDefaults?.maxDailyTrades || 0)
  const intervalTicks = Number(selectedVersion?.rotationDefaults?.intervalTicks || runtimeBehavior?.rotationIntervalTicks || 0)
  if (maxDailyTrades >= 12 || (intervalTicks > 0 && intervalTicks <= 30)) return 'Активный'
  if (maxDailyTrades >= 7 || (intervalTicks > 0 && intervalTicks <= 60)) return 'Умеренный'
  return 'Редкий'
}

function getNoTradeReasons(selectedVersion, runtimeBehavior) {
  const defaults = selectedVersion?.parameterSchema?.defaults || {}
  const reasons = []
  if (Number(defaults.maxSpreadPct) > 0) reasons.push(`Ждёт spread ≤ ${formatNumber(Number(defaults.maxSpreadPct), 2)}%`)
  if (Number(defaults.minVolume) > 0) reasons.push(`Фильтрует объём ниже ${formatCompact(Number(defaults.minVolume))}`)
  if (Number(runtimeBehavior?.cooldownRuleCount) > 0) reasons.push(`Соблюдает cooldown по ${runtimeBehavior.cooldownRuleCount} правилам`)
  if ((runtimeBehavior?.channelTypes || []).includes('feed')) reasons.push('Ждёт подтверждающий feed/catalyst context')
  return reasons.slice(0, 3)
}

function getInstallReadinessItems({ walletAddress, selectedAgentName, hasCompatibleAgents, hasManagedRotation, requiredChannels }) {
  return [
    {
      label: 'Кошелёк подключён',
      ok: Boolean(walletAddress),
      value: walletAddress ? 'Готово' : 'Нужно подключение',
    },
    {
      label: 'Целевой агент выбран',
      ok: Boolean(selectedAgentName),
      value: selectedAgentName || 'Выберите агента',
    },
    {
      label: 'Совместимость',
      ok: Boolean(hasCompatibleAgents),
      value: hasCompatibleAgents ? 'Есть совместимые агенты' : 'Нет совместимого agent',
    },
    {
      label: 'Runtime inputs',
      ok: (requiredChannels || []).length > 0,
      value: (requiredChannels || []).length > 0 ? `${requiredChannels.length} канала` : 'Только market data',
    },
    {
      label: 'Rotation defaults',
      ok: Boolean(hasManagedRotation),
      value: hasManagedRotation ? 'Managed rotation задан' : 'Только direct execution',
    },
  ]
}

function getPrimarySignal(trace) {
  if (!Array.isArray(trace?.signals)) return null
  return trace.signals.find((signal) => signal?.action && signal.action !== 'hold') || trace.signals[0] || null
}

function formatConfidence(confidence) {
  const numeric = Number(confidence)
  if (!Number.isFinite(numeric)) return null
  return `${Math.round(numeric * 100)}% conf`
}

function formatTraceReasoning(trace) {
  const primarySignal = getPrimarySignal(trace)
  if (primarySignal?.reasoning) return primarySignal.reasoning
  if (trace?.matchedRuleIds?.length > 0) return `Совпали правила: ${trace.matchedRuleIds.slice(0, 3).join(', ')}`
  return 'Стратегия просмотрела runtime context, но не нашла достаточно сильного сетапа для действия.'
}

function buildTraceStatChips(trace) {
  const market = trace?.contextSnapshot?.market || {}
  const agent = trace?.contextSnapshot?.agent || {}
  const primarySignal = getPrimarySignal(trace)
  const chips = []

  if (Number.isFinite(Number(market.spreadPct))) chips.push(`spread ${Number(market.spreadPct).toFixed(2)}%`)
  if (Number.isFinite(Number(market.oracleChangePct))) chips.push(`oracle ${Number(market.oracleChangePct) >= 0 ? '+' : ''}${Number(market.oracleChangePct).toFixed(2)}%`)
  if (Number.isFinite(Number(market.totalVolume))) chips.push(`vol ${formatCompact(Number(market.totalVolume))}`)
  if (Number.isFinite(Number(agent.position)) && Number(agent.position) > 0) chips.push(`pos ${formatCompact(Number(agent.position))}`)
  if (Number.isFinite(Number(primarySignal?.size)) && Number(primarySignal.size) > 0) chips.push(`size ${formatCompact(Number(primarySignal.size))}`)
  if (Number.isFinite(Number(primarySignal?.price)) && Number(primarySignal.price) > 0) chips.push(`@ ${formatNumber(Number(primarySignal.price), 4)}`)

  return chips.slice(0, 5)
}

function diagnoseTrace(trace, selectedVersion) {
  if (!trace) return 'Диагностика пока недоступна.'

  const defaults = selectedVersion?.parameterSchema?.defaults || {}
  const market = trace.contextSnapshot?.market || {}
  const primarySignal = getPrimarySignal(trace)
  const maxSpreadPct = Number(defaults.maxSpreadPct)
  const minVolume = Number(defaults.minVolume)

  if (primarySignal && primarySignal.action && primarySignal.action !== 'hold') {
    return `Сработал actionable signal: ${formatTraceLabel(primarySignal.action)}${primarySignal.meta?.matchedRuleId ? ` по правилу ${primarySignal.meta.matchedRuleId}` : ''}.`
  }

  if (primarySignal?.action === 'hold') {
    return primarySignal.reasoning || 'Runtime вернул hold и не стал размещать заявку.'
  }

  if (Number.isFinite(maxSpreadPct) && Number.isFinite(Number(market.spreadPct)) && Number(market.spreadPct) > maxSpreadPct) {
    return `Сетап отфильтрован: текущий spread ${Number(market.spreadPct).toFixed(2)}% выше лимита ${formatNumber(maxSpreadPct, 2)}%.`
  }

  if (Number.isFinite(minVolume) && minVolume > 0 && Number.isFinite(Number(market.totalVolume)) && Number(market.totalVolume) < minVolume) {
    return `Сетап отфильтрован: объём ${formatCompact(Number(market.totalVolume))} ниже минимального порога ${formatCompact(minVolume)}.`
  }

  if (trace?.matchedRuleIds?.length === 0) {
    return 'Ни одно правило не совпало: стратегия осталась в режиме наблюдения.'
  }

  return 'Цикл завершился без actionable signals, но runtime context сохранён для разбора.'
}

function buildOwnerDiagnostics(traces, selectedVersion) {
  const recent = Array.isArray(traces) ? traces.slice(0, 8) : []
  if (recent.length === 0) return null

  const matchedCount = recent.filter((trace) => (trace.matchedRuleIds || []).length > 0).length
  const emittedSignals = recent.filter((trace) => (trace.signals || []).some((signal) => signal?.action && signal.action !== 'hold')).length
  const noSignalCount = recent.filter((trace) => !trace.signals?.length || trace.signals.every((signal) => signal?.action === 'hold')).length
  const confidenceValues = recent
    .flatMap((trace) => (trace.signals || []).map((signal) => Number(signal?.confidence)).filter(Number.isFinite))
  const avgConfidence = confidenceValues.length > 0
    ? `${Math.round(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length * 100)}%`
    : '—'

  const reasons = new Map()
  for (const trace of recent) {
    const diagnosis = diagnoseTrace(trace, selectedVersion)
    reasons.set(diagnosis, (reasons.get(diagnosis) || 0) + 1)
  }

  return {
    matchedRate: `${Math.round((matchedCount / recent.length) * 100)}%`,
    actionableRate: `${Math.round((emittedSignals / recent.length) * 100)}%`,
    noSignalRate: `${Math.round((noSignalCount / recent.length) * 100)}%`,
    avgConfidence,
    topReasons: Array.from(reasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => ({ reason, count })),
  }
}

function buildRuleHitLeaderboard(traces) {
  const recent = Array.isArray(traces) ? traces.slice(0, 12) : []
  if (recent.length === 0) return []

  const counts = new Map()
  for (const trace of recent) {
    for (const ruleId of trace.matchedRuleIds || []) {
      if (!ruleId) continue
      counts.set(ruleId, (counts.get(ruleId) || 0) + 1)
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ruleId, count]) => ({
      ruleId,
      count,
      share: `${count}x`,
    }))
}

function getDominantAction(traces) {
  const mix = buildTraceMix(traces)
  if (!mix.length) return 'нет signals'
  const top = [...mix].sort((a, b) => b.value - a.value)[0]
  return `${formatTraceLabel(top.name)} · ${top.value}`
}

function buildRuntimeDiff(publicEvents, privateTraces) {
  const publicRecent = Array.isArray(publicEvents) ? publicEvents.slice(0, 8) : []
  const privateRecent = Array.isArray(privateTraces) ? privateTraces.slice(0, 8) : []
  if (publicRecent.length === 0 || privateRecent.length === 0) return null

  const publicMatched = publicRecent.filter((trace) => (trace.matchedRuleIds || []).length > 0).length
  const privateMatched = privateRecent.filter((trace) => (trace.matchedRuleIds || []).length > 0).length
  const publicSignals = publicRecent.filter((trace) => (trace.signals || []).some((signal) => signal?.action && signal.action !== 'hold')).length
  const privateSignals = privateRecent.filter((trace) => (trace.signals || []).some((signal) => signal?.action && signal.action !== 'hold')).length

  return {
    matchedDelta: `${Math.round((privateMatched / privateRecent.length) * 100) - Math.round((publicMatched / publicRecent.length) * 100)} pp`,
    actionableDelta: `${Math.round((privateSignals / privateRecent.length) * 100) - Math.round((publicSignals / publicRecent.length) * 100)} pp`,
    publicAction: getDominantAction(publicRecent),
    privateAction: getDominantAction(privateRecent),
  }
}

export default function StrategyDetailModal({
  open,
  onClose,
  listing,
  template,
  versions = [],
  strategyMetrics,
  metricsLoading = false,
  traces = [],
  tracesLoading = false,
  walletAddress,
  selectedAgentName,
  hasCompatibleAgents = true,
  selectedVersion = null,
  runtimeBehavior = null,
  activeTemplateId = null,
  onConnectWallet,
  onInstall,
  installing = false,
}) {
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  useEffect(() => {
    if (open) setTab('overview')
  }, [open, listing?.strategyTemplateId])

  const versionTimeline = useMemo(() => buildVersionTimeline(versions, listing), [versions, listing])
  const traceMix = useMemo(() => buildTraceMix(traces), [traces])
  const live = strategyMetrics?.live || {}
  const structure = strategyMetrics?.structure || {}
  const cohortPnl = strategyMetrics?.charts?.cohortPnl || []
  const publicSignalMix = strategyMetrics?.charts?.signalMix || []
  const publicOutcomeMix = strategyMetrics?.charts?.outcomeMix || []
  const connectedAgents = strategyMetrics?.agents || []
  const publicRecentEvents = strategyMetrics?.runtime?.recentEvents || []
  const rotationDefaults = selectedVersion?.rotationDefaults || {}
  const hasManagedRotation = Object.keys(rotationDefaults).length > 0
  const riskProfile = useMemo(() => getStrategyRiskProfile(selectedVersion), [selectedVersion])
  const rotationProfile = useMemo(() => getStrategyRotationProfile(selectedVersion, runtimeBehavior), [selectedVersion, runtimeBehavior])
  const installImpact = useMemo(
    () => getStrategyInstallImpact({ version: selectedVersion, runtimeBehavior, agentName: selectedAgentName || '' }),
    [selectedVersion, runtimeBehavior, selectedAgentName]
  )
  const originMeta = useMemo(() => getListingOriginMeta(listing), [listing])
  const latestPrivateTrace = traces?.[0] || null
  const latestPublicEvent = publicRecentEvents?.[0] || null
  const signalChartData = publicSignalMix.length > 0 ? publicSignalMix : traceMix
  const installReadiness = useMemo(
    () => getInstallReadinessItems({ walletAddress, selectedAgentName, hasCompatibleAgents, hasManagedRotation, requiredChannels: selectedVersion?.requiredChannels || [] }),
    [walletAddress, selectedAgentName, hasCompatibleAgents, hasManagedRotation, selectedVersion]
  )
  const expectedTempo = useMemo(() => getExpectedTempo(selectedVersion, runtimeBehavior), [selectedVersion, runtimeBehavior])
  const noTradeReasons = useMemo(() => getNoTradeReasons(selectedVersion, runtimeBehavior), [selectedVersion, runtimeBehavior])
  const ownerDiagnostics = useMemo(() => buildOwnerDiagnostics(traces, selectedVersion), [traces, selectedVersion])
  const ownerRuleLeaderboard = useMemo(() => buildRuleHitLeaderboard(traces), [traces])
  const runtimeDiff = useMemo(() => buildRuntimeDiff(publicRecentEvents, traces), [publicRecentEvents, traces])
  const orderedVersions = useMemo(
    () => (versions?.length
      ? [...versions].sort((a, b) => (b.versionNumber || 0) - (a.versionNumber || 0))
      : versionTimeline.map((item) => ({ versionNumber: item.versionNumber, changelog: '', publishedAt: item.createdAt, createdAt: item.createdAt }))),
    [versions, versionTimeline]
  )
  const bestFitSummary = useMemo(
    () => getBestFitSummary({ template, selectedVersion, runtimeBehavior, riskProfile }),
    [template, selectedVersion, runtimeBehavior, riskProfile]
  )
  const marketScenarioGuidance = useMemo(
    () => getMarketScenarioGuidance({ template, selectedVersion, runtimeBehavior }),
    [template, selectedVersion, runtimeBehavior]
  )

  if (!open || !listing) return null

  const currentVersion = listing.version?.versionNumber || versionTimeline.at(-1)?.versionNumber || 1
  const publishedCount = (versions || []).filter((version) => version.publishedAt).length || (listing.version?.publishedAt ? 1 : 0)
  const isActiveOnTargetAgent = Boolean(activeTemplateId && activeTemplateId === listing?.strategyTemplateId)
  const installStatusText = !walletAddress
    ? 'Подключите кошелёк, чтобы установить эту стратегию на одного из своих агентов.'
    : !hasCompatibleAgents
      ? 'Для этого кошелька пока нет подходящего engine-agent с поддержкой marketplace strategies.'
      : isActiveOnTargetAgent
        ? `${selectedAgentName || 'Выбранный агент'} уже использует эту стратегию как активный direct runtime layer.`
        : selectedAgentName
          ? hasManagedRotation
            ? `Готово для ${selectedAgentName}: Direct execution и настройки managed rotation уже подготовлены.`
            : `Готово для ${selectedAgentName}: стратегия установится в режиме Direct execution.`
          : 'Выберите целевого агента в боковой панели маркетплейса и установите стратегию.'
  const installButtonLabel = !walletAddress
    ? 'Подключить кошелёк'
    : !hasCompatibleAgents
      ? 'Нужен agent'
    : installing
      ? 'Установка…'
      : isActiveOnTargetAgent
        ? 'Уже активна'
        : selectedAgentName
          ? `Установить на ${selectedAgentName}`
          : 'Выберите целевого агента'

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-2 py-2 backdrop-blur-md animate-in fade-in duration-200 sm:px-4 sm:py-4" onClick={onClose}>
      <div
        className="relative flex max-h-[96vh] w-full max-w-6xl flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.98),rgba(9,13,24,0.96))] shadow-[0_40px_120px_rgba(0,0,0,0.55)] animate-in zoom-in-95 slide-in-from-bottom-4 duration-300 sm:max-h-[92vh] sm:rounded-[28px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(129,140,248,0.15),transparent_22%),radial-gradient(circle_at_bottom_left,rgba(52,211,153,0.08),transparent_24%)]" />
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white sm:right-4 sm:top-4 sm:h-10 sm:w-10"
          aria-label="Закрыть детали стратегии"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="overflow-auto">
          <section className="relative overflow-hidden border-b border-white/10 px-4 py-5 sm:px-6 sm:py-6 md:px-8 md:py-8">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(129,140,248,0.26),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(52,211,153,0.12),transparent_24%)]" />
            <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_360px]">
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-white/15 bg-white/5 text-white">{template?.category || 'custom'}</Badge>
                  <Badge variant="secondary" className="bg-white/10 text-white">{template?.type || 'custom'}</Badge>
                  <Badge variant="outline" className={cn('bg-white/5', originMeta.className)}>{originMeta.label}</Badge>
                  <Badge variant="outline" className="border-white/15 bg-white/5 text-white">v{currentVersion}</Badge>
                  {listing.verifiedBadge ? <Badge variant="active">Проверено</Badge> : null}
                  {isActiveOnTargetAgent ? <Badge variant="outline" className="border-emerald-400/35 bg-emerald-400/10 text-emerald-100">Активна у агента</Badge> : null}
                </div>

                <div>
                  <div className="text-xs uppercase tracking-[0.18em] text-white/50">Профиль стратегии</div>
                  <h2 className="mt-2 pr-10 text-2xl font-semibold tracking-tight text-white sm:text-3xl md:pr-0 md:text-4xl">{template?.name || 'Стратегия без названия'}</h2>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-white/70 md:text-base">
                    {template?.shortDescription || 'Эта стратегия опубликована в маркетплейсе и готова к установке на совместимых user agents.'}
                  </p>
                  <div className="mt-3 text-xs text-white/50">{originMeta.description}</div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricTile icon={Bot} label="Подключено" value={formatCompact(live.connectedAgents || 0)} sub={`${formatCompact(live.activeAgents || 0)} активных агентов`} />
                  <MetricTile icon={TrendingUp} label="Средний P&L" value={`${(live.avgPnlPercent || 0) >= 0 ? '+' : ''}${formatNumber(live.avgPnlPercent || 0, 2)}%`} sub="Когорта подключённых стратегий" />
                  <MetricTile icon={ShieldCheck} label="Win rate" value={`${formatNumber(live.avgWinRate || 0, 1)}%`} sub={`${formatCompact(live.totalTrades || 0)} сделок всего`} />
                  <MetricTile icon={Layers3} label="Версии" value={String(versionTimeline.length)} sub={`${publishedCount} опубликованных релизов`} />
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <QuickFact label="Tempo" value={expectedTempo} tone="positive" />
                  <QuickFact label="Execution" value="Direct execution" />
                  <QuickFact label="Inputs" value={(selectedVersion?.requiredChannels || []).length > 0 ? `${selectedVersion.requiredChannels.length} каналов` : 'Market data'} />
                  <QuickFact label="Rotation" value={hasManagedRotation ? rotationProfile.label : 'Без autorotation'} tone="positive" />
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 backdrop-blur-sm sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-white">Быстрая установка</div>
                      <div className="mt-1 text-xs text-white/55">{installStatusText}</div>
                    </div>
                    <Badge variant={isActiveOnTargetAgent ? 'active' : 'outline'} className="border-white/15 bg-white/[0.04] text-white">
                      {isActiveOnTargetAgent ? 'Активна у агента' : 'Готова к установке'}
                    </Badge>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Badge variant="outline" className={cn('text-center whitespace-normal', originMeta.className)}>{originMeta.label}</Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-center text-white whitespace-normal">{template?.visibility || 'public'}</Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-center text-white whitespace-normal">Ранг {formatNumber(listing?.rankingScore || 0, 0)}</Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-center text-white whitespace-normal">{formatCompact(listing?.installCount || 0)} установок</Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-center text-white whitespace-normal">Direct execution</Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-center text-white whitespace-normal">{riskProfile.label}</Badge>
                    {hasManagedRotation ? (
                      <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 text-center text-emerald-100 whitespace-normal">
                        Managed rotation
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <QuickFact label="Правила" value={structure.ruleCount || 0} />
                    <QuickFact label="Параметры" value={structure.parameterCount || 0} />
                    <QuickFact label="Каналы" value={structure.requiredChannelCount || 0} />
                    <QuickFact label="Удержание" value={`${listing?.installCount > 0 ? Math.min(100, Math.round(((listing?.activeInstallCount || 0) / listing.installCount) * 100)) : 0}%`} tone="positive" />
                  </div>

                  <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs text-white/70">
                    <div className="font-medium text-white">Readiness checklist</div>
                    <div className="mt-3 space-y-2">
                      {installReadiness.map((item) => (
                        <div key={item.label} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className={cn('inline-flex h-2.5 w-2.5 rounded-full', item.ok ? 'bg-emerald-400' : 'bg-amber-400')} />
                            <span className="text-white/82">{item.label}</span>
                          </div>
                          <span className="text-white/50">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs text-white/70">
                    <div className="font-medium text-white">Latest snapshot</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant={getTraceVariant(latestPrivateTrace || latestPublicEvent)}>
                        {latestPrivateTrace ? 'Private trace' : latestPublicEvent ? 'Public runtime' : 'Нет данных'}
                      </Badge>
                      {(latestPrivateTrace || latestPublicEvent)?.mode ? (
                        <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{(latestPrivateTrace || latestPublicEvent).mode}</Badge>
                      ) : null}
                    </div>
                    <div className="mt-2 text-sm text-white/80">{buildTraceHeadline(latestPrivateTrace || latestPublicEvent)}</div>
                    {latestPrivateTrace || latestPublicEvent ? (
                      <div className="mt-2 text-xs text-white/50">{new Date((latestPrivateTrace || latestPublicEvent).createdAt).toLocaleString()}</div>
                    ) : null}
                  </div>

                  <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {!walletAddress ? (
                      <Button variant="outline" onClick={onConnectWallet} className="h-auto w-full whitespace-normal border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white sm:w-auto">
                        <Bot className="h-4 w-4" /> Подключить кошелёк
                      </Button>
                    ) : (
                      <Button onClick={onInstall} disabled={!selectedAgentName || installing || isActiveOnTargetAgent || !hasCompatibleAgents} className="h-auto w-full whitespace-normal text-left sm:w-auto sm:text-center">
                        <Download className="h-4 w-4" /> {installButtonLabel}
                      </Button>
                    )}
                    <Button variant="outline" onClick={onClose} className="h-auto w-full whitespace-normal border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white sm:w-auto">Закрыть</Button>
                  </div>
                </div>

                <div className="rounded-[24px] border border-white/10 bg-white/[0.04] p-4 backdrop-blur-sm sm:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-white">Decision guide</div>
                      <div className="mt-1 text-xs text-white/55">Что ожидать от стратегии до установки.</div>
                    </div>
                    <Sparkles className="h-4 w-4 text-primary" />
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <QuickFact label="Сложность" value={`${Math.min(100, Math.round(template?.complexityScore || 0))}/100`} />
                    <QuickFact label="Объяснимость" value={`${Math.min(100, Math.round(template?.explainabilityScore || 0))}/100`} />
                    <QuickFact label="Профиль риска" value={riskProfile.label} />
                    <QuickFact label="Rotation" value={rotationProfile.label} tone="positive" />
                  </div>
                  <div className="mt-4 space-y-2 text-sm text-white/70">
                    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">{installImpact[0]}</div>
                    {noTradeReasons.map((item) => (
                      <div key={item} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">{item}</div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="px-4 py-4 sm:px-6 md:px-8">
            <div className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    'shrink-0 snap-start inline-flex items-center gap-2 rounded-full border px-3 py-2 text-left text-sm whitespace-normal transition-colors sm:px-4 sm:text-center',
                    tab === id
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-white/10 bg-white/[0.04] text-white/65 hover:bg-white/[0.08] hover:text-white'
                  )}
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
          </section>

          <section className="px-4 pb-4 sm:px-6 sm:pb-6 md:px-8 md:pb-8">
            {tab === 'overview' ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
                <Card className="border-white/10 bg-white/[0.035] text-white shadow-none">
                  <CardHeader>
                    <CardTitle className="text-white">Как работает стратегия</CardTitle>
                    <CardDescription className="text-white/55">Сначала объяснение поведения, затем install impact и условия, в которых стратегия проявляется лучше всего.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 text-sm">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-white/72">
                      {template?.shortDescription || 'Стратегия опубликована в маркетплейсе и готова к установке на совместимых user agents.'}
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <QuickFact label="Tempo" value={expectedTempo} tone="positive" />
                      <QuickFact label="Профиль риска" value={riskProfile.label} />
                      <QuickFact label="Триггерная логика" value={runtimeBehavior?.advancedTriggerCount > 0 ? `${runtimeBehavior.advancedTriggerCount} advanced checks` : 'Классический набор правил'} />
                      <QuickFact label="Используемые входы" value={runtimeBehavior?.channelTypes?.length > 0 ? runtimeBehavior.channelTypes.join(', ') : 'Только market data'} />
                    </div>
                    <div className="space-y-2">
                      <div className="text-xs uppercase tracking-[0.14em] text-white/45">Что меняется после установки</div>
                      {installImpact.map((line) => (
                        <div key={line} className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-white/72">
                          {line}
                        </div>
                      ))}
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <div className="text-xs uppercase tracking-[0.14em] text-white/45">Best fit for</div>
                      <div className="mt-3 space-y-2">
                        {bestFitSummary.length > 0 ? bestFitSummary.map((item) => (
                          <div key={item} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-white/72">
                            {item}
                          </div>
                        )) : (
                          <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-2 text-white/55">
                            Стратегия подходит агентам, которым нужен объяснимый direct execution со встроенными runtime-ограничениями.
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-white/10 bg-white/[0.035] text-white shadow-none">
                  <CardHeader>
                    <CardTitle className="text-white">Когда стратегия действует</CardTitle>
                    <CardDescription className="text-white/55">Сигналы качества, no-trade причины и runtime fit без перегрузки графиками.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                      <QuickFact label="Опубликовано" value={publishedCount} />
                      <QuickFact label="Активные установки" value={formatCompact(listing?.activeInstallCount || 0)} tone="positive" />
                      <QuickFact label="Сделок всего" value={formatCompact(live.totalTrades || 0)} />
                      <QuickFact label="Win rate" value={`${formatNumber(live.avgWinRate || 0, 1)}%`} tone="positive" />
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <div className="text-xs uppercase tracking-[0.14em] text-white/45">Top no-trade reasons</div>
                      <div className="mt-3 space-y-2">
                        {noTradeReasons.length > 0 ? noTradeReasons.map((item) => (
                          <div key={item} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-white/72">{item}</div>
                        )) : (
                          <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-2 text-white/55">У стратегии нет явных runtime-блокеров кроме базовой market fit логики.</div>
                        )}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <div className="text-xs uppercase tracking-[0.14em] text-white/45">Latest signal health</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant={getTraceVariant(latestPrivateTrace || latestPublicEvent)}>{formatTraceLabel((latestPrivateTrace || latestPublicEvent)?.outcome, 'нет runtime')}</Badge>
                        <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{(latestPrivateTrace || latestPublicEvent)?.signals?.length || 0} signals</Badge>
                        <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{(latestPrivateTrace || latestPublicEvent)?.matchedRuleIds?.length || 0} rules</Badge>
                      </div>
                      <div className="mt-3 text-white/72">{buildTraceHeadline(latestPrivateTrace || latestPublicEvent)}</div>
                      </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <div className="text-xs uppercase tracking-[0.14em] text-white/45">Market scenarios</div>
                      <div className="mt-3 space-y-2">
                        {marketScenarioGuidance.map((item) => (
                          <div key={item} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-white/72">
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {tab === 'performance' ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
                <Card className="border-white/10 bg-white/[0.035] text-white shadow-none">
                  <CardHeader>
                    <CardTitle className="text-white">P&L подключённых агентов</CardTitle>
                    <CardDescription className="text-white/55">Один график — один ответ: как во времени ведёт себя подключённая когорта.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {metricsLoading ? (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.04] p-6 text-sm text-white/65">Загрузка метрик когорты…</div>
                    ) : cohortPnl.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.04] p-6 text-sm text-white/65">Пока нет когорты подключённых агентов. Когда агенты начнут устанавливать стратегию, здесь появится агрегированная динамика P&L.</div>
                    ) : (
                      <div className="h-[220px] sm:h-[260px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={cohortPnl} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                            <defs>
                              <linearGradient id="strategyCohortGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="oklch(0.72 0.19 155)" stopOpacity={0.35} />
                                <stop offset="100%" stopColor="oklch(0.72 0.19 155)" stopOpacity={0.02} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                            <XAxis dataKey="label" tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }} axisLine={false} tickLine={false} />
                            <YAxis tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }} axisLine={false} tickLine={false} width={42} tickFormatter={(value) => `${Number(value).toFixed(1)}%`} />
                            <Tooltip content={<ChartTooltip formatter={(value) => `${Number(value).toFixed(2)}%`} />} />
                            <Area type="monotone" name="Avg P&L" dataKey="avgPnlPercent" stroke="oklch(0.72 0.19 155)" fill="url(#strategyCohortGrad)" strokeWidth={2.4} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-white/10 bg-white/[0.035] text-white shadow-none">
                  <CardHeader>
                    <CardTitle className="text-white">Adoption snapshot</CardTitle>
                    <CardDescription className="text-white/55">Сначала простые структурные факты, затем лучшие подключённые агенты.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                      <QuickFact label="Активные установки" value={formatCompact(listing?.activeInstallCount || 0)} tone="positive" />
                      <QuickFact label="Install → active" value={`${listing?.installCount > 0 ? Math.min(100, Math.round(((listing?.activeInstallCount || 0) / listing.installCount) * 100)) : 0}%`} tone="positive" />
                      <QuickFact label="Сделок всего" value={formatCompact(live.totalTrades || 0)} />
                      <QuickFact label="Win rate" value={`${formatNumber(live.avgWinRate || 0, 1)}%`} tone="positive" />
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <div className="text-xs uppercase tracking-[0.14em] text-white/45">Best performing fit</div>
                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <QuickFact label="Tempo" value={expectedTempo} tone="positive" />
                        <QuickFact label="Risk profile" value={riskProfile.label} />
                        <QuickFact label="Inputs" value={(selectedVersion?.requiredChannels || []).length > 0 ? `${selectedVersion.requiredChannels.length} channels` : 'base'} />
                        <QuickFact label="Rotation" value={hasManagedRotation ? rotationProfile.label : 'direct only'} />
                      </div>
                    </div>
                    {connectedAgents.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.04] p-6 text-sm text-white/65">Пока нет подключённых агентов. Виджет станет богаче, когда накопятся установки и demo-run данные.</div>
                    ) : connectedAgents.slice(0, 3).map((agent) => (
                      <div key={agent.id} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/[0.06] text-lg">{agent.icon}</div>
                            <div>
                              <div className="font-medium text-white">{agent.name}</div>
                              <div className="text-xs text-white/50">{agent.mode} mode · {agent.totalTrades} сделок · {agent.winRate.toFixed(1)}% win rate</div>
                            </div>
                          </div>
                          <Badge variant={agent.status === 'active' ? 'active' : 'outline'}>{agent.status}</Badge>
                        </div>
                        <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                          <div className="rounded-xl bg-white/[0.04] px-3 py-2">
                            <div className="text-white/50">P&L</div>
                            <div className={cn('mt-1 font-semibold', agent.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300')}>{(agent.pnlPercent || 0) >= 0 ? '+' : ''}{formatNumber(agent.pnlPercent || 0, 2)}%</div>
                          </div>
                          <div className="rounded-xl bg-white/[0.04] px-3 py-2">
                            <div className="text-white/50">Equity</div>
                            <div className="mt-1 font-semibold text-white">${formatCompact(agent.equity || 0)}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {tab === 'versions' ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
                <Card className="border-white/10 bg-white/[0.035] text-white shadow-none">
                  <CardHeader>
                    <CardTitle className="text-white">Лента версий</CardTitle>
                    <CardDescription className="text-white/55">Последовательность релизов и состояние публикации в одном взгляде.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[220px] sm:h-[280px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={versionTimeline} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                          <XAxis dataKey="label" tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }} axisLine={false} tickLine={false} />
                          <YAxis allowDecimals={false} tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }} axisLine={false} tickLine={false} width={24} />
                          <Tooltip content={<ChartTooltip formatter={(value, payload) => payload.published ? `v${value} · опубликовано` : `v${value} · черновик`} />} />
                          <Line type="monotone" dataKey="versionNumber" stroke="oklch(0.72 0.19 155)" strokeWidth={2.5} dot={{ r: 4, fill: 'oklch(0.72 0.19 155)' }} activeDot={{ r: 5 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-white/10 bg-white/[0.035] text-white shadow-none">
                  <CardHeader>
                    <CardTitle className="text-white">Заметки к релизам</CardTitle>
                    <CardDescription className="text-white/55">Понятные карточки версий и структурные метрики, которые важнее всего для strategy builder.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                        <div className="text-white/50">Правила</div>
                        <div className="mt-1 font-semibold text-white">{structure.ruleCount || 0}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                        <div className="text-white/50">Параметры</div>
                        <div className="mt-1 font-semibold text-white">{structure.parameterCount || 0}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                        <div className="text-white/50">Каналы</div>
                        <div className="mt-1 font-semibold text-white">{structure.requiredChannelCount || 0}</div>
                      </div>
                    </div>
                    {orderedVersions.map((version, index) => {
                      const previousVersion = orderedVersions[index + 1] || null
                      const impactLabels = buildVersionImpactLabels(version, previousVersion)
                      const isLatest = index === 0

                      return (
                      <div key={version.versionNumber} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-medium text-white">v{version.versionNumber}</div>
                            {isLatest ? <Badge variant="active">recommended</Badge> : null}
                          </div>
                          <Badge variant={version.publishedAt ? 'active' : 'outline'}>{version.publishedAt ? 'Опубликовано' : 'Черновик'}</Badge>
                        </div>
                        <div className="mt-2 text-xs text-white/50">
                          {new Date(version.publishedAt || version.createdAt || Date.now()).toLocaleString()}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {impactLabels.map((item) => (
                            <Badge key={`${version.versionNumber}-${item.label}`} variant={item.variant} className="border-white/15 bg-white/[0.04] text-white">
                              {item.label}
                            </Badge>
                          ))}
                        </div>
                        <div className="mt-2 text-sm text-white/70">
                          {version.changelog || 'Релиз опубликован, но changelog пока не добавлен.'}
                        </div>
                        <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                          <QuickFact label="Rules" value={version.definition?.rules?.length || version.definition?.entries?.length || structure.ruleCount || 0} />
                          <QuickFact label="Inputs" value={(version.requiredChannels || []).length > 0 ? `${version.requiredChannels.length}` : 'base'} />
                          <QuickFact label="Rotation" value={version.rotationDefaults?.goalMode || 'direct only'} />
                        </div>
                      </div>
                    )})}
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {tab === 'runtime' ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <Card className="border-white/10 bg-white/[0.035] text-white shadow-none">
                  <CardHeader>
                    <CardTitle className="text-white">Смесь runtime-сигналов</CardTitle>
                    <CardDescription className="text-white/55">Публичная агрегированная картина emitted actions по недавним исполнениям этой стратегии.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {signalChartData.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.04] p-5 text-sm text-white/65">
                        Публичной runtime-статистики пока нет. Когда demo или user agents начнут исполнять эту стратегию, здесь появится доминирующий action mix.
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="h-[190px] sm:h-[210px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={signalChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                              <XAxis dataKey="name" tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }} axisLine={false} tickLine={false} />
                              <YAxis allowDecimals={false} tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }} axisLine={false} tickLine={false} width={26} />
                              <Tooltip content={<ChartTooltip formatter={(value) => `${value} сигналов`} />} />
                              <Bar dataKey="value" radius={[8, 8, 0, 0]} fill="oklch(0.72 0.19 155)" />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                        {publicOutcomeMix.length > 0 ? (
                          <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                            {publicOutcomeMix.map((item) => (
                              <div key={item.name} className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                                <div className="text-white/50 capitalize">{item.name}</div>
                                <div className="mt-1 font-semibold text-white">{item.value}</div>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {walletAddress && ownerDiagnostics ? (
                          <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.06] p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-medium text-white">Owner diagnostics</div>
                                <div className="mt-1 text-xs text-white/55">Сводка по последним private execution cycles для вашего агента.</div>
                              </div>
                              <Badge variant="active">Private</Badge>
                            </div>
                            <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                              <QuickFact label="Matched" value={ownerDiagnostics.matchedRate} tone="positive" />
                              <QuickFact label="Actionable" value={ownerDiagnostics.actionableRate} tone="positive" />
                              <QuickFact label="No-signal" value={ownerDiagnostics.noSignalRate} />
                              <QuickFact label="Avg confidence" value={ownerDiagnostics.avgConfidence} />
                            </div>
                            <div className="mt-4 space-y-2">
                              {ownerDiagnostics.topReasons.map((item) => (
                                <div key={item.reason} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/75">
                                  {item.reason} <span className="text-white/45">· {item.count}x</span>
                                </div>
                              ))}
                            </div>

                            {ownerRuleLeaderboard.length > 0 ? (
                              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                                <div className="text-xs uppercase tracking-[0.14em] text-white/45">Rule hit leaderboard</div>
                                <div className="mt-3 space-y-2">
                                  {ownerRuleLeaderboard.map((item) => (
                                    <div key={item.ruleId} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm">
                                      <span className="font-mono text-white/78">{formatTraceLabel(item.ruleId)}</span>
                                      <span className="text-white/45">{item.share}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {runtimeDiff ? (
                              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                                <div className="text-xs uppercase tracking-[0.14em] text-white/45">Public vs private</div>
                                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  <QuickFact label="Matched delta" value={runtimeDiff.matchedDelta} tone="positive" />
                                  <QuickFact label="Actionable delta" value={runtimeDiff.actionableDelta} tone="positive" />
                                  <QuickFact label="Public dominant" value={runtimeDiff.publicAction} />
                                  <QuickFact label="Private dominant" value={runtimeDiff.privateAction} />
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-white/10 bg-white/[0.035] text-white shadow-none">
                  <CardHeader>
                    <CardTitle className="text-white">Лента runtime-событий</CardTitle>
                    <CardDescription className="text-white/55">Поток исполнения на уровне стратегии и owner-only decision cards, если доступны private traces установки.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {publicRecentEvents.length === 0 && (!walletAddress || traces.length === 0) ? (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.04] p-5 text-sm text-white/65">Runtime-события пока недоступны.</div>
                    ) : (
                      <>
                        {publicRecentEvents.slice(0, 4).map((trace) => (
                          <div key={trace.id} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={trace.outcome === 'matched' ? 'active' : 'outline'}>{trace.outcome}</Badge>
                              <Badge variant="outline" className="border-white/10 bg-white/[0.04] text-white">{trace.mode}</Badge>
                              <span className="text-xs text-white/50">{new Date(trace.createdAt).toLocaleString()}</span>
                            </div>
                            <div className="mt-2 text-sm text-white">{trace.matchedRuleIds?.length ? trace.matchedRuleIds.join(', ') : 'Явного совпадения правил нет'}</div>
                            <div className="mt-1 text-xs text-white/55">Сигналы: {trace.signals?.map((signal) => signal.action).join(', ') || 'нет'}</div>
                          </div>
                        ))}
                        {walletAddress ? (
                          tracesLoading ? (
                            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.04] p-5 text-sm text-white/65">Загрузка private traces…</div>
                          ) : traces.slice(0, 2).map((trace) => (
                            <div key={`private-${trace.id}`} className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.06] p-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="active">Latest decision</Badge>
                                <Badge variant={getTraceVariant(trace)}>{formatTraceLabel(trace.outcome, 'runtime')}</Badge>
                                <span className="inline-flex items-center gap-1 text-xs text-white/50"><Clock3 className="h-3.5 w-3.5" /> {new Date(trace.createdAt).toLocaleString()}</span>
                              </div>
                              <div className="mt-3 text-sm font-medium text-white">{buildTraceHeadline(trace)}</div>
                              <div className="mt-2 text-sm text-white/78">{formatTraceReasoning(trace)}</div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {(trace.matchedRuleIds?.length ? trace.matchedRuleIds.slice(0, 3) : ['no matched rules']).map((rule) => (
                                  <Badge key={`${trace.id}-${rule}`} variant="outline" className="border-white/15 bg-white/[0.04] text-white">
                                    {formatTraceLabel(rule)}
                                  </Badge>
                                ))}
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {buildTraceStatChips(trace).map((item) => (
                                  <span key={`${trace.id}-${item}`} className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-white/65">
                                    {item}
                                  </span>
                                ))}
                              </div>
                              <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/68">
                                {diagnoseTrace(trace, selectedVersion)}
                              </div>
                              {getPrimarySignal(trace) ? (
                                <div className="mt-2 text-xs text-white/55">
                                  {formatTraceLabel(getPrimarySignal(trace).action)}
                                  {formatConfidence(getPrimarySignal(trace).confidence) ? ` · ${formatConfidence(getPrimarySignal(trace).confidence)}` : ''}
                                  {getPrimarySignal(trace).orderType ? ` · ${getPrimarySignal(trace).orderType}` : ''}
                                </div>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <WalletAuthGate
                              title="Подключите кошелёк для private traces"
                              description="Подключите TON-кошелёк, чтобы дополнить этот экран своими private traces установки."
                              actionLabel="Подключить кошелёк"
                            onConnect={onConnectWallet}
                            icon={Lock}
                            variant="dark"
                            compact
                          />
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : null}
          </section>
        </div>

        <div className="border-t border-white/10 bg-white/[0.025] px-4 py-4 sm:px-6 md:px-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="text-sm text-white/60 sm:max-w-[60%]">
              {walletAddress
                ? (selectedAgentName ? `Целевой агент: ${selectedAgentName}` : 'Выберите целевого агента в панели установки маркетплейса.')
                : 'Подключите кошелёк, чтобы установить эту стратегию в своего user agent.'}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button variant="outline" onClick={onClose} className="h-auto w-full whitespace-normal border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white sm:w-auto">Закрыть</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
