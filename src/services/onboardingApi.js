const API_BASE = '/api'
const BOOTSTRAP_CACHE_TTL_MS = 1000

const onboardingBootstrapInflight = new Map()
const onboardingBootstrapCache = new Map()

function buildHeaders() {
  return { 'Content-Type': 'application/json' }
}

async function request(method, path, body, address) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: buildHeaders(),
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const error = new Error(err.error || `Request failed: ${res.status}`)
    error.status = res.status
    if (err.details) error.details = err.details
    throw error
  }

  const json = await res.json()
  return json && json.success !== undefined && 'data' in json ? json.data : json
}

function getBootstrapCacheKey(address) {
  return String(address || '')
}

function clearBootstrapCache(address) {
  if (typeof address === 'undefined') {
    onboardingBootstrapInflight.clear()
    onboardingBootstrapCache.clear()
    return
  }

  const key = getBootstrapCacheKey(address)
  onboardingBootstrapInflight.delete(key)
  onboardingBootstrapCache.delete(key)
}

export function fetchOnboardingBootstrap(address) {
  const cacheKey = getBootstrapCacheKey(address)
  const query = address ? `?address=${encodeURIComponent(address)}` : ''
  const now = Date.now()
  const cached = onboardingBootstrapCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value)
  }

  const inFlight = onboardingBootstrapInflight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const nextRequest = request('GET', `/onboarding/bootstrap${query}`, undefined, address)
    .then((data) => {
      onboardingBootstrapCache.set(cacheKey, {
        value: data,
        expiresAt: Date.now() + BOOTSTRAP_CACHE_TTL_MS,
      })
      return data
    })
    .finally(() => {
      onboardingBootstrapInflight.delete(cacheKey)
    })

  onboardingBootstrapInflight.set(cacheKey, nextRequest)
  return nextRequest
}

export function saveOnboardingProfile(payload, address) {
  clearBootstrapCache(address)
  return request('POST', '/onboarding/profile', payload, address)
}

export function registerOnboarding(payload, address) {
  clearBootstrapCache(address)
  return request('POST', '/onboarding/register', payload, address)
}

export function linkWalletIdentity(payload, address) {
  clearBootstrapCache(address)
  return request('POST', '/onboarding/wallets/link', payload, address)
}

export function createManagedWallet(payload, address) {
  clearBootstrapCache(address)
  return request('POST', '/onboarding/wallets/managed', payload, address)
}

export function fetchManagedWalletRuntime({ walletId, address } = {}) {
  const params = new URLSearchParams()
  if (walletId) params.set('walletId', walletId)
  if (address) params.set('address', address)
  const query = params.toString()
  return request('GET', `/onboarding/wallets/managed/runtime${query ? `?${query}` : ''}`, undefined, address)
}