#!/usr/bin/env node

import assert from 'assert'
import { randomUUID } from 'crypto'

const wallet = process.env.MARKETPLACE_TEST_WALLET || '0:dce21276027c17f76577b690c155aac660960c944b79665be382d611f5970b21'
const base = process.env.MARKETPLACE_API_BASE || 'http://localhost:3001/api'
const pollTimeoutMs = Number(process.env.MARKETPLACE_ROTATION_TIMEOUT_MS || 70000)
const pollIntervalMs = Number(process.env.MARKETPLACE_ROTATION_POLL_MS || 2000)
const jar = []

function updateCookieJar(response) {
  const raw = response.headers.get('set-cookie')
  if (!raw) return
  const cookie = raw.split(';')[0]
  if (!jar.includes(cookie)) jar.push(cookie)
}

async function request(path, { method = 'GET', payload } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jar.length ? { cookie: jar.join('; ') } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  })

  updateCookieJar(response)

  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${JSON.stringify(data)}`)
  }
  return data?.data ?? data
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function auth() {
  const challenge = await request('/auth/challenge', {
    method: 'POST',
    payload: { address: wallet },
  })
  assert.ok(challenge?.nonce, 'Auth challenge nonce missing')

  await request('/auth', {
    method: 'POST',
    payload: { address: wallet, nonce: challenge.nonce },
  })
}

async function ensureWalletAgent() {
  const owned = await request(`/engine/agents/by-wallet/${encodeURIComponent(wallet)}`)
  if (owned?.agent?.id) return owned.agent

  const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`
  return request('/engine/agents', {
    method: 'POST',
    payload: {
      name: `Marketplace Rotation Smoke ${suffix.slice(-6)}`,
      strategy: 'vwap',
      isUserAgent: true,
      walletAddress: wallet,
      virtualBalance: 1500,
      riskLevel: 'medium',
      bio: 'Auto-created for marketplace rotation limit smoke verification',
    },
  })
}

async function listCustomMarketplaceStrategies() {
  const market = await request('/strategies/marketplace?limit=50&sort=ranking')
  const listings = Array.isArray(market) ? market : market?.items || []
  return listings.filter((item) => item?.template?.type === 'custom' && item?.strategyTemplateId && item?.currentVersionId)
}

async function getAgent(agentId) {
  return request(`/engine/agents/${encodeURIComponent(agentId)}`)
}

function getActiveSubscriptions(agent) {
  return (agent?.indexSubscriptions || []).filter((sub) => sub?.status === 'active')
}

async function installStrategy(agentId, listing, rotationPolicy) {
  return request('/strategies/install', {
    method: 'POST',
    payload: {
      agentId,
      templateId: listing.strategyTemplateId,
      versionId: listing.currentVersionId,
      rotationPolicy,
    },
  })
}

async function waitForAgentState(agentId, predicate, label) {
  const deadline = Date.now() + pollTimeoutMs
  let last = null

  while (Date.now() < deadline) {
    last = await getAgent(agentId)
    if (predicate(last)) return last
    await sleep(pollIntervalMs)
  }

  throw new Error(`${label} timed out. Last state: ${JSON.stringify({
    activeSubscriptions: getActiveSubscriptions(last).map((sub) => ({ indexId: sub.indexId, source: sub.source })),
    lastSubscriptionRotationSummary: last?.lastSubscriptionRotationSummary || null,
    recentRotationEvents: last?.recentRotationEvents || [],
    strategySource: last?.strategySource || null,
    subscriptionOwner: last?.subscriptionOwner || null,
    config: last?.config || {},
  }, null, 2)}`)
}

function buildRotationPolicy(maxActiveChannels) {
  return {
    enabled: true,
    goalMode: 'balanced',
    profileName: `smoke-${maxActiveChannels}`,
    intervalTicks: 5,
    maxActiveChannels,
    minChannelLifetimeTicks: 5,
    churnBudgetPerDay: 20,
    maxCandidateChannels: Math.max(maxActiveChannels + 2, 4),
  }
}

async function main() {
  console.log('🧪 Marketplace runtime rotation-limit smoke test')
  console.log(`Wallet: ${wallet}`)
  console.log(`API: ${base}`)

  await auth()

  const listings = await listCustomMarketplaceStrategies()
  assert.ok(listings.length >= 3, 'Need at least 3 custom marketplace strategies for rotation-limit smoke')

  const indexes = await request('/indexes?limit=20')
  assert.ok(Array.isArray(indexes) && indexes.length >= 3, 'Need at least 3 active indexes for rotation smoke')

  const selected = listings.slice(0, 3)
  const agent = await ensureWalletAgent()
  assert.ok(agent?.id, 'Wallet-bound agent was not found or created')

  const checkpoints = []
  const limitSequence = [2, 3, 1]

  for (let i = 0; i < selected.length; i++) {
    const listing = selected[i]
    const maxActiveChannels = limitSequence[i]
    const rotationPolicy = buildRotationPolicy(maxActiveChannels)

    const install = await installStrategy(agent.id, listing, rotationPolicy)
    assert.ok(install?.instance?.id, `Install ${i + 1} did not return an instance id`)

    const checkpoint = await waitForAgentState(
      agent.id,
      (state) => {
        const activeSubs = getActiveSubscriptions(state)
        const countMatches = i < 2
          ? activeSubs.length === maxActiveChannels
          : activeSubs.length <= maxActiveChannels
        const sourcesManaged = activeSubs.every((sub) => ['rotation', 'bootstrap', 'seed_fanout'].includes(sub?.source))
        const strategyMatches = state?.activeStrategyTemplateId === listing.strategyTemplateId
        const ownerMatches = state?.subscriptionOwner === 'custom'
        const rotationApplied = Number(state?.config?.maxActiveSubscriptions) === maxActiveChannels
        const rotationSeen = i === 0
          ? Boolean(state?.lastSubscriptionRotationSummary?.rotatedIn >= 1)
          : Boolean(state?.lastSubscriptionRotationAt)

        return countMatches && sourcesManaged && strategyMatches && ownerMatches && rotationApplied && rotationSeen
      },
      `agent to converge after install ${i + 1} (${listing?.template?.name || listing.strategyTemplateId})`,
    )

    checkpoints.push({
      step: i + 1,
      templateId: listing.strategyTemplateId,
      templateName: listing?.template?.name || null,
      maxActiveChannels,
      activeSubscriptions: getActiveSubscriptions(checkpoint).map((sub) => ({
        indexId: sub.indexId,
        source: sub.source,
        allocationPct: sub.allocationPct,
      })),
      activeCount: getActiveSubscriptions(checkpoint).length,
      lastSubscriptionRotationSummary: checkpoint.lastSubscriptionRotationSummary,
      recentRotationEvents: checkpoint.recentRotationEvents,
      activeStrategyTemplateId: checkpoint.activeStrategyTemplateId,
      strategySource: checkpoint.strategySource,
      subscriptionOwner: checkpoint.subscriptionOwner,
      maxActiveSubscriptionsConfig: checkpoint?.config?.maxActiveSubscriptions,
    })
  }

  assert.equal(checkpoints[0].activeCount, 2, 'First install should settle to exactly 2 active subscriptions')
  assert.equal(checkpoints[1].activeCount, 3, 'Second install should expand to exactly 3 active subscriptions')
  assert.ok(checkpoints[2].activeCount <= 1, 'Third install should prune active subscriptions down to the 1-channel limit')
  assert.equal(checkpoints[2].maxActiveSubscriptionsConfig, 1, 'Final runtime config should keep maxActiveSubscriptions=1')
  assert.ok((checkpoints[2].lastSubscriptionRotationSummary?.rotatedOut || 0) >= 1, 'Final prune step should rotate out at least one subscription')

  console.log(JSON.stringify({
    agentId: agent.id,
    indexesAvailable: indexes.length,
    selectedStrategies: selected.map((item) => ({
      templateId: item.strategyTemplateId,
      templateName: item?.template?.name || null,
      versionId: item.currentVersionId,
    })),
    checkpoints,
  }, null, 2))
  console.log('✅ Marketplace runtime rotation-limit smoke test passed')
}

main().catch((error) => {
  console.error('❌ Marketplace runtime rotation-limit smoke test failed')
  console.error(error.message)
  process.exit(1)
})
