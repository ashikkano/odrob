// ═══════════════════════════════════════════════════════════════════════
// Shared API Client — fetch wrapper with AbortController & error handling
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create an API client for a given base path.
 *
 * Features:
 * - AbortController support: pass { signal } to cancel requests
 * - Standard response envelope unwrapping (extracts `data` from `{ success, data }`)
 * - Consistent error handling with error messages from server
 * - Shared credentials-based session handling for authenticated requests
 *
 * @param {string} basePath — e.g. '/api/engine'
 * @param {{ getHeaders?: () => Record<string, string> }} [options]
 * @returns {{ request, setWalletAddress }}
 */
export function createApiClient(basePath, options = {}) {
  let _walletAddress = null
  const envFallbackTarget = (
    import.meta.env.VITE_API_FALLBACK_TARGET
    || import.meta.env.VITE_API_TARGET
    || 'http://localhost:3001'
  ).replace(/\/$/, '')

  function getDevFallbackUrl(path) {
    if (typeof window === 'undefined') return null
    const hostname = window.location.hostname
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    if (!isLocalhost) return null
    if (!String(basePath || '').startsWith('/api')) return null
    if (window.location.port === '3001') return null
    return `${envFallbackTarget}${basePath}${path}`
  }

  async function executeRequest(url, opts, headers) {
    return fetch(url, {
      credentials: 'include',
      headers,
      ...opts,
    })
  }

  function setWalletAddress(addr) {
    _walletAddress = addr
  }

  /**
   * Make an API request.
   * @param {string} path — relative to basePath
   * @param {RequestInit & { signal?: AbortSignal }} [opts]
   * @returns {Promise<any>} — response data (unwrapped from envelope if present)
   */
  async function request(path, opts = {}) {
    const dynamicHeaders = typeof options.getHeaders === 'function' ? (options.getHeaders() || {}) : {}
    const headers = { 'Content-Type': 'application/json', ...dynamicHeaders, ...opts.headers }

    const primaryUrl = `${basePath}${path}`
    const fallbackUrl = getDevFallbackUrl(path)

    let res
    let primaryError = null

    try {
      res = await executeRequest(primaryUrl, opts, headers)
    } catch (error) {
      primaryError = error
      if (!fallbackUrl) throw error
      res = await executeRequest(fallbackUrl, opts, headers)
    }

    if (res.status === 404 && fallbackUrl && primaryUrl !== fallbackUrl) {
      res = await executeRequest(fallbackUrl, opts, headers)
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const err = new Error(body.error || primaryError?.message || `HTTP ${res.status}`)
      err.status = res.status
      err.details = body.details
      throw err
    }

    const json = await res.json()

    // Unwrap standard envelope: { success: true, data: ... } → data
    if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
      return json.data
    }

    return json
  }

  return { request, setWalletAddress }
}

/**
 * Create an AbortController that auto-aborts on component unmount.
 * Usage in useEffect:
 *   const controller = new AbortController()
 *   fetchSomething({ signal: controller.signal })
 *   return () => controller.abort()
 *
 * @returns {AbortController}
 */
export function createAbortController() {
  return new AbortController()
}
