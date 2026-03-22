// ═══════════════════════════════════════════════════════════════════════
// LLM Module Integration Test
//
// Tests the full pipeline: contextAssembler → prePrompter → responseParser
// Also tests individual modules in isolation.
//
// Run: node --experimental-vm-modules server/engine/llm/test.js
// ═══════════════════════════════════════════════════════════════════════

import { buildContext, aggregateCandles, computeImbalance, detectTrend } from './contextAssembler.js'
import { buildPrompts, buildReflectionPrompts } from './prePrompter.js'
import { parse } from './responseParser.js'
import { LLM_CONFIG } from './config.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}: ${err.message}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed')
}

// ─── Mock Data ─────────────────────────────────────────────────────

const mockAgent = {
  id: 'test-agent-1',
  name: 'TestBot',
  strategy: 'llm_trader',
  riskLevel: 'medium',
  bio: 'A careful AI trader who likes mean reversion',
  virtualBalance: 500,
  position: 100,
  positionValue: 3.4,
  avgEntryPrice: 0.034,
  realizedPnl: 1.5,
  unrealizedPnl: 0.2,
  maxDrawdown: 5.2,
  totalTrades: 15,
  winningTrades: 9,
  losingTrades: 6,
  openOrders: [],
  config: {},
  trades: [
    { side: 'buy', price: 0.033, size: 50, pnl: 0.1, timestamp: Date.now() - 60000 },
    { side: 'sell', price: 0.035, size: 30, pnl: 0.06, timestamp: Date.now() - 30000 },
  ],
}

const mockCtx = {
  mid: 0.034,
  bestBid: 0.0338,
  bestAsk: 0.0342,
  spread: 0.0004,
  currentPrice: 0.034,
  priceHistory: Array.from({ length: 50 }, (_, i) => 0.033 + Math.sin(i / 5) * 0.002),
  volumeHistory: Array.from({ length: 50 }, () => Math.random() * 100),
  volatility: 0.015,
  tickCount: 42,
  bandLow: 0.030,
  bandHigh: 0.038,
  bandWidthPct: 6,
  pendingOrders: [
    { id: 'o1', side: 'buy', price: 0.0335, remaining: 20, timestamp: Date.now() - 5000 },
    { id: 'o2', side: 'sell', price: 0.0345, remaining: 15, timestamp: Date.now() - 3000 },
  ],
  allIndexContexts: {
    AI_TRADE: {
      oraclePrice: 1.23,
      mid: 1.24,
      bandLow: 1.19,
      bandHigh: 1.27,
      spread: 0.02,
      priceHistory: Array.from({ length: 20 }, (_, i) => 1.2 + i * 0.002),
    },
  },
}

// ═══════════════════════════════════════════════════════════════════════
console.log('\n🧪 LLM Module Integration Tests\n')

// ─── Context Assembler ─────────────────────────────────────────────
console.log('📦 Context Assembler:')

test('buildContext returns all sections', () => {
  const ctx = buildContext(mockAgent, mockCtx)
  assert(ctx.agent, 'missing agent section')
  assert(ctx.market, 'missing market section')
  assert(ctx.indexes, 'missing indexes section')
  assert(ctx.meta, 'missing meta section')
  assert(typeof ctx.summary === 'string', 'missing summary')
})

test('agent section has correct fields', () => {
  const ctx = buildContext(mockAgent, mockCtx)
  assert(ctx.agent.name === 'TestBot', `name=${ctx.agent.name}`)
  assert(ctx.agent.balance === 500, `balance=${ctx.agent.balance}`)
  assert(ctx.agent.position === 100, `position=${ctx.agent.position}`)
  assert(ctx.agent.winRate === '60.0%', `winRate=${ctx.agent.winRate}`)
  assert(ctx.agent.recentTrades.length === 2, `trades=${ctx.agent.recentTrades.length}`)
})

test('market section has computed fields', () => {
  const ctx = buildContext(mockAgent, mockCtx)
  assert(ctx.market.mid === 0.034, `mid=${ctx.market.mid}`)
  assert(ctx.market.spreadPct > 0, `spreadPct=${ctx.market.spreadPct}`)
  assert(ctx.market.recentPrices.length === 20, `recentPrices=${ctx.market.recentPrices.length}`)
  assert(ctx.market.candles.length > 0, `candles=${ctx.market.candles.length}`)
  assert(ctx.market.imbalance.signal, `imbalance=${JSON.stringify(ctx.market.imbalance)}`)
  assert(['up', 'down', 'sideways'].includes(ctx.market.trend), `trend=${ctx.market.trend}`)
})

test('indexes section parses correctly', () => {
  const ctx = buildContext(mockAgent, mockCtx)
  assert(ctx.indexes.length === 1, `indexes=${ctx.indexes.length}`)
  assert(ctx.indexes[0].indexId === 'AI_TRADE', `indexId=${ctx.indexes[0].indexId}`)
  assert(ctx.indexes[0].oraclePrice === 1.23, `oracle=${ctx.indexes[0].oraclePrice}`)
})

test('aggregateCandles produces correct structure', () => {
  const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const candles = aggregateCandles(prices, 5)
  assert(candles.length === 2, `candles=${candles.length}`)
  assert(candles[0].open === 1, `open=${candles[0].open}`)
  assert(candles[0].high === 5, `high=${candles[0].high}`)
  assert(candles[0].low === 1, `low=${candles[0].low}`)
  assert(candles[0].close === 5, `close=${candles[0].close}`)
})

test('detectTrend identifies uptrend', () => {
  const upTrend = Array.from({ length: 20 }, (_, i) => 1.0 + i * 0.01)
  assert(detectTrend(upTrend) === 'up', `expected 'up', got '${detectTrend(upTrend)}'`)
})

test('detectTrend identifies downtrend', () => {
  const downTrend = Array.from({ length: 20 }, (_, i) => 2.0 - i * 0.01)
  assert(detectTrend(downTrend) === 'down', `expected 'down'`)
})

test('detectTrend identifies sideways', () => {
  const flat = Array.from({ length: 20 }, () => 1.0)
  assert(detectTrend(flat) === 'sideways', `expected 'sideways'`)
})

test('computeImbalance detects buy pressure', () => {
  const ctx = { pendingOrders: [
    { side: 'buy', remaining: 100 },
    { side: 'buy', remaining: 100 },
    { side: 'sell', remaining: 20 },
  ]}
  const imb = computeImbalance(ctx)
  assert(imb.signal === 'buy_pressure', `signal=${imb.signal}`)
  assert(imb.ratio > 0.65, `ratio=${imb.ratio}`)
})

// ─── Pre-Prompter ──────────────────────────────────────────────────
console.log('\n✍️  Pre-Prompter:')

test('buildPrompts returns system and user prompts', () => {
  const ctx = buildContext(mockAgent, mockCtx)
  const { systemPrompt, userPrompt } = buildPrompts(mockAgent, ctx)
  assert(typeof systemPrompt === 'string' && systemPrompt.length > 100, 'systemPrompt too short')
  assert(typeof userPrompt === 'string' && userPrompt.length > 100, 'userPrompt too short')
})

test('system prompt contains agent identity', () => {
  const ctx = buildContext(mockAgent, mockCtx)
  const { systemPrompt } = buildPrompts(mockAgent, ctx)
  assert(systemPrompt.includes('TestBot'), 'missing agent name')
  assert(systemPrompt.includes('medium'), 'missing risk level')
  assert(systemPrompt.includes('mean reversion'), 'missing bio')
})

test('user prompt contains market data', () => {
  const ctx = buildContext(mockAgent, mockCtx)
  const { userPrompt } = buildPrompts(mockAgent, ctx)
  assert(userPrompt.includes('0.034'), 'missing mid price')
  assert(userPrompt.includes('500'), 'missing balance')
  assert(userPrompt.includes('100'), 'missing position')
  assert(userPrompt.includes('Tick #42'), 'missing tick count')
})

test('user prompt includes memory when provided', () => {
  const ctx = buildContext(mockAgent, mockCtx)
  const memory = {
    decisions: [
      { tick: 30, action: 'buy', price: 0.033, size: 50, confidence: 0.8, reasoning: 'Test buy', outcome_tag: 'win', outcome_pnl: 0.05 },
    ],
    insights: [
      { content: { one_line_insight: 'Buy on dips works well' } },
    ],
  }
  const { userPrompt } = buildPrompts(mockAgent, ctx, memory)
  assert(userPrompt.includes('Recent Memory'), 'missing memory section')
  assert(userPrompt.includes('Buy on dips'), 'missing insight')
})

test('buildReflectionPrompts generates reflection prompt', () => {
  const decisions = [
    { tick: 10, action: 'buy', instrument: 'MAIN', price: 0.033, size: 50, confidence: 0.8, reasoning: 'dip buy', outcome_tag: 'win', outcome_pnl: 0.05 },
    { tick: 20, action: 'sell', instrument: 'MAIN', price: 0.035, size: 30, confidence: 0.7, reasoning: 'take profit', outcome_tag: 'win', outcome_pnl: 0.06 },
    { tick: 30, action: 'buy', instrument: 'MAIN', price: 0.036, size: 40, confidence: 0.6, reasoning: 'momentum', outcome_tag: 'loss', outcome_pnl: -0.03 },
  ]
  const { systemPrompt, userPrompt } = buildReflectionPrompts(mockAgent, decisions)
  assert(systemPrompt.includes('analyst'), 'missing analyst identity')
  assert(userPrompt.includes('TestBot'), 'missing agent name')
  assert(userPrompt.includes('dip buy'), 'missing decision')
  assert(userPrompt.includes('Wins: 2'), 'wrong win count')
})

// ─── Response Parser ───────────────────────────────────────────────
console.log('\n🔍 Response Parser:')

test('parse valid JSON response', () => {
  const raw = JSON.stringify({
    thinking: 'Market is trending up with low volatility',
    action: 'buy',
    instrument: 'MAIN',
    price: 0.034,
    size: 50,
    confidence: 0.75,
    reasoning: 'Uptrend detected, buying dip',
    risk_note: 'Watch for reversal',
  })
  const { signals, metadata } = parse(raw, mockAgent, mockCtx)
  assert(signals.length === 1, `signals=${signals.length}`)
  assert(signals[0].action === 'buy', `action=${signals[0].action}`)
  assert(signals[0].price === 0.034, `price=${signals[0].price}`)
  assert(signals[0].confidence === 0.75, `conf=${signals[0].confidence}`)
  assert(metadata.thinking.includes('trending up'), `thinking=${metadata.thinking}`)
})

test('parse JSON wrapped in markdown', () => {
  const raw = '```json\n{"action":"sell","price":0.035,"size":30,"confidence":0.8,"reasoning":"Take profit"}\n```'
  const { signals } = parse(raw, mockAgent, mockCtx)
  assert(signals[0].action === 'sell', `action=${signals[0].action}`)
})

test('parse invalid JSON → hold fallback', () => {
  const raw = 'This is not JSON at all!'
  const { signals, metadata } = parse(raw, mockAgent, mockCtx)
  assert(signals[0].action === 'hold', `action=${signals[0].action}`)
  assert(metadata.parseError, 'missing parseError')
})

test('low confidence → hold (gated)', () => {
  const raw = JSON.stringify({ action: 'buy', price: 0.034, size: 50, confidence: 0.2, reasoning: 'Unsure' })
  const { signals, metadata } = parse(raw, mockAgent, mockCtx)
  assert(signals[0].action === 'hold', `action=${signals[0].action}`)
  assert(metadata.gated === true, 'should be gated')
})

test('sell size clamped to position', () => {
  const raw = JSON.stringify({ action: 'sell', price: 0.035, size: 9999, confidence: 0.9, reasoning: 'Sell all' })
  const { signals } = parse(raw, mockAgent, mockCtx)
  assert(signals[0].size <= mockAgent.position, `size=${signals[0].size} > position=${mockAgent.position}`)
})

test('buy size clamped to balance', () => {
  const raw = JSON.stringify({ action: 'buy', price: 0.034, size: 999999, confidence: 0.9, reasoning: 'Buy heavy' })
  const { signals } = parse(raw, mockAgent, mockCtx)
  const maxSize = (mockAgent.virtualBalance * 0.9) / 0.034
  assert(signals[0].size <= maxSize, `size=${signals[0].size} > maxSize=${maxSize}`)
})

test('price clamped to band', () => {
  const raw = JSON.stringify({ action: 'buy', price: 0.050, size: 10, confidence: 0.9, reasoning: 'High bid' })
  const { signals } = parse(raw, mockAgent, mockCtx)
  assert(signals[0].price <= mockCtx.bandHigh, `price=${signals[0].price} > bandHigh=${mockCtx.bandHigh}`)
})

test('invalid action → hold', () => {
  const raw = JSON.stringify({ action: 'short', price: 0.034, size: 10, confidence: 0.9, reasoning: 'Invalid' })
  const { signals } = parse(raw, mockAgent, mockCtx)
  assert(signals[0].action === 'hold', `action=${signals[0].action}`)
})

test('hold action passes through', () => {
  const raw = JSON.stringify({ action: 'hold', confidence: 0.6, reasoning: 'Waiting for better entry' })
  const { signals } = parse(raw, mockAgent, mockCtx)
  assert(signals[0].action === 'hold', `action=${signals[0].action}`)
  assert(signals[0].reasoning === 'Waiting for better entry', `reasoning=${signals[0].reasoning}`)
})

test('cancel_all passes through', () => {
  const raw = JSON.stringify({ action: 'cancel_all', confidence: 0.9, reasoning: 'Clear the book' })
  const { signals } = parse(raw, mockAgent, mockCtx)
  assert(signals[0].action === 'cancel_all', `action=${signals[0].action}`)
})

test('size scaled by confidence', () => {
  const raw = JSON.stringify({ action: 'buy', price: 0.034, size: 100, confidence: 0.5, reasoning: 'Half sure' })
  const { signals } = parse(raw, mockAgent, mockCtx)
  // size should be 100 * 0.5 = 50, then clamped by balance
  assert(signals[0].size < 100, `size should be scaled down: ${signals[0].size}`)
})

test('empty response → hold', () => {
  const { signals } = parse('', mockAgent, mockCtx)
  assert(signals[0].action === 'hold', `action=${signals[0].action}`)
})

test('null response → hold', () => {
  const { signals } = parse(null, mockAgent, mockCtx)
  assert(signals[0].action === 'hold', `action=${signals[0].action}`)
})

// ─── Full Pipeline Test ────────────────────────────────────────────
console.log('\n🔗 Full Pipeline (mock LLM):')

test('context → prompts → parse → signals', () => {
  // 1. Build context
  const ctx = buildContext(mockAgent, mockCtx)
  assert(ctx.agent.balance === 500, 'context build failed')

  // 2. Build prompts
  const { systemPrompt, userPrompt } = buildPrompts(mockAgent, ctx)
  assert(systemPrompt.length > 100, 'system prompt too short')
  assert(userPrompt.length > 100, 'user prompt too short')

  // 3. Simulate LLM response
  const mockLLMResponse = JSON.stringify({
    thinking: 'Market shows buy pressure with uptrend. Spread is tight, vol is low.',
    action: 'buy',
    instrument: 'MAIN',
    price: 0.0339,
    size: 40,
    confidence: 0.72,
    reasoning: 'Buy pressure + uptrend + low volatility = good entry',
    risk_note: 'Position will be 140 units, ~28% of balance',
  })

  // 4. Parse
  const { signals, metadata } = parse(mockLLMResponse, mockAgent, mockCtx)
  assert(signals[0].action === 'buy', `final action=${signals[0].action}`)
  assert(signals[0].price >= mockCtx.bandLow && signals[0].price <= mockCtx.bandHigh, 'price out of band')
  assert(signals[0].size > 0, 'size must be > 0')
  assert(signals[0].confidence === 0.72, `confidence=${signals[0].confidence}`)
  assert(metadata.thinking.includes('buy pressure'), `thinking missing content`)
})

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log(`${'═'.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)
