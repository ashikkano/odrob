// ═══════════════════════════════════════════════════════════════════════
// Engine API Client — Fetches data from autonomous agent engine
// ═══════════════════════════════════════════════════════════════════════

import { createApiClient } from './apiClient.js'
import { login as loginWallet } from './agentApi'

const { request, setWalletAddress: _setWallet } = createApiClient('/api/engine')
let currentWalletAddress = null

export function setWalletAddress(addr) {
  currentWalletAddress = addr || null
  _setWallet(addr)
}

async function requestWithWalletAuth(path, opts) {
  if (currentWalletAddress) {
    await loginWallet(currentWalletAddress)
  }

  try {
    return await request(path, opts)
  } catch (err) {
    if (err?.status !== 401 || !currentWalletAddress) throw err
    await loginWallet(currentWalletAddress)
    return request(path, opts)
  }
}

// ─── Dashboard ───────────────────────────────────────────────────────

export function fetchMetrics() {
  return request('/metrics')
}

// ─── Agents ──────────────────────────────────────────────────────────

export function fetchEngineAgents() {
  return request('/agents/public')
}

export function fetchEngineAgent(id) {
  return request(`/agents/${id}`)
}

export function fetchAgentByWallet(address) {
  return request(`/agents/by-wallet/${encodeURIComponent(address)}`)
}

export function createEngineAgent(data) {
  return requestWithWalletAuth('/agents', { method: 'POST', body: JSON.stringify(data) })
}

export function updateEngineAgent(id, data) {
  return requestWithWalletAuth(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
}

export function deleteEngineAgent(id) {
  return requestWithWalletAuth(`/agents/${id}`, { method: 'DELETE' })
}

export function startEngineAgent(id) {
  return requestWithWalletAuth(`/agents/${id}/start`, { method: 'POST' })
}

export function pauseEngineAgent(id) {
  return requestWithWalletAuth(`/agents/${id}/pause`, { method: 'POST' })
}

export function stopEngineAgent(id) {
  return requestWithWalletAuth(`/agents/${id}/stop`, { method: 'POST' })
}

// ─── Data ────────────────────────────────────────────────────────────

export function fetchOrderBook(depth = 15) {
  return request(`/orderbook?depth=${depth}`)
}

export function fetchRecentTrades(limit = 50) {
  return request(`/trades?limit=${limit}`)
}

export function fetchDecisions(agentId, limit = 50) {
  if (agentId) return request(`/agents/${agentId}/decisions?limit=${limit}`)
  return request(`/decisions?limit=${limit}`)
}

export function fetchEquityCurve() {
  return request('/equity')
}

export function fetchStrategies() {
  return request('/strategies')
}

// ─── Engine control ──────────────────────────────────────────────────

export function startEngine() {
  return request('/start', { method: 'POST' })
}

export function stopEngine() {
  return request('/stop', { method: 'POST' })
}

export function fetchEngineStatus() {
  return request('/status')
}
