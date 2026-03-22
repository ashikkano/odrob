// ═══════════════════════════════════════════════════════════════════════
// Agent API Client
// Frontend ↔ Backend communication for user auth + agent management.
// Requests rely on server-issued session cookies after login.
// ═══════════════════════════════════════════════════════════════════════

const API_BASE = '/api'

function headers() {
  return {
    'Content-Type': 'application/json',
  }
}

async function request(method, path, address, body) {
  const opts = { method, headers: headers(), credentials: 'include' }
  if (body) opts.body = JSON.stringify(body)

  const res = await fetch(`${API_BASE}${path}`, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const e = new Error(err.error || `Request failed: ${res.status}`)
    e.status = res.status
    if (err.details) e.details = err.details
    throw e
  }
  const json = await res.json()
  // Unwrap standardised { success, data } envelope
  return json && json.success !== undefined && 'data' in json ? json.data : json
}

// ─── Auth ─────────────────────────────────────────────────────────────

export const login = async (address) => {
  const challenge = await request('POST', '/auth/challenge', address, { address })
  return request('POST', '/auth', address, { address, nonce: challenge?.nonce })
}

export const logout = (address) =>
  request('POST', '/auth/logout', address)

export const getMe = (address) =>
  request('GET', '/me', address)

// ─── Agents CRUD ──────────────────────────────────────────────────────

export const fetchAgents = (address) =>
  request('GET', '/agents', address)

export const createAgent = (address, params) =>
  request('POST', '/agents', address, params)

export const getAgent = (address, id) =>
  request('GET', `/agents/${id}`, address)

export const updateAgent = (address, id, updates) =>
  request('PATCH', `/agents/${id}`, address, updates)

export const deleteAgent = (address, id) =>
  request('DELETE', `/agents/${id}`, address)

// ─── Agent Actions ────────────────────────────────────────────────────

export const startAgent = (address, id) =>
  request('POST', `/agents/${id}/start`, address)

export const pauseAgent = (address, id) =>
  request('POST', `/agents/${id}/pause`, address)

export const stopAgent = (address, id) =>
  request('POST', `/agents/${id}/stop`, address)

export const refreshBalance = (address, id) =>
  request('GET', `/agents/${id}/balance`, address)

export const recordDeposit = (address, id, amount, txHash) =>
  request('POST', `/agents/${id}/deposit`, address, { amount, txHash })
