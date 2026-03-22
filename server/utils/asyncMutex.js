// ═══════════════════════════════════════════════════════════════════════
// ARC-004 — Lightweight per-key async mutex
//
// Prevents logical race conditions in Node.js async code where an
// `await` point allows interleaving between oracle ticks and HTTP
// trade requests for the SAME index.
//
// Usage:
//   const lock = new AsyncMutex()
//   await lock.runExclusive('AI_TRADE', async () => { ... })
//
// Guarantees: only ONE callback per key runs at a time.
// Zero deps, zero overhead when lock is uncontested (~just a Map lookup).
// ═══════════════════════════════════════════════════════════════════════

export class AsyncMutex {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this._locks = new Map()
  }

  /**
   * Run an async function exclusively for the given key.
   * If another function is already running for this key, waits until it finishes.
   *
   * @param {string} key — e.g. index ID
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  async runExclusive(key, fn) {
    // Wait for any existing lock on this key
    while (this._locks.has(key)) {
      try { await this._locks.get(key) } catch { /* swallow — we just need to wait */ }
    }

    // Set our own lock
    let resolve
    const promise = new Promise(r => { resolve = r })
    this._locks.set(key, promise)

    try {
      return await fn()
    } finally {
      this._locks.delete(key)
      resolve()
    }
  }

  /** Check if a key is currently locked (for diagnostics). */
  isLocked(key) {
    return this._locks.has(key)
  }
}
