// ═══════════════════════════════════════════════════════════════════════
// TriggerBook — Storage for stop / stop-limit / trailing-stop orders
// Separate from the main order book (not visible in depth chart)
// Uses RBTree for efficient range-scan trigger checking
// ═══════════════════════════════════════════════════════════════════════

import { RBTree }   from './rbtree.js'
import { OrderType } from './order.js'

export class TriggerBook {
  constructor() {
    // Sell-stops: trigger when price falls TO or BELOW triggerPrice
    //   → stored in tree keyed by triggerPrice
    //   → fire all where triggerPrice >= currentPrice
    this.sellStopTree = new RBTree((a, b) => a - b)

    // Buy-stops: trigger when price rises TO or ABOVE triggerPrice
    //   → fire all where triggerPrice <= currentPrice
    this.buyStopTree = new RBTree((a, b) => a - b)

    // O(1) lookup by orderId
    /** @type {Map<string, {order, triggerPrice, side}>} */
    this.indexById = new Map()

    // Agent index: agentId → Set<orderId>
    /** @type {Map<string, Set<string>>} */
    this.indexByAgent = new Map()

    // Trailing stop state: orderId → { order, highWaterMark, lowWaterMark }
    /** @type {Map<string, object>} */
    this.trailingStops = new Map()
  }

  get size() { return this.indexById.size }

  /* ═══════ ADD ═══════════════════════════════════════════════════ */

  /**
   * Add a trigger order (stop, stop_limit, trailing_stop).
   */
  add(order) {
    const tree = order.side === 'sell' ? this.sellStopTree : this.buyStopTree
    const tp   = order.triggerPrice

    // Tree may have multiple orders at same trigger price → store as array
    let bucket = tree.find(tp)
    if (!bucket) {
      bucket = []
      tree.insert(tp, bucket)
    }
    bucket.push(order)

    // Index
    this.indexById.set(order.id, { order, triggerPrice: tp, side: order.side })
    let agentSet = this.indexByAgent.get(order.agentId)
    if (!agentSet) {
      agentSet = new Set()
      this.indexByAgent.set(order.agentId, agentSet)
    }
    agentSet.add(order.id)

    // Trailing stop: initialize watermark
    if (order.type === OrderType.TRAILING_STOP) {
      this.trailingStops.set(order.id, {
        order,
        highWaterMark: order.triggerPrice + (order.trailAmount || 0),
        lowWaterMark:  order.triggerPrice - (order.trailAmount || 0),
      })
    }
  }

  /* ═══════ REMOVE ═══════════════════════════════════════════════ */

  /**
   * Remove a trigger order by ID. O(1) lookup + O(k) bucket scan.
   */
  remove(orderId) {
    const entry = this.indexById.get(orderId)
    if (!entry) return false

    const { order, triggerPrice, side } = entry
    const tree = side === 'sell' ? this.sellStopTree : this.buyStopTree

    const bucket = tree.find(triggerPrice)
    if (bucket) {
      const idx = bucket.indexOf(order)
      if (idx !== -1) bucket.splice(idx, 1)
      if (bucket.length === 0) tree.remove(triggerPrice)
    }

    this.indexById.delete(orderId)
    const agentSet = this.indexByAgent.get(order.agentId)
    if (agentSet) {
      agentSet.delete(orderId)
      if (agentSet.size === 0) this.indexByAgent.delete(order.agentId)
    }
    this.trailingStops.delete(orderId)
    return true
  }

  /**
   * Remove all triggers for an agent.
   */
  removeAllForAgent(agentId) {
    const ids = [...(this.indexByAgent.get(agentId) || [])]
    let count = 0
    for (const id of ids) {
      if (this.remove(id)) count++
    }
    return count
  }

  /* ═══════ CHECK TRIGGERS ═══════════════════════════════════════ */

  /**
   * Check which stop orders are triggered at the given price.
   * Returns triggered orders (removed from the book).
   * @param {number} currentPrice
   * @returns {object[]} Array of triggered orders
   */
  checkTriggers(currentPrice) {
    const triggered = []

    // Sell stops: fire when price <= triggerPrice
    // All sell-stop entries with triggerPrice >= currentPrice should fire
    this.sellStopTree.forEachGE(currentPrice, (_tp, bucket) => {
      for (const order of bucket) {
        triggered.push({ ...this._toOutput(order), triggerSide: 'sell' })
      }
    })

    // Buy stops: fire when price >= triggerPrice
    // All buy-stop entries with triggerPrice <= currentPrice should fire
    this.buyStopTree.forEachLE(currentPrice, (_tp, bucket) => {
      for (const order of bucket) {
        triggered.push({ ...this._toOutput(order), triggerSide: 'buy' })
      }
    })

    // Remove all triggered orders from the book
    for (const t of triggered) {
      this.remove(t.order.id)
    }

    return triggered
  }

  /* ═══════ TRAILING STOPS ═══════════════════════════════════════ */

  /**
   * Update all trailing stops based on new price.
   * Moves trigger price closer but NEVER further away.
   * @param {number} currentPrice
   */
  updateTrailingStops(currentPrice) {
    for (const [orderId, state] of this.trailingStops) {
      const { order } = state

      if (order.side === 'sell') {
        // Sell trailing: HWM tracks highest price, trigger = HWM - trail
        if (currentPrice > state.highWaterMark) {
          state.highWaterMark = currentPrice

          const newTrigger = order.trailPercent
            ? currentPrice * (1 - order.trailPercent / 100)
            : currentPrice - (order.trailAmount || 0)

          // Move trigger UP (never down)
          if (newTrigger > order.triggerPrice) {
            this._moveTrigger(order, newTrigger, 'sell')
          }
        }
      } else {
        // Buy trailing: LWM tracks lowest price, trigger = LWM + trail
        if (currentPrice < state.lowWaterMark) {
          state.lowWaterMark = currentPrice

          const newTrigger = order.trailPercent
            ? currentPrice * (1 + order.trailPercent / 100)
            : currentPrice + (order.trailAmount || 0)

          // Move trigger DOWN (never up)
          if (newTrigger < order.triggerPrice) {
            this._moveTrigger(order, newTrigger, 'buy')
          }
        }
      }
    }
  }

  /**
   * Move an order's trigger price in the tree.
   */
  _moveTrigger(order, newTriggerPrice, side) {
    const tree = side === 'sell' ? this.sellStopTree : this.buyStopTree
    const oldTp = order.triggerPrice

    // Remove from old bucket
    const oldBucket = tree.find(oldTp)
    if (oldBucket) {
      const idx = oldBucket.indexOf(order)
      if (idx !== -1) oldBucket.splice(idx, 1)
      if (oldBucket.length === 0) tree.remove(oldTp)
    }

    // Update trigger price
    order.triggerPrice = newTriggerPrice

    // Add to new bucket
    let newBucket = tree.find(newTriggerPrice)
    if (!newBucket) {
      newBucket = []
      tree.insert(newTriggerPrice, newBucket)
    }
    newBucket.push(order)

    // Update index
    const entry = this.indexById.get(order.id)
    if (entry) entry.triggerPrice = newTriggerPrice
  }

  /* ═══════ GETTERS ═══════════════════════════════════════════════ */

  getByAgent(agentId) {
    const ids = this.indexByAgent.get(agentId) || new Set()
    const result = []
    for (const id of ids) {
      const entry = this.indexById.get(id)
      if (entry) result.push(entry.order)
    }
    return result
  }

  getAll() {
    const result = []
    for (const [, entry] of this.indexById) {
      result.push(entry.order)
    }
    return result
  }

  _toOutput(order) {
    return {
      order,
      triggerPrice: order.triggerPrice,
      type: order.type,
    }
  }
}
