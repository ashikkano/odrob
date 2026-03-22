// ═══════════════════════════════════════════════════════════════════════
// OrderSideTree — Wraps RBTree to manage one side of the order book
// (all bids or all asks), with PriceLevel nodes
// ═══════════════════════════════════════════════════════════════════════

import { RBTree }     from './rbtree.js'
import { PriceLevel } from './priceLevel.js'

export class OrderSideTree {
  /**
   * @param {'buy'|'sell'} side
   */
  constructor(side) {
    this.side = side
    // Tree always sorted ascending by price
    this.tree = new RBTree((a, b) => a - b)
  }

  /** Number of distinct price levels. */
  get levelCount() { return this.tree.size }

  /**
   * Get existing PriceLevel or create a new one.
   * @param {number} price
   * @returns {PriceLevel}
   */
  getOrCreateLevel(price) {
    let level = this.tree.find(price)
    if (!level) {
      level = new PriceLevel(price, this.side)
      this.tree.insert(price, level)
    }
    return level
  }

  /**
   * Remove price level from tree if it's empty.
   * @param {number} price
   * @returns {boolean} true if removed
   */
  removeLevelIfEmpty(price) {
    const level = this.tree.find(price)
    if (level && level.isEmpty()) {
      this.tree.remove(price)
      return true
    }
    return false
  }

  /**
   * Best price level:
   *   buy side  → highest price (max)
   *   sell side → lowest price  (min)
   * @returns {PriceLevel|null}
   */
  best() {
    if (this.side === 'buy') {
      const m = this.tree.max()
      return m ? m.value : null
    } else {
      const m = this.tree.min()
      return m ? m.value : null
    }
  }

  /**
   * Get top N price levels (best first).
   * @param {number} depth
   * @returns {PriceLevel[]}
   */
  getLevels(depth) {
    if (this.side === 'buy') {
      // Bids: descending (highest first)
      return this.tree.firstN(depth, true).map(n => n.value)
    } else {
      // Asks: ascending (lowest first)
      return this.tree.firstN(depth, false).map(n => n.value)
    }
  }

  /**
   * Total volume across all price levels.
   */
  totalVolume() {
    let vol = 0
    this.tree.forEach((_price, level) => { vol += level.totalVolume })
    return vol
  }

  /**
   * Total order count across all levels.
   */
  totalOrders() {
    let count = 0
    this.tree.forEach((_price, level) => { count += level.orderCount })
    return count
  }

  /** Iterate levels from best to worst. */
  *[Symbol.iterator]() {
    const levels = this.getLevels(this.tree.size)
    for (const level of levels) {
      yield level
    }
  }
}
