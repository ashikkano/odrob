import { adminLimiter } from '../../middleware/index.js'
import { ok } from '../../validation/index.js'
import { INDEX_FORMULAS } from '../../engine/indexFormulas.js'
import { getStrategyRevenueSummaryGlobal, listRecentStrategyRevenueEvents } from '../../db.js'

function roundMoney(value, precision = 2) {
  const numeric = Number(value || 0)
  if (!Number.isFinite(numeric)) return 0
  const factor = 10 ** precision
  return Math.round(numeric * factor) / factor
}

function buildFinancialTimeline(financialHistory = [], strategyRevenueEvents = [], hours = 72) {
  const bucketMs = 60 * 60 * 1000
  const cutoff = Date.now() - (hours * bucketMs)
  const buckets = new Map()

  const ensureBucket = (timestamp) => {
    const bucketTs = Math.floor(timestamp / bucketMs) * bucketMs
    if (!buckets.has(bucketTs)) {
      const date = new Date(bucketTs)
      const label = `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`
      buckets.set(bucketTs, {
        timestamp: bucketTs,
        label,
        directPlatform: 0,
        managedProtocol: 0,
        creatorRevenue: 0,
        strategyRoyalties: 0,
      })
    }
    return buckets.get(bucketTs)
  }

  for (const event of financialHistory) {
    const timestamp = Number(event?.timestamp || 0)
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue
    const amount = Number(event?.amount || 0)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const bucket = ensureBucket(timestamp)
    if (event.stream === 'platform_revenue') bucket.directPlatform += amount
    else if (event.stream === 'global_pool') bucket.managedProtocol += amount
    else if (event.stream === 'creator_revenue') bucket.creatorRevenue += amount
  }

  for (const event of strategyRevenueEvents) {
    const timestamp = Number(event?.createdAt || 0)
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue
    const amount = Number(event?.royaltyAmount || 0)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const bucket = ensureBucket(timestamp)
    bucket.strategyRoyalties += amount
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item) => ({
      ...item,
      directPlatform: roundMoney(item.directPlatform, 4),
      managedProtocol: roundMoney(item.managedProtocol, 4),
      creatorRevenue: roundMoney(item.creatorRevenue, 4),
      strategyRoyalties: roundMoney(item.strategyRoyalties, 4),
      grossPlatform: roundMoney(item.directPlatform + item.managedProtocol, 4),
      totalEconomicFlows: roundMoney(item.directPlatform + item.managedProtocol + item.creatorRevenue + item.strategyRoyalties, 4),
    }))
}

function buildRecentFinancialEvents(financialHistory = [], strategyRevenueEvents = [], limit = 20) {
  const normalizedFinancialHistory = financialHistory.map((event) => ({
    id: event.id,
    timestamp: event.timestamp,
    type: event.stream,
    bucket: event.bucket,
    amount: roundMoney(event.amount, 4),
    indexId: event.indexId || null,
    indexSymbol: event.indexSymbol || null,
    feeType: event.feeType || null,
    creationType: event.creationType || null,
  }))

  const normalizedStrategyEvents = strategyRevenueEvents.map((event) => ({
    id: event.id,
    timestamp: event.createdAt,
    type: 'strategy_royalty',
    bucket: event.feeType || 'trade',
    amount: roundMoney(event.royaltyAmount, 4),
    indexId: event.sourceIndexId || null,
    indexSymbol: null,
    feeType: event.feeType || null,
    creationType: null,
    ownerUserAddress: event.ownerUserAddress || null,
    templateName: event.templateName || null,
  }))

  return [...normalizedFinancialHistory, ...normalizedStrategyEvents]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit)
}

export function registerOverviewRoutes(router, context) {
  const { engine, indexRegistry, agentIndexFactory, systemMMs, hotCache } = context

  router.get('/dashboard', adminLimiter, (req, res) => {
    const dashboard = indexRegistry.getAdminDashboard()
    dashboard.marketMakers = Object.entries(systemMMs).map(([indexId, mm]) => mm.getSnapshot())
    dashboard.engine = {
      running: engine.running,
      tickCount: engine.tickCount,
      agentCount: engine.agents.size,
      uptime: engine.startTime ? Date.now() - engine.startTime : 0,
    }
    ok(res, dashboard)
  })

  router.get('/formulas', (req, res) => {
    ok(res, Object.entries(INDEX_FORMULAS).map(([id, formula]) => ({
      id,
      name: formula.name,
      desc: formula.desc,
      formula: formula.formula,
      behavior: formula.behavior,
      drivers: formula.drivers,
    })))
  })

  router.get('/activity', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100
    ok(res, indexRegistry.getGlobalActivity(limit))
  })

  router.get('/market-makers', (req, res) => {
    ok(res, Object.entries(systemMMs).map(([indexId, mm]) => mm.getSnapshot()))
  })

  router.get('/monitoring', (req, res) => {
    const cached = hotCache.get('admin:monitoring')
    if (cached) return ok(res, cached)

    const factoryMonitoring = agentIndexFactory.getMonitoringData()

    const indexHealth = []
    for (const [indexId, state] of indexRegistry.indexes) {
      const ob = state.orderBook.getSnapshot(5)
      const bidDepth = ob.bids.reduce((sum, order) => sum + (order.volume || order.size || 0), 0)
      const askDepth = ob.asks.reduce((sum, order) => sum + (order.volume || order.size || 0), 0)
      const spread = ob.spread || Infinity
      const spreadBps = state.oraclePrice > 0 ? (spread / state.oraclePrice) * 10000 : 0
      const circValue = state.circulatingSupply * state.oraclePrice

      indexHealth.push({
        indexId,
        symbol: state.symbol,
        name: state.name,
        status: state.status,
        pauseReason: state.pauseReason || null,
        creationType: state.creationType || 'system',
        creatorAgentId: state.creatorAgentId || null,
        oraclePrice: state.oraclePrice,
        totalVolume: Math.round(state.totalVolume * 100) / 100,
        totalTrades: state.totalTrades,
        holderCount: state.holderCount,
        circulatingSupply: state.circulatingSupply,
        circulatingValueUsd: Math.round(circValue * 100) / 100,
        treasury: {
          balance: Math.round((state.treasury?.balance || 0) * 100) / 100,
          totalCollected: Math.round((state.treasury?.totalCollected || 0) * 100) / 100,
          totalRedistributed: Math.round((state.treasury?.totalRedistributed || 0) * 100) / 100,
          totalBurned: Math.round((state.treasury?.totalBurned || 0) * 100) / 100,
          hwmPrice: Math.round((state.treasury?.hwmPrice || 0) * 1e6) / 1e6,
          backingRatio: circValue > 0
            ? Math.round(((state.treasury?.balance || 0) / circValue) * 10000) / 100
            : 0,
        },
        orderBook: {
          bidLevels: ob.bids.length,
          askLevels: ob.asks.length,
          bidDepth: Math.round(bidDepth * 100) / 100,
          askDepth: Math.round(askDepth * 100) / 100,
          spreadBps: Math.round(spreadBps * 10) / 10,
          bestBid: ob.bids[0]?.price || 0,
          bestAsk: ob.asks[0]?.price || 0,
        },
        liquidity: {
          depthScore: Math.round(Math.min(100, ((bidDepth + askDepth) / (state.maxSupply * 0.001)) * 100)),
          spreadScore: Math.round(Math.max(0, 100 - spreadBps / 5)),
          holderScore: Math.round(Math.min(100, (state.holderCount / 10) * 100)),
        },
        hasSystemMM: !!systemMMs[indexId],
        creatorFees: state.creatorFees || null,
        platformFees: state.platformFees || null,
      })
    }

    let totalCreatorFees = 0
    let totalIndexPlatformFees = 0
    let totalTreasuryBalance = 0
    let totalTreasuryCollected = 0
    for (const [, state] of indexRegistry.indexes) {
      if (state.creatorFees) totalCreatorFees += state.creatorFees.totalEarned
      if (state.platformFees) totalIndexPlatformFees += state.platformFees.totalEarned
      totalTreasuryBalance += (state.treasury?.balance || 0)
      totalTreasuryCollected += (state.treasury?.totalCollected || 0)
    }
    const totalProtocolFees = factoryMonitoring.globalPool.totalCollected
    const directPlatformFees = factoryMonitoring.platformRevenue?.totalCollected || 0
    const strategyRevenue = getStrategyRevenueSummaryGlobal()
    const strategyRevenueEvents = listRecentStrategyRevenueEvents({ limit: 200 })
    const recentStrategyRevenueEvents = strategyRevenueEvents.slice(0, 8)
    const financialHistory = agentIndexFactory.getFinancialHistorySnapshot(400)
    const financialTimeline = buildFinancialTimeline(financialHistory, strategyRevenueEvents, 72)
    const recentFinancialEvents = buildRecentFinancialEvents(financialHistory, strategyRevenueEvents, 24)

    const systemIndexRevenue = indexHealth
      .filter((item) => item.creationType !== 'agent')
      .reduce((sum, item) => sum + Number(item.platformFees?.totalEarned || 0), 0)
    const agentIndexProtocolRevenue = indexHealth
      .filter((item) => item.creationType === 'agent')
      .reduce((sum, item) => sum + Number(item.platformFees?.totalEarned || 0), 0)

    const financials = {
      summary: {
        directPlatformFees: roundMoney(directPlatformFees),
        managedProtocolFees: roundMoney(totalProtocolFees),
        grossPlatformFees: roundMoney(directPlatformFees + totalProtocolFees),
        creatorFees: roundMoney(totalCreatorFees),
        strategyRoyalties: roundMoney(strategyRevenue.totalRevenue || 0),
        totalTreasuryBalance: roundMoney(totalTreasuryBalance),
        totalTreasuryCollected: roundMoney(totalTreasuryCollected),
        totalIndexPlatformFees: roundMoney(totalIndexPlatformFees),
        systemIndexRevenue: roundMoney(systemIndexRevenue),
        agentIndexProtocolRevenue: roundMoney(agentIndexProtocolRevenue),
      },
      composition: {
        directPlatform: {
          total: roundMoney(directPlatformFees),
          trading: roundMoney(factoryMonitoring.platformRevenue?.breakdown?.fromSystemTradingFees || 0),
          mint: roundMoney(factoryMonitoring.platformRevenue?.breakdown?.fromSystemMintFees || 0),
        },
        managedProtocol: {
          total: roundMoney(totalProtocolFees),
          creation: roundMoney(factoryMonitoring.globalPool?.breakdown?.fromCreationFees || 0),
          trading: roundMoney(factoryMonitoring.globalPool?.breakdown?.fromTradingFees || 0),
          mint: roundMoney(factoryMonitoring.globalPool?.breakdown?.fromMintFees || 0),
        },
        creator: {
          total: roundMoney(totalCreatorFees),
        },
        royalties: {
          total: roundMoney(strategyRevenue.totalRevenue || 0),
        },
      },
      platformRevenue: factoryMonitoring.platformRevenue,
      globalPool: factoryMonitoring.globalPool,
      timeline: financialTimeline,
      recentEvents: recentFinancialEvents,
      indexRevenue: indexHealth.map((item) => ({
        indexId: item.indexId,
        symbol: item.symbol,
        name: item.name,
        creationType: item.creationType,
        totalVolume: item.totalVolume,
        totalTrades: item.totalTrades,
        treasuryBalance: roundMoney(item.treasury?.balance || 0),
        creatorFees: roundMoney(item.creatorFees?.totalEarned || 0),
        platformFees: roundMoney(item.platformFees?.totalEarned || 0),
      })),
    }

    const mmHealth = Object.entries(systemMMs).map(([indexId, mm]) => {
      const snapshot = mm.getSnapshot()
      return {
        indexId,
        symbol: snapshot.indexId || indexId,
        running: snapshot.running,
        inventory: snapshot.inventory,
        pnl: snapshot.pnl,
        ordersPlaced: snapshot.ordersPlaced,
        config: snapshot.config,
      }
    })

    const pausedIndexes = indexHealth
      .filter((item) => item.status === 'paused' && item.pauseReason)
      .map((item) => ({
        targetType: 'index',
        targetId: item.indexId,
        label: item.symbol,
        reason: item.pauseReason,
        status: item.status,
      }))

    const pausedAgents = engine.getAllAgents()
      .filter((agent) => agent.status === 'paused' && agent.pauseReason)
      .map((agent) => ({
        targetType: 'agent',
        targetId: agent.id,
        label: agent.name,
        reason: agent.pauseReason,
        status: agent.status,
      }))

    const recentSafetyHits = [
      ...(indexRegistry.getSafetyEvents?.(25) || []),
      ...(engine.getSafetyEvents?.(25) || []),
    ]
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 20)
    const totalSafetyHits = (indexRegistry.getSafetyEvents?.(0) || []).length + (engine.getSafetyEvents?.(0) || []).length

    const payload = {
      timestamp: Date.now(),
      overview: {
        totalIndexes: indexRegistry.indexes.size,
        systemIndexes: Array.from(indexRegistry.indexes.values()).filter((state) => state.creationType !== 'agent').length,
        agentIndexes: factoryMonitoring.totalAgentIndexes,
        activeIndexes: Array.from(indexRegistry.indexes.values()).filter((state) => state.status === 'active').length,
        totalFeeRevenue: {
          creatorFees: Math.round(totalCreatorFees * 100) / 100,
          protocolFees: Math.round(totalProtocolFees * 100) / 100,
          directPlatformFees: Math.round(directPlatformFees * 100) / 100,
          grossPlatformFees: Math.round((directPlatformFees + totalProtocolFees) * 100) / 100,
          strategyRoyalties: Math.round((strategyRevenue.totalRevenue || 0) * 100) / 100,
        },
        strategyRevenue,
      },
      safeguards: {
        pausedIndexCount: pausedIndexes.length,
        pausedAgentCount: pausedAgents.length,
        totalHits: totalSafetyHits,
        pausedIndexes,
        pausedAgents,
        recentHits: recentSafetyHits,
      },
      globalPool: factoryMonitoring.globalPool,
      platformRevenue: factoryMonitoring.platformRevenue,
      financials,
      indexHealth,
      agentIndexes: factoryMonitoring.indexes,
      marketMakers: mmHealth,
      recentStrategyRevenueEvents,
      config: factoryMonitoring.config,
    }

    hotCache.set('admin:monitoring', payload)
    ok(res, payload)
  })

  router.get('/financials', (req, res) => {
    const cached = hotCache.get('admin:monitoring')
    if (cached?.financials) return ok(res, cached.financials)

    const factoryMonitoring = agentIndexFactory.getMonitoringData()
    const strategyRevenueEvents = listRecentStrategyRevenueEvents({ limit: 200 })
    const financialHistory = agentIndexFactory.getFinancialHistorySnapshot(400)
    ok(res, {
      summary: {
        directPlatformFees: roundMoney(factoryMonitoring.platformRevenue?.totalCollected || 0),
        managedProtocolFees: roundMoney(factoryMonitoring.globalPool?.totalCollected || 0),
        grossPlatformFees: roundMoney((factoryMonitoring.platformRevenue?.totalCollected || 0) + (factoryMonitoring.globalPool?.totalCollected || 0)),
        strategyRoyalties: roundMoney(getStrategyRevenueSummaryGlobal().totalRevenue || 0),
      },
      platformRevenue: factoryMonitoring.platformRevenue,
      globalPool: factoryMonitoring.globalPool,
      timeline: buildFinancialTimeline(financialHistory, strategyRevenueEvents, 72),
      recentEvents: buildRecentFinancialEvents(financialHistory, strategyRevenueEvents, 24),
    })
  })
}
