// ═══════════════════════════════════════════════════════════════════════
// Hot endpoint cache — tiny in-memory TTL cache
// ═══════════════════════════════════════════════════════════════════════

export function createTTLCache(defaultTtlMs = 1500) {
  const store = new Map()

  function get(key) {
    const row = store.get(key)
    if (!row) return null
    if (row.exp <= Date.now()) {
      store.delete(key)
      return null
    }
    return row.value
  }

  function set(key, value, ttlMs = defaultTtlMs) {
    store.set(key, { value, exp: Date.now() + ttlMs })
    return value
  }

  function del(key) {
    store.delete(key)
  }

  function clear() {
    store.clear()
  }

  function stats() {
    return { size: store.size }
  }

  return { get, set, del, clear, stats }
}
