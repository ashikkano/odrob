import { createApiClient } from './apiClient.js'

const { request } = createApiClient('/api')
const SESSION_CACHE_TTL_MS = 1000

let authSessionInFlight = null
let authSessionCache = {
  value: null,
  expiresAt: 0,
}

export function invalidateAuthSessionCache() {
  authSessionInFlight = null
  authSessionCache = {
    value: null,
    expiresAt: 0,
  }
}

export function verifyPrivyAuth(accessToken) {
  return request('/auth/privy/verify', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ accessToken }),
  })
}

export function fetchAuthSession({ force = false } = {}) {
  if (force) {
    invalidateAuthSessionCache()
  }

  const now = Date.now()
  if (authSessionCache.value && authSessionCache.expiresAt > now) {
    return Promise.resolve(authSessionCache.value)
  }
  if (authSessionInFlight) {
    return authSessionInFlight
  }

  authSessionInFlight = request('/auth/session')
    .then((data) => {
      authSessionCache = {
        value: data,
        expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
      }
      return data
    })
    .finally(() => {
      authSessionInFlight = null
    })

  return authSessionInFlight
}

export function setActiveWallet(walletAddress, walletProvider = 'wdk-ton') {
  invalidateAuthSessionCache()
  return request('/auth/active-wallet', {
    method: 'POST',
    body: JSON.stringify({ walletAddress, walletProvider }),
  })
}

export function logoutAuth() {
  invalidateAuthSessionCache()
  return request('/auth/logout', { method: 'POST' })
}