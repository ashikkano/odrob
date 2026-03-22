// ═══════════════════════════════════════════════════════════════════════
// RingBuffer — Fixed-capacity circular buffer for trade/decision logs
// Avoids O(n) unshift + O(n) slice on every insert.
// ═══════════════════════════════════════════════════════════════════════

/**
 * A fixed-size circular buffer that supports newest-first iteration.
 * Items are added at the "head" and oldest items are silently dropped
 * when the buffer wraps around.
 *
 * @template T
 */
export class RingBuffer {
  /**
   * @param {number} capacity — maximum number of items
   */
  constructor(capacity) {
    this.capacity = capacity
    /** @type {T[]} */
    this._buf = new Array(capacity)
    this._head = 0    // next write position
    this._size = 0    // current number of items
  }

  /** Number of items currently stored. */
  get length() { return this._size }

  /**
   * Add an item (newest). O(1).
   * @param {T} item
   */
  push(item) {
    this._buf[this._head] = item
    this._head = (this._head + 1) % this.capacity
    if (this._size < this.capacity) this._size++
  }

  /**
   * Get the N most recent items, newest first. O(n).
   * @param {number} [n] — defaults to all
   * @returns {T[]}
   */
  slice(n) {
    const count = Math.min(n ?? this._size, this._size)
    const result = new Array(count)
    for (let i = 0; i < count; i++) {
      // Walk backwards from head
      const idx = (this._head - 1 - i + this.capacity) % this.capacity
      result[i] = this._buf[idx]
    }
    return result
  }

  /**
   * Get all items, newest first. Equivalent to slice().
   * @returns {T[]}
   */
  toArray() {
    return this.slice()
  }

  /**
   * Convert to plain array for JSON serialization.
   * @returns {T[]}
   */
  toJSON() {
    return this.toArray()
  }

  /**
   * Create a RingBuffer pre-filled from an existing array (newest-first order).
   * @template T
   * @param {T[]} arr — items in newest-first order
   * @param {number} capacity
   * @returns {RingBuffer<T>}
   */
  static from(arr, capacity) {
    const rb = new RingBuffer(capacity)
    // Insert oldest first so newest ends up at head
    const items = arr.slice(0, capacity).reverse()
    for (const item of items) {
      rb.push(item)
    }
    return rb
  }
}
