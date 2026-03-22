#!/usr/bin/env node

import assert from 'assert'
import { randomUUID } from 'crypto'
import { AgentIndexFactory } from '../server/engine/agentIndexFactory.js'
import { IndexRegistry } from '../server/engine/indexRegistry.js'
import {
  createStrategyTemplate,
  getStrategyRevenueSummaryByOwner,
} from '../server/db.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`✅ ${name}`)
  } catch (error) {
    failed++
    console.log(`❌ ${name}`)
    console.log(`   ${error.message}`)
  }
}

function assertClose(actual, expected, epsilon = 1e-6, label = 'values') {
  const diff = Math.abs(actual - expected)
  assert.ok(diff <= epsilon, `${label}: expected ${expected}, got ${actual} (diff=${diff})`)
}

function makeAgent(id, virtualBalance, extra = {}) {
  return {
    id,
    name: extra.name || id,
    icon: extra.icon || '🤖',
    virtualBalance,
    feeIncome: 0,
    trades: [],
    decisions: [],
    realizedPnl: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalTrades: 0,
    totalVolume: 0,
    ...extra,
  }
}

function createHarness({ creatorPresent }) {
  const creator = creatorPresent ? makeAgent('creator', 100, { name: 'Creator' }) : null
  const buyer = makeAgent('buyer', 5_000, { name: 'Buyer' })
  const seller = makeAgent('seller', 500, { name: 'Seller' })

  const agentManager = {
    agents: new Map([
      ['buyer', buyer],
      ['seller', seller],
      ...(creator ? [['creator', creator]] : []),
    ]),
    getAgent(id) {
      return this.agents.get(id)
    },
  }

  const registry = new IndexRegistry({ agentManager })
  registry._emitFeed = () => {}

  const factory = new AgentIndexFactory({
    indexRegistry: registry,
    agentManager,
    systemMMs: {},
    IndexMarketMaker: class {},
  })
  factory._saveGlobalPool = () => {}
  registry.agentIndexFactory = factory

  const state = {
    id: creatorPresent ? 'IDX_PRESENT' : 'IDX_MISSING',
    name: 'Fee Test Index',
    symbol: 'FEE',
    description: 'fee smoke test',
    formulaId: 'creator_pnl',
    icon: '📈',
    status: 'active',
    oracleIntervalMs: 25_000,
    lastOracleAt: 0,
    oraclePrice: 10,
    prevOraclePrice: 10,
    bandWidthPct: 4,
    bandLow: 9.6,
    bandHigh: 10.4,
    maxSupply: 200_000,
    circulatingSupply: 0,
    initialPrice: 10,
    totalVolume: 0,
    totalTrades: 0,
    holderCount: 0,
    params: {},
    creationType: 'agent',
    creatorAgentId: 'creator',
    creatorFees: {
      totalEarned: 0,
      tradingFees: 0,
      mintFees: 0,
      performanceFees: 0,
    },
    feeHistory: [],
    holders: new Map(),
    recentTrades: [],
    treasury: {
      balance: 0,
      totalCollected: 0,
      totalRedistributed: 0,
      totalBurned: 0,
      lastRedistributionAt: 0,
      redistributionCount: 0,
      creatorStakeTarget: 0,
      creatorStakeAccrued: 0,
      creatorStakeLockUntil: 0,
      hwmPrice: 10,
    },
  }

  registry.indexes.set(state.id, state)
  return { creator, buyer, seller, agentManager, registry, factory, state }
}

function seedPublicStrategyTemplate({ ownerUserAddress, name = 'Royalty Strategy' }) {
  const now = Date.now()
  return createStrategyTemplate({
    id: randomUUID(),
    ownerUserAddress,
    slug: `royalty-${Math.random().toString(36).slice(2, 10)}`,
    name,
    shortDescription: 'Revenue share verification template',
    category: 'custom',
    type: 'llm',
    visibility: 'public',
    status: 'published',
    complexityScore: 0.5,
    explainabilityScore: 0.5,
    createdAt: now,
    updatedAt: now,
  })
}

console.log('\n🧪 Fee Accounting Smoke Test\n')

test('preview reports retained mint fee when creator is missing', () => {
  const { factory, state } = createHarness({ creatorPresent: false })
  const preview = factory.getFeePreview(state.id, 1_000, 'mint')
  assertClose(preview.totalFee, 10, 1e-9, 'mint total fee')
  assertClose(preview.payableFee, 5, 1e-9, 'mint payable fee')
  assertClose(preview.retainedFee, 5, 1e-9, 'mint retained fee')
})

test('preview reports retained trade fee when creator is missing', () => {
  const { factory, state } = createHarness({ creatorPresent: false })
  const preview = factory.getFeePreview(state.id, 1_000, 'trade')
  assertClose(preview.totalFee, 3, 1e-9, 'trade total fee')
  assertClose(preview.payableFee, 1.5, 1e-9, 'trade payable fee')
  assertClose(preview.retainedFee, 1.5, 1e-9, 'trade retained fee')
})

test('_tryMint credits treasury net of full payable fee when creator exists', () => {
  const { creator, registry, factory, state } = createHarness({ creatorPresent: true })
  registry._tryMint(state, 'buyer', 100, 10)

  assertClose(state.treasury.balance, 990, 1e-9, 'treasury balance after mint')
  assertClose(state.treasury.totalCollected, 990, 1e-9, 'treasury collected after mint')
  assertClose(factory.globalPool.balance, 5, 1e-9, 'protocol pool after mint')
  assertClose(creator.virtualBalance, 105, 1e-9, 'creator balance after mint fee')
  assertClose(state.creatorFees.totalEarned, 5, 1e-9, 'creator earned after mint')
})

test('_tryMint keeps creator share in treasury when creator is missing', () => {
  const { registry, factory, state } = createHarness({ creatorPresent: false })
  registry._tryMint(state, 'buyer', 100, 10)

  assertClose(state.treasury.balance, 995, 1e-9, 'treasury balance after mint')
  assertClose(state.treasury.totalCollected, 995, 1e-9, 'treasury collected after mint')
  assertClose(factory.globalPool.balance, 5, 1e-9, 'protocol pool after mint')
  assertClose(state.creatorFees.totalEarned, 0, 1e-9, 'creator earned after mint')
})

test('_onIndexTrade with passive seller withholds full trade fee when creator exists', () => {
  const { creator, seller, registry, factory, state } = createHarness({ creatorPresent: true })
  state.holders.set('seller', {
    balance: 100,
    avgEntryPrice: 8,
    realizedPnl: 0,
    totalBought: 100,
    totalSold: 0,
  })

  registry._onIndexTrade(state, {
    id: 'trade-present',
    buyAgentId: 'buyer',
    sellAgentId: 'seller',
    aggressorSide: 'buy',
    price: 10,
    size: 100,
    timestamp: Date.now(),
  })

  assertClose(seller.virtualBalance, 1_497, 1e-9, 'seller cash after trade')
  assertClose(seller.realizedPnl, 197, 1e-9, 'seller pnl after trade')
  assertClose(factory.globalPool.balance, 1.5, 1e-9, 'protocol pool after trade')
  assertClose(creator.virtualBalance, 101.5, 1e-9, 'creator balance after trade fee')
  assertClose(state.creatorFees.tradingFees, 1.5, 1e-9, 'creator trading fees after trade')
})

test('_onIndexTrade with passive seller retains missing creator share in treasury economics', () => {
  const { seller, registry, factory, state } = createHarness({ creatorPresent: false })
  state.holders.set('seller', {
    balance: 100,
    avgEntryPrice: 8,
    realizedPnl: 0,
    totalBought: 100,
    totalSold: 0,
  })

  registry._onIndexTrade(state, {
    id: 'trade-missing',
    buyAgentId: 'buyer',
    sellAgentId: 'seller',
    aggressorSide: 'buy',
    price: 10,
    size: 100,
    timestamp: Date.now(),
  })

  assertClose(seller.virtualBalance, 1_498.5, 1e-9, 'seller cash after trade')
  assertClose(seller.realizedPnl, 198.5, 1e-9, 'seller pnl after trade')
  assertClose(factory.globalPool.balance, 1.5, 1e-9, 'protocol pool after trade')
  assertClose(state.creatorFees.tradingFees, 0, 1e-9, 'creator trading fees after trade')
})

test('public custom strategy author earns royalty from another agent trade without increasing trader fee', () => {
  const { creator, seller, registry, factory, state } = createHarness({ creatorPresent: true })
  const templateOwner = `wallet:${randomUUID()}`
  const template = seedPublicStrategyTemplate({ ownerUserAddress: templateOwner })
  const before = getStrategyRevenueSummaryByOwner(templateOwner)

  seller.walletAddress = `wallet:${randomUUID()}`
  seller.config = {
    ...(seller.config || {}),
    strategyTemplateId: template.id,
    activeStrategyInstanceId: randomUUID(),
    strategySource: 'custom_public',
  }

  state.holders.set('seller', {
    balance: 100,
    avgEntryPrice: 8,
    realizedPnl: 0,
    totalBought: 100,
    totalSold: 0,
  })

  registry._onIndexTrade(state, {
    id: `trade-royalty-${randomUUID()}`,
    buyAgentId: 'buyer',
    sellAgentId: 'seller',
    aggressorSide: 'buy',
    price: 10,
    size: 100,
    timestamp: Date.now(),
  })

  const after = getStrategyRevenueSummaryByOwner(templateOwner)
  assertClose(seller.virtualBalance, 1_497, 1e-9, 'seller cash after royalty trade')
  assertClose(creator.virtualBalance, 101.5, 1e-9, 'index creator balance after royalty trade')
  assertClose(factory.globalPool.balance, 1.125, 1e-9, 'protocol pool after royalty share')
  assertClose(after.totalRevenue - before.totalRevenue, 0.375, 1e-9, 'strategy author royalty delta')
})

test('self-owned public strategy does not earn royalty from its own agent trades', () => {
  const { seller, registry, factory, state } = createHarness({ creatorPresent: false })
  const ownerWallet = `wallet:${randomUUID()}`
  const template = seedPublicStrategyTemplate({ ownerUserAddress: ownerWallet, name: 'Self Use Strategy' })
  const before = getStrategyRevenueSummaryByOwner(ownerWallet)

  seller.walletAddress = ownerWallet
  seller.config = {
    ...(seller.config || {}),
    strategyTemplateId: template.id,
    activeStrategyInstanceId: randomUUID(),
    strategySource: 'custom_public',
  }

  state.holders.set('seller', {
    balance: 100,
    avgEntryPrice: 8,
    realizedPnl: 0,
    totalBought: 100,
    totalSold: 0,
  })

  registry._onIndexTrade(state, {
    id: `trade-self-${randomUUID()}`,
    buyAgentId: 'buyer',
    sellAgentId: 'seller',
    aggressorSide: 'buy',
    price: 10,
    size: 100,
    timestamp: Date.now(),
  })

  const after = getStrategyRevenueSummaryByOwner(ownerWallet)
  assertClose(factory.globalPool.balance, 1.5, 1e-9, 'protocol pool unchanged for self-owned strategy')
  assertClose(after.totalRevenue - before.totalRevenue, 0, 1e-9, 'self-owned strategy royalty delta')
})

console.log(`\nPassed: ${passed}`)
if (failed > 0) {
  console.log(`Failed: ${failed}`)
  process.exit(1)
}
console.log('All fee accounting smoke checks passed.')
