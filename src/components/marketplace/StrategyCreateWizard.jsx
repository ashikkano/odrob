import { useEffect, useMemo, useState } from 'react'
import {
  Wand2,
  Sparkles,
  TrendingUp,
  Radio,
  Layers3,
  ChevronRight,
  ShieldCheck,
  Globe,
  EyeOff,
  Link2,
  Bot,
  Loader2,
  CircleHelp,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import WalletAuthGate from '@/components/wallet/WalletAuthGate'
import { useTranslation } from '@/contexts/LanguageContext'
import {
  createStrategyTemplate,
  createStrategyVersion,
  publishStrategyTemplate,
} from '@/services/strategyMarketplaceApi'
import { cn } from '@/lib/utils'

const DEFAULT_STRATEGY_ROYALTY_SHARE_PCT = 25

const PERSONAS = [
  {
    id: 'mean_reversion',
    icon: '🛡️',
    title: 'Консервативный ревертер',
    type: 'custom',
    category: 'mean-reversion',
    color: '#6ee7b7',
    description: 'Покупает слабость у поддержки и сокращает позицию на отскоке. Подходит, если нужна понятная логика с низким churn.',
    summary: 'Сначала защищает капитал, потом забирает колебания.',
    defaultName: 'Мой Corridor Guard',
    defaults: {
      entryThreshold: -1.15,
      exitThreshold: 1.2,
      maxSpreadPct: 1.1,
      buySizePct: 18,
      sellSizePct: 50,
      confidence: 0.74,
      mode: 'direct',
      risk: 'medium',
    },
    fields: [
      { key: 'entryThreshold', label: 'Покупка на просадке (%)', type: 'number', min: -6, max: 0, step: 0.05 },
      { key: 'exitThreshold', label: 'Продажа на отскоке (%)', type: 'number', min: 0.1, max: 6, step: 0.05 },
      { key: 'maxSpreadPct', label: 'Макс. спред (%)', type: 'number', min: 0.1, max: 5, step: 0.05 },
      { key: 'buySizePct', label: 'Размер покупки (%)', type: 'number', min: 1, max: 100, step: 1 },
      { key: 'sellSizePct', label: 'Размер продажи (%)', type: 'number', min: 1, max: 100, step: 1 },
    ],
    requiredChannels: [{ channelType: 'index', name: 'Index oracle', subscriptionKind: 'trading' }],
    riskDefaults: { maxPositionPct: 26, stopLossPct: 4.5, maxDailyTrades: 8 },
    rotationDefaults: { goalMode: 'conservative', intervalTicks: 60, maxActiveChannels: 2 },
  },
  {
    id: 'momentum',
    icon: '🚀',
    title: 'Охотник за пробоем',
    type: 'custom',
    category: 'momentum',
    color: '#60a5fa',
    description: 'Подключается к расширяющемуся тренду, когда растёт участие. Подходит для выразительных стратегий с высокой уверенностью.',
    summary: 'Быстрые входы, понятный invalidation, средняя сложность.',
    defaultName: 'Мой Breakout Pulse',
    defaults: {
      entryThreshold: 1.6,
      exitThreshold: -0.8,
      maxSpreadPct: 1.8,
      buySizePct: 24,
      sellSizePct: 100,
      confidence: 0.81,
      mode: 'direct',
      risk: 'high',
      minVolume: 300,
    },
    fields: [
      { key: 'entryThreshold', label: 'Триггер пробоя (%)', type: 'number', min: 0.1, max: 8, step: 0.05 },
      { key: 'exitThreshold', label: 'Fail-safe выход (%)', type: 'number', min: -5, max: 0, step: 0.05 },
      { key: 'minVolume', label: 'Мин. объём', type: 'number', min: 10, max: 100000, step: 10 },
      { key: 'buySizePct', label: 'Размер входа (%)', type: 'number', min: 1, max: 100, step: 1 },
      { key: 'maxSpreadPct', label: 'Макс. спред (%)', type: 'number', min: 0.1, max: 5, step: 0.05 },
    ],
    requiredChannels: [{ channelType: 'index', name: 'Index oracle', subscriptionKind: 'trading' }],
    riskDefaults: { maxPositionPct: 34, stopLossPct: 5.5, maxDailyTrades: 12 },
    rotationDefaults: { goalMode: 'aggressive', intervalTicks: 35, maxActiveChannels: 3 },
  },
  {
    id: 'event_driven',
    icon: '📡',
    title: 'Реактор сигналов',
    type: 'custom',
    category: 'event-driven',
    color: '#f59e0b',
    description: 'Торгует только тогда, когда интенсивность feed и реакция рынка совпадают. Подходит для более редких и контекстных стратегий.',
    summary: 'Исполнение от катализаторов с чистым risk-off поведением.',
    defaultName: 'Мой Feed Reactor',
    defaults: {
      entryThreshold: 0.7,
      exitThreshold: -0.35,
      buySizePct: 16,
      sellSizePct: 100,
      confidence: 0.79,
      mode: 'direct',
      risk: 'medium',
      highSeverityCount: 1,
    },
    fields: [
      { key: 'entryThreshold', label: 'Движение катализатора (%)', type: 'number', min: 0.05, max: 5, step: 0.05 },
      { key: 'highSeverityCount', label: 'Число high severity событий', type: 'number', min: 1, max: 10, step: 1 },
      { key: 'buySizePct', label: 'Размер входа (%)', type: 'number', min: 1, max: 100, step: 1 },
      { key: 'confidence', label: 'Уверенность сигнала', type: 'number', min: 0.2, max: 1, step: 0.01 },
    ],
    requiredChannels: [
      { channelType: 'feed', name: 'Index feed', subscriptionKind: 'signal' },
      { channelType: 'creator', name: 'Creator channel', subscriptionKind: 'signal' },
    ],
    riskDefaults: { maxPositionPct: 24, stopLossPct: 6, maxDailyTrades: 10 },
    rotationDefaults: { goalMode: 'balanced', intervalTicks: 28, maxActiveChannels: 5 },
  },
  {
    id: 'liquidity',
    icon: '🌊',
    title: 'Сборщик ликвидности',
    type: 'custom',
    category: 'market-making',
    color: '#a78bfa',
    description: 'Предпочитает пассивные входы и сбор спреда с сильным фокусом на аккуратное исполнение.',
    summary: 'Больше структуры, больше точности, меньше шума.',
    defaultName: 'Мой Liquidity Harvester',
    defaults: {
      entryThreshold: 0.65,
      exitThreshold: 0.2,
      maxSpreadPct: 2.1,
      buySizePct: 14,
      sellSizePct: 38,
      confidence: 0.68,
      mode: 'direct',
      risk: 'medium',
    },
    fields: [
      { key: 'entryThreshold', label: 'Мин. спред для входа (%)', type: 'number', min: 0.05, max: 5, step: 0.05 },
      { key: 'exitThreshold', label: 'Отмена ниже спреда (%)', type: 'number', min: 0.05, max: 2, step: 0.05 },
      { key: 'maxSpreadPct', label: 'Макс. спред (%)', type: 'number', min: 0.1, max: 8, step: 0.05 },
      { key: 'buySizePct', label: 'Размер bid-квоты (%)', type: 'number', min: 1, max: 100, step: 1 },
      { key: 'sellSizePct', label: 'Размер ask-квоты (%)', type: 'number', min: 1, max: 100, step: 1 },
    ],
    requiredChannels: [
      { channelType: 'index', name: 'Index oracle', subscriptionKind: 'trading' },
      { channelType: 'strategy_signal', name: 'Order-book depth', subscriptionKind: 'signal' },
    ],
    riskDefaults: { maxPositionPct: 22, stopLossPct: 3.2, maxDailyTrades: 16 },
    rotationDefaults: { goalMode: 'balanced', intervalTicks: 30, maxActiveChannels: 4 },
  },
  {
    id: 'llm_operator',
    icon: '🧠',
    title: 'LLM Navigator',
    type: 'llm',
    category: 'llm',
    color: '#818cf8',
    description: 'LLM-ready профиль для стратегий, которые ранжируют рынок, сигналы и качество исполнения перед входом.',
    summary: 'Публикуется как LLM strategy template и зарабатывает роялти, когда чужие агенты торгуют через него.',
    defaultName: 'Мой LLM Navigator',
    defaults: {
      entryThreshold: 0.85,
      exitThreshold: -0.55,
      maxSpreadPct: 1.6,
      buySizePct: 18,
      sellSizePct: 100,
      confidence: 0.8,
      mode: 'direct',
      risk: 'medium',
      highSeverityCount: 1,
    },
    fields: [
      { key: 'entryThreshold', label: 'LLM conviction trigger (%)', type: 'number', min: 0.05, max: 6, step: 0.05 },
      { key: 'exitThreshold', label: 'Risk-off trigger (%)', type: 'number', min: -6, max: 0, step: 0.05 },
      { key: 'maxSpreadPct', label: 'Макс. спред (%)', type: 'number', min: 0.1, max: 5, step: 0.05 },
      { key: 'buySizePct', label: 'Размер входа (%)', type: 'number', min: 1, max: 100, step: 1 },
      { key: 'confidence', label: 'Уверенность сигнала', type: 'number', min: 0.2, max: 1, step: 0.01 },
    ],
    requiredChannels: [],
    riskDefaults: { maxPositionPct: 20, stopLossPct: 4.2, maxDailyTrades: 9 },
    rotationDefaults: {},
  },
]

const VISIBILITY_OPTIONS = [
  { id: 'private', label: 'Приватный черновик', icon: EyeOff, description: 'Виден только вам для итераций и тестов.' },
  { id: 'unlisted', label: 'Unlisted', icon: Link2, description: 'Доступен по ссылке, но скрыт из публичного каталога.' },
  { id: 'public', label: 'Опубликовать публично', icon: Globe, description: 'Сразу появится в маркетплейсе.', recommended: true },
]

const STEP_HELP = {
  1: 'Выберите ближайшую persona, чтобы логика стратегии оставалась очевидной.',
  2: 'Дайте понятное имя и описание, чтобы стратегию можно было быстро распознать.',
  3: 'Настройте только те параметры, которые действительно важны.',
  4: 'Выберите видимость, проверьте royalty flow и выпустите первую версию.',
}

const PARAMETER_HELP = {
  entryThreshold: 'Какое движение должно произойти, чтобы стратегия захотела войти в сделку.',
  exitThreshold: 'Подсказывает стратегии, когда сетап уже отработал или держать позицию больше не стоит.',
  minVolume: 'Отсекает слишком пустые рынки и ждёт достаточной активности для более реалистичного исполнения.',
  buySizePct: 'Определяет, какую долю аллокации стратегия тратит на покупку.',
  sellSizePct: 'Определяет, насколько агрессивно стратегия сокращает или закрывает позицию.',
  maxSpreadPct: 'Не даёт стратегии входить в рынки со слишком широким спредом.',
  confidence: 'Минимальный уровень уверенности, с которым стратегия готова действовать.',
  highSeverityCount: 'Сколько сильных событий должно случиться, прежде чем стратегия отреагирует.',
  maxPositionPct: 'Ограничивает, какую долю капитала агента может занять одна позиция.',
  stopLossPct: 'Показывает, насколько позиция может пойти против вас до принудительного выхода.',
  maxDailyTrades: 'Ограничивает число сделок в день, чтобы стратегия не переторговывала.',
  maxPositionAgeMinutes: 'Закрывает слишком старые позиции, если они долго не разрешаются.',
  intervalTicks: 'Как часто стратегия пересматривает активный набор рынков.',
  maxActiveChannels: 'Сколько индексов или feed-каналов стратегия может держать активными одновременно.',
  minChannelLifetimeTicks: 'Не даёт слишком быстро переключаться после новой подписки.',
  churnBudgetPerDay: 'Максимум rotation-переключений, которые стратегия может сделать за день.',
  maxCandidateChannels: 'Сколько рынков разрешено сравнивать перед финальным выбором.',
  weightVolume: 'Чем выше значение, тем сильнее стратегия учитывает объём при ранжировании рынков.',
  weightTrades: 'Чем выше значение, тем сильнее учитывается число недавних сделок.',
  weightHolders: 'Чем выше значение, тем сильнее вознаграждаются индексы с активными держателями.',
  weightOracleMove: 'Чем выше значение, тем важнее движение цены в rotation scoring.',
  weightBandWidth: 'Чем выше значение, тем важнее ширина коридора или диапазона.',
  filterMinVolume: 'Убирает рынки ниже выбранного минимального уровня активности.',
  filterMaxVolatility: 'Убирает рынки, которые слишком хаотичны для выбранного лимита.',
}

function getParameterHelp(key, fallbackLabel) {
  return PARAMETER_HELP[key] || `${fallbackLabel} показывает, насколько сильно эта часть стратегии влияет на поведение.`
}

const GOAL_MODE_OPTIONS = [
  { id: 'balanced', label: 'Balanced', description: 'Смешивает rotation fit, ликвидность и непрерывность работы.' },
  { id: 'aggressive', label: 'Aggressive', description: 'Предпочитает более быстрые и более активные индексы.' },
  { id: 'conservative', label: 'Conservative', description: 'Предпочитает более стабильные индексы и низкий churn.' },
  { id: 'sticky', label: 'Sticky', description: 'Держит подписки дольше, если не появляется явно лучший вариант.' },
]

const CHANNEL_LIBRARY = {
  index: {
    channelType: 'index',
    name: 'Index oracle',
    description: 'Базовая цена, спред и торговый контекст.',
    subscriptionKind: 'trading',
  },
  feed: {
    channelType: 'feed',
    name: 'Index feed',
    description: 'Катализаторы, алерты и событийный контекст.',
    subscriptionKind: 'signal',
  },
  creator: {
    channelType: 'creator',
    name: 'Creator channel',
    description: 'Контекст creator и индексы, завязанные на creator-источник.',
    subscriptionKind: 'signal',
  },
  strategy_signal: {
    channelType: 'strategy_signal',
    name: 'Order-book depth',
    description: 'Дисбаланс глубины стакана и сигналы качества исполнения.',
    subscriptionKind: 'signal',
  },
}

const TUNE_PRESETS = [
  { id: 'safe', label: 'Safe', description: 'Меньший размер, более жёсткое исполнение, более медленные входы.' },
  { id: 'balanced', label: 'Balanced', description: 'Использует defaults persona как понятную середину.' },
  { id: 'aggressive', label: 'Aggressive', description: 'Больший размер и более свободное исполнение для сильных движений.' },
]

const CONFIG_TABS = [
  { id: 'core', label: 'Core' },
  { id: 'risk', label: 'Risk' },
  { id: 'rotation', label: 'Rotation' },
  { id: 'inputs', label: 'Inputs & Filters' },
]

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function formatPreviewValue(field, value) {
  if (field.type === 'number') {
    return Number(value).toFixed(field.step >= 1 ? 0 : 2)
  }
  return String(value)
}

function formatMinutes(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return '—'
  if (numeric >= 60) {
    const hours = numeric / 60
    return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)}h`
  }
  return `${numeric.toFixed(0)}m`
}

function buildRequiredChannels(persona, form) {
  if (persona?.type === 'llm') return []
  const personaChannels = Array.isArray(persona?.requiredChannels) ? persona.requiredChannels : []
  const selectedTypes = Object.keys(CHANNEL_LIBRARY).filter((type) => Boolean(form[`channel_${type}`]))

  return selectedTypes.map((type) => {
    const preset = CHANNEL_LIBRARY[type]
    const existing = personaChannels.find((channel) => channel?.channelType === type)
    return {
      channelType: type,
      name: existing?.name || preset.name,
      description: existing?.description || preset.description,
      subscriptionKind: existing?.subscriptionKind || preset.subscriptionKind,
    }
  })
}

function buildRuntimeRequirements(persona, requiredChannels) {
  if (persona?.type === 'llm') {
    return {
      marketContext: true,
      orderbook: true,
      feed: true,
      sharedCreatorExecution: true,
      inheritsCreatorMemory: true,
      inheritsCreatorLearning: true,
      sharedSignals: true,
    }
  }

  const channelTypes = new Set((requiredChannels || []).map((channel) => channel.channelType))
  return {
    marketContext: channelTypes.has('index') || channelTypes.size === 0,
    orderbook: channelTypes.has('strategy_signal') || channelTypes.has('index'),
    feed: channelTypes.has('feed') || channelTypes.has('creator'),
  }
}

function adjustPresetValue(field, baseValue, presetId) {
  const numericValue = Number(baseValue)
  if (!Number.isFinite(numericValue)) return baseValue

  if (presetId === 'balanced') return numericValue

  const isPercentSize = /size|confidence/i.test(field.key)
  const isSpread = /spread/i.test(field.key)
  const isEntry = /entry/i.test(field.key)
  const isExit = /exit/i.test(field.key)
  const isVolume = /volume|severity/i.test(field.key)

  let nextValue = numericValue
  if (presetId === 'safe') {
    if (isPercentSize) nextValue = numericValue * (field.key === 'confidence' ? 0.92 : 0.78)
    else if (isSpread) nextValue = numericValue * 0.82
    else if (isEntry) nextValue = numericValue >= 0 ? numericValue * 1.15 : numericValue * 1.2
    else if (isExit) nextValue = numericValue >= 0 ? numericValue * 0.82 : numericValue * 0.8
    else if (isVolume) nextValue = numericValue * 1.15
  }

  if (presetId === 'aggressive') {
    if (isPercentSize) nextValue = numericValue * (field.key === 'confidence' ? 1.06 : 1.22)
    else if (isSpread) nextValue = numericValue * 1.18
    else if (isEntry) nextValue = numericValue >= 0 ? numericValue * 0.86 : numericValue * 0.82
    else if (isExit) nextValue = numericValue >= 0 ? numericValue * 1.15 : numericValue * 1.18
    else if (isVolume) nextValue = numericValue * 0.85
  }

  return clamp(nextValue, field.min, field.max)
}

function SliderCard({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  displayValue,
  hint = null,
  className = '',
  help = null,
}) {
  return (
    <div className={cn('rounded-2xl border border-white/10 bg-white/[0.04] p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-white">{label}</label>
            {help ? (
              <HelpTooltipButton label={`Explain ${label}`}>
                {help}
              </HelpTooltipButton>
            ) : null}
          </div>
          {hint ? <div className="mt-1 text-[11px] leading-5 text-white/45">{hint}</div> : null}
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-white/70">{displayValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        className="mt-4 w-full accent-primary"
      />
      <div className="mt-2 flex items-center justify-between text-[11px] text-white/35">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

function SnapshotItem({ label, value, accent = false }) {
  return (
    <div className={cn(
      'rounded-2xl border px-4 py-3',
      accent ? 'border-primary/20 bg-primary/10' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className={cn('text-[11px] uppercase tracking-[0.14em]', accent ? 'text-primary/80' : 'text-white/45')}>{label}</div>
      <div className="mt-1 text-sm font-semibold text-white">{value}</div>
    </div>
  )
}

function HelpTooltipButton({ label, children, className = '' }) {
  const [open, setOpen] = useState(false)

  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={120}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full text-white/35 transition-colors hover:bg-white/8 hover:text-white/70', className)}
          aria-label={label}
          aria-expanded={open}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpen((current) => !current)
          }}
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] leading-5">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

function InlineHelp({ label, children, className = '' }) {
  return (
    <HelpTooltipButton label={label} className={className}>{children}</HelpTooltipButton>
  )
}

function buildRuleDefinition(persona, form) {
  const params = {
    entryThreshold: Number(form.entryThreshold),
    exitThreshold: Number(form.exitThreshold),
    maxSpreadPct: Number(form.maxSpreadPct ?? persona.defaults.maxSpreadPct ?? 1.5),
    buySizePct: Number(form.buySizePct ?? persona.defaults.buySizePct ?? 20),
    sellSizePct: Number(form.sellSizePct ?? persona.defaults.sellSizePct ?? 50),
    confidence: clamp(Number(form.confidence ?? persona.defaults.confidence ?? 0.7), 0.2, 1),
    minVolume: Number(form.minVolume ?? persona.defaults.minVolume ?? 0),
    highSeverityCount: Number(form.highSeverityCount ?? persona.defaults.highSeverityCount ?? 1),
  }

  if (persona.id === 'momentum') {
    return {
      kind: 'rule_v1',
      summary: 'Momentum breakout with participation and spread confirmation.',
      rules: [
        {
          id: 'join-breakout',
          when: {
            all: [
              { source: '$market.oracleChangePct', op: 'gte', value: '$params.entryThreshold' },
              { source: '$market.totalVolume', op: 'gte', value: '$params.minVolume' },
              { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'bestAsk',
            priceOffsetPct: 0.12,
            sizePct: '$params.buySizePct',
            confidence: '$params.confidence',
            reasoning: 'Breakout confirmation is strong enough to join trend continuation.',
          },
        },
        {
          id: 'failed-breakout-exit',
          when: {
            all: [
              { source: '$agent.position', op: 'truthy' },
              { source: '$market.oracleChangePct', op: 'lte', value: '$params.exitThreshold' },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bestBid',
            sizePct: '$params.sellSizePct',
            confidence: '$params.confidence',
            reasoning: 'Momentum failed after entry, so the strategy exits to protect trend capital.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'No clean breakout setup or volume confirmation yet.' },
    }
  }

  if (persona.id === 'event_driven') {
    return {
      kind: 'rule_v1',
      summary: 'Feed-aware catalyst strategy with explicit risk-off behavior.',
      rules: [
        {
          id: 'buy-catalyst',
          when: {
            all: [
              { source: '$feed.severityCounts.high', op: 'gte', value: '$params.highSeverityCount' },
              { source: '$market.oracleChangePct', op: 'gte', value: '$params.entryThreshold' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'latestTrade',
            sizePct: '$params.buySizePct',
            confidence: '$params.confidence',
            reasoning: 'High-severity signal and market confirmation align.',
          },
        },
        {
          id: 'risk-off-feed',
          when: {
            any: [
              { all: [{ source: '$agent.position', op: 'truthy' }, { source: '$feed.severityCounts.critical', op: 'gte', value: 1 }] },
              { all: [{ source: '$agent.position', op: 'truthy' }, { source: '$market.oracleChangePct', op: 'lte', value: '$params.exitThreshold' }] },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bestBid',
            sizePct: '$params.sellSizePct',
            confidence: '$params.confidence',
            reasoning: 'Catalyst deteriorates or price rejects the move, so exposure is reduced quickly.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'Нет режима катализаторов, по которому стоит действовать.' },
    }
  }

  if (persona.id === 'liquidity') {
    return {
      kind: 'rule_v1',
      summary: 'Passive spread harvesting with order-book-aware cleanup.',
      rules: [
        {
          id: 'quote-buy',
          when: {
            all: [
              { source: '$market.spreadPct', op: 'gte', value: '$params.entryThreshold' },
              { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
              { source: '$orderbook.askDepth', op: 'gt', value: '$orderbook.bidDepth' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'bestBid',
            priceOffsetPct: -0.08,
            sizePct: '$params.buySizePct',
            confidence: '$params.confidence',
            reasoning: 'Wide spread and ask-heavy book make passive bidding attractive.',
          },
        },
        {
          id: 'quote-sell',
          when: {
            all: [
              { source: '$agent.position', op: 'truthy' },
              { source: '$market.spreadPct', op: 'gte', value: '$params.entryThreshold' },
              { source: '$orderbook.bidDepth', op: 'gt', value: '$orderbook.askDepth' },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bestAsk',
            priceOffsetPct: 0.08,
            sizePct: '$params.sellSizePct',
            confidence: '$params.confidence',
            reasoning: 'Bid-side support lets the strategy rotate inventory into the spread.',
          },
        },
        {
          id: 'cancel-compressed-spread',
          when: {
            all: [
              { source: '$market.spreadPct', op: 'lte', value: '$params.exitThreshold' },
              { source: '$orderbook.pendingOrders', op: 'truthy' },
            ],
          },
          then: {
            action: 'cancel_stale',
            confidence: 0.55,
            reasoning: 'Spread compressed; stale passive orders should be cleared.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'Spread is not wide enough for harvesting.' },
    }
  }

  if (persona.id === 'llm_operator') {
    return {
      kind: 'rule_v1',
      summary: 'LLM-ready operator that waits for aligned market, feed, and execution-quality signals.',
      rules: [
        {
          id: 'llm-conviction-buy',
          when: {
            all: [
              { source: '$market.oracleChangePct', op: 'gte', value: '$params.entryThreshold' },
              { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
              { source: '$feed.severityCounts.high', op: 'gte', value: '$params.highSeverityCount' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'bestAsk',
            priceOffsetPct: 0.05,
            sizePct: '$params.buySizePct',
            confidence: '$params.confidence',
            reasoning: 'Context, catalyst, and execution quality align strongly enough for an LLM-style conviction entry.',
          },
        },
        {
          id: 'llm-risk-off-sell',
          when: {
            any: [
              {
                all: [
                  { source: '$agent.position', op: 'truthy' },
                  { source: '$market.oracleChangePct', op: 'lte', value: '$params.exitThreshold' },
                ],
              },
              {
                all: [
                  { source: '$agent.position', op: 'truthy' },
                  { source: '$orderbook.askDepth', op: 'gt', value: '$orderbook.bidDepth' },
                ],
              },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bestBid',
            sizePct: '$params.sellSizePct',
            confidence: '$params.confidence',
            reasoning: 'Risk-off exit when market context weakens or execution quality deteriorates.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'LLM-style signal stack is not aligned yet.' },
    }
  }

  return {
    kind: 'rule_v1',
    summary: 'Понятный шаблон mean-reversion с явным контролем спреда и выхода.',
    rules: [
      {
        id: 'buy-pullback',
        when: {
          all: [
            { source: '$market.oracleChangePct', op: 'lte', value: '$params.entryThreshold' },
            { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
          ],
        },
        then: {
          action: 'buy',
          orderType: 'limit',
          priceSource: 'bandLow',
          sizePct: '$params.buySizePct',
          confidence: '$params.confidence',
          reasoning: 'Цена уходит в слабость у нижней границы коридора при контролируемом спреде.',
        },
      },
      {
        id: 'sell-relief',
        when: {
          all: [
            { source: '$agent.position', op: 'truthy' },
            { source: '$market.oracleChangePct', op: 'gte', value: '$params.exitThreshold' },
          ],
        },
        then: {
          action: 'sell',
          orderType: 'limit',
          priceSource: 'bandHigh',
          sizePct: '$params.sellSizePct',
          confidence: '$params.confidence',
          reasoning: 'Отскок дошёл до верхней границы коридора, поэтому прибыль фиксируется системно.',
        },
      },
    ],
    fallback: { action: 'hold', reasoning: 'Ожидание чистого reversion-сетапа.' },
  }
}

function stepReady(step, state) {
  if (step === 1) return !!state.personaId
  if (step === 2) return state.name.trim().length >= 3 && state.slug.trim().length >= 3
  if (step === 3) return true
  return true
}

export default function StrategyCreateWizard({ walletAddress, open, onClose, onCreated, onConnectWallet }) {
  const { t } = useTranslation()
  const [step, setStep] = useState(1)
  const [tunePreset, setTunePreset] = useState('balanced')
  const [configTab, setConfigTab] = useState('core')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const [createdSummary, setCreatedSummary] = useState(null)
  const [form, setForm] = useState({
    personaId: '',
    name: '',
    slug: '',
    shortDescription: '',
    visibility: 'public',
    complexityScore: 42,
    explainabilityScore: 78,
    entryThreshold: '',
    exitThreshold: '',
    maxSpreadPct: '',
    buySizePct: '',
    sellSizePct: '',
    confidence: '',
    minVolume: '',
    highSeverityCount: '',
    maxPositionPct: '',
    stopLossPct: '',
    maxDailyTrades: '',
    maxPositionAgeMinutes: '',
    goalMode: 'balanced',
    intervalTicks: '',
    maxActiveChannels: '',
    minChannelLifetimeTicks: '',
    churnBudgetPerDay: '',
    maxCandidateChannels: '',
    channel_index: false,
    channel_feed: false,
    channel_creator: false,
    channel_strategy_signal: false,
    weightVolume: '',
    weightTrades: '',
    weightHolders: '',
    weightOracleMove: '',
    weightBandWidth: '',
    filterCreationType: 'any',
    filterMinVolume: '',
    filterMaxVolatility: '',
  })

  const personas = useMemo(() => PERSONAS.map((item) => ({
    ...item,
    title: t(`strategyWizard.persona.${item.id}.title`),
    description: t(`strategyWizard.persona.${item.id}.description`),
    summary: t(`strategyWizard.persona.${item.id}.summary`),
    defaultName: t(`strategyWizard.persona.${item.id}.defaultName`),
    fields: (item.fields || []).map((field) => ({
      ...field,
      label: t(`strategyWizard.persona.${item.id}.field.${field.key}`),
    })),
  })), [t])
  const visibilityOptions = useMemo(() => VISIBILITY_OPTIONS.map((item) => ({
    ...item,
    label: t(`strategyWizard.visibility.${item.id}.label`),
    description: t(`strategyWizard.visibility.${item.id}.description`),
  })), [t])
  const tunePresets = useMemo(() => TUNE_PRESETS.map((item) => ({
    ...item,
    label: t(`strategyWizard.tune.${item.id}.label`),
    description: t(`strategyWizard.tune.${item.id}.description`),
  })), [t])
  const goalModeOptions = useMemo(() => GOAL_MODE_OPTIONS.map((item) => ({
    ...item,
    label: t(`strategyWizard.goalMode.${item.id}.label`),
    description: t(`strategyWizard.goalMode.${item.id}.description`),
  })), [t])
  const configTabs = useMemo(() => CONFIG_TABS.map((item) => ({
    ...item,
    label: t(`strategyWizard.configTab.${item.id}`),
  })), [t])
  const stepHelp = useMemo(() => ({
    1: t('strategyWizard.stepHelp.1'),
    2: t('strategyWizard.stepHelp.2'),
    3: t('strategyWizard.stepHelp.3'),
    4: t('strategyWizard.stepHelp.4'),
  }), [t])
  const persona = useMemo(() => personas.find((item) => item.id === form.personaId) || null, [form.personaId, personas])
  const isLlmPersona = persona?.type === 'llm'
  const visibleConfigTabs = useMemo(
    () => (isLlmPersona ? configTabs.filter((item) => item.id === 'core' || item.id === 'risk') : configTabs),
    [configTabs, isLlmPersona]
  )
  const steps = useMemo(() => [
    { num: 1, label: t('strategyWizard.step.persona') },
    { num: 2, label: t('strategyWizard.step.positioning') },
    { num: 3, label: t('strategyWizard.step.configuration') },
    { num: 4, label: t('strategyWizard.step.publish') },
  ], [t])

  useEffect(() => {
    if (!open) return
    setError(null)
    setCreatedSummary(null)
    setConfigTab('core')
  }, [open])

  useEffect(() => {
    if (step !== 3) setConfigTab('core')
  }, [step])

  useEffect(() => {
    if (!visibleConfigTabs.some((item) => item.id === configTab)) {
      setConfigTab('core')
    }
  }, [configTab, visibleConfigTabs])

  useEffect(() => {
    if (!persona) return
    setTunePreset('balanced')
    setForm((prev) => {
      const nextName = prev.name || persona.defaultName
      return {
        ...prev,
        type: persona.type,
        category: persona.category,
        name: nextName,
        slug: prev.slug || slugify(nextName),
        shortDescription: prev.shortDescription || persona.description,
        entryThreshold: prev.entryThreshold !== '' ? prev.entryThreshold : persona.defaults.entryThreshold,
        exitThreshold: prev.exitThreshold !== '' ? prev.exitThreshold : persona.defaults.exitThreshold,
        maxSpreadPct: prev.maxSpreadPct !== '' ? prev.maxSpreadPct : (persona.defaults.maxSpreadPct ?? ''),
        buySizePct: prev.buySizePct !== '' ? prev.buySizePct : (persona.defaults.buySizePct ?? ''),
        sellSizePct: prev.sellSizePct !== '' ? prev.sellSizePct : (persona.defaults.sellSizePct ?? ''),
        confidence: prev.confidence !== '' ? prev.confidence : (persona.defaults.confidence ?? ''),
        minVolume: prev.minVolume !== '' ? prev.minVolume : (persona.defaults.minVolume ?? ''),
        highSeverityCount: prev.highSeverityCount !== '' ? prev.highSeverityCount : (persona.defaults.highSeverityCount ?? ''),
        maxPositionPct: prev.maxPositionPct !== '' ? prev.maxPositionPct : (persona.riskDefaults?.maxPositionPct ?? ''),
        stopLossPct: prev.stopLossPct !== '' ? prev.stopLossPct : (persona.riskDefaults?.stopLossPct ?? ''),
        maxDailyTrades: prev.maxDailyTrades !== '' ? prev.maxDailyTrades : (persona.riskDefaults?.maxDailyTrades ?? ''),
        maxPositionAgeMinutes: prev.maxPositionAgeMinutes !== ''
          ? prev.maxPositionAgeMinutes
          : (Number.isFinite(Number(persona.riskDefaults?.maxPositionAgeMs)) ? Number(persona.riskDefaults.maxPositionAgeMs) / 60000 : 30),
        goalMode: prev.goalMode || persona.rotationDefaults?.goalMode || 'balanced',
        intervalTicks: prev.intervalTicks !== '' ? prev.intervalTicks : (persona.rotationDefaults?.intervalTicks ?? ''),
        maxActiveChannels: prev.maxActiveChannels !== '' ? prev.maxActiveChannels : (persona.rotationDefaults?.maxActiveChannels ?? ''),
        minChannelLifetimeTicks: prev.minChannelLifetimeTicks !== '' ? prev.minChannelLifetimeTicks : (persona.rotationDefaults?.minChannelLifetimeTicks ?? 20),
        churnBudgetPerDay: prev.churnBudgetPerDay !== '' ? prev.churnBudgetPerDay : (persona.rotationDefaults?.churnBudgetPerDay ?? 6),
        maxCandidateChannels: prev.maxCandidateChannels !== '' ? prev.maxCandidateChannels : (persona.rotationDefaults?.maxCandidateChannels ?? 12),
        channel_index: prev.channel_index || persona.requiredChannels?.some((channel) => channel.channelType === 'index') || false,
        channel_feed: prev.channel_feed || persona.requiredChannels?.some((channel) => channel.channelType === 'feed') || false,
        channel_creator: prev.channel_creator || persona.requiredChannels?.some((channel) => channel.channelType === 'creator') || false,
        channel_strategy_signal: prev.channel_strategy_signal || persona.requiredChannels?.some((channel) => channel.channelType === 'strategy_signal') || false,
        weightVolume: prev.weightVolume !== '' ? prev.weightVolume : (persona.rotationDefaults?.scoreWeights?.volume ?? 0),
        weightTrades: prev.weightTrades !== '' ? prev.weightTrades : (persona.rotationDefaults?.scoreWeights?.trades ?? 0),
        weightHolders: prev.weightHolders !== '' ? prev.weightHolders : (persona.rotationDefaults?.scoreWeights?.holders ?? 0),
        weightOracleMove: prev.weightOracleMove !== '' ? prev.weightOracleMove : (persona.rotationDefaults?.scoreWeights?.oracleMove ?? 0),
        weightBandWidth: prev.weightBandWidth !== '' ? prev.weightBandWidth : (persona.rotationDefaults?.scoreWeights?.bandWidth ?? 0),
        filterCreationType: prev.filterCreationType || persona.rotationDefaults?.filters?.creationType || 'any',
        filterMinVolume: prev.filterMinVolume !== '' ? prev.filterMinVolume : (persona.rotationDefaults?.filters?.minVolume ?? 0),
        filterMaxVolatility: prev.filterMaxVolatility !== '' ? prev.filterMaxVolatility : (persona.rotationDefaults?.filters?.maxVolatility ?? 0),
        complexityScore: prev.complexityScore || 42,
        explainabilityScore: prev.explainabilityScore || 78,
      }
    })
  }, [persona])

  const accentColor = persona?.color || '#818cf8'
  const selectedVisibility = visibilityOptions.find((item) => item.id === form.visibility)
  const ruleDefinition = persona ? buildRuleDefinition(persona, form) : null
  const requiredChannels = useMemo(() => buildRequiredChannels(persona, form), [persona, form])
  const royaltySharePct = DEFAULT_STRATEGY_ROYALTY_SHARE_PCT
  const parameterSchema = persona ? {
    defaults: {
      entryThreshold: Number(form.entryThreshold),
      exitThreshold: Number(form.exitThreshold),
      maxSpreadPct: Number(form.maxSpreadPct || persona.defaults.maxSpreadPct || 0),
      buySizePct: Number(form.buySizePct || persona.defaults.buySizePct || 0),
      sellSizePct: Number(form.sellSizePct || persona.defaults.sellSizePct || 0),
      confidence: Number(form.confidence || persona.defaults.confidence || 0.7),
      minVolume: Number(form.minVolume || persona.defaults.minVolume || 0),
      highSeverityCount: Number(form.highSeverityCount || persona.defaults.highSeverityCount || 1),
    },
    fields: persona?.fields || [],
  } : null
  const riskDefaults = persona ? {
    maxPositionPct: Number(form.maxPositionPct || persona.riskDefaults?.maxPositionPct || 0),
    stopLossPct: Number(form.stopLossPct || persona.riskDefaults?.stopLossPct || 0),
    maxDailyTrades: Number(form.maxDailyTrades || persona.riskDefaults?.maxDailyTrades || 0),
    maxPositionAgeMs: Math.max(1, Number(form.maxPositionAgeMinutes || 0)) * 60 * 1000,
  } : null
  const rotationDefaults = persona ? (isLlmPersona ? {} : {
    goalMode: form.goalMode || persona.rotationDefaults?.goalMode || 'balanced',
    intervalTicks: Number(form.intervalTicks || persona.rotationDefaults?.intervalTicks || 40),
    maxActiveChannels: Number(form.maxActiveChannels || persona.rotationDefaults?.maxActiveChannels || 2),
    minChannelLifetimeTicks: Number(form.minChannelLifetimeTicks || persona.rotationDefaults?.minChannelLifetimeTicks || 20),
    churnBudgetPerDay: Number(form.churnBudgetPerDay || persona.rotationDefaults?.churnBudgetPerDay || 6),
    maxCandidateChannels: Number(form.maxCandidateChannels || persona.rotationDefaults?.maxCandidateChannels || 12),
    scoreWeights: {
      volume: Number(form.weightVolume || 0),
      trades: Number(form.weightTrades || 0),
      holders: Number(form.weightHolders || 0),
      oracleMove: Number(form.weightOracleMove || 0),
      bandWidth: Number(form.weightBandWidth || 0),
    },
    filters: {
      ...(form.filterCreationType && form.filterCreationType !== 'any' ? { creationType: form.filterCreationType } : {}),
      ...(Number(form.filterMinVolume || 0) > 0 ? { minVolume: Number(form.filterMinVolume) } : {}),
      ...(Number(form.filterMaxVolatility || 0) > 0 ? { maxVolatility: Number(form.filterMaxVolatility) } : {}),
    },
  }) : null
  const runtimeRequirements = useMemo(() => buildRuntimeRequirements(persona, requiredChannels), [persona, requiredChannels])

  if (!open) return null

  const canContinue = stepReady(step, form)
  const progressPct = Math.round((step / steps.length) * 100)

  const getLocalizedParameterHelp = (key, fallbackLabel) => {
    const translationKey = `strategyWizard.paramHelp.${key}`
    const value = t(translationKey)
    return value === translationKey
      ? `${fallbackLabel} shows how strongly this part of the strategy affects behavior.`
      : value
  }

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const applyTunePreset = (presetId) => {
    if (!persona) return
    setTunePreset(presetId)
    setForm((prev) => {
      const next = { ...prev }
      for (const field of persona.fields || []) {
        const baseValue = persona.defaults?.[field.key] ?? prev[field.key]
        next[field.key] = adjustPresetValue(field, baseValue, presetId)
      }
      return next
    })
  }

  const handleNameChange = (value) => {
    setForm((prev) => {
      const autoSlug = prev.slug === '' || prev.slug === slugify(prev.name)
      return {
        ...prev,
        name: value,
        slug: autoSlug ? slugify(value) : prev.slug,
      }
    })
  }

  const handleCreate = async () => {
    if (!persona || !walletAddress) return
    setCreating(true)
    setError(null)
    try {
      const template = await createStrategyTemplate({
        slug: form.slug,
        name: form.name.trim(),
        shortDescription: form.shortDescription.trim(),
        category: persona.category,
        type: persona.type,
        visibility: form.visibility,
        complexityScore: Number(form.complexityScore),
        explainabilityScore: Number(form.explainabilityScore),
      })

      const version = await createStrategyVersion(template.id, {
        changelog: t('strategyWizard.changelogInitial', { persona: persona.title }),
        definition: ruleDefinition,
        parameterSchema,
        triggerSchema: {
          wizardPersona: persona.id,
          importantSignals: ['oracleChangePct', 'spreadPct', 'volatility', 'feedSeverity', 'depthImbalance'],
        },
        requiredChannels,
        runtimeRequirements,
        riskDefaults,
        rotationDefaults,
      })

      let listing = null
      if (form.visibility === 'public') {
        listing = await publishStrategyTemplate(template.id, {
          currentVersionId: version.id,
          priceMode: 'free',
          rankingScore: Number(form.complexityScore) + Number(form.explainabilityScore) / 2,
          verifiedBadge: false,
        })
      }

      const result = { template, version, listing, visibility: form.visibility }
      setCreatedSummary(result)
      onCreated?.(result)
    } catch (err) {
      const details = Array.isArray(err?.details) && err.details.length > 0
        ? `\n${err.details.map((item) => `• ${item.field}: ${item.message}`).join('\n')}`
        : ''
      setError(`${err.message || t('strategyWizard.errorCreate')}${details}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-2 py-2 backdrop-blur-md sm:px-4 sm:py-4" onClick={onClose}>
      <div
        className="relative flex max-h-[96vh] w-full max-w-6xl flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.98),rgba(10,14,26,0.97))] shadow-[0_40px_120px_rgba(0,0,0,0.55)] sm:max-h-[92vh] sm:rounded-[28px]"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex-1 overflow-auto">
        <div className="sticky top-0 z-20 relative overflow-hidden border-b border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(10,14,26,0.94))] px-4 py-4 backdrop-blur-xl sm:px-6 sm:py-5 md:px-8 md:py-5">
          <div className="absolute inset-0" style={{ background: `radial-gradient(circle at top right, ${accentColor}2a, transparent 32%)` }} />
          <div className="relative flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white">
                    <Wand2 className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-col gap-0.5 md:flex-row md:items-center md:gap-3">
                      <h3 className="truncate text-lg font-semibold tracking-tight text-white sm:text-xl">{t('strategyWizard.title')}</h3>
                      <p className="hidden min-w-0 truncate text-xs leading-5 text-white/55 md:block">{t('strategyWizard.subtitle')}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 lg:min-w-[220px]">
                <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-[0.18em] text-white/45">
                  <span>{t('strategyWizard.progressLabel')}</span>
                  <span>{t('strategyWizard.stepCounter', { current: step, total: steps.length })}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10 shadow-inner shadow-black/20">
                  <div className="h-full rounded-full transition-all duration-300" style={{ width: `${progressPct}%`, background: `linear-gradient(90deg, ${accentColor}, rgba(255,255,255,0.92))` }} />
                </div>
                <div className="inline-flex items-center gap-2 text-xs text-white/65">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>{t('strategyWizard.progressBadge', { progress: progressPct })}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {steps.map((item) => (
                <button
                  key={item.num}
                  type="button"
                  disabled={step < item.num}
                  onClick={() => { if (step > item.num) setStep(item.num) }}
                  className={cn(
                    'group flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2.5 text-left transition-all duration-200 lg:min-h-[68px]',
                    step === item.num
                      ? 'border-primary/60 bg-primary/12 text-white shadow-[0_0_0_1px_rgba(99,102,241,0.18)]'
                      : step > item.num
                        ? 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-100 hover:border-emerald-300/40'
                        : 'border-white/10 bg-white/[0.03] text-white/55'
                  )}
                >
                  <span className={cn(
                    'inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-2 text-xs font-semibold',
                    step === item.num
                      ? 'bg-primary text-primary-foreground'
                      : step > item.num
                        ? 'bg-emerald-400/20 text-emerald-200'
                        : 'bg-white/10 text-white/70'
                  )}>
                    {step > item.num ? '✓' : item.num}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={cn(
                      'text-[10px] uppercase tracking-[0.16em]',
                      step === item.num ? 'text-white/55' : 'text-white/35'
                    )}>{t('strategyWizard.stepLabel', { step: item.num })}</div>
                    <div className="mt-0.5 truncate text-[13px] font-medium leading-5 sm:text-sm">{item.label}</div>
                  </div>
                  <span className={cn(
                    'hidden h-px w-6 shrink-0 rounded-full lg:block',
                      step === item.num
                      ? 'bg-primary/45'
                        : step > item.num
                        ? 'bg-emerald-300/40'
                        : 'bg-white/10'
                  )} />
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="px-4 py-5 sm:px-6 sm:py-6 md:px-8">
          {!walletAddress ? (
            <WalletAuthGate
              title={t('strategyWizard.walletGate.title')}
              description={t('strategyWizard.walletGate.description')}
              actionLabel={t('strategyWizard.walletGate.action')}
              onConnect={onConnectWallet}
              icon={Bot}
              variant="dark"
              className="rounded-3xl p-8"
            />
          ) : createdSummary ? (
            <div className="space-y-6">
              <div className="rounded-3xl border border-emerald-400/20 bg-emerald-400/[0.08] p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-400/15 text-emerald-300">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <h4 className="text-lg font-semibold text-white">{t('strategyWizard.success.title')}</h4>
                    <p className="mt-2 text-sm text-white/70">
                      {createdSummary.visibility === 'public'
                        ? t('strategyWizard.success.publicDescription')
                        : t('strategyWizard.success.draftDescription')}
                    </p>
                    <p className="mt-2 text-xs text-white/55">{t('strategyWizard.success.revenueHint')}</p>
                  </div>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
                  <div className="text-xs uppercase tracking-[0.16em] text-white/45">{t('strategyWizard.success.template')}</div>
                  <div className="mt-2 text-xl font-semibold text-white">{createdSummary.template.name}</div>
                  <div className="mt-1 text-sm text-white/60">@{createdSummary.template.slug}</div>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
                  <div className="text-xs uppercase tracking-[0.16em] text-white/45">{t('strategyWizard.success.release')}</div>
                  <div className="mt-2 text-xl font-semibold text-white">{t('strategyWizard.success.version', { version: createdSummary.version.versionNumber })}</div>
                  <div className="mt-1 text-sm text-white/60">{t('strategyWizard.success.visibility', { visibility: createdSummary.visibility })}</div>
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <Button variant="outline" onClick={onClose} className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white">{t('strategyWizard.success.closeAndReview')}</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/65">
                {stepHelp[step]}
              </div>

              {step === 1 ? (
                <div className="space-y-5">
                  <div>
                    <h4 className="text-lg font-semibold text-white">{t('strategyWizard.personaSection.title')}</h4>
                    <p className="mt-1 text-sm text-white/60">{t('strategyWizard.personaSection.description')}</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    {personas.map((item) => {
                      const selected = form.personaId === item.id
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setField('personaId', item.id)}
                          className={cn(
                            'group relative overflow-hidden rounded-3xl border p-5 text-left transition-all duration-300 ease-out hover:-translate-y-1',
                            selected
                              ? 'border-primary bg-white/[0.06] shadow-[0_20px_50px_rgba(99,102,241,0.2)] ring-1 ring-primary/25'
                              : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05] hover:shadow-[0_18px_50px_rgba(15,23,42,0.28)]'
                          )}
                        >
                          <div className={cn(
                            'pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300',
                            selected
                              ? 'bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.16),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(56,189,248,0.10),transparent_26%)] opacity-100'
                              : 'bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.08),transparent_24%)] group-hover:opacity-100'
                          )} />
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-3xl transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-3">{item.icon}</div>
                              <div className="mt-3 text-lg font-semibold text-white">{item.title}</div>
                            </div>
                            <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{item.category}</Badge>
                          </div>
                          <p className="relative mt-3 text-sm text-white/65">{item.description}</p>
                          <div className="relative mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/72 transition-colors duration-300 group-hover:bg-white/[0.05]">
                            {item.summary}
                          </div>
                          <div className="relative mt-3 flex flex-wrap gap-2 text-xs">
                            <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{t('strategyWizard.badge.directExecution')}</Badge>
                            <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{item.defaults.risk === 'high' ? t('strategyWizard.badge.highRisk') : t('strategyWizard.badge.mediumRisk')}</Badge>
                            <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{t('strategyWizard.badge.controls', { count: item.fields.length })}</Badge>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                  <div className="space-y-4">
                    <div>
                      <h4 className="text-lg font-semibold text-white">{t('strategyWizard.positioning.title')}</h4>
                      <p className="mt-1 text-sm text-white/60">{t('strategyWizard.positioning.description')}</p>
                    </div>
                    <div className="space-y-4">
                      <div>
                        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-white/50">{t('strategyWizard.positioning.nameLabel')}</label>
                        <input
                          className="flex h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-colors focus:border-primary"
                          value={form.name}
                          onChange={(event) => handleNameChange(event.target.value)}
                          placeholder={t('strategyWizard.positioning.namePlaceholder')}
                          maxLength={80}
                          autoFocus
                        />
                        <div className="mt-2 flex items-center justify-between text-xs text-white/45">
                          <span>{t('strategyWizard.positioning.nameHint')}</span>
                          <span>{form.name.length}/80</span>
                        </div>
                      </div>
                      <div>
                        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-white/50">{t('strategyWizard.positioning.slugLabel')}</label>
                        <input
                          className="flex h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-colors focus:border-primary"
                          value={form.slug}
                          onChange={(event) => setField('slug', slugify(event.target.value))}
                          placeholder="night-corridor-guard"
                        />
                        <div className="mt-2 text-xs text-white/45">{t('strategyWizard.positioning.slugHint')}</div>
                      </div>
                      <div>
                        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-white/50">{t('strategyWizard.positioning.descriptionLabel')}</label>
                        <textarea
                          className="min-h-[120px] w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-primary"
                          value={form.shortDescription}
                          onChange={(event) => setField('shortDescription', event.target.value)}
                          placeholder={t('strategyWizard.positioning.descriptionPlaceholder')}
                          maxLength={500}
                        />
                        <div className="mt-2 flex items-center justify-between text-xs text-white/45">
                          <span>{t('strategyWizard.positioning.descriptionHint')}</span>
                          <span>{form.shortDescription.length}/500</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                    <div className="text-xs uppercase tracking-[0.16em] text-white/45">{t('strategyWizard.positioning.preview')}</div>
                    <div className="mt-4 rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-3xl">{persona?.icon || '✨'}</div>
                          <div className="mt-3 text-xl font-semibold text-white">{form.name || t('strategyWizard.positioning.defaultName')}</div>
                          <div className="mt-1 text-sm text-white/55">@{form.slug || 'strategy-slug'}</div>
                        </div>
                        <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{persona?.type || 'custom'}</Badge>
                      </div>
                      <p className="mt-4 text-sm leading-6 text-white/68">{form.shortDescription || persona?.description || t('strategyWizard.positioning.defaultDescription')}</p>
                    </div>
                  </div>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
                  <div className="order-2 space-y-5 xl:order-1">
                    <div>
                      <h4 className="text-lg font-semibold text-white">{t('strategyWizard.configuration.title')}</h4>
                      <p className="mt-1 text-sm text-white/60">{isLlmPersona ? t('strategyWizard.configuration.llmDescription') : t('strategyWizard.configuration.description')}</p>
                    </div>
                    <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-white/45">{t('strategyWizard.configuration.moduleTitle')}</div>
                          <div className="mt-1 text-sm text-white/60">{t('strategyWizard.configuration.moduleDescription')}</div>
                        </div>
                        <Badge variant="outline" className="w-fit border-white/15 bg-white/[0.04] text-white">{persona?.title || t('strategyWizard.configuration.personaFallback')}</Badge>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {visibleConfigTabs.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setConfigTab(item.id)}
                            className={cn(
                              'rounded-full border px-3 py-2 text-sm transition-colors',
                              configTab === item.id
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/[0.08]'
                            )}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {configTab === 'core' ? (
                      <>
                        <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <div className="text-xs uppercase tracking-[0.16em] text-white/45">{t('strategyWizard.quickPresets.title')}</div>
                              <div className="mt-1 text-sm text-white/60">{t('strategyWizard.quickPresets.description')}</div>
                            </div>
                            <Badge variant="outline" className="w-fit border-white/15 bg-white/[0.04] text-white">{persona?.title || t('strategyWizard.configuration.personaFallback')}</Badge>
                          </div>
                          <div className="mt-4 grid gap-2 lg:grid-cols-3">
                                {tunePresets.map((preset) => (
                              <button
                                key={preset.id}
                                type="button"
                                onClick={() => applyTunePreset(preset.id)}
                                className={cn(
                                  'rounded-2xl border px-4 py-3 text-left transition-colors',
                                  tunePreset === preset.id
                                    ? 'border-primary bg-primary/12 text-primary'
                                    : 'border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.08]'
                                )}
                              >
                                <div className="font-medium">{preset.label}</div>
                                <div className="mt-1 text-xs text-inherit/80">{preset.description}</div>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                          {(persona?.fields || []).map((field) => (
                            <SliderCard
                              key={field.key}
                              label={field.label}
                              value={Number(form[field.key])}
                              min={field.min}
                              max={field.max}
                              step={field.step}
                              displayValue={formatPreviewValue(field, form[field.key])}
                              help={getLocalizedParameterHelp(field.key, field.label)}
                              onChange={(event) => setField(field.key, Number(event.target.value))}
                            />
                          ))}
                        </div>
                      </>
                    ) : null}

                    {configTab === 'risk' ? (
                      <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                        <div>
                          <h5 className="text-sm font-semibold text-white">{t('strategyWizard.risk.title')}</h5>
                          <p className="mt-1 text-xs text-white/55">{isLlmPersona ? t('strategyWizard.risk.llmDescription') : t('strategyWizard.risk.description')}</p>
                        </div>
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          <SliderCard
                            label={t('strategyWizard.risk.maxPosition')}
                            value={Number(form.maxPositionPct || 0)}
                            min={1}
                            max={100}
                            step={1}
                            displayValue={`${Number(form.maxPositionPct || 0).toFixed(0)}%`}
                            hint={t('strategyWizard.risk.maxPositionHint')}
                            help={getLocalizedParameterHelp('maxPositionPct', t('strategyWizard.risk.maxPosition'))}
                            onChange={(event) => setField('maxPositionPct', Number(event.target.value))}
                          />
                          <SliderCard
                            label={t('strategyWizard.risk.stopLoss')}
                            value={Number(form.stopLossPct || 0)}
                            min={1}
                            max={20}
                            step={0.1}
                            displayValue={`-${Number(form.stopLossPct || 0).toFixed(1)}%`}
                            hint={t('strategyWizard.risk.stopLossHint')}
                            help={getLocalizedParameterHelp('stopLossPct', t('strategyWizard.risk.stopLoss'))}
                            onChange={(event) => setField('stopLossPct', Number(event.target.value))}
                          />
                          <SliderCard
                            label={t('strategyWizard.risk.maxDailyTrades')}
                            value={Number(form.maxDailyTrades || 0)}
                            min={1}
                            max={40}
                            step={1}
                            displayValue={Number(form.maxDailyTrades || 0).toFixed(0)}
                            hint={t('strategyWizard.risk.maxDailyTradesHint')}
                            help={getLocalizedParameterHelp('maxDailyTrades', t('strategyWizard.risk.maxDailyTrades'))}
                            onChange={(event) => setField('maxDailyTrades', Number(event.target.value))}
                          />
                          <SliderCard
                            label={t('strategyWizard.risk.positionTimeout')}
                            value={Number(form.maxPositionAgeMinutes || 0)}
                            min={5}
                            max={180}
                            step={5}
                            displayValue={formatMinutes(form.maxPositionAgeMinutes)}
                            hint={t('strategyWizard.risk.positionTimeoutHint')}
                            help={getLocalizedParameterHelp('maxPositionAgeMinutes', t('strategyWizard.risk.positionTimeout'))}
                            onChange={(event) => setField('maxPositionAgeMinutes', Number(event.target.value))}
                          />
                        </div>
                      </div>
                    ) : null}

                    {configTab === 'rotation' ? (
                      <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                        <div>
                          <h5 className="text-sm font-semibold text-white">{t('strategyWizard.rotation.title')}</h5>
                          <p className="mt-1 text-xs text-white/55">{t('strategyWizard.rotation.description')}</p>
                        </div>
                        <div className="mt-4 space-y-4">
                          <div>
                            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-white/45">
                              <span>{t('strategyWizard.rotation.goalMode')}</span>
                              <InlineHelp label="Объяснить goal mode">
                                {t('strategyWizard.rotation.goalModeHelp')}
                              </InlineHelp>
                            </div>
                            <div className="grid gap-2">
                              {goalModeOptions.map((option) => (
                                <button
                                  key={option.id}
                                  type="button"
                                  onClick={() => setField('goalMode', option.id)}
                                  className={cn(
                                    'rounded-2xl border px-4 py-3 text-left transition-colors',
                                    form.goalMode === option.id
                                      ? 'border-primary bg-primary/12 text-primary'
                                      : 'border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/[0.08]'
                                  )}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="font-medium">{option.label}</div>
                                    <InlineHelp label={`Explain ${option.label} goal mode`} className="mt-0.5 shrink-0">
                                      {option.description}
                                    </InlineHelp>
                                  </div>
                                  <div className="mt-1 text-xs text-inherit/80">{option.description}</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <SliderCard
                              label={t('strategyWizard.rotation.intervalTicks')}
                              value={Number(form.intervalTicks || 0)}
                              min={5}
                              max={180}
                              step={1}
                              displayValue={Number(form.intervalTicks || 0).toFixed(0)}
                              hint={t('strategyWizard.rotation.intervalTicksHint')}
                              help={getLocalizedParameterHelp('intervalTicks', t('strategyWizard.rotation.intervalTicks'))}
                              onChange={(event) => setField('intervalTicks', Number(event.target.value))}
                            />
                            <SliderCard
                              label={t('strategyWizard.rotation.maxActiveChannels')}
                              value={Number(form.maxActiveChannels || 0)}
                              min={1}
                              max={8}
                              step={1}
                              displayValue={Number(form.maxActiveChannels || 0).toFixed(0)}
                              hint={t('strategyWizard.rotation.maxActiveChannelsHint')}
                              help={getLocalizedParameterHelp('maxActiveChannels', t('strategyWizard.rotation.maxActiveChannels'))}
                              onChange={(event) => setField('maxActiveChannels', Number(event.target.value))}
                            />
                            <SliderCard
                              label={t('strategyWizard.rotation.minChannelLifetimeTicks')}
                              value={Number(form.minChannelLifetimeTicks || 0)}
                              min={5}
                              max={120}
                              step={1}
                              displayValue={`${Number(form.minChannelLifetimeTicks || 0).toFixed(0)} ticks`}
                              hint={t('strategyWizard.rotation.minChannelLifetimeTicksHint')}
                              help={getLocalizedParameterHelp('minChannelLifetimeTicks', t('strategyWizard.rotation.minChannelLifetimeTicks'))}
                              onChange={(event) => setField('minChannelLifetimeTicks', Number(event.target.value))}
                            />
                            <SliderCard
                              label={t('strategyWizard.rotation.churnBudgetPerDay')}
                              value={Number(form.churnBudgetPerDay || 0)}
                              min={0}
                              max={20}
                              step={1}
                              displayValue={Number(form.churnBudgetPerDay || 0).toFixed(0)}
                              hint={t('strategyWizard.rotation.churnBudgetPerDayHint')}
                              help={getLocalizedParameterHelp('churnBudgetPerDay', t('strategyWizard.rotation.churnBudgetPerDay'))}
                              onChange={(event) => setField('churnBudgetPerDay', Number(event.target.value))}
                            />
                            <SliderCard
                              label={t('strategyWizard.rotation.maxCandidateChannels')}
                              value={Number(form.maxCandidateChannels || 0)}
                              min={4}
                              max={40}
                              step={1}
                              displayValue={`${Number(form.maxCandidateChannels || 0).toFixed(0)} indexes`}
                              hint={t('strategyWizard.rotation.maxCandidateChannelsHint')}
                              className="md:col-span-2"
                              help={getLocalizedParameterHelp('maxCandidateChannels', t('strategyWizard.rotation.maxCandidateChannels'))}
                              onChange={(event) => setField('maxCandidateChannels', Number(event.target.value))}
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {configTab === 'inputs' ? (
                      <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                        <div>
                          <h5 className="text-sm font-semibold text-white">{t('strategyWizard.inputs.title')}</h5>
                          <p className="mt-1 text-xs text-white/55">{t('strategyWizard.inputs.description')}</p>
                        </div>

                        <div className="mt-4 grid gap-6 2xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
                          <div>
                            <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-white/45">
                              <span>{t('strategyWizard.inputs.requiredChannels')}</span>
                              <InlineHelp label="Объяснить required channels">
                                {t('strategyWizard.inputs.requiredChannelsHelp')}
                              </InlineHelp>
                            </div>
                            <div className="grid gap-2">
                              {Object.entries(CHANNEL_LIBRARY).map(([key, channel]) => {
                                const enabled = Boolean(form[`channel_${key}`])
                                return (
                                  <button
                                    key={key}
                                    type="button"
                                    onClick={() => setField(`channel_${key}`, !enabled)}
                                    className={cn(
                                      'rounded-2xl border px-4 py-3 text-left transition-colors',
                                      enabled
                                        ? 'border-primary bg-primary/12 text-primary'
                                        : 'border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/[0.08]'
                                    )}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="flex items-center gap-2">
                                        <div className="font-medium">{channel.name}</div>
                                        <InlineHelp label={`Explain ${channel.name}`} className="shrink-0">
                                          {channel.description} {t('strategyWizard.inputs.channelKind', { kind: channel.subscriptionKind })}
                                        </InlineHelp>
                                      </div>
                                      <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-current">{channel.subscriptionKind}</Badge>
                                    </div>
                                    <div className="mt-1 text-xs text-inherit/80">{channel.description}</div>
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          <div className="space-y-4">
                            <div>
                              <div className="mb-3 text-xs uppercase tracking-[0.14em] text-white/45">{t('strategyWizard.inputs.rotationWeights')}</div>
                              <div className="grid gap-3 md:grid-cols-2">
                                {[
                                  ['weightVolume', 'Вес объёма'],
                                  ['weightTrades', 'Вес сделок'],
                                  ['weightHolders', 'Вес держателей'],
                                  ['weightOracleMove', 'Вес движения'],
                                  ['weightBandWidth', 'Вес ширины диапазона'],
                                ].map(([key, label]) => (
                                  <SliderCard
                                    key={key}
                                    label={label}
                                    value={Number(form[key] || 0)}
                                    min={0}
                                    max={3}
                                    step={0.1}
                                    displayValue={Number(form[key] || 0).toFixed(1)}
                                    help={getLocalizedParameterHelp(key, label)}
                                    onChange={(event) => setField(key, Number(event.target.value))}
                                  />
                                ))}
                              </div>
                            </div>

                            <div>
                              <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-white/45">
                                <span>{t('strategyWizard.inputs.rotationFilters')}</span>
                                <InlineHelp label="Объяснить rotation filters">
                                  {t('strategyWizard.inputs.rotationFiltersHelp')}
                                </InlineHelp>
                              </div>
                              <div className="grid gap-3 md:grid-cols-3">
                                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                                  <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-white/50">
                                    <span>{t('strategyWizard.inputs.creationType')}</span>
                                    <InlineHelp label="Объяснить фильтр creation type">
                                      {t('strategyWizard.inputs.creationTypeHelp')}
                                    </InlineHelp>
                                  </div>
                                  <select value={form.filterCreationType} onChange={(event) => setField('filterCreationType', event.target.value)} className="flex h-11 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none focus:border-primary">
                                    <option value="any">{t('strategyWizard.inputs.creationTypeAny')}</option>
                                    <option value="system">{t('strategyWizard.inputs.creationTypeSystem')}</option>
                                    <option value="agent">{t('strategyWizard.inputs.creationTypeAgent')}</option>
                                  </select>
                                </div>
                                <SliderCard
                                  label={t('strategyWizard.inputs.filterMinVolume')}
                                  value={Number(form.filterMinVolume || 0)}
                                  min={0}
                                  max={5000}
                                  step={50}
                                  displayValue={Number(form.filterMinVolume || 0).toFixed(0)}
                                  help={getLocalizedParameterHelp('filterMinVolume', t('strategyWizard.inputs.filterMinVolume'))}
                                  onChange={(event) => setField('filterMinVolume', Number(event.target.value))}
                                />
                                <SliderCard
                                  label={t('strategyWizard.inputs.filterMaxVolatility')}
                                  value={Number(form.filterMaxVolatility || 0)}
                                  min={0}
                                  max={10}
                                  step={0.1}
                                  displayValue={Number(form.filterMaxVolatility || 0).toFixed(1)}
                                  help={getLocalizedParameterHelp('filterMaxVolatility', t('strategyWizard.inputs.filterMaxVolatility'))}
                                  onChange={(event) => setField('filterMaxVolatility', Number(event.target.value))}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="order-1 self-start space-y-4 xl:order-2 xl:sticky xl:top-0">
                    <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-white/45">{t('strategyWizard.runtimeSnapshot.title')}</div>
                          <div className="mt-1 text-sm text-white/60">{t('strategyWizard.runtimeSnapshot.description')}</div>
                        </div>
                        <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-center text-white whitespace-normal">{tunePresets.find((item) => item.id === tunePreset)?.label || t('strategyWizard.tune.balanced.label')}</Badge>
                      </div>
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        <div className="rounded-2xl border border-primary/20 bg-primary/10 px-4 py-3 sm:col-span-2">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="text-[11px] uppercase tracking-[0.14em] text-primary/80">{t('strategyWizard.runtimeSnapshot.execution')}</div>
                              <div className="mt-1 font-semibold text-white">{t('strategyWizard.badge.directExecution')}</div>
                            </div>
                            <div className="text-xs text-primary/80">{isLlmPersona ? t('strategyWizard.runtimeSnapshot.llmInstallHint') : t('strategyWizard.runtimeSnapshot.directInstallHint')}</div>
                          </div>
                          <div className="mt-2 text-xs leading-5 text-white/65">{isLlmPersona ? t('strategyWizard.runtimeSnapshot.llmInstallDescription') : t('strategyWizard.runtimeSnapshot.directInstallDescription')}</div>
                        </div>
                        <SnapshotItem label={t('strategyWizard.runtimeSnapshot.installEffect')} value={isLlmPersona ? t('strategyWizard.runtimeSnapshot.llmInstallEffect', { position: Number(form.maxPositionPct || 0).toFixed(0) }) : t('strategyWizard.runtimeSnapshot.directInstallEffect', { position: Number(form.maxPositionPct || 0).toFixed(0), goal: form.goalMode })} />
                        <SnapshotItem label={t('strategyWizard.runtimeSnapshot.declaredInputs')} value={isLlmPersona ? t('strategyWizard.runtimeSnapshot.llmDeclaredInputs') : t('strategyWizard.runtimeSnapshot.directDeclaredInputs', { channels: requiredChannels.length, active: Number(form.maxActiveChannels || 0).toFixed(0) })} />
                      </div>
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        {(persona?.fields || []).slice(0, 4).map((field) => (
                          <SnapshotItem key={field.key} label={field.label} value={formatPreviewValue(field, form[field.key])} />
                        ))}
                        <SnapshotItem label={t('strategyWizard.runtimeSnapshot.risk')} value={t('strategyWizard.runtimeSnapshot.riskValue', { position: Number(form.maxPositionPct || 0).toFixed(0), stop: Number(form.stopLossPct || 0).toFixed(1) })} />
                        <SnapshotItem label={t('strategyWizard.runtimeSnapshot.rotation')} value={isLlmPersona ? t('strategyWizard.runtimeSnapshot.llmRotation') : t('strategyWizard.runtimeSnapshot.directRotation', { goal: form.goalMode, active: Number(form.maxActiveChannels || 0).toFixed(0) })} />
                        <SnapshotItem label={t('strategyWizard.runtimeSnapshot.channels')} value={isLlmPersona ? t('strategyWizard.runtimeSnapshot.llmChannels') : t('strategyWizard.runtimeSnapshot.directChannels', { channels: requiredChannels.length })} accent />
                      </div>
                      <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                        <div className="text-xs uppercase tracking-[0.14em] text-white/45">{t('strategyWizard.runtimeSnapshot.whyItMatters')}</div>
                        <ul className="mt-3 space-y-1.5 text-sm text-white/70">
                          <li>• {t('strategyWizard.runtimeSnapshot.bullet1')}</li>
                          <li>• {t('strategyWizard.runtimeSnapshot.bullet2')}</li>
                          <li>• {isLlmPersona ? t('strategyWizard.runtimeSnapshot.bullet3Llm') : t('strategyWizard.runtimeSnapshot.bullet3Direct')}</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {step === 4 ? (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                  <div className="space-y-5">
                    <div>
                      <h4 className="text-lg font-semibold text-white">{t('strategyWizard.publish.title')}</h4>
                      <p className="mt-1 text-sm text-white/60">{t('strategyWizard.publish.description')}</p>
                    </div>

                    <div className="grid gap-3">
                      {visibilityOptions.map((option) => {
                        const Icon = option.icon
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => setField('visibility', option.id)}
                            className={cn(
                              'rounded-2xl border px-4 py-4 text-left transition-colors',
                              form.visibility === option.id
                                ? 'border-primary bg-primary/12 text-primary'
                                : 'border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.08]'
                            )}
                          >
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5"><Icon className="h-4 w-4" /></div>
                              <div>
                                <div className="flex items-center gap-2 font-medium">
                                  <span>{option.label}</span>
                                  {option.recommended ? <Badge variant="active">{t('strategyWizard.publish.recommended')}</Badge> : null}
                                </div>
                                <div className="mt-1 text-xs text-inherit/80">{option.description}</div>
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                        <div className="text-xs uppercase tracking-[0.14em] text-white/45">{t('strategyWizard.publish.complexity')}</div>
                        <input type="range" min="0" max="100" value={Number(form.complexityScore)} onChange={(e) => setField('complexityScore', Number(e.target.value))} className="mt-4 w-full accent-primary" />
                        <div className="mt-2 text-sm text-white">{form.complexityScore}/100</div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                        <div className="text-xs uppercase tracking-[0.14em] text-white/45">{t('strategyWizard.publish.explainability')}</div>
                        <input type="range" min="0" max="100" value={Number(form.explainabilityScore)} onChange={(e) => setField('explainabilityScore', Number(e.target.value))} className="mt-4 w-full accent-primary" />
                        <div className="mt-2 text-sm text-white">{form.explainabilityScore}/100</div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.08] p-4 text-sm text-white/80">
                      <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/80">{t('strategyWizard.publish.royaltyModel')}</div>
                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3">
                          <div className="text-white/45">{t('strategyWizard.publish.royaltyRecipient')}</div>
                          <div className="mt-1 font-medium text-white">{t('strategyWizard.publish.royaltyRecipientValue')}</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3">
                          <div className="text-white/45">{t('strategyWizard.publish.royaltyAmount')}</div>
                          <div className="mt-1 font-medium text-white">{t('strategyWizard.publish.royaltyAmountValue', { share: royaltySharePct })}</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3">
                          <div className="text-white/45">{t('strategyWizard.publish.royaltyWhen')}</div>
                          <div className="mt-1 font-medium text-white">{t('strategyWizard.publish.royaltyWhenValue')}</div>
                        </div>
                      </div>
                      <div className="mt-3 text-xs leading-5 text-white/60">{t('strategyWizard.publish.royaltyDescription')}</div>
                    </div>
                  </div>

                  <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                    <div className="text-xs uppercase tracking-[0.16em] text-white/45">{t('strategyWizard.publish.launchSummary')}</div>
                    <div className="mt-4 rounded-[24px] border border-white/10 bg-white/[0.04] p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-3xl">{persona?.icon || '✨'}</div>
                          <div className="mt-3 text-xl font-semibold text-white">{form.name}</div>
                          <div className="mt-1 text-sm text-white/55">{selectedVisibility?.label}</div>
                        </div>
                        <Badge variant="outline" className="border-white/15 bg-white/[0.04] text-white">{isLlmPersona ? 'LLM' : t('strategyWizard.badge.directExecution')}</Badge>
                      </div>
                      <div className="mt-5 grid gap-2 text-sm">
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.type')}</span><span className="font-medium text-white">{isLlmPersona ? t('strategyWizard.summary.typeLlm') : t('strategyWizard.summary.typeDirect')}</span></div>
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.rules')}</span><span className="font-medium text-white">{ruleDefinition?.rules?.length || 0}</span></div>
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.parameters')}</span><span className="font-medium text-white">{parameterSchema?.fields?.length || 0}</span></div>
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.channels')}</span><span className="font-medium text-white">{requiredChannels.length}</span></div>
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.royalty')}</span><span className="font-medium text-white">{t('strategyWizard.publish.royaltyAmountValue', { share: royaltySharePct })}</span></div>
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.maxPosition')}</span><span className="font-medium text-white">{Number(form.maxPositionPct || 0).toFixed(0)}%</span></div>
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.positionTimeout')}</span><span className="font-medium text-white">{formatMinutes(form.maxPositionAgeMinutes)}</span></div>
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.rotationGoal')}</span><span className="font-medium capitalize text-white">{form.goalMode}</span></div>
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-white/55">{t('strategyWizard.summary.maxSubscriptions')}</span><span className="font-medium text-white">{Number(form.maxActiveChannels || 0).toFixed(0)}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/[0.08] px-4 py-3 text-sm text-rose-200 whitespace-pre-wrap">{error}</div> : null}
            </div>
          )}
        </div>
        </div>

        {!createdSummary && walletAddress ? (
          <div className="border-t border-white/10 bg-white/[0.025] px-4 py-4 sm:px-6 md:px-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <div className="space-y-1 text-sm text-white/55">
                <div className="flex items-center gap-2">
                  {persona ? <><Sparkles className="h-4 w-4" /> {persona.title}</> : <><Layers3 className="h-4 w-4" /> {t('strategyWizard.footer.startWithPersona')}</>}
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/45">{t('strategyWizard.footer.stepCounter', { step, total: steps.length })}</span>
                </div>
                <div className="text-xs text-white/40">{stepHelp[step]}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:flex">
                <Button variant="outline" onClick={() => (step === 1 ? onClose() : setStep((prev) => prev - 1))} className="w-full border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white sm:w-auto">
                  {step === 1 ? t('common.cancel') : t('wizard.back')}
                </Button>
                {step < 4 ? (
                  <Button onClick={() => setStep((prev) => prev + 1)} disabled={!canContinue} className="w-full sm:w-auto">
                    {t('strategyWizard.footer.next')} <ChevronRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button onClick={handleCreate} disabled={creating || !persona} className="w-full sm:w-auto">
                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
                    {creating ? t('strategyWizard.footer.creating') : form.visibility === 'public' ? t('strategyWizard.footer.createAndPublish') : t('strategyWizard.footer.createDraft')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
