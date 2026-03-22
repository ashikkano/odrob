import { createApiClient } from './apiClient.js'
import { login as loginWallet } from './agentApi'

const { request, setWalletAddress: _setWallet } = createApiClient('/api/strategies')
let currentWalletAddress = null
let authenticatedWalletAddress = null
let authInFlight = null

export function setStrategyMarketplaceWalletAddress(addr) {
  currentWalletAddress = addr || null
  if (authenticatedWalletAddress !== currentWalletAddress) {
    authenticatedWalletAddress = null
    authInFlight = null
  }
  _setWallet(addr)
}

async function ensureWalletAuth(force = false) {
  if (!currentWalletAddress) return
  if (!force && authenticatedWalletAddress === currentWalletAddress) return

  if (!authInFlight) {
    authInFlight = loginWallet(currentWalletAddress)
      .then((result) => {
        authenticatedWalletAddress = currentWalletAddress
        return result
      })
      .finally(() => {
        authInFlight = null
      })
  }

  return authInFlight
}

async function requestWithWalletAuth(path, opts) {
  try {
    return await request(path, opts)
  } catch (err) {
    if (err?.status !== 401 || !currentWalletAddress) throw err
    authenticatedWalletAddress = null
    await ensureWalletAuth(true)
    return request(path, opts)
  }
}

export function fetchStrategyMarketplace({ limit = 24, offset = 0, category = null, sort = 'ranking', includeMeta = false } = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (offset > 0) params.set('offset', String(offset))
  if (category) params.set('category', category)
  if (sort) params.set('sort', sort)
  if (includeMeta) params.set('includeMeta', '1')
  return request(`/marketplace?${params.toString()}`)
}

export function fetchStrategyTemplate(id) {
  return request(`/templates/${id}`)
}

export function fetchStrategyVersions(id) {
  return request(`/templates/${id}/versions`)
}

export function fetchStrategyTemplateMetrics(id) {
  return request(`/templates/${id}/metrics`)
}

export function fetchMyStrategyTemplates() {
  return requestWithWalletAuth('/mine/templates')
}

export function fetchMyStrategyRevenue({ limit = 25 } = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  return requestWithWalletAuth(`/mine/revenue?${params.toString()}`)
}

export function createStrategyTemplate(payload) {
  return requestWithWalletAuth('/templates', { method: 'POST', body: JSON.stringify(payload) })
}

export function createStrategyVersion(templateId, payload) {
  return requestWithWalletAuth(`/templates/${encodeURIComponent(templateId)}/versions`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function publishStrategyTemplate(templateId, payload) {
  return requestWithWalletAuth(`/templates/${encodeURIComponent(templateId)}/publish`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function installMarketplaceStrategy(payload) {
  return requestWithWalletAuth('/install', { method: 'POST', body: JSON.stringify(payload) })
}

export function fetchStrategyExecutions(agentId, { limit = 25, strategyInstanceId = null } = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (strategyInstanceId) params.set('strategyInstanceId', strategyInstanceId)
  return requestWithWalletAuth(`/agents/${encodeURIComponent(agentId)}/executions?${params.toString()}`)
}