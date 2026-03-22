// ═══════════════════════════════════════════════════════════════════════
// RingBuffer — Fixed-size circular buffer for trade storage
// O(1) push, O(1) index access, bounded memory
// ═══════════════════════════════════════════════════════════════════════

export class RingBuffer {
  /**
   * @param {number} capacity Maximum number of items to store.
   */
  constructor(capacity) {
    this.capacity = capacity
    this.buffer   = new Array(capacity)
    this.head     = 0    // next write position
    this.length   = 0    // current number of items
  }

  /** Push an item. Overwrites oldest if full. O(1). */
  push(item) {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this.length < this.capacity) this.length++
  }

  /**
   * Get item by index (0 = most recent, 1 = second most recent, ...).
   * Returns undefined if out of range.
   */
  get(index) {
    if (index < 0 || index >= this.length) return undefined
    // Most recent is at (head - 1), so index 0 → head - 1
    const pos = (this.head - 1 - index + this.capacity * 2) % this.capacity
    return this.buffer[pos]
  }

  /**
   * Slice most recent N items (newest first).
   * @param {number} [start=0]
   * @param {number} [end=this.length]
   * @returns {Array}
   */
  slice(start = 0, end) {
    end = Math.min(end ?? this.length, this.length)
    const result = []
    for (let i = start; i < end; i++) {
      result.push(this.get(i))
    }
    return result
  }

  /** Convert to array (newest first). */
  toArray() {
    return this.slice(0, this.length)
  }

  /** Is the buffer at capacity? */
  isFull() {
    return this.length >= this.capacity
  }

  /** Clear all items. */
  clear() {
    this.buffer = new Array(this.capacity)
    this.head   = 0
    this.length = 0
  }

  /** Iterate newest → oldest. */
  *[Symbol.iterator]() {
    for (let i = 0; i < this.length; i++) {
      yield this.get(i)
    }
  }
}
