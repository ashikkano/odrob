// ═══════════════════════════════════════════════════════════════════════
// MatchingEngine — Core order matching with price-time priority
//
// Features:
//   • Price-time priority matching at resting order's price
//   • TimeInForce: GTC, IOC, FOK, GTD
//   • Self-Trade Prevention: cancel_newest, cancel_oldest, cancel_both
//   • Market orders with slippage protection
//   • Event emission: trade, order:placed, order:filled, order:cancelled
// ═══════════════════════════════════════════════════════════════════════

import { randomUUID }    from 'crypto'
import { EventEmitter }  from 'events'
import { createOrder, OrderType, TimeInForce, STPMode, OrderStatus } from './order.js'
import { OrderSideTree } from './orderSideTree.js'
import { OrderIndex }    from './orderIndex.js'
import { RingBuffer }    from './ringBuffer.js'
import { Metrics }       from './metrics.js'

export class MatchingEngine extends EventEmitter {
  constructor(options = {}) {
    super()
    this.bidTree    = new OrderSideTree('buy')
    this.askTree    = new OrderSideTree('sell')
    this.orderIndex = new OrderIndex()
    this.trades     = new RingBuffer(options.recentTradesSize || 500)
    this.allTrades  = new RingBuffer(options.allTradesSize || 10_000)
    this.metrics    = new Metrics()
    this.lastPrice  = null
    this.stats      = {
      totalVolume: 0,
      totalTrades: 0,
      high24h:     0,
      low24h:      Infinity,
    }
  }

  /* ═══════ PUBLIC API ═════════════════════════════════════════════ */

  /**
   * Submit a new order to the matching engine.
   * Routes by type and TimeInForce, matches, and adds remainder to book.
   * @returns {{ order, fills: Trade[] }}
   */
  submitOrder(params) {
    const start = process.hrtime.bigint()
    const order = (params.id && params.remaining !== undefined) ? params : createOrder(params)

    // ── Market orders ──
    if (order.type === OrderType.MARKET) {
      return this._handleMarket(order, start)
    }

    // ── FOK: dry-run first ──
    if (order.timeInForce === TimeInForce.FOK) {
      return this._handleFOK(order, start)
    }

    // ── GTD: check expiry ──
    if (order.timeInForce === TimeInForce.GTD && order.expireAt && Date.now() > order.expireAt) {
      order.status = OrderStatus.REJECTED
      return { order, fills: [] }
    }

    // ── Standard matching (GTC / IOC / GTD) ──
    const fills = this._match(order)

    // IOC: cancel any remainder
    if (order.timeInForce === TimeInForce.IOC && order.remaining > 0) {
      order.status = order.filled > 0 ? OrderStatus.PARTIAL : OrderStatus.CANCELLED
      this.metrics.recordInsert(process.hrtime.bigint() - start)
      return { order, fills }
    }

    // GTC / GTD: add unfilled remainder to book
    if (order.remaining > 0) {
      this._addToBook(order)
    }

    this.metrics.recordInsert(process.hrtime.bigint() - start)
    return { order, fills }
  }

  /**
   * Cancel an order by ID. O(1) lookup + O(log n) tree removal.
   * @returns {boolean}
   */
  cancelOrder(orderId) {
    const start = process.hrtime.bigint()
    const entry = this.orderIndex.get(orderId)
    if (!entry) return false

    const { order, priceLevel, side } = entry
    priceLevel.remove(order)
    this.orderIndex.remove(orderId)

    const tree = side === 'buy' ? this.bidTree : this.askTree
    tree.removeLevelIfEmpty(priceLevel.price)

    order.status = OrderStatus.CANCELLED
    this.emit('order:cancelled', order)
    this.metrics.recordCancel(process.hrtime.bigint() - start)
    return true
  }

  /**
   * Cancel all orders for an agent.
   * @returns {number} count of cancelled orders
   */
  cancelAllForAgent(agentId) {
    const orderIds = [...this.orderIndex.getByAgent(agentId)]
    let count = 0
    for (const oid of orderIds) {
      if (this.cancelOrder(oid)) count++
    }
    return count
  }

  /* ═══════ MARKET ORDERS ═════════════════════════════════════════ */

  _handleMarket(order, start) {
    // Market orders: use extreme price to guarantee crossing
    order.price = order.side === 'buy' ? Number.MAX_SAFE_INTEGER : 0
    const fills = this._match(order)

    // Market orders never rest in book — unfilled portion is cancelled
    if (order.remaining > 0) {
      order.status = order.filled > 0 ? OrderStatus.PARTIAL : OrderStatus.CANCELLED
    }

    this.metrics.recordMatch(process.hrtime.bigint() - start)
    return { order, fills }
  }

  /* ═══════ FOK (Fill Or Kill) ════════════════════════════════════ */

  _handleFOK(order, start) {
    // Dry-run: check if we CAN fill the entire order
    const opposing = order.side === 'buy' ? this.askTree : this.bidTree
    let available = 0
    let blocked = false  // true if STP would kill the incoming order

    for (const level of opposing) {
      // Price cross check
      if (order.side === 'buy'  && order.price < level.price) break
      if (order.side === 'sell' && order.price > level.price) break

      for (const resting of level) {
        // Self-trade prevention simulation
        if (order.agentId === resting.agentId && order.stpMode !== STPMode.NONE) {
          if (order.stpMode === STPMode.CANCEL_NEWEST || order.stpMode === STPMode.CANCEL_BOTH) {
            // Incoming order would be cancelled → cannot fill at all
            blocked = true
            break
          }
          // CANCEL_OLDEST: resting removed, skip and continue
          continue
        }
        available += resting.remaining
        if (available >= order.size - 1e-10) break
      }
      if (blocked || available >= order.size - 1e-10) break
    }

    if (blocked || available < order.size - 1e-10) {
      // Cannot fill entirely → reject
      order.status = OrderStatus.REJECTED
      this.metrics.recordInsert(process.hrtime.bigint() - start)
      return { order, fills: [] }
    }

    // Full fill possible → execute for real
    const fills = this._match(order)
    this.metrics.recordInsert(process.hrtime.bigint() - start)
    return { order, fills }
  }

  /* ═══════ CORE MATCHING ═════════════════════════════════════════ */

  /**
   * Match incoming order against opposing side.
   * Price-time priority: fills at RESTING order's price.
   * @returns {Trade[]}
   */
  _match(order) {
    const startNs = process.hrtime.bigint()
    const fills = []
    const opposing = order.side === 'buy' ? this.askTree : this.bidTree

    while (order.remaining > 1e-10) {
      const bestLevel = opposing.best()
      if (!bestLevel) break

      // Price cross check
      if (order.side === 'buy'  && order.price < bestLevel.price) break
      if (order.side === 'sell' && order.price > bestLevel.price) break

      const resting = bestLevel.peek()
      if (!resting) {
        // Empty level, clean up
        opposing.removeLevelIfEmpty(bestLevel.price)
        continue
      }

      // ── Self-Trade Prevention ──
      if (order.agentId === resting.agentId && order.stpMode !== STPMode.NONE) {
        const stpResult = this._handleSTP(order, resting, bestLevel, opposing)
        if (stpResult === 'stop') break
        continue  // resting was removed, try next
      }

      // ── Execute fill ──
      const fillSize  = Math.min(order.remaining, resting.remaining)
      const fillPrice = resting.price  // price-time priority

      const trade = {
        id:             randomUUID(),
        price:          fillPrice,
        size:           fillSize,
        buyAgentId:     order.side === 'buy' ? order.agentId : resting.agentId,
        sellAgentId:    order.side === 'sell' ? order.agentId : resting.agentId,
        aggressorSide:  order.side,
        timestamp:      Date.now(),
      }

      fills.push(trade)
      this.trades.push(trade)
      this.allTrades.push(trade)

      // Update book stats
      this.lastPrice = fillPrice
      this.stats.totalVolume += fillSize * fillPrice
      this.stats.totalTrades++
      if (fillPrice > this.stats.high24h) this.stats.high24h = fillPrice
      if (fillPrice < this.stats.low24h)  this.stats.low24h  = fillPrice

      // Update order quantities
      const fillDelta = -fillSize
      order.remaining   -= fillSize
      order.filled      += fillSize
      resting.remaining -= fillSize
      resting.filled    += fillSize
      bestLevel.updateVolume(fillDelta)

      // Remove fully-filled resting order
      if (resting.remaining <= 1e-10) {
        resting.remaining = 0
        resting.status = OrderStatus.FILLED
        bestLevel.remove(resting)
        this.orderIndex.remove(resting.id)
        if (bestLevel.isEmpty()) {
          opposing.removeLevelIfEmpty(bestLevel.price)
        }
        this.emit('order:filled', resting)
      }

      this.emit('trade', trade)
    }

    // Update incoming order status
    if (order.filled > 0) {
      order.status = order.remaining <= 1e-10
        ? OrderStatus.FILLED
        : OrderStatus.PARTIAL
      if (order.remaining <= 1e-10) order.remaining = 0
    }

    this.metrics.recordMatch(process.hrtime.bigint() - startNs)
    return fills
  }

  /* ═══════ SELF-TRADE PREVENTION ═════════════════════════════════ */

  _handleSTP(incoming, resting, restingLevel, opposingTree) {
    switch (incoming.stpMode) {
      case STPMode.CANCEL_NEWEST:
        // Cancel the incoming (aggressive) order
        incoming.remaining = 0
        incoming.status = OrderStatus.CANCELLED
        this.emit('order:stp_cancelled', { cancelled: incoming, surviving: resting, mode: 'cancel_newest' })
        return 'stop'

      case STPMode.CANCEL_OLDEST:
        // Cancel the resting order, continue matching
        restingLevel.remove(resting)
        this.orderIndex.remove(resting.id)
        resting.status = OrderStatus.CANCELLED
        if (restingLevel.isEmpty()) opposingTree.removeLevelIfEmpty(restingLevel.price)
        this.emit('order:stp_cancelled', { cancelled: resting, surviving: incoming, mode: 'cancel_oldest' })
        return 'continue'

      case STPMode.CANCEL_BOTH:
        restingLevel.remove(resting)
        this.orderIndex.remove(resting.id)
        resting.status = OrderStatus.CANCELLED
        if (restingLevel.isEmpty()) opposingTree.removeLevelIfEmpty(restingLevel.price)
        incoming.remaining = 0
        incoming.status = OrderStatus.CANCELLED
        this.emit('order:stp_cancelled', { cancelled: [incoming, resting], mode: 'cancel_both' })
        return 'stop'

      default:
        return 'continue'
    }
  }

  /* ═══════ ADD TO BOOK ═══════════════════════════════════════════ */

  _addToBook(order) {
    const tree  = order.side === 'buy' ? this.bidTree : this.askTree
    const level = tree.getOrCreateLevel(order.price)
    level.append(order)
    this.orderIndex.add(order, level, order.side)
    order.status = order.filled > 0 ? OrderStatus.PARTIAL : OrderStatus.OPEN
    this.emit('order:placed', order)
  }

  /* ═══════ GETTERS ═══════════════════════════════════════════════ */

  getSpread() {
    const bestBidLevel = this.bidTree.best()
    const bestAskLevel = this.askTree.best()
    const bestBid = bestBidLevel?.price || 0
    const bestAsk = bestAskLevel?.price || Infinity
    const spread = bestAsk - bestBid
    // Fallback to lastPrice when one side is empty (avoids Infinity mid)
    const mid = (bestAsk === Infinity || bestBid === 0)
      ? (this.lastPrice || 0)
      : (bestBid + bestAsk) / 2
    return { bestBid, bestAsk, spread, mid }
  }

  getOrdersForAgent(agentId) {
    const orderIds = this.orderIndex.getByAgent(agentId)
    const result = []
    for (const oid of orderIds) {
      const entry = this.orderIndex.get(oid)
      if (!entry) continue
      const o = entry.order
      result.push({
        id: o.id,
        side: o.side,
        price: o.price,
        remaining: o.remaining,
        timestamp: o.timestamp,
        type: o.type,
        timeInForce: o.timeInForce,
      })
    }
    return result
  }

  getRecentTrades(limit = 50) {
    return this.trades.slice(0, limit)
  }

  /** Check and remove expired GTD orders. */
  expireGTD(now = Date.now()) {
    const expired = []
    // Scan all orders in the index
    for (const [orderId, entry] of this.orderIndex.byId) {
      if (entry.order.timeInForce === TimeInForce.GTD &&
          entry.order.expireAt && now > entry.order.expireAt) {
        expired.push(orderId)
      }
    }
    for (const oid of expired) {
      this.cancelOrder(oid)
    }
    return expired.length
  }

  /** Reset 24h stats. */
  reset24hStats() {
    this.stats.high24h = this.lastPrice || 0
    this.stats.low24h  = this.lastPrice || Infinity
  }
}
