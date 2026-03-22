#!/usr/bin/env node

import assert from 'node:assert/strict'
import { loadLocalEnv } from './loadLocalEnv.js'

loadLocalEnv({ overrideProcessEnv: true })

const baseUrl = String(process.env.ODROB_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '')
const address = process.argv[2] || '0:7777777777777777777777777777777777777777777777777777777777777777'
const requestTimeoutMs = Number(process.env.ODROB_VERIFY_TIMEOUT_MS || 10000)

function buildCandidateBaseUrls(input) {
  const urls = [input]
  if (input.includes('://localhost:')) {
    urls.push(input.replace('://localhost:', '://127.0.0.1:'))
  }
  return [...new Set(urls)]
}

function printSection(title, lines = []) {
  console.log(`\n${title}`)
  for (const line of lines) console.log(line)
}

async function requestJson(path, { method = 'GET', body, cookie, allowStatus = [] } = {}) {
  let response = null
  let lastNetworkError = null

  for (const candidateBaseUrl of buildCandidateBaseUrls(baseUrl)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)

    try {
      response = await fetch(`${candidateBaseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      clearTimeout(timer)
      break
    } catch (error) {
      clearTimeout(timer)
      lastNetworkError = error
    }
  }

  if (!response) {
    throw lastNetworkError || new Error('Request failed before receiving a response')
  }

  const payload = await response.json().catch(() => null)
  const acceptedStatuses = new Set([response.ok ? response.status : -1, ...allowStatus])

  if (!response.ok && !acceptedStatuses.has(response.status)) {
    const error = new Error(payload?.error || `Request failed: ${response.status}`)
    error.status = response.status
    error.payload = payload
    throw error
  }

  const setCookie = typeof response.headers.get === 'function'
    ? response.headers.get('set-cookie')
    : null

  return {
    status: response.status,
    cookie: setCookie ? setCookie.split(';')[0] : '',
    data: payload?.success !== undefined && 'data' in (payload || {}) ? payload.data : payload,
    payload,
  }
}

async function main() {
  console.log(`🔎 Verifying user runtime bridge against ${baseUrl}`)
  console.log(`Using TON address: ${address}`)

  let cookie = ''
  let createdAgentId = null

  try {
    console.log('Step 1/11: challenge')
    const challenge = await requestJson('/api/auth/challenge', {
      method: 'POST',
      body: { address },
    })

    console.log('Step 2/11: auth')
    const auth = await requestJson('/api/auth', {
      method: 'POST',
      body: { address, nonce: challenge.data?.nonce },
    })

    cookie = auth.cookie
    assert.ok(cookie, 'Auth cookie was not returned')

    console.log('Step 3/11: session and baseline')
    const session = await requestJson('/api/auth/session', { cookie })
    assert.equal(session.data?.authenticated, true, 'Session did not authenticate after auth flow')
    assert.equal(session.data?.activeWalletAddress, address, 'Active wallet address mismatch after auth flow')

    const meBefore = await requestJson('/api/me', { cookie })
    const beforeAgentCount = Number(meBefore.data?.agentCount || 0)

    const listBefore = await requestJson('/api/agents', { cookie })
    const beforeListCount = Array.isArray(listBefore.data) ? listBefore.data.length : 0

    console.log('Step 4/11: create agent')
    const createResponse = await requestJson('/api/agents', {
      method: 'POST',
      cookie,
      body: {
        name: `Bridge Smoke ${Date.now()}`,
        preset: 'runtime-bridge-smoke',
        strategy: 'mean_reversion',
        index: 'FLOOR',
        config: {
          source: 'verify-user-runtime-bridge',
        },
        riskParams: {
          maxLossPct: 5,
        },
      },
    })

    const createdAgent = createResponse.data
    createdAgentId = createdAgent?.id || null
    assert.ok(createdAgentId, 'Agent creation did not return an id')
    assert.equal(createdAgent.ownerAddress, address, 'Created agent owner mismatch')
    assert.ok(createdAgent.walletId, 'Created agent did not persist walletId')
    assert.ok(createdAgent.walletAddress, 'Created agent did not persist walletAddress')
    assert.equal(createdAgent.status, 'funding', 'Created agent should start in funding status')

    console.log('Step 5/11: read and patch agent')
    const getCreated = await requestJson(`/api/agents/${encodeURIComponent(createdAgentId)}`, { cookie })
    assert.equal(getCreated.data?.id, createdAgentId, 'Agent fetch by id returned wrong agent')

    const updatedName = `${createdAgent.name} Updated`
    const patchResponse = await requestJson(`/api/agents/${encodeURIComponent(createdAgentId)}`, {
      method: 'PATCH',
      cookie,
      body: {
        name: updatedName,
        riskParams: {
          maxLossPct: 7,
          rebalanceIntervalMs: 60000,
        },
      },
    })
    assert.equal(patchResponse.data?.name, updatedName, 'Agent name was not updated')
    assert.equal(patchResponse.data?.riskParams?.maxLossPct, 7, 'Agent risk params were not updated')

    console.log('Step 6/11: start agent')
    const started = await requestJson(`/api/agents/${encodeURIComponent(createdAgentId)}/start`, {
      method: 'POST',
      cookie,
    })
    assert.equal(started.data?.status, 'active', 'Agent start did not persist active status')

    console.log('Step 7/11: pause agent')
    const paused = await requestJson(`/api/agents/${encodeURIComponent(createdAgentId)}/pause`, {
      method: 'POST',
      cookie,
    })
    assert.equal(paused.data?.status, 'paused', 'Agent pause did not persist paused status')

    console.log('Step 8/11: stop agent')
    const stopped = await requestJson(`/api/agents/${encodeURIComponent(createdAgentId)}/stop`, {
      method: 'POST',
      cookie,
    })
    assert.equal(stopped.data?.status, 'stopped', 'Agent stop did not persist stopped status')

    console.log('Step 9/11: deposit')
    const deposited = await requestJson(`/api/agents/${encodeURIComponent(createdAgentId)}/deposit`, {
      method: 'POST',
      cookie,
      body: {
        amount: 1.25,
        txHash: `smoke-${Date.now()}`,
      },
    })
    assert.ok(Array.isArray(deposited.data?.deposits), 'Agent deposits were not persisted as an array')
    assert.equal(deposited.data.deposits.length, 1, 'Agent deposit entry was not persisted')

    console.log('Step 10/11: delete and verify counts')
    const listAfterCreate = await requestJson('/api/agents', { cookie })
    const afterCreateCount = Array.isArray(listAfterCreate.data) ? listAfterCreate.data.length : 0
    assert.equal(afterCreateCount, beforeListCount + 1, 'Agent list count did not increase after create')

    const meAfterCreate = await requestJson('/api/me', { cookie })
    assert.equal(Number(meAfterCreate.data?.agentCount || 0), beforeAgentCount + 1, 'Agent count did not increase after create')

    const deletedAgentId = createdAgentId
    const deleted = await requestJson(`/api/agents/${encodeURIComponent(deletedAgentId)}`, {
      method: 'DELETE',
      cookie,
    })
    assert.equal(deleted.data?.deleted, true, 'Agent delete did not confirm deletion')
    createdAgentId = null

    const missingAfterDelete = await requestJson(`/api/agents/${encodeURIComponent(deletedAgentId)}`, {
      cookie,
      allowStatus: [404],
    })
    assert.equal(missingAfterDelete.status, 404, 'Deleted agent remained readable')

    const meAfterDelete = await requestJson('/api/me', { cookie })
    assert.equal(Number(meAfterDelete.data?.agentCount || 0), beforeAgentCount, 'Agent count did not return after delete')

    const listAfterDelete = await requestJson('/api/agents', { cookie })
    const afterDeleteCount = Array.isArray(listAfterDelete.data) ? listAfterDelete.data.length : 0
    assert.equal(afterDeleteCount, beforeListCount, 'Agent list count did not return after delete')

    console.log('Step 11/11: logout')
    const logout = await requestJson('/api/auth/logout', {
      method: 'POST',
      cookie,
    })
    assert.equal(logout.data?.loggedOut, true, 'Logout did not complete successfully')

    const sessionAfterLogout = await requestJson('/api/auth/session', { cookie })
    assert.equal(sessionAfterLogout.data?.authenticated, false, 'Session remained authenticated after logout')

    printSection('Result', [
      '- User runtime bridge flow passed.',
      '- Auth session, me, legacy agent CRUD, state transitions, deposit persistence, and logout all behaved as expected.',
    ])
  } finally {
    if (createdAgentId && cookie) {
      await requestJson(`/api/agents/${encodeURIComponent(createdAgentId)}`, {
        method: 'DELETE',
        cookie,
        allowStatus: [404],
      }).catch(() => null)
    }
    if (cookie) {
      await requestJson('/api/auth/logout', {
        method: 'POST',
        cookie,
        allowStatus: [200, 401],
      }).catch(() => null)
    }
  }
}

main().catch((error) => {
  console.error('\nVerification failed:', error.message)
  if (error.payload) {
    console.error(JSON.stringify(error.payload, null, 2))
  }
  process.exitCode = 1
})