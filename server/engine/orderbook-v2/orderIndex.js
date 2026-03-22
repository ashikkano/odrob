// ═══════════════════════════════════════════════════════════════════════
// OrderIndex — HashMap indexes for O(1) order lookup
//   • By orderId  → { order, priceLevel, side }
//   • By agentId  → Set<orderId>
// ═══════════════════════════════════════════════════════════════════════

export class OrderIndex {
  constructor() {
    /** @type {Map<string, {order, priceLevel, side}>} */
    this.byId = new Map()
    /** @type {Map<string, Set<string>>} */
    this.byAgent = new Map()
  }

  /** Register order in both indexes. O(1). */
  add(order, priceLevel, side) {
    this.byId.set(order.id, { order, priceLevel, side })

    let agentSet = this.byAgent.get(order.agentId)
    if (!agentSet) {
      agentSet = new Set()
      this.byAgent.set(order.agentId, agentSet)
    }
    agentSet.add(order.id)
  }

  /** Remove order from both indexes. O(1). */
  remove(orderId) {
    const entry = this.byId.get(orderId)
    if (!entry) return false

    this.byId.delete(orderId)

    const agentSet = this.byAgent.get(entry.order.agentId)
    if (agentSet) {
      agentSet.delete(orderId)
      if (agentSet.size === 0) this.byAgent.delete(entry.order.agentId)
    }
    return true
  }

  /** Lookup by orderId. O(1). Returns { order, priceLevel, side } or null. */
  get(orderId) {
    return this.byId.get(orderId) || null
  }

  /** Check existence. O(1). */
  has(orderId) {
    return this.byId.has(orderId)
  }

  /** Get all order IDs for an agent. Returns a copy of Set<orderId> (safe to iterate while cancelling). */
  getByAgent(agentId) {
    const set = this.byAgent.get(agentId)
    return set ? new Set(set) : new Set()
  }

  /** Total number of indexed orders. */
  get totalOrders() {
    return this.byId.size
  }

  /** Clear all indexes. */
  clear() {
    this.byId.clear()
    this.byAgent.clear()
  }
}
