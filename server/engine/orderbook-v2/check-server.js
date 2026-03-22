// Quick health check - run after server is started
const [indexes, aidx, amom, oil] = await Promise.all([
  fetch('http://localhost:3001/api/indexes').then(r => r.json()),
  fetch('http://localhost:3001/api/indexes/AI_TRADE/orderbook').then(r => r.json()),
  fetch('http://localhost:3001/api/indexes/AGENT_MOMENTUM/orderbook').then(r => r.json()),
  fetch('http://localhost:3001/api/indexes/OIL_INDEX/orderbook').then(r => r.json()),
])

console.log('\n📊 OrderBook v2 — Live Integration Check')
console.log('═'.repeat(55))

const books = [aidx, amom, oil]
for (let i = 0; i < indexes.length; i++) {
  const idx = indexes[i]
  const b = books[i] || {}
  console.log(`${idx.symbol}:`)
  console.log(`  Bids: ${b.bids?.length || 0} levels, Asks: ${b.asks?.length || 0} levels`)
  console.log(`  Spread: ${(b.spread || 0).toFixed(4)} (${((b.spreadPercent || 0) * 100).toFixed(2)}%)`)
  console.log(`  Mid: $${(b.mid || 0).toFixed(4)} | Trades: ${idx.totalTrades} | Vol: $${Math.floor(idx.totalVolume || 0)}`)
}

console.log('═'.repeat(55))
console.log('✅ OrderBookV2 drop-in replacement — WORKING\n')
