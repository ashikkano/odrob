// ═══════════════════════════════════════════════════════════════════════
// OrderBook v2 — Comprehensive Test Suite
// Run: node server/engine/orderbook-v2/test.js
// ═══════════════════════════════════════════════════════════════════════

import assert from 'assert'
import { RBTree }          from './rbtree.js'
import { PriceLevel }      from './priceLevel.js'
import { OrderIndex }      from './orderIndex.js'
import { RingBuffer }      from './ringBuffer.js'
import { OrderSideTree }   from './orderSideTree.js'
import { MatchingEngine }  from './matchingEngine.js'
import { TriggerBook }     from './triggerBook.js'
import { TriggerMonitor }  from './triggerMonitor.js'
import { OrderBookV2 }     from './index.js'
import { createOrder, OrderType, TimeInForce, STPMode } from './order.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ❌ ${name}`)
    console.log(`     ${e.message}`)
    if (e.stack) {
      const line = e.stack.split('\n').find(l => l.includes('test.js'))
      if (line) console.log(`     ${line.trim()}`)
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🌳 Red-Black Tree')
/* ═══════════════════════════════════════════════════════════════════ */

test('insert and find', () => {
  const tree = new RBTree()
  tree.insert(10, 'a')
  tree.insert(5, 'b')
  tree.insert(15, 'c')
  tree.insert(3, 'd')
  tree.insert(7, 'e')

  assert.strictEqual(tree.find(10), 'a')
  assert.strictEqual(tree.find(5), 'b')
  assert.strictEqual(tree.find(15), 'c')
  assert.strictEqual(tree.find(3), 'd')
  assert.strictEqual(tree.find(7), 'e')
  assert.strictEqual(tree.find(99), null)
  assert.strictEqual(tree.size, 5)
})

test('insert duplicate updates value', () => {
  const tree = new RBTree()
  tree.insert(10, 'first')
  tree.insert(10, 'second')
  assert.strictEqual(tree.find(10), 'second')
  assert.strictEqual(tree.size, 1)
})

test('min and max', () => {
  const tree = new RBTree()
  tree.insert(50, 'mid')
  tree.insert(20, 'low')
  tree.insert(80, 'high')
  tree.insert(10, 'lowest')
  tree.insert(90, 'highest')

  assert.strictEqual(tree.min().key, 10)
  assert.strictEqual(tree.max().key, 90)
})

test('remove leaf', () => {
  const tree = new RBTree()
  tree.insert(10, 'a')
  tree.insert(5, 'b')
  tree.insert(15, 'c')

  assert.strictEqual(tree.remove(5), 'b')
  assert.strictEqual(tree.size, 2)
  assert.strictEqual(tree.find(5), null)
  assert.strictEqual(tree.find(10), 'a')
  assert.strictEqual(tree.find(15), 'c')
})

test('remove root', () => {
  const tree = new RBTree()
  tree.insert(10, 'a')
  tree.insert(5, 'b')
  tree.insert(15, 'c')

  assert.strictEqual(tree.remove(10), 'a')
  assert.strictEqual(tree.size, 2)
  assert.strictEqual(tree.find(10), null)
})

test('remove node with two children', () => {
  const tree = new RBTree()
  for (const v of [50, 25, 75, 10, 30, 60, 80]) {
    tree.insert(v, `v${v}`)
  }
  tree.remove(25)
  assert.strictEqual(tree.find(25), null)
  assert.strictEqual(tree.size, 6)
  // All other nodes still exist
  for (const v of [50, 75, 10, 30, 60, 80]) {
    assert.ok(tree.find(v) !== null, `node ${v} should exist`)
  }
})

test('remove all nodes', () => {
  const tree = new RBTree()
  const vals = [40, 20, 60, 10, 30, 50, 70, 5, 15, 25, 35, 45, 55, 65, 75]
  for (const v of vals) tree.insert(v, v)
  assert.strictEqual(tree.size, 15)

  for (const v of vals) {
    tree.remove(v)
  }
  assert.strictEqual(tree.size, 0)
  assert.strictEqual(tree.min(), null)
  assert.strictEqual(tree.max(), null)
})

test('forEach ascending', () => {
  const tree = new RBTree()
  tree.insert(30, 'c')
  tree.insert(10, 'a')
  tree.insert(20, 'b')
  const keys = []
  tree.forEach((k) => keys.push(k))
  assert.deepStrictEqual(keys, [10, 20, 30])
})

test('forEachDesc descending', () => {
  const tree = new RBTree()
  tree.insert(30, 'c')
  tree.insert(10, 'a')
  tree.insert(20, 'b')
  const keys = []
  tree.forEachDesc((k) => keys.push(k))
  assert.deepStrictEqual(keys, [30, 20, 10])
})

test('firstN ascending and descending', () => {
  const tree = new RBTree()
  for (let i = 1; i <= 10; i++) tree.insert(i, `v${i}`)
  const first3 = tree.firstN(3)
  assert.deepStrictEqual(first3.map(n => n.key), [1, 2, 3])
  const last3 = tree.firstN(3, true)
  assert.deepStrictEqual(last3.map(n => n.key), [10, 9, 8])
})

test('forEachGE', () => {
  const tree = new RBTree()
  for (let i = 1; i <= 10; i++) tree.insert(i * 10, i)
  const result = []
  tree.forEachGE(50, (k) => result.push(k))
  assert.deepStrictEqual(result, [50, 60, 70, 80, 90, 100])
})

test('forEachLE', () => {
  const tree = new RBTree()
  for (let i = 1; i <= 10; i++) tree.insert(i * 10, i)
  const result = []
  tree.forEachLE(50, (k) => result.push(k))
  assert.deepStrictEqual(result, [10, 20, 30, 40, 50])
})

test('stress: 1000 insert + remove', () => {
  const tree = new RBTree()
  const keys = Array.from({ length: 1000 }, (_, i) => i)
  // Shuffle
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]]
  }
  for (const k of keys) tree.insert(k, k)
  assert.strictEqual(tree.size, 1000)
  assert.strictEqual(tree.min().key, 0)
  assert.strictEqual(tree.max().key, 999)

  // Remove half
  for (let i = 0; i < 500; i++) tree.remove(keys[i])
  assert.strictEqual(tree.size, 500)

  // Verify remaining
  for (let i = 500; i < 1000; i++) {
    assert.ok(tree.find(keys[i]) !== null)
  }
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n📋 PriceLevel')
/* ═══════════════════════════════════════════════════════════════════ */

test('append, peek, remove', () => {
  const level = new PriceLevel(1.00, 'buy')
  const o1 = createOrder({ agentId: 'a1', side: 'buy', price: 1.00, size: 10 })
  const o2 = createOrder({ agentId: 'a2', side: 'buy', price: 1.00, size: 20 })
  const o3 = createOrder({ agentId: 'a3', side: 'buy', price: 1.00, size: 30 })

  level.append(o1)
  level.append(o2)
  level.append(o3)

  assert.strictEqual(level.orderCount, 3)
  assert.strictEqual(level.totalVolume, 60)
  assert.strictEqual(level.peek(), o1) // FIFO

  // Remove middle
  level.remove(o2)
  assert.strictEqual(level.orderCount, 2)
  assert.strictEqual(level.totalVolume, 40)
  assert.strictEqual(level.peek(), o1) // o1 still first

  // Remove head
  level.remove(o1)
  assert.strictEqual(level.peek(), o3)
  assert.strictEqual(level.orderCount, 1)

  level.remove(o3)
  assert.ok(level.isEmpty())
})

test('iteration in FIFO order', () => {
  const level = new PriceLevel(1.00, 'sell')
  const orders = [5, 3, 7].map((size, i) =>
    createOrder({ agentId: `a${i}`, side: 'sell', price: 1.00, size }))
  for (const o of orders) level.append(o)

  const sizes = [...level].map(o => o.size)
  assert.deepStrictEqual(sizes, [5, 3, 7])
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n#️⃣  OrderIndex')
/* ═══════════════════════════════════════════════════════════════════ */

test('add, get, remove, getByAgent', () => {
  const idx = new OrderIndex()
  const o1 = createOrder({ agentId: 'agent1', side: 'buy', price: 1.00, size: 10 })
  const o2 = createOrder({ agentId: 'agent1', side: 'sell', price: 1.02, size: 5 })
  const o3 = createOrder({ agentId: 'agent2', side: 'buy', price: 0.99, size: 8 })

  const mockLevel = { price: 1.00 }
  idx.add(o1, mockLevel, 'buy')
  idx.add(o2, { price: 1.02 }, 'sell')
  idx.add(o3, { price: 0.99 }, 'buy')

  assert.strictEqual(idx.totalOrders, 3)
  assert.ok(idx.has(o1.id))
  assert.strictEqual(idx.get(o1.id).order, o1)
  assert.strictEqual(idx.getByAgent('agent1').size, 2)
  assert.strictEqual(idx.getByAgent('agent2').size, 1)

  idx.remove(o1.id)
  assert.strictEqual(idx.totalOrders, 2)
  assert.ok(!idx.has(o1.id))
  assert.strictEqual(idx.getByAgent('agent1').size, 1)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🔄 RingBuffer')
/* ═══════════════════════════════════════════════════════════════════ */

test('push, get, slice', () => {
  const buf = new RingBuffer(5)
  buf.push('a')
  buf.push('b')
  buf.push('c')
  assert.strictEqual(buf.length, 3)
  assert.strictEqual(buf.get(0), 'c') // most recent
  assert.strictEqual(buf.get(1), 'b')
  assert.strictEqual(buf.get(2), 'a') // oldest
  assert.deepStrictEqual(buf.slice(0, 3), ['c', 'b', 'a'])
})

test('overflow wraps around', () => {
  const buf = new RingBuffer(3)
  buf.push(1)
  buf.push(2)
  buf.push(3)
  buf.push(4) // overwrites 1
  buf.push(5) // overwrites 2
  assert.strictEqual(buf.length, 3)
  assert.strictEqual(buf.get(0), 5) // newest
  assert.strictEqual(buf.get(1), 4)
  assert.strictEqual(buf.get(2), 3) // oldest
  assert.ok(buf.isFull())
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🌲 OrderSideTree')
/* ═══════════════════════════════════════════════════════════════════ */

test('buy side: best is highest price', () => {
  const tree = new OrderSideTree('buy')
  const l1 = tree.getOrCreateLevel(1.00)
  const l2 = tree.getOrCreateLevel(1.05)
  const l3 = tree.getOrCreateLevel(0.95)

  l1.append(createOrder({ agentId: 'a', side: 'buy', price: 1.00, size: 10 }))
  l2.append(createOrder({ agentId: 'a', side: 'buy', price: 1.05, size: 10 }))
  l3.append(createOrder({ agentId: 'a', side: 'buy', price: 0.95, size: 10 }))

  assert.strictEqual(tree.best().price, 1.05)
  assert.strictEqual(tree.levelCount, 3)

  const levels = tree.getLevels(2)
  assert.strictEqual(levels[0].price, 1.05)
  assert.strictEqual(levels[1].price, 1.00)
})

test('sell side: best is lowest price', () => {
  const tree = new OrderSideTree('sell')
  tree.getOrCreateLevel(1.00).append(createOrder({ agentId: 'a', side: 'sell', price: 1.00, size: 10 }))
  tree.getOrCreateLevel(1.05).append(createOrder({ agentId: 'a', side: 'sell', price: 1.05, size: 10 }))
  tree.getOrCreateLevel(0.95).append(createOrder({ agentId: 'a', side: 'sell', price: 0.95, size: 10 }))

  assert.strictEqual(tree.best().price, 0.95)

  const levels = tree.getLevels(2)
  assert.strictEqual(levels[0].price, 0.95)
  assert.strictEqual(levels[1].price, 1.00)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n⚡ MatchingEngine — Limit Orders')
/* ═══════════════════════════════════════════════════════════════════ */

test('limit sell rests, limit buy fills at resting price', () => {
  const eng = new MatchingEngine()

  // Place 3 sells
  eng.submitOrder({ agentId: 's1', side: 'sell', price: 1.02, size: 10, type: 'limit' })
  eng.submitOrder({ agentId: 's2', side: 'sell', price: 1.01, size: 5,  type: 'limit' })
  eng.submitOrder({ agentId: 's3', side: 'sell', price: 1.03, size: 15, type: 'limit' })

  // Buy that crosses best ask
  const { order, fills } = eng.submitOrder({ agentId: 'b1', side: 'buy', price: 1.025, size: 12, type: 'limit' })

  // Should fill against s2 (5 @ 1.01) and s1 (7 @ 1.02)
  assert.strictEqual(fills.length, 2)
  assert.strictEqual(fills[0].price, 1.01)
  assert.strictEqual(fills[0].size, 5)
  assert.strictEqual(fills[1].price, 1.02)
  assert.strictEqual(fills[1].size, 7)
  assert.strictEqual(order.filled, 12)
  assert.strictEqual(order.remaining, 0)
  assert.strictEqual(order.status, 'filled')
})

test('partial fill: remainder rests in book', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 5, type: 'limit' })

  const { order, fills } = eng.submitOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 10, type: 'limit' })

  assert.strictEqual(fills.length, 1)
  assert.strictEqual(fills[0].size, 5)
  assert.strictEqual(order.filled, 5)
  assert.strictEqual(order.remaining, 5)
  assert.strictEqual(order.status, 'partial')

  // Remaining 5 should be resting in the book
  const spread = eng.getSpread()
  assert.strictEqual(spread.bestBid, 1.00)
})

test('no cross: order rests in book', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 's1', side: 'sell', price: 1.05, size: 10, type: 'limit' })
  eng.submitOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 10, type: 'limit' })

  const spread = eng.getSpread()
  assert.strictEqual(spread.bestBid, 1.00)
  assert.strictEqual(spread.bestAsk, 1.05)
  assert.ok(Math.abs(spread.spread - 0.05) < 1e-10, `spread ${spread.spread} ≈ 0.05`)
})

test('price-time priority: older order fills first at same price', () => {
  const eng = new MatchingEngine()

  const r1 = eng.submitOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 5, type: 'limit' })
  const r2 = eng.submitOrder({ agentId: 's2', side: 'sell', price: 1.00, size: 5, type: 'limit' })

  const { fills } = eng.submitOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 3, type: 'limit' })

  // s1 should fill first (older timestamp)
  assert.strictEqual(fills.length, 1)
  assert.strictEqual(fills[0].sellAgentId, 's1')
  assert.strictEqual(fills[0].size, 3)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🏪 MatchingEngine — Market Orders')
/* ═══════════════════════════════════════════════════════════════════ */

test('market buy fills all available liquidity', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 's1', side: 'sell', price: 1.01, size: 10, type: 'limit' })
  eng.submitOrder({ agentId: 's2', side: 'sell', price: 1.02, size: 10, type: 'limit' })

  const { order, fills } = eng.submitOrder({ agentId: 'b1', side: 'buy', size: 15, type: 'market' })

  assert.strictEqual(fills.length, 2)
  assert.strictEqual(fills[0].price, 1.01)
  assert.strictEqual(fills[0].size, 10)
  assert.strictEqual(fills[1].price, 1.02)
  assert.strictEqual(fills[1].size, 5)
  assert.strictEqual(order.filled, 15)
})

test('market order on empty book: no fills', () => {
  const eng = new MatchingEngine()
  const { order, fills } = eng.submitOrder({ agentId: 'b1', side: 'buy', size: 10, type: 'market' })
  assert.strictEqual(fills.length, 0)
  assert.strictEqual(order.status, 'cancelled')
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n⏱️  MatchingEngine — IOC / FOK')
/* ═══════════════════════════════════════════════════════════════════ */

test('IOC: partial fill, remainder cancelled', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 5, type: 'limit' })

  const { order, fills } = eng.submitOrder({
    agentId: 'b1', side: 'buy', price: 1.00, size: 10, type: 'limit',
    timeInForce: 'IOC',
  })

  assert.strictEqual(fills.length, 1)
  assert.strictEqual(fills[0].size, 5)
  assert.strictEqual(order.filled, 5)
  assert.strictEqual(order.remaining, 5)
  assert.strictEqual(order.status, 'partial')

  // Nothing should be in the book
  const spread = eng.getSpread()
  assert.strictEqual(spread.bestBid, 0) // no bids
})

test('FOK: full fill succeeds', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 10, type: 'limit' })

  const { order, fills } = eng.submitOrder({
    agentId: 'b1', side: 'buy', price: 1.00, size: 10, type: 'limit',
    timeInForce: 'FOK',
  })

  assert.strictEqual(fills.length, 1)
  assert.strictEqual(order.status, 'filled')
})

test('FOK: insufficient liquidity → rejected', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 5, type: 'limit' })

  const { order, fills } = eng.submitOrder({
    agentId: 'b1', side: 'buy', price: 1.00, size: 10, type: 'limit',
    timeInForce: 'FOK',
  })

  assert.strictEqual(fills.length, 0)
  assert.strictEqual(order.status, 'rejected')

  // Original sell should still be in book (not consumed by dry-run)
  const spread = eng.getSpread()
  assert.strictEqual(spread.bestAsk, 1.00)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🛡️  MatchingEngine — Self-Trade Prevention')
/* ═══════════════════════════════════════════════════════════════════ */

test('STP cancel_newest: incoming cancelled', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 'agent1', side: 'sell', price: 1.00, size: 10, type: 'limit' })

  const { order, fills } = eng.submitOrder({
    agentId: 'agent1', side: 'buy', price: 1.00, size: 10, type: 'limit',
    stpMode: 'cancel_newest',
  })

  assert.strictEqual(fills.length, 0)
  assert.strictEqual(order.status, 'cancelled')
  // Original sell still in book
  assert.strictEqual(eng.getSpread().bestAsk, 1.00)
})

test('STP cancel_oldest: resting cancelled, incoming continues', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 'agent1', side: 'sell', price: 1.00, size: 10, type: 'limit' })
  eng.submitOrder({ agentId: 'agent2', side: 'sell', price: 1.01, size: 10, type: 'limit' })

  const { order, fills } = eng.submitOrder({
    agentId: 'agent1', side: 'buy', price: 1.01, size: 10, type: 'limit',
    stpMode: 'cancel_oldest',
  })

  // Should skip self-trade at 1.00, fill against agent2 at 1.01
  assert.strictEqual(fills.length, 1)
  assert.strictEqual(fills[0].sellAgentId, 'agent2')
  assert.strictEqual(fills[0].price, 1.01)
})

test('STP none: allows self-trade', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 'agent1', side: 'sell', price: 1.00, size: 10, type: 'limit' })

  const { fills } = eng.submitOrder({
    agentId: 'agent1', side: 'buy', price: 1.00, size: 5, type: 'limit',
    stpMode: 'none',
  })

  assert.strictEqual(fills.length, 1)
  assert.strictEqual(fills[0].size, 5)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🔫 MatchingEngine — Cancel')
/* ═══════════════════════════════════════════════════════════════════ */

test('cancel by ID', () => {
  const eng = new MatchingEngine()
  const { order } = eng.submitOrder({ agentId: 'a1', side: 'buy', price: 1.00, size: 10, type: 'limit' })
  assert.strictEqual(eng.getSpread().bestBid, 1.00)

  const ok = eng.cancelOrder(order.id)
  assert.ok(ok)
  assert.strictEqual(eng.getSpread().bestBid, 0)
})

test('cancelAllForAgent', () => {
  const eng = new MatchingEngine()
  eng.submitOrder({ agentId: 'a1', side: 'buy', price: 1.00, size: 10, type: 'limit' })
  eng.submitOrder({ agentId: 'a1', side: 'sell', price: 1.05, size: 10, type: 'limit' })
  eng.submitOrder({ agentId: 'a2', side: 'buy', price: 0.99, size: 10, type: 'limit' })

  const count = eng.cancelAllForAgent('a1')
  assert.strictEqual(count, 2)
  assert.strictEqual(eng.getSpread().bestBid, 0.99) // a2's order remains
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🎯 TriggerBook')
/* ═══════════════════════════════════════════════════════════════════ */

test('sell stop triggers on price drop', () => {
  const tb = new TriggerBook()
  const stopOrder = createOrder({
    agentId: 'a1', side: 'sell', type: 'stop', triggerPrice: 0.95, size: 10, price: 0,
  })
  tb.add(stopOrder)
  assert.strictEqual(tb.size, 1)

  // Price at 1.00 → no trigger
  let triggered = tb.checkTriggers(1.00)
  assert.strictEqual(triggered.length, 0)

  // Price drops to 0.94 → trigger fires
  triggered = tb.checkTriggers(0.94)
  assert.strictEqual(triggered.length, 1)
  assert.strictEqual(triggered[0].order.agentId, 'a1')
  assert.strictEqual(tb.size, 0) // removed from book
})

test('buy stop triggers on price rise', () => {
  const tb = new TriggerBook()
  const stopOrder = createOrder({
    agentId: 'a1', side: 'buy', type: 'stop', triggerPrice: 1.05, size: 10, price: 0,
  })
  tb.add(stopOrder)

  let triggered = tb.checkTriggers(1.03)
  assert.strictEqual(triggered.length, 0)

  triggered = tb.checkTriggers(1.06)
  assert.strictEqual(triggered.length, 1)
  assert.strictEqual(tb.size, 0)
})

test('multiple triggers at different prices', () => {
  const tb = new TriggerBook()
  tb.add(createOrder({ agentId: 'a1', side: 'sell', type: 'stop', triggerPrice: 0.95, size: 10, price: 0 }))
  tb.add(createOrder({ agentId: 'a2', side: 'sell', type: 'stop', triggerPrice: 0.90, size: 10, price: 0 }))
  tb.add(createOrder({ agentId: 'a3', side: 'sell', type: 'stop', triggerPrice: 0.80, size: 10, price: 0 }))

  // Price drops to 0.89 → triggers at 0.95 and 0.90 fire (both >= 0.89)
  const triggered = tb.checkTriggers(0.89)
  assert.strictEqual(triggered.length, 2)
  assert.strictEqual(tb.size, 1) // only 0.80 remains
})

test('removeAllForAgent', () => {
  const tb = new TriggerBook()
  tb.add(createOrder({ agentId: 'a1', side: 'sell', type: 'stop', triggerPrice: 0.95, size: 10, price: 0 }))
  tb.add(createOrder({ agentId: 'a1', side: 'buy', type: 'stop', triggerPrice: 1.05, size: 10, price: 0 }))
  tb.add(createOrder({ agentId: 'a2', side: 'sell', type: 'stop', triggerPrice: 0.90, size: 10, price: 0 }))

  const count = tb.removeAllForAgent('a1')
  assert.strictEqual(count, 2)
  assert.strictEqual(tb.size, 1)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n📊 OrderBookV2 — Backward Compatibility')
/* ═══════════════════════════════════════════════════════════════════ */

test('placeOrder / placeMarketOrder / cancelOrder compat', () => {
  const ob = new OrderBookV2()

  // Place limit orders (v1 API)
  ob.placeOrder({ agentId: 's1', side: 'sell', price: 1.02, size: 10 })
  ob.placeOrder({ agentId: 's2', side: 'sell', price: 1.01, size: 5 })
  ob.placeOrder({ agentId: 'b1', side: 'buy', price: 0.99, size: 10 })

  const snap = ob.getSnapshot(10)
  assert.strictEqual(snap.bids.length, 1)
  assert.strictEqual(snap.asks.length, 2)
  assert.strictEqual(snap.asks[0].price, 1.01) // best ask
  assert.strictEqual(snap.bids[0].price, 0.99)

  // Market buy (v1 API)
  const { fills } = ob.placeMarketOrder({ agentId: 'b2', side: 'buy', size: 7 })
  assert.strictEqual(fills.length, 2)
  assert.strictEqual(fills[0].price, 1.01)
  assert.strictEqual(fills[0].size, 5)
  assert.strictEqual(fills[1].price, 1.02)
  assert.strictEqual(fills[1].size, 2)
})

test('getSnapshot format matches v1', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 's1', side: 'sell', price: 1.05, size: 10 })
  ob.placeOrder({ agentId: 's2', side: 'sell', price: 1.05, size: 5 })
  ob.placeOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 20 })

  const snap = ob.getSnapshot(5)

  // Check structure
  assert.ok(Array.isArray(snap.bids))
  assert.ok(Array.isArray(snap.asks))
  assert.ok(typeof snap.spread === 'number')
  assert.ok(typeof snap.spreadPercent === 'number')
  assert.ok(typeof snap.mid === 'number')

  // Aggregation: two sells at same price → one level
  assert.strictEqual(snap.asks.length, 1)
  assert.strictEqual(snap.asks[0].volume, 15) // 10 + 5
  assert.strictEqual(snap.asks[0].count, 2)

  // Cumulative volume
  assert.strictEqual(snap.bids[0].cumVolume, 20)
})

test('getSpread matches v1 format', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 's1', side: 'sell', price: 1.02, size: 10 })
  ob.placeOrder({ agentId: 'b1', side: 'buy', price: 0.98, size: 10 })

  const s = ob.getSpread()
  assert.strictEqual(s.bestBid, 0.98)
  assert.strictEqual(s.bestAsk, 1.02)
  assert.ok(Math.abs(s.spread - 0.04) < 1e-10, `spread ${s.spread} ≈ 0.04`)
  assert.strictEqual(s.mid, 1.00)
})

test('getOrdersForAgent', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 'a1', side: 'buy', price: 1.00, size: 10 })
  ob.placeOrder({ agentId: 'a1', side: 'sell', price: 1.05, size: 5 })
  ob.placeOrder({ agentId: 'a2', side: 'buy', price: 0.99, size: 8 })

  const orders = ob.getOrdersForAgent('a1')
  assert.strictEqual(orders.length, 2)
})

test('getRecentTrades', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 10 })
  ob.placeOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 3 })

  const trades = ob.getRecentTrades(10)
  assert.strictEqual(trades.length, 1)
  assert.strictEqual(trades[0].price, 1.00)
  assert.strictEqual(trades[0].size, 3)
})

test('cancelAllForAgent clears book + triggers', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 'a1', side: 'buy', price: 1.00, size: 10 })
  ob.placeStopOrder({ agentId: 'a1', side: 'sell', triggerPrice: 0.95, size: 5 })

  const count = ob.cancelAllForAgent('a1')
  assert.strictEqual(count, 2)
})

test('stats and lastPrice', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 10 })
  ob.placeOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 5 })

  assert.strictEqual(ob.lastPrice, 1.00)
  assert.strictEqual(ob.stats.totalTrades, 1)
  assert.ok(ob.stats.totalVolume > 0)
})

test('bids/asks getters return arrays for compat', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 'a1', side: 'buy', price: 1.00, size: 10 })
  ob.placeOrder({ agentId: 'a2', side: 'sell', price: 1.05, size: 5 })

  assert.ok(Array.isArray(ob.bids))
  assert.ok(Array.isArray(ob.asks))
  assert.strictEqual(ob.bids.length, 1)
  assert.strictEqual(ob.asks.length, 1)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🎯 OrderBookV2 — New Features')
/* ═══════════════════════════════════════════════════════════════════ */

test('IOC order via v2 API', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 5 })

  const { order, fills } = ob.placeIOCOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 10 })
  assert.strictEqual(fills.length, 1)
  assert.strictEqual(order.filled, 5)
  // Remainder should NOT be in book
  assert.strictEqual(ob.getSnapshot().bids.length, 0)
})

test('FOK order via v2 API', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 10 })

  // Insufficient: rejected
  const r1 = ob.placeFOKOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 15 })
  assert.strictEqual(r1.order.status, 'rejected')
  // Book unchanged
  assert.strictEqual(ob.getSnapshot().asks[0].volume, 10)

  // Sufficient: filled
  const r2 = ob.placeFOKOrder({ agentId: 'b2', side: 'buy', price: 1.00, size: 10 })
  assert.strictEqual(r2.fills.length, 1)
  assert.strictEqual(r2.order.status, 'filled')
})

test('stop order + checkTriggers', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 'lp', side: 'buy', price: 0.80, size: 100 }) // liquidity

  // Place sell stop
  ob.placeStopOrder({ agentId: 'a1', side: 'sell', triggerPrice: 0.90, size: 10 })
  assert.strictEqual(ob.getTriggerOrders().length, 1)

  // Trigger at price 0.89
  const result = ob.checkTriggers(0.89)
  assert.strictEqual(result.triggered, 1)
  assert.ok(result.fills.length > 0) // should have matched against the buy at 0.80
  assert.strictEqual(ob.getTriggerOrders().length, 0)
})

test('getMetrics returns performance data', () => {
  const ob = new OrderBookV2()
  ob.placeOrder({ agentId: 's1', side: 'sell', price: 1.00, size: 10 })
  ob.placeOrder({ agentId: 'b1', side: 'buy', price: 1.00, size: 5 })
  ob.getSnapshot()

  const metrics = ob.getMetrics()
  assert.ok(metrics.insert.count > 0)
  assert.ok(metrics.match.count > 0)
  assert.ok(metrics.snapshot.count > 0)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n🏎️  Benchmark: v2 Performance')
/* ═══════════════════════════════════════════════════════════════════ */

test('benchmark: 1000 limit orders + matching', () => {
  const ob = new OrderBookV2()
  const N = 1000

  // Place N sell orders at various prices
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    ob.placeOrder({
      agentId: `s${i % 50}`,
      side: 'sell',
      price: 1.00 + (i % 100) * 0.001,
      size: Math.random() * 10 + 1,
    })
  }
  const insertTime = performance.now() - t0

  // Place N/2 buy orders that cross
  const t1 = performance.now()
  for (let i = 0; i < N / 2; i++) {
    ob.placeOrder({
      agentId: `b${i % 50}`,
      side: 'buy',
      price: 1.00 + (i % 50) * 0.001,
      size: Math.random() * 5 + 1,
    })
  }
  const matchTime = performance.now() - t1

  // Snapshot
  const t2 = performance.now()
  for (let i = 0; i < 100; i++) ob.getSnapshot(20)
  const snapTime = (performance.now() - t2) / 100

  // Cancel
  const t3 = performance.now()
  for (let i = 0; i < 50; i++) ob.cancelAllForAgent(`s${i}`)
  const cancelTime = performance.now() - t3

  console.log(`     📈 ${N} inserts: ${insertTime.toFixed(1)}ms (${(insertTime / N * 1000).toFixed(1)}μs/op)`)
  console.log(`     📈 ${N / 2} matching buys: ${matchTime.toFixed(1)}ms (${(matchTime / (N / 2) * 1000).toFixed(1)}μs/op)`)
  console.log(`     📈 snapshot(20): ${snapTime.toFixed(2)}ms`)
  console.log(`     📈 cancelAll(50 agents): ${cancelTime.toFixed(1)}ms`)
  console.log(`     📈 Stats: ${ob.stats.totalTrades} trades, vol=$${ob.stats.totalVolume.toFixed(0)}`)
})

/* ═══════════════════════════════════════════════════════════════════ */
console.log('\n────────────────────────────────────────')
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('❌ SOME TESTS FAILED\n')
  process.exit(1)
} else {
  console.log('✅ ALL TESTS PASSED\n')
  process.exit(0)
}
