// ═══════════════════════════════════════════════════════════════════════
// Index API Client — Fetches custom index data from backend
// ═══════════════════════════════════════════════════════════════════════

import { createApiClient } from './apiClient.js'

const { request: req, setWalletAddress: _setWallet } = createApiClient('/api')

export function setIndexWalletAddress(addr) { _setWallet(addr) }

// ─── Indexes ─────────────────────────────────────────────────────────

/** List all indexes (summary) */
export function fetchIndexes() {
  return req('/indexes')
}

/** Full index detail + orderbook + trades + priceHistory */
export function fetchIndex(indexId) {
  return req(`/indexes/${indexId}`)
}

/** Lightweight price-only (~200 bytes vs 16KB full snapshot) */
export function fetchIndexPrice(indexId) {
  return req(`/indexes/${indexId}/price`)
}

/** Index order book */
export function fetchIndexOrderBook(indexId, depth = 12) {
  return req(`/indexes/${indexId}/orderbook?depth=${depth}`)
}

/** Recent trades for an index */
export function fetchIndexTrades(indexId, limit = 30) {
  return req(`/indexes/${indexId}/trades?limit=${limit}`)
}

/** Index holders leaderboard */
export function fetchIndexHolders(indexId) {
  return req(`/indexes/${indexId}/holders`)
}

/** Index oracle price history */
export function fetchIndexOracle(indexId, limit = 200) {
  return req(`/indexes/${indexId}/oracle?limit=${limit}`)
}

/** Index feed (events) */
export function fetchIndexFeed(indexId, limit = 30) {
  return req(`/indexes/${indexId}/feed?limit=${limit}`)
}

/** System market maker snapshot */
export function fetchIndexMM(indexId) {
  return req(`/indexes/${indexId}/market-maker`)
}

// ─── Subscriptions ───────────────────────────────────────────────────

/** Subscribe agent to index */
export function subscribeToIndex(indexId, agentId, allocationPct = 5) {
  return req(`/indexes/${indexId}/subscribe`, {
    method: 'POST',
    body: JSON.stringify({ agentId, allocationPct }),
  })
}

/** Unsubscribe agent from index */
export function unsubscribeFromIndex(indexId, agentId) {
  return req(`/indexes/${indexId}/subscribe/${agentId}`, { method: 'DELETE' })
}

/** Get agent's index subscriptions */
export function fetchAgentIndexes(agentId) {
  return req(`/engine/agents/${agentId}/indexes`)
}

/** Get agent's index holdings across all indexes */
export function fetchAgentIndexHoldings(agentId) {
  return req(`/engine/agents/${agentId}/index-holdings`)
}

// ─── Agent-Created Indexes ───────────────────────────────────────────

/** Get formula templates for agent index creation */
export function fetchAgentTemplates() {
  return req('/indexes/templates')
}

/** Check if agent can create an index (balance / trades / limits) */
export function fetchCanCreateIndex(agentId) {
  return req(`/indexes/can-create/${agentId}`)
}

/** Create a new agent-owned index */
export function createAgentIndex({ agentId, templateId, name, symbol }) {
  return req('/indexes/create-by-agent', {
    method: 'POST',
    body: JSON.stringify({ agentId, templateId, name, symbol }),
  })
}

/** Get creator stats / revenue dashboard for an agent */
export function fetchCreatorStats(agentId) {
  return req(`/indexes/creator-stats/${agentId}`)
}

/** Protocol treasury snapshot for an index */
export function fetchIndexTreasury(indexId) {
  return req(`/indexes/${indexId}/treasury`)
}

/** Global liquidity pool snapshot */
export function fetchGlobalPool() {
  return req('/indexes/global-pool')
}
