#!/usr/bin/env node

import assert from 'assert'
import { randomUUID } from 'crypto'

const ownerWallet = process.env.SHARED_SCOPE_OWNER_WALLET || '0:dce21276027c17f76577b690c155aac660960c944b79665be382d611f5970b21'
const followerWallet = process.env.SHARED_SCOPE_FOLLOWER_WALLET || '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const base = process.env.MARKETPLACE_API_BASE || 'http://localhost:3001/api'
const pollTimeoutMs = Number(process.env.SHARED_SCOPE_POLL_TIMEOUT_MS || 30000)
const pollIntervalMs = Number(process.env.SHARED_SCOPE_POLL_INTERVAL_MS || 2000)

class ApiClient {
  constructor(wallet) {
    this.wallet = wallet
    this.jar = []
  }

  updateCookieJar(response) {
    const raw = response.headers.get('set-cookie')
    if (!raw) return
    const cookie = raw.split(';')[0]
    if (!this.jar.includes(cookie)) this.jar.push(cookie)
  }

  async request(path, { method = 'GET', payload, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.jar.length ? { cookie: this.jar.join('; ') } : {}),
        ...headers,
      },
      body: payload ? JSON.stringify(payload) : undefined,
    })

    this.updateCookieJar(response)

    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${JSON.stringify(data)}`)
    }
    return data?.data ?? data
  }

  async auth() {
    const challenge = await this.request('/auth/challenge', {
      method: 'POST',
      payload: { address: this.wallet },
    })
    assert.ok(challenge?.nonce, `Auth challenge nonce missing for ${this.wallet}`)
    await this.request('/auth', {
      method: 'POST',
      payload: { address: this.wallet, nonce: challenge.nonce },
    })
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureWalletAgent(client, { name, strategy, virtualBalance }) {
  const owned = await client.request(`/engine/agents/by-wallet/${encodeURIComponent(client.wallet)}`)
  if (owned?.agent?.id) return owned.agent

  return client.request('/engine/agents', {
    method: 'POST',
    payload: {
      name,
      strategy,
      isUserAgent: true,
      walletAddress: client.wallet,
      virtualBalance,
      riskLevel: 'medium',
      bio: 'Auto-created for shared LLM scope smoke verification',
    },
  })
}

function buildDefinition() {
  return {
    kind: 'llm_shared_scope_smoke',
    summary: 'Smoke template for shared LLM scope verification',
    fallback: {
      action: 'hold',
      reasoning: 'Shared LLM scope smoke template waiting for runtime context.',
    },
  }
}

async function waitForScopeSync({ ownerClient, followerClient, ownerAgentId, followerAgentId, expectedIndexId, expectedTemplateId = null, expectedMaxActiveChannels = null }) {
  const deadline = Date.now() + pollTimeoutMs
  let lastOwner = null
  let lastFollower = null

  while (Date.now() < deadline) {
    lastOwner = await ownerClient.request(`/engine/agents/${encodeURIComponent(ownerAgentId)}`)
    lastFollower = await followerClient.request(`/engine/agents/${encodeURIComponent(followerAgentId)}`)

    const ownerPlan = lastOwner.llmSharedPlanIndexIds || lastOwner.llmSharedMirroredIndexIds || []
    const followerPlan = lastFollower.llmSharedPlanIndexIds || lastFollower.llmSharedMirroredIndexIds || []
    const followerSubs = (lastFollower.indexSubscriptions || []).filter((sub) => sub?.status === 'active').map((sub) => sub.indexId)

    const sameScope = Boolean(lastOwner.llmSharedScopeId) && lastOwner.llmSharedScopeId === lastFollower.llmSharedScopeId
    const expectedTemplate = expectedTemplateId
      ? lastOwner.activeStrategyTemplateId === expectedTemplateId && lastFollower.activeStrategyTemplateId === expectedTemplateId
      : true
    const hasPlan = ownerPlan.length > 0 && followerPlan.length > 0
    const samePlan = JSON.stringify(ownerPlan) === JSON.stringify(followerPlan)
    const planSized = expectedMaxActiveChannels == null
      ? true
      : ownerPlan.length <= expectedMaxActiveChannels && followerPlan.length <= expectedMaxActiveChannels
    const restored = expectedIndexId ? followerSubs.includes(expectedIndexId) : true
    const llmScopeOwnership = lastOwner.subscriptionOwner === 'llm_scope' && lastFollower.subscriptionOwner === 'llm_scope'

    if (sameScope && expectedTemplate && hasPlan && samePlan && planSized && restored && llmScopeOwnership) {
      return { owner: lastOwner, follower: lastFollower }
    }

    await sleep(pollIntervalMs)
  }

  return { owner: lastOwner, follower: lastFollower, timeout: true }
}

async function main() {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`
  const slug = `shared-llm-scope-${suffix}`
  const strategyName = `Shared Scope ${suffix.slice(-6)}`

  const ownerClient = new ApiClient(ownerWallet)
  const followerClient = new ApiClient(followerWallet)
  await ownerClient.auth()
  await followerClient.auth()

  const ownerAgent = await ensureWalletAgent(ownerClient, {
    name: `Scope Owner ${suffix.slice(-4)}`,
    strategy: 'vwap',
    virtualBalance: 1100,
  })
  const followerAgent = await ensureWalletAgent(followerClient, {
    name: `Scope Follower ${suffix.slice(-4)}`,
    strategy: 'mean_reversion',
    virtualBalance: 2300,
  })

  assert.ok(ownerAgent?.id, 'Owner agent missing')
  assert.ok(followerAgent?.id, 'Follower agent missing')

  await ownerClient.request(`/engine/agents/${encodeURIComponent(ownerAgent.id)}`, {
    method: 'PATCH',
    payload: {
      config: {
        llmProvider: 'openrouter',
        llmModel: 'gpt-4o-mini',
      },
    },
  })

  const template = await ownerClient.request('/strategies/templates', {
    method: 'POST',
    payload: {
      slug,
      name: strategyName,
      shortDescription: 'Smoke test for strategy-owned shared LLM scope',
      category: 'llm',
      type: 'llm',
      visibility: 'public',
      complexityScore: 22,
      explainabilityScore: 78,
    },
  })
  assert.ok(template?.id, 'Template creation failed')

  const version = await ownerClient.request(`/strategies/templates/${encodeURIComponent(template.id)}/versions`, {
    method: 'POST',
    payload: {
      changelog: 'Initial shared scope smoke version',
      definition: buildDefinition(),
      parameterSchema: {
        defaults: {
          confidence: 0.72,
        },
      },
      triggerSchema: {
        wizardPersona: 'llm_operator',
      },
      requiredChannels: [],
      runtimeRequirements: {
        sharedCreatorExecution: true,
        inheritsCreatorMemory: true,
        inheritsCreatorLearning: true,
        sharedSignals: true,
      },
      riskDefaults: {
        maxDailyTrades: 6,
      },
      rotationDefaults: {
        goalMode: 'balanced',
        intervalTicks: 10,
        maxActiveChannels: 1,
        minChannelLifetimeTicks: 5,
        maxCandidateChannels: 12,
      },
    },
  })
  assert.ok(version?.id, 'Version creation failed')

  await ownerClient.request(`/strategies/templates/${encodeURIComponent(template.id)}/publish`, {
    method: 'POST',
    payload: {
      currentVersionId: version.id,
      priceMode: 'free',
      rankingScore: 91,
    },
  })

  const ownerInstall = await ownerClient.request('/strategies/install', {
    method: 'POST',
    payload: {
      agentId: ownerAgent.id,
      templateId: template.id,
      versionId: version.id,
      customParams: { confidence: 0.75 },
    },
  })
  const followerInstall = await followerClient.request('/strategies/install', {
    method: 'POST',
    payload: {
      agentId: followerAgent.id,
      templateId: template.id,
      versionId: version.id,
      customParams: { confidence: 0.61 },
    },
  })

  assert.ok(ownerInstall?.instance?.id, 'Owner install did not return instance id')
  assert.ok(followerInstall?.instance?.id, 'Follower install did not return instance id')

  const initialSync = await waitForScopeSync({
    ownerClient,
    followerClient,
    ownerAgentId: ownerAgent.id,
    followerAgentId: followerAgent.id,
    expectedTemplateId: template.id,
    expectedMaxActiveChannels: 1,
  })
  assert.ok(!initialSync.timeout, 'Shared scope did not converge after install')

  const initialPlan = initialSync.owner.llmSharedPlanIndexIds || initialSync.owner.llmSharedMirroredIndexIds || []
  assert.ok(initialPlan.length > 0, 'Shared scope plan is empty')
  assert.ok(initialPlan.length <= 1, `Expected shared scope to respect maxActiveChannels=1, got ${initialPlan.length}`)

  const driftIndexId = initialPlan[0]
  let lockError = null
  try {
    await followerClient.request(`/indexes/${encodeURIComponent(driftIndexId)}/subscribe/${encodeURIComponent(followerAgent.id)}`, {
      method: 'DELETE',
    })
  } catch (error) {
    lockError = error
  }
  assert.ok(lockError, 'Manual drift should be rejected for shared LLM scope agents')
  assert.ok(/shared LLM scope/i.test(lockError.message), `Expected shared LLM scope lock error, got: ${lockError.message}`)

  const ownerFinal = await ownerClient.request(`/engine/agents/${encodeURIComponent(ownerAgent.id)}`)
  const followerFinal = await followerClient.request(`/engine/agents/${encodeURIComponent(followerAgent.id)}`)
  const ownerPlan = ownerFinal.llmSharedPlanIndexIds || ownerFinal.llmSharedMirroredIndexIds || []
  const followerPlan = followerFinal.llmSharedPlanIndexIds || followerFinal.llmSharedMirroredIndexIds || []
  const followerFinalSubs = (followerFinal.indexSubscriptions || []).filter((sub) => sub?.status === 'active').map((sub) => sub.indexId)

  assert.equal(ownerFinal.executionOwner, 'llm', 'Owner executionOwner should be llm')
  assert.equal(followerFinal.executionOwner, 'llm', 'Follower executionOwner should be llm')
  assert.equal(ownerFinal.subscriptionOwner, 'llm_scope', 'Owner subscriptionOwner should be llm_scope')
  assert.equal(followerFinal.subscriptionOwner, 'llm_scope', 'Follower subscriptionOwner should be llm_scope')
  assert.ok(ownerFinal.llmSharedScopeId, 'Owner scope id missing')
  assert.equal(ownerFinal.llmSharedScopeId, followerFinal.llmSharedScopeId, 'Agents must share the same persisted scope id')
  assert.deepEqual(ownerPlan, followerPlan, 'Owner/follower shared plan must match')
  assert.ok(followerFinalSubs.includes(driftIndexId), 'Follower shared LLM subscription is missing after lock check')
  assert.notEqual(ownerFinal.virtualBalance, followerFinal.virtualBalance, 'Balances should remain isolated per agent')

  const summary = {
    template: {
      id: template.id,
      slug: template.slug,
      name: template.name,
    },
    scope: {
      id: ownerFinal.llmSharedScopeId,
      key: ownerFinal.llmSharedScopeKey,
      controllerAgentId: ownerFinal.llmSharedControllerAgentId || ownerFinal.llmSharedLeaderAgentId,
      controllerAgentName: ownerFinal.llmSharedControllerAgentName || ownerFinal.llmSharedLeaderAgentName,
      memberCount: ownerFinal.llmSharedScopeMemberCount || 0,
      planIndexIds: ownerPlan,
    },
    owner: {
      id: ownerFinal.id,
      walletAddress: ownerFinal.walletAddress,
      virtualBalance: ownerFinal.virtualBalance,
      subscriptionOwner: ownerFinal.subscriptionOwner,
      executionOwner: ownerFinal.executionOwner,
      indexSubscriptions: (ownerFinal.indexSubscriptions || []).filter((sub) => sub?.status === 'active').map((sub) => sub.indexId),
    },
    follower: {
      id: followerFinal.id,
      walletAddress: followerFinal.walletAddress,
      virtualBalance: followerFinal.virtualBalance,
      subscriptionOwner: followerFinal.subscriptionOwner,
      executionOwner: followerFinal.executionOwner,
      lockedIndexId: driftIndexId,
      indexSubscriptions: followerFinalSubs,
      blockedIndexIds: followerFinal.llmSharedBlockedIndexIds || [],
    },
  }

  console.log(JSON.stringify(summary, null, 2))
  console.log('✅ Shared LLM scope smoke test passed')
}

main().catch((error) => {
  console.error('❌ Shared LLM scope smoke test failed')
  console.error(error.message)
  process.exit(1)
})
