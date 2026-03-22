#!/usr/bin/env node

import assert from 'assert'

const wallet = process.env.MARKETPLACE_TEST_WALLET || '0:dce21276027c17f76577b690c155aac660960c944b79665be382d611f5970b21'
const base = process.env.MARKETPLACE_API_BASE || 'http://localhost:3001/api'
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
  return data
}

async function ensureWalletAgent(walletAddress) {
  const owned = await request(`/engine/agents/by-wallet/${encodeURIComponent(walletAddress)}`)
  const existing = owned?.data?.agent
  if (existing?.id) return existing

  const created = await request('/engine/agents', {
    method: 'POST',
    payload: {
      name: 'Marketplace Smoke Agent',
      strategy: 'vwap',
      isUserAgent: true,
      walletAddress,
      virtualBalance: 1000,
      riskLevel: 'medium',
      bio: 'Auto-created for marketplace smoke verification',
    },
  })

  return created?.data || created
}

async function main() {
  console.log('🧪 Marketplace install/switch smoke test')
  console.log(`Wallet: ${wallet}`)
  console.log(`API: ${base}`)

  const challenge = await request('/auth/challenge', {
    method: 'POST',
    payload: { address: wallet },
  })
  const nonce = challenge?.data?.nonce
  assert.ok(nonce, 'Auth challenge nonce missing')

  await request('/auth', {
    method: 'POST',
    payload: { address: wallet, nonce },
  })

  const agent = await ensureWalletAgent(wallet)
  assert.ok(agent?.id, 'No wallet-bound engine agent found')

  const market = await request('/strategies/marketplace?limit=20&sort=ranking')
  const listings = market?.data || market
  assert.ok(Array.isArray(listings) && listings.length > 0, 'Marketplace listings are empty')
  const seededListings = listings.filter((item) => (item?.template?.ownerUserAddress || item?.authorUserAddress || '') === 'system:marketplace')
  assert.ok(seededListings.length > 0, 'Seeded marketplace listings are empty')

  const before = {
    strategy: agent.strategy,
    strategySource: agent.strategySource,
    activeStrategyTemplateId: agent.activeStrategyTemplateId,
    activeStrategyMode: agent.activeStrategyMode,
    executionOwner: agent.executionOwner,
    subscriptionOwner: agent.subscriptionOwner,
  }

  const targetListing = seededListings.find((item) => item.strategyTemplateId !== before.activeStrategyTemplateId) || seededListings[0]
  assert.ok(targetListing?.strategyTemplateId, 'No target strategy template found for switch test')

  const install = await request('/strategies/install', {
    method: 'POST',
    payload: {
      agentId: agent.id,
      templateId: targetListing.strategyTemplateId,
    },
  })

  const afterResponse = await request(`/engine/agents/${encodeURIComponent(agent.id)}`)
  const after = afterResponse?.data || {}

  const summary = {
    selectedInstallTemplate: targetListing.strategyTemplateId,
    selectedInstallName: targetListing?.template?.name,
    before,
    installResponse: {
      instanceId: install?.data?.instance?.id,
      instanceMode: install?.data?.instance?.mode,
      templateId: install?.data?.template?.id,
      versionId: install?.data?.version?.id,
      agentActiveTemplate: install?.data?.agent?.activeStrategyTemplateId,
      strategySource: install?.data?.agent?.strategySource,
    },
    after: {
      strategy: after.strategy,
      strategySource: after.strategySource,
      activeStrategyTemplateId: after.activeStrategyTemplateId,
      activeStrategyMode: after.activeStrategyMode,
      executionOwner: after.executionOwner,
      subscriptionOwner: after.subscriptionOwner,
      activeStrategyInstanceId: after.activeStrategyInstanceId,
    },
    changedTemplate: before.activeStrategyTemplateId !== after.activeStrategyTemplateId,
  }

  assert.ok(summary.installResponse.instanceId, 'Install response did not return a strategy instance id')
  assert.equal(summary.installResponse.instanceMode, 'direct', 'Installed strategy instance mode must be direct')
  assert.equal(after.strategySource, 'marketplace_seed', 'Agent strategySource should be marketplace_seed after seeded marketplace install')
  assert.equal(after.activeStrategyMode, 'direct', 'Agent activeStrategyMode should be direct after install')
  assert.ok(after.activeStrategyInstanceId, 'Agent activeStrategyInstanceId should be set after install')
  assert.ok(summary.changedTemplate, 'Active strategy template id did not change after install')
  assert.equal(after.activeStrategyTemplateId, targetListing.strategyTemplateId, 'Agent activeStrategyTemplateId mismatch after install')

  console.log(JSON.stringify(summary, null, 2))
  console.log('✅ Marketplace install/switch smoke test passed')
}

main().catch((error) => {
  console.error('❌ Marketplace install/switch smoke test failed')
  console.error(error.message)
  process.exit(1)
})
