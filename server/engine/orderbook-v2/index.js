// ═══════════════════════════════════════════════════════════════════════
// OrderBookV2 — Drop-in replacement for OrderBook v1
//
// Backward-compatible public API:
//   placeOrder(order)         → { order, fills }
//   placeMarketOrder(order)   → { order, fills }
//   cancelOrder(orderId)      → boolean
//   cancelAllForAgent(agentId)→ number
//   getSpread()               → { bestBid, bestAsk, spread, mid }
//   getSnapshot(depth)        → { bids, asks, spread, spreadPercent, mid, lastPrice }
//   getRecentTrades(limit)    → Trade[]
//   getOrdersForAgent(agentId)→ Order[]
//   reset24hStats()           → void
//
// New capabilities:
//   placeStopOrder(order)     → void (stop, stop-limit, trailing)
//   placeIOCOrder(order)      → { order, fills }
//   placeFOKOrder(order)      → { order, fills }
//   checkTriggers(price)      → { triggered, fills }
//   getMetrics()              → performance metrics
//   getTriggerOrders()        → all pending triggers
// ═══════════════════════════════════════════════════════════════════════

import { EventEmitter }    from 'events'
import { MatchingEngine }  from './matchingEngine.js'
import { TriggerBook }     from './triggerBook.js'
import { TriggerMonitor }  from './triggerMonitor.js'
import { createOrder, OrderType, TimeInForce, STPMode } from './order.js'

export class OrderBookV2 extends EventEmitter {
  constructor(options = {}) {
    super()
    this.engine         = new MatchingEngine(options)
    this.triggerBook    = new TriggerBook()
    this.triggerMonitor = new TriggerMonitor(this.triggerBook, this.engine)

    // Proxy events from engine to this
    this.engine.on('trade', (trade) => this.emit('trade', trade))
    this.engine.on('order:placed', (o) => this.emit('order:placed', o))
    this.engine.on('order:filled', (o) => this.emit('order:filled', o))
    this.engine.on('order:cancelled', (o) => this.emit('order:cancelled', o))
    this.triggerMonitor.on('trigger:fired', (e) => this.emit('trigger:fired', e))
  }

  /* ═══════ BACKWARD-COMPATIBLE API (drop-in for v1) ═════════════ */

  /**
   * Place a limit order (GTC). Identical signature to v1.
   * @param {{ agentId, side, price, size, reasoning? }} order
   * @returns {{ order, fills }}
   */
  placeOrder(order) {
    const result = this.engine.submitOrder({
      agentId:     order.agentId,
      side:        order.side,
      type:        OrderType.LIMIT,
      price:       order.price,
      size:        order.size,
      reasoning:   order.reasoning || '',
      timeInForce: TimeInForce.GTC,
      stpMode:     order.stpMode || STPMode.NONE,  // v1 compat: no STP by default
    })

    // After a trade, check if any triggers fire
    if (result.fills.length > 0) {
      const lastFillPrice = result.fills[result.fills.length - 1].price
      this.triggerMonitor.onPriceUpdate(lastFillPrice)
    }

    return result
  }

  /**
   * Place a market order. Identical signature to v1.
   * @param {{ agentId, side, size, reasoning? }} order
   * @returns {{ order, fills }}
   */
  placeMarketOrder(order) {
    const result = this.engine.submitOrder({
      agentId:   order.agentId,
      side:      order.side,
      type:      OrderType.MARKET,
      price:     order.side === 'buy' ? Number.MAX_SAFE_INTEGER : 0,
      size:      order.size,
      reasoning: order.reasoning || '',
    })

    if (result.fills.length > 0) {
      const lastFillPrice = result.fills[result.fills.length - 1].price
      this.triggerMonitor.onPriceUpdate(lastFillPrice)
    }

    return result
  }

  /**
   * Cancel an order by ID. Checks both book and triggers.
   * @param {string} orderId
   * @returns {boolean}
   */
  cancelOrder(orderId) {
    // Try main book first, then trigger book
    if (this.engine.cancelOrder(orderId)) return true
    if (this.triggerBook.remove(orderId)) return true
    return false
  }

  /**
   * Cancel all orders for an agent (book + triggers).
   * @returns {number}
   */
  cancelAllForAgent(agentId) {
    const bookCount    = this.engine.cancelAllForAgent(agentId)
    const triggerCount = this.triggerBook.removeAllForAgent(agentId)
    return bookCount + triggerCount
  }

  /**
   * Get spread info. Identical to v1.
   */
  getSpread() {
    return this.engine.getSpread()
  }

  /**
   * Get order book snapshot. Backward-compatible with v1 format.
   * @param {number} [depth=15]
   */
  getSnapshot(depth = 15) {
    const start = process.hrtime.bigint()

    const bidLevels = this.engine.bidTree.getLevels(depth)
    const askLevels = this.engine.askTree.getLevels(depth)

    // Aggregate: each PriceLevel already has totalVolume and orderCount
    const bids = bidLevels.map(level => ({
      price:     level.price,
      volume:    level.totalVolume,
      count:     level.orderCount,
      cumVolume: 0,  // filled below
    }))

    const asks = askLevels.map(level => ({
      price:     level.price,
      volume:    level.totalVolume,
      count:     level.orderCount,
      cumVolume: 0,
    }))

    // Cumulative volumes
    let cum = 0
    bids.forEach(b => { cum += b.volume; b.cumVolume = cum })
    cum = 0
    asks.forEach(a => { cum += a.volume; a.cumVolume = cum })

    // Spread
    const spread = asks.length && bids.length
      ? asks[0].price - bids[0].price : 0
    const mid = asks.length && bids.length
      ? (asks[0].price + bids[0].price) / 2 : this.engine.lastPrice || 0
    const spreadPercent = mid > 0 ? (spread / mid) * 100 : 0

    this.engine.metrics.recordSnapshot(process.hrtime.bigint() - start)

    return { bids, asks, spread, spreadPercent, mid, lastPrice: this.engine.lastPrice }
  }

  /**
   * Get recent trades. Identical to v1.
   * @param {number} [limit=50]
   */
  getRecentTrades(limit = 50) {
    return this.engine.getRecentTrades(limit)
  }

  /**
   * Get all pending orders for an agent.
   */
  getOrdersForAgent(agentId) {
    return this.engine.getOrdersForAgent(agentId)
  }

  /**
   * Reset 24h stats.
   */
  reset24hStats() {
    this.engine.reset24hStats()
  }

  /* ═══════ NEW API (v2 only) ═════════════════════════════════════ */

  /**
   * Place an IOC order (Immediate Or Cancel).
   */
  placeIOCOrder(order) {
    return this.engine.submitOrder({
      agentId:     order.agentId,
      side:        order.side,
      type:        OrderType.LIMIT,
      price:       order.price,
      size:        order.size,
      reasoning:   order.reasoning || '',
      timeInForce: TimeInForce.IOC,
    })
  }

  /**
   * Place a FOK order (Fill Or Kill).
   */
  placeFOKOrder(order) {
    return this.engine.submitOrder({
      agentId:     order.agentId,
      side:        order.side,
      type:        OrderType.LIMIT,
      price:       order.price,
      size:        order.size,
      reasoning:   order.reasoning || '',
      timeInForce: TimeInForce.FOK,
    })
  }

  /**
   * Place a stop/stop-limit/trailing-stop order.
   */
  placeStopOrder(order) {
    const o = createOrder({
      agentId:      order.agentId,
      side:         order.side,
      type:         order.type || OrderType.STOP,
      price:        order.price || 0,        // For stop-limit: the limit price
      size:         order.size,
      triggerPrice: order.triggerPrice,
      trailAmount:  order.trailAmount,
      trailPercent: order.trailPercent,
      reasoning:    order.reasoning || '',
      timeInForce:  order.timeInForce || TimeInForce.GTC,
      stpMode:      order.stpMode,
    })
    this.triggerBook.add(o)
    return { order: o }
  }

  /**
   * Manually check triggers at a given price (e.g., on oracle update).
   * @param {number} currentPrice
   */
  checkTriggers(currentPrice) {
    return this.triggerMonitor.onPriceUpdate(currentPrice)
  }

  /** Get all pending trigger orders. */
  getTriggerOrders() {
    return this.triggerBook.getAll()
  }

  /** Get trigger orders for an agent. */
  getTriggerOrdersForAgent(agentId) {
    return this.triggerBook.getByAgent(agentId)
  }

  /** Get performance metrics. */
  getMetrics() {
    return this.engine.metrics.getSummary()
  }

  /** Check and remove expired GTD orders. */
  expireGTD() {
    return this.engine.expireGTD()
  }

  /* ═══════ STATS (v1-compatible properties) ═════════════════════ */

  get lastPrice() { return this.engine.lastPrice }
  get stats()     { return this.engine.stats }
  get trades()    { return this.engine.trades.toArray() }
  get allTrades() { return this.engine.allTrades.toArray() }

  // Expose bids/asks arrays for code that accesses .bids / .asks directly
  get bids() {
    const result = []
    for (const level of this.engine.bidTree) {
      for (const order of level) {
        result.push(order)
      }
    }
    return result
  }

  get asks() {
    const result = []
    for (const level of this.engine.askTree) {
      for (const order of level) {
        result.push(order)
      }
    }
    return result
  }
}

// Named export for convenience
export { OrderBookV2 as OrderBook }
