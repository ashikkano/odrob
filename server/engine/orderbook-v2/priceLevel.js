// ═══════════════════════════════════════════════════════════════════════
// PriceLevel — Doubly-linked list of orders at the same price
// All operations O(1): append, remove, peek, isEmpty
// ═══════════════════════════════════════════════════════════════════════

export class PriceLevel {
  constructor(price, side) {
    this.price       = price
    this.side        = side     // 'buy' | 'sell'
    this.totalVolume = 0
    this.orderCount  = 0
    this.head        = null    // first (oldest) — highest priority (FIFO)
    this.tail        = null    // last (newest)
  }

  /** Append order to the end (FIFO queue). O(1). */
  append(order) {
    order.prev = this.tail
    order.next = null
    if (this.tail) {
      this.tail.next = order
    } else {
      this.head = order
    }
    this.tail = order
    this.totalVolume += order.remaining
    this.orderCount++
  }

  /** Remove order from anywhere in the list. O(1). */
  remove(order) {
    // Guard against double-removal: if pointers are null and order isn't head, it's already removed
    if (!order.prev && !order.next && this.head !== order) return

    if (order.prev) {
      order.prev.next = order.next
    } else {
      this.head = order.next
    }
    if (order.next) {
      order.next.prev = order.prev
    } else {
      this.tail = order.prev
    }
    order.prev = null
    order.next = null
    this.totalVolume -= order.remaining
    this.orderCount--
  }

  /** Look at the first (highest-priority) order without removing. O(1). */
  peek() {
    return this.head
  }

  /** Is this level empty? */
  isEmpty() {
    return this.orderCount === 0
  }

  /** Update totalVolume delta (e.g. after partial fill of order). */
  updateVolume(delta) {
    this.totalVolume += delta
  }

  /** Iterate orders in FIFO order. */
  *[Symbol.iterator]() {
    let current = this.head
    while (current) {
      const next = current.next  // capture before yield (order may be removed)
      yield current
      current = next
    }
  }
}
