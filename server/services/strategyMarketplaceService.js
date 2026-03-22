import { randomUUID } from 'crypto'
import {
  createAgentStrategyInstance,
  createStrategyTemplate,
  createStrategyVersion,
  getActiveStrategyInstanceForAgent,
  getStrategyMarketplaceListing,
  getStrategyTemplate,
  incrementStrategyInstallCounts,
  listStrategyExecutionEventsByTemplate,
  listStrategyVersions,
  markStrategyVersionPublished,
  updateStrategyTemplateLifecycle,
  upsertStrategyMarketplaceListing,
} from '../runtimeStrategyStore.js'

const SYSTEM_OWNER = 'system:marketplace'
const TEMPLATE_PREFIX = 'strategy-template:'
const VERSION_PREFIX = 'strategy-version:'
const LISTING_PREFIX = 'strategy-listing:'
const INSTANCE_PREFIX = 'strategy-instance:'

const SEEDED_STRATEGIES = [
  {
    slug: 'corridor-sentinel',
    name: 'Corridor Sentinel',
    shortDescription: 'Defensive corridor trader that buys structured weakness and sells relief into upper-band strength.',
    category: 'mean-reversion',
    type: 'custom',
    complexityScore: 34,
    explainabilityScore: 92,
    priceMode: 'free',
    rankingScore: 86,
    verifiedBadge: true,
    featuredRank: 1,
    changelog: 'Initial release with lower-band accumulation and upper-band de-risking presets.',
    parameterSchema: {
      defaults: {
        buyDropPct: -1.25,
        sellRisePct: 1.4,
        maxSpreadPct: 1.2,
        maxVolatility: 2.6,
        buySizePct: 22,
        sellSizePct: 55,
      },
      fields: [
        { key: 'buyDropPct', label: 'Buy on drop (%)', type: 'number', min: -6, max: 0, step: 0.05 },
        { key: 'sellRisePct', label: 'Sell on rebound (%)', type: 'number', min: 0.1, max: 6, step: 0.05 },
        { key: 'maxSpreadPct', label: 'Max spread (%)', type: 'number', min: 0.1, max: 5, step: 0.05 },
        { key: 'buySizePct', label: 'Buy size (%)', type: 'number', min: 1, max: 100, step: 1 },
        { key: 'sellSizePct', label: 'Sell size (%)', type: 'number', min: 1, max: 100, step: 1 },
      ],
    },
    requiredChannels: [{ channelType: 'index', name: 'Index oracle', subscriptionKind: 'trading' }],
    riskDefaults: { maxPositionPct: 28, stopLossPct: 4.5, maxDailyTrades: 8, maxPositionAgeMs: 45 * 60 * 1000 },
    rotationDefaults: { goalMode: 'conservative', intervalTicks: 60, maxActiveChannels: 2 },
    listing: { installCount: 18, activeInstallCount: 4, forkCount: 2, reviewCount: 5, avgRating: 4.8 },
    demoInstallMode: 'direct',
    definition: {
      kind: 'rule_v1',
      summary: 'Mean-reversion corridor strategy with volatility gating.',
      rules: [
        {
          id: 'buy-pullback',
          name: 'Buy pullback',
          when: {
            all: [
              { source: '$market.oracleChangePct', op: 'lte', value: '$params.buyDropPct' },
              { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
              { source: '$market.volatility', op: 'lte', value: '$params.maxVolatility' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'bandLow',
            sizePct: '$params.buySizePct',
            confidence: 0.74,
            reasoning: 'Weakness reaches the lower corridor while spread stays controlled.',
          },
        },
        {
          id: 'sell-relief',
          name: 'Sell relief',
          when: {
            all: [
              { source: '$agent.position', op: 'truthy' },
              { source: '$market.oracleChangePct', op: 'gte', value: '$params.sellRisePct' },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bandHigh',
            sizePct: '$params.sellSizePct',
            confidence: 0.77,
            reasoning: 'Recovery reaches the upper corridor, so the strategy harvests mean reversion gains.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'Waiting for a clean lower-band or upper-band setup.' },
    },
  },
  {
    slug: 'breakout-pulse',
    name: 'Breakout Pulse',
    shortDescription: 'Momentum strategy that joins expanding moves when oracle drift and market participation rise together.',
    category: 'momentum',
    type: 'custom',
    complexityScore: 49,
    explainabilityScore: 77,
    priceMode: 'free',
    rankingScore: 90,
    verifiedBadge: true,
    featuredRank: 2,
    changelog: 'Adds breakout and fade rules with volume confirmation and spread safety.',
    parameterSchema: {
      defaults: {
        breakoutPct: 1.8,
        volumeFloor: 500,
        maxSpreadPct: 1.8,
        entrySizePct: 26,
        exitDropPct: -0.85,
      },
      fields: [
        { key: 'breakoutPct', label: 'Breakout threshold (%)', type: 'number', min: 0.2, max: 8, step: 0.05 },
        { key: 'volumeFloor', label: 'Volume floor', type: 'number', min: 10, max: 100000, step: 10 },
        { key: 'entrySizePct', label: 'Entry size (%)', type: 'number', min: 1, max: 100, step: 1 },
        { key: 'exitDropPct', label: 'Exit reversal (%)', type: 'number', min: -5, max: 0, step: 0.05 },
      ],
    },
    requiredChannels: [{ channelType: 'index', name: 'Index oracle', subscriptionKind: 'trading' }],
    riskDefaults: { maxPositionPct: 35, stopLossPct: 5.5, maxDailyTrades: 12, maxPositionAgeMs: 20 * 60 * 1000 },
    rotationDefaults: { goalMode: 'aggressive', intervalTicks: 35, maxActiveChannels: 3 },
    listing: { installCount: 27, activeInstallCount: 5, forkCount: 4, reviewCount: 8, avgRating: 4.9 },
    demoInstallMode: 'direct',
    definition: {
      kind: 'rule_v1',
      summary: 'Breakout participation with volume and spread confirmation.',
      rules: [
        {
          id: 'join-breakout',
          cooldownTicks: 3,
          when: {
            all: [
              { source: '$market.oraclePrice', op: 'crosses_above', value: '$market.bandHigh' },
              { source: '$market.oracleDeltaPct', op: 'gte', value: '$params.breakoutPct' },
              { source: '$market.totalVolume', op: 'gte', value: '$params.volumeFloor' },
              { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'bestAsk',
            priceOffsetPct: 0.12,
            sizePct: '$params.entrySizePct',
            confidence: 0.82,
            reasoning: 'Breakout is confirmed by participation and acceptable spread.',
          },
        },
        {
          id: 'cut-failed-breakout',
          cooldownTicks: 2,
          when: {
            all: [
              { source: '$agent.position', op: 'truthy' },
              { source: '$market.oracleDeltaPct', op: 'lte', value: '$params.exitDropPct' },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bestBid',
            sizePct: 100,
            confidence: 0.78,
            reasoning: 'Momentum failed after entry, so the strategy exits quickly.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'No validated momentum continuation or reversal yet.' },
    },
  },
  {
    slug: 'liquidity-harvester',
    name: 'Liquidity Harvester',
    shortDescription: 'Maker-biased spread harvester that leans into order-book imbalance while keeping inventory tight.',
    category: 'market-making',
    type: 'custom',
    complexityScore: 58,
    explainabilityScore: 74,
    priceMode: 'free',
    rankingScore: 83,
    verifiedBadge: false,
    featuredRank: 3,
    changelog: 'Launch version tuned for wider spreads and passive rebalancing.',
    parameterSchema: {
      defaults: {
        minSpreadPct: 0.65,
        maxSpreadPct: 2.2,
        makerBuyPct: 18,
        makerSellPct: 42,
        cancelSpreadPct: 0.22,
      },
      fields: [
        { key: 'minSpreadPct', label: 'Min spread to engage (%)', type: 'number', min: 0.05, max: 5, step: 0.05 },
        { key: 'maxSpreadPct', label: 'Max spread (%)', type: 'number', min: 0.1, max: 8, step: 0.05 },
        { key: 'makerBuyPct', label: 'Maker buy size (%)', type: 'number', min: 1, max: 100, step: 1 },
        { key: 'makerSellPct', label: 'Maker sell size (%)', type: 'number', min: 1, max: 100, step: 1 },
      ],
    },
    requiredChannels: [
      { channelType: 'index', name: 'Index oracle', subscriptionKind: 'trading' },
      { channelType: 'strategy_signal', name: 'Order-book depth', subscriptionKind: 'signal' },
    ],
    riskDefaults: { maxPositionPct: 22, stopLossPct: 3.2, maxDailyTrades: 16, maxPositionAgeMs: 30 * 60 * 1000 },
    rotationDefaults: { goalMode: 'balanced', intervalTicks: 30, maxActiveChannels: 4 },
    listing: { installCount: 14, activeInstallCount: 3, forkCount: 1, reviewCount: 4, avgRating: 4.5 },
    demoInstallMode: 'direct',
    definition: {
      kind: 'rule_v1',
      summary: 'Spread capture and passive inventory rebalancing.',
      rules: [
        {
          id: 'harvest-wide-spread-buy',
          when: {
            all: [
              { source: '$market.spreadPct', op: 'gte', value: '$params.minSpreadPct' },
              { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
              { source: '$orderbook.askDepth', op: 'gt', value: '$orderbook.bidDepth' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'bestBid',
            priceOffsetPct: -0.08,
            sizePct: '$params.makerBuyPct',
            confidence: 0.68,
            reasoning: 'Ask-heavy book with wide spread offers passive entry opportunity.',
          },
        },
        {
          id: 'harvest-wide-spread-sell',
          when: {
            all: [
              { source: '$agent.position', op: 'truthy' },
              { source: '$market.spreadPct', op: 'gte', value: '$params.minSpreadPct' },
              { source: '$orderbook.bidDepth', op: 'gt', value: '$orderbook.askDepth' },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bestAsk',
            priceOffsetPct: 0.08,
            sizePct: '$params.makerSellPct',
            confidence: 0.69,
            reasoning: 'Bid support is stronger, so the strategy rotates inventory into the spread.',
          },
        },
        {
          id: 'cancel-tight-market',
          when: {
            all: [
              { source: '$market.spreadPct', op: 'lte', value: '$params.cancelSpreadPct' },
              { source: '$orderbook.pendingOrders', op: 'truthy' },
            ],
          },
          then: {
            action: 'cancel_stale',
            confidence: 0.55,
            reasoning: 'Spread compressed too much for passive harvesting; stale maker orders should be cleared.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'Spread is not attractive enough for maker-style harvesting.' },
    },
  },
  {
    slug: 'feed-reactor',
    name: 'Feed Reactor',
    shortDescription: 'Event-driven strategy that upgrades or de-risks positions based on feed intensity and market response.',
    category: 'event-driven',
    type: 'custom',
    complexityScore: 63,
    explainabilityScore: 71,
    priceMode: 'free',
    rankingScore: 88,
    verifiedBadge: true,
    featuredRank: 4,
    changelog: 'Feed-aware release focused on high-severity catalyst detection and risk-off exits.',
    parameterSchema: {
      defaults: {
        catalystMovePct: 0.75,
        exitSeverityCount: 1,
        entrySizePct: 19,
        exitSizePct: 100,
      },
      fields: [
        { key: 'catalystMovePct', label: 'Catalyst move (%)', type: 'number', min: 0.05, max: 5, step: 0.05 },
        { key: 'exitSeverityCount', label: 'High severity count', type: 'number', min: 1, max: 10, step: 1 },
        { key: 'entrySizePct', label: 'Entry size (%)', type: 'number', min: 1, max: 100, step: 1 },
      ],
    },
    requiredChannels: [
      { channelType: 'feed', name: 'Index feed', subscriptionKind: 'signal' },
      { channelType: 'creator', name: 'Creator channel', subscriptionKind: 'signal' },
    ],
    riskDefaults: { maxPositionPct: 24, stopLossPct: 6, maxDailyTrades: 10, maxPositionAgeMs: 15 * 60 * 1000 },
    rotationDefaults: { goalMode: 'balanced', intervalTicks: 28, maxActiveChannels: 5 },
    listing: { installCount: 19, activeInstallCount: 3, forkCount: 2, reviewCount: 6, avgRating: 4.7 },
    demoInstallMode: 'direct',
    definition: {
      kind: 'rule_v1',
      summary: 'Catalyst trading using feed severity and market confirmation.',
      rules: [
        {
          id: 'buy-catalyst',
          cooldownTicks: 4,
          when: {
            all: [
              { source: '$feed.severityCounts.high', op: 'gte', value: 1 },
              { source: '$market.oracleDeltaPct', op: 'gte', value: '$params.catalystMovePct' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'latestTrade',
            sizePct: '$params.entrySizePct',
            confidence: 0.8,
            reasoning: 'High-severity feed event aligns with positive price confirmation.',
          },
        },
        {
          id: 'risk-off-alert',
          when: {
            any: [
              { all: [{ source: '$agent.position', op: 'truthy' }, { source: '$feed.severityCounts.critical', op: 'gte', value: 1 }] },
              { all: [{ source: '$agent.position', op: 'truthy' }, { source: '$feed.severityCounts.high', op: 'gte', value: '$params.exitSeverityCount' }, { source: '$market.oracleChangePct', op: 'lte', value: -0.4 }] },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bestBid',
            sizePct: '$params.exitSizePct',
            confidence: 0.84,
            reasoning: 'Feed severity escalates against the position, so the strategy de-risks aggressively.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'Feed intensity is not high enough to justify an event trade.' },
    },
  },
  {
    slug: 'volatility-ladder',
    name: 'Volatility Ladder',
    shortDescription: 'Adaptive volatility trader that scales into panic and distributes out on compression and snapback.',
    category: 'volatility',
    type: 'custom',
    complexityScore: 67,
    explainabilityScore: 69,
    priceMode: 'free',
    rankingScore: 85,
    verifiedBadge: false,
    featuredRank: 5,
    changelog: 'Volatility-aware laddering with safety on spread expansion.',
    parameterSchema: {
      defaults: {
        minVolatility: 1.1,
        panicDropPct: -1.4,
        snapbackPct: 1.1,
        addSizePct: 17,
        trimSizePct: 45,
      },
      fields: [
        { key: 'minVolatility', label: 'Minimum volatility', type: 'number', min: 0.1, max: 10, step: 0.1 },
        { key: 'panicDropPct', label: 'Panic drop (%)', type: 'number', min: -8, max: 0, step: 0.05 },
        { key: 'snapbackPct', label: 'Snapback (%)', type: 'number', min: 0.05, max: 8, step: 0.05 },
      ],
    },
    requiredChannels: [{ channelType: 'index', name: 'Index oracle', subscriptionKind: 'trading' }],
    riskDefaults: { maxPositionPct: 32, stopLossPct: 7, maxDailyTrades: 14, maxPositionAgeMs: 60 * 60 * 1000 },
    rotationDefaults: { goalMode: 'sticky', intervalTicks: 45, maxActiveChannels: 3 },
    listing: { installCount: 16, activeInstallCount: 2, forkCount: 1, reviewCount: 4, avgRating: 4.4 },
    demoInstallMode: 'direct',
    definition: {
      kind: 'rule_v1',
      summary: 'Volatility-based accumulation and trim strategy.',
      rules: [
        {
          id: 'buy-panic-vol',
          when: {
            all: [
              { source: '$market.volatility', op: 'gte', value: '$params.minVolatility' },
              { source: '$market.oracleChangePct', op: 'lte', value: '$params.panicDropPct' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'bandLow',
            sizePct: '$params.addSizePct',
            confidence: 0.79,
            reasoning: 'The strategy buys panic when volatility is elevated and price is near the lower corridor.',
          },
        },
        {
          id: 'trim-snapback',
          when: {
            all: [
              { source: '$agent.position', op: 'truthy' },
              { source: '$market.oracleChangePct', op: 'gte', value: '$params.snapbackPct' },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'mid',
            sizePct: '$params.trimSizePct',
            confidence: 0.75,
            reasoning: 'The rebound is strong enough to trim inventory accumulated during panic.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'Volatility regime does not justify a ladder adjustment.' },
    },
  },
  {
    slug: 'depth-reverter',
    name: 'Depth Reverter',
    shortDescription: 'Contrarian order-book strategy that fades one-sided depth when price extension looks stretched.',
    category: 'orderbook',
    type: 'custom',
    complexityScore: 61,
    explainabilityScore: 73,
    priceMode: 'free',
    rankingScore: 84,
    verifiedBadge: false,
    featuredRank: 6,
    changelog: 'Order-book mean reversion tuned for depth imbalance and spread discipline.',
    parameterSchema: {
      defaults: {
        entryDropPct: -0.9,
        reliefRisePct: 0.8,
        buySizePct: 21,
        sellSizePct: 60,
        maxSpreadPct: 1.7,
      },
      fields: [
        { key: 'entryDropPct', label: 'Entry drop (%)', type: 'number', min: -5, max: 0, step: 0.05 },
        { key: 'reliefRisePct', label: 'Relief rise (%)', type: 'number', min: 0.05, max: 5, step: 0.05 },
        { key: 'maxSpreadPct', label: 'Max spread (%)', type: 'number', min: 0.1, max: 5, step: 0.05 },
      ],
    },
    requiredChannels: [
      { channelType: 'strategy_signal', name: 'Order-book depth', subscriptionKind: 'signal' },
      { channelType: 'index', name: 'Index oracle', subscriptionKind: 'trading' },
    ],
    riskDefaults: { maxPositionPct: 26, stopLossPct: 4.2, maxDailyTrades: 11, maxPositionAgeMs: 25 * 60 * 1000 },
    rotationDefaults: { goalMode: 'balanced', intervalTicks: 32, maxActiveChannels: 4 },
    listing: { installCount: 13, activeInstallCount: 2, forkCount: 1, reviewCount: 3, avgRating: 4.3 },
    demoInstallMode: 'direct',
    definition: {
      kind: 'rule_v1',
      summary: 'Depth-imbalance contrarian with controlled spread filter.',
      rules: [
        {
          id: 'buy-depth-imbalance',
          when: {
            all: [
              { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
              { source: '$market.oracleChangePct', op: 'lte', value: '$params.entryDropPct' },
              { source: '$orderbook.bidDepth', op: 'gt', value: '$orderbook.askDepth' },
            ],
          },
          then: {
            action: 'buy',
            orderType: 'limit',
            priceSource: 'bestBid',
            sizePct: '$params.buySizePct',
            confidence: 0.71,
            reasoning: 'Bid-side depth absorbs weakness, so the strategy fades the stretch.',
          },
        },
        {
          id: 'sell-depth-relief',
          when: {
            all: [
              { source: '$agent.position', op: 'truthy' },
              { source: '$market.oracleChangePct', op: 'gte', value: '$params.reliefRisePct' },
              { source: '$orderbook.askDepth', op: 'gt', value: '$orderbook.bidDepth' },
            ],
          },
          then: {
            action: 'sell',
            orderType: 'limit',
            priceSource: 'bestAsk',
            sizePct: '$params.sellSizePct',
            confidence: 0.73,
            reasoning: 'Relief rally meets heavier asks, so the position is reduced into opposing depth.',
          },
        },
      ],
      fallback: { action: 'hold', reasoning: 'Depth imbalance is not strong enough to justify a contrarian trade.' },
    },
  },
]

function templateIdFor(slug) {
  return `${TEMPLATE_PREFIX}${slug}`
}

function versionIdFor(slug, versionNumber = 1) {
  return `${VERSION_PREFIX}${slug}:v${versionNumber}`
}

function listingIdFor(slug) {
  return `${LISTING_PREFIX}${slug}`
}

function instanceIdFor(slug, agentId) {
  return `${INSTANCE_PREFIX}${slug}:${agentId}`
}

function getDefaultParams(parameterSchema) {
  return parameterSchema?.defaults || {}
}

function buildRuntimeRequirements(requiredChannels = []) {
  const channelTypes = new Set((requiredChannels || []).map((channel) => channel?.channelType).filter(Boolean))
  return {
    marketContext: channelTypes.has('index') || channelTypes.size === 0,
    orderbook: channelTypes.has('strategy_signal') || channelTypes.has('index'),
    feed: channelTypes.has('feed') || channelTypes.has('creator'),
  }
}

function getPublicAgentLabel(agent, ordinal) {
  if (!agent.isUserAgent) {
    return { name: agent.name, icon: agent.icon || '🤖', private: false }
  }
  return { name: `Private User Agent ${ordinal}`, icon: '🕶️', private: true }
}

function buildSignalMix(events) {
  const counts = new Map()
  for (const event of events || []) {
    for (const signal of event.signals || []) {
      const key = signal.action || 'hold'
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return Array.from(counts.entries()).map(([name, value]) => ({ name, value }))
}

function buildOutcomeMix(events) {
  const counts = new Map()
  for (const event of events || []) {
    const key = event.outcome || 'fallback'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return Array.from(counts.entries()).map(([name, value]) => ({ name, value }))
}

function buildCohortSeries(agents, points = 24) {
  if (!agents?.length) return []
  const maxPoints = Math.min(points, Math.max(...agents.map((agent) => agent.equityCurve?.length || 0), 0))
  if (maxPoints <= 0) return []

  const series = []
  for (let step = 0; step < maxPoints; step++) {
    let totalEquity = 0
    let totalPnl = 0
    let totalPnlPercent = 0
    let agentCount = 0
    let latestTime = 0

    for (const agent of agents) {
      const curve = agent.equityCurve || []
      const idx = curve.length - maxPoints + step
      if (idx < 0 || !curve[idx]) continue
      const point = curve[idx]
      const base = Number(agent.initialBalance || 0) || Number(curve[0]?.equity || 0) || 1
      totalEquity += Number(point.equity || 0)
      totalPnl += Number(point.equity || 0) - base
      totalPnlPercent += ((Number(point.equity || 0) - base) / base) * 100
      latestTime = Math.max(latestTime, Number(point.time || 0))
      agentCount += 1
    }

    if (agentCount === 0) continue
    series.push({
      time: latestTime || Date.now(),
      label: step + 1,
      totalEquity,
      totalPnl,
      avgPnlPercent: totalPnlPercent / agentCount,
      agentCount,
    })
  }

  return series
}

export function buildStrategyTemplateMetrics({ templateId, engine }) {
  const template = getStrategyTemplate(templateId)
  if (!template) return null

  const agents = (engine?.getAllAgents?.() || [])
    .filter((agent) => agent.activeStrategyTemplateId === template.id)

  const connectedAgentCards = agents
    .slice()
    .sort((a, b) => (b.pnlPercent || 0) - (a.pnlPercent || 0))
    .slice(0, 6)
    .map((agent, index) => {
      const publicLabel = getPublicAgentLabel(agent, index + 1)
      return {
        id: publicLabel.private ? `private-${index + 1}` : agent.id,
        name: publicLabel.name,
        icon: publicLabel.icon,
        status: agent.status,
        mode: agent.activeStrategyMode || 'direct',
        pnl: agent.pnl || 0,
        pnlPercent: agent.pnlPercent || 0,
        winRate: agent.winRate || 0,
        totalTrades: agent.totalTrades || 0,
        equity: agent.equity || 0,
        isPrivate: publicLabel.private,
      }
    })

  const totalInitial = agents.reduce((sum, agent) => sum + (Number(agent.initialBalance) || 0), 0)
  const totalEquity = agents.reduce((sum, agent) => sum + (Number(agent.equity) || 0), 0)
  const totalTrades = agents.reduce((sum, agent) => sum + (Number(agent.totalTrades) || 0), 0)
  const totalVolume = agents.reduce((sum, agent) => sum + (Number(agent.totalVolume) || 0), 0)
  const avgPnlPercent = agents.length > 0
    ? agents.reduce((sum, agent) => sum + (Number(agent.pnlPercent) || 0), 0) / agents.length
    : 0
  const avgWinRate = agents.length > 0
    ? agents.reduce((sum, agent) => sum + (Number(agent.winRate) || 0), 0) / agents.length
    : 0
  const avgDrawdown = agents.length > 0
    ? agents.reduce((sum, agent) => sum + (Number(agent.maxDrawdown) || 0), 0) / agents.length
    : 0

  const versionList = listStrategyVersions(template.id)
  const executionEvents = listStrategyExecutionEventsByTemplate(template.id, { limit: 120 })
  const currentVersion = versionList.length > 0
    ? versionList.sort((a, b) => (b.versionNumber || 0) - (a.versionNumber || 0))[0]
    : null

  return {
    templateId: template.id,
    live: {
      connectedAgents: agents.length,
      activeAgents: agents.filter((agent) => agent.status === 'active').length,
      positiveAgents: agents.filter((agent) => (agent.pnl || 0) >= 0).length,
      totalInitial,
      totalEquity,
      totalPnl: totalEquity - totalInitial,
      avgPnlPercent,
      avgWinRate,
      avgDrawdown,
      totalTrades,
      totalVolume,
    },
    charts: {
      cohortPnl: buildCohortSeries(agents),
      signalMix: buildSignalMix(executionEvents),
      outcomeMix: buildOutcomeMix(executionEvents),
    },
    agents: connectedAgentCards,
    runtime: {
      recentEvents: executionEvents.slice(0, 8),
      totalEvents: executionEvents.length,
    },
    structure: {
      ruleCount: currentVersion?.definition?.rules?.length || 0,
      parameterCount: currentVersion?.parameterSchema?.fields?.length || 0,
      requiredChannelCount: currentVersion?.requiredChannels?.length || 0,
      versionCount: versionList.length,
      publishedVersionCount: versionList.filter((version) => version.publishedAt).length,
    },
  }
}

function upsertSeedTemplate(seed, now) {
  let template = getStrategyTemplate(seed.slug)
  if (!template) {
    template = createStrategyTemplate({
      id: templateIdFor(seed.slug),
      ownerUserAddress: SYSTEM_OWNER,
      slug: seed.slug,
      name: seed.name,
      shortDescription: seed.shortDescription,
      category: seed.category,
      type: seed.type,
      visibility: 'public',
      status: 'published',
      complexityScore: seed.complexityScore,
      explainabilityScore: seed.explainabilityScore,
      createdAt: now,
      updatedAt: now,
    })
  } else {
    updateStrategyTemplateLifecycle(template.id, { visibility: 'public', status: 'published' })
    template = getStrategyTemplate(template.id)
  }

  let version = listStrategyVersions(template.id).find((item) => item.versionNumber === 1)
  if (!version) {
    version = createStrategyVersion({
      id: versionIdFor(seed.slug, 1),
      strategyTemplateId: template.id,
      versionNumber: 1,
      changelog: seed.changelog,
      definition: seed.definition,
      parameterSchema: seed.parameterSchema,
      triggerSchema: { importantSignals: ['oracleChangePct', 'spreadPct', 'volatility', 'feedSeverity', 'depthImbalance'] },
      requiredChannels: seed.requiredChannels,
      runtimeRequirements: buildRuntimeRequirements(seed.requiredChannels),
      riskDefaults: seed.riskDefaults,
      rotationDefaults: seed.rotationDefaults,
      publishedAt: now,
      createdAt: now,
    })
  }

  if (!version.publishedAt) {
    version = markStrategyVersionPublished(version.id, now)
  }

  upsertStrategyMarketplaceListing({
    id: listingIdFor(seed.slug),
    strategyTemplateId: template.id,
    currentVersionId: version.id,
    authorUserAddress: SYSTEM_OWNER,
    priceMode: seed.priceMode || 'free',
    priceValue: null,
    installCount: seed.listing.installCount,
    activeInstallCount: seed.listing.activeInstallCount,
    forkCount: seed.listing.forkCount,
    reviewCount: seed.listing.reviewCount,
    avgRating: seed.listing.avgRating,
    verifiedBadge: seed.verifiedBadge,
    featuredRank: seed.featuredRank,
    rankingScore: seed.rankingScore,
    createdAt: now,
    updatedAt: now,
  })

  return { template: getStrategyTemplate(template.id), version }
}

function ensureDemoInstall({ engine, seed, template, version, customStrategyRuntime }) {
  const demoAgents = (engine?.getAllAgentsRaw?.() || []).filter((agent) => !agent.isUserAgent)
  const targetAgent = demoAgents.find((agent) => !getActiveStrategyInstanceForAgent(agent.id))
    || demoAgents.find((agent) => agent.config?.strategyTemplateId === template.id)

  if (!targetAgent) return { bound: false, createdInstall: false }

  const current = getActiveStrategyInstanceForAgent(targetAgent.id)
  let createdInstall = false
  if (!current || current.strategyTemplateId !== template.id) {
    createAgentStrategyInstance({
      id: instanceIdFor(seed.slug, targetAgent.id),
      agentId: targetAgent.id,
      strategyTemplateId: template.id,
      strategyVersionId: version.id,
      mode: 'direct',
      status: 'active',
      customParams: getDefaultParams(version.parameterSchema),
      customRisk: version.riskDefaults || {},
      customRotation: version.rotationDefaults || {},
      installedFromMarketplace: true,
      installedByUser: SYSTEM_OWNER,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    createdInstall = true
  }

  targetAgent.config = {
    ...(targetAgent.config || {}),
    activeStrategyInstanceId: instanceIdFor(seed.slug, targetAgent.id),
    strategyTemplateId: template.id,
    strategyVersionId: version.id,
    strategyMode: 'direct',
    strategySource: 'marketplace_seed',
  }
  customStrategyRuntime?.invalidate?.(targetAgent.id)
  return { bound: true, createdInstall }
}

export function ensureSeededMarketplaceStrategies({ engine, customStrategyRuntime } = {}) {
  const now = Date.now()
  const newlyInstalledTemplateIds = []

  for (const seed of SEEDED_STRATEGIES) {
    const { template, version } = upsertSeedTemplate(seed, now)
    const installState = ensureDemoInstall({ engine, seed, template, version, customStrategyRuntime })
    if (installState.createdInstall) newlyInstalledTemplateIds.push(template.id)
  }

  for (const templateId of newlyInstalledTemplateIds) {
    incrementStrategyInstallCounts(templateId)
  }

  return SEEDED_STRATEGIES.length
}

export function getSeededStrategyBlueprints() {
  return SEEDED_STRATEGIES.map((item) => ({
    slug: item.slug,
    name: item.name,
    category: item.category,
    type: item.type,
    summary: item.shortDescription,
    parameterDefaults: item.parameterSchema?.defaults || {},
    ruleCount: item.definition?.rules?.length || 0,
  }))
}
