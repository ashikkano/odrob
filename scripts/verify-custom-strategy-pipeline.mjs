#!/usr/bin/env node

import assert from 'assert'
import { randomUUID } from 'crypto'

const wallet = process.env.MARKETPLACE_TEST_WALLET || '0:dce21276027c17f76577b690c155aac660960c944b79665be382d611f5970b21'
const base = process.env.MARKETPLACE_API_BASE || 'http://localhost:3001/api'
const traceWaitMs = Number(process.env.CUSTOM_STRATEGY_TRACE_WAIT_MS || 30000)
const tracePollIntervalMs = Number(process.env.CUSTOM_STRATEGY_TRACE_POLL_MS || 2000)
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
  const ownedResponse = await request(`/engine/agents/by-wallet/${encodeURIComponent(walletAddress)}`)
  const existing = ownedResponse?.data?.agent
  if (existing?.id) return existing

  const createdResponse = await request('/engine/agents', {
    method: 'POST',
    payload: {
      name: 'Custom Pipeline Smoke Agent',
      strategy: 'vwap',
      isUserAgent: true,
      walletAddress,
      virtualBalance: 1000,
      riskLevel: 'medium',
      bio: 'Auto-created for custom strategy smoke verification',
    },
  })

  return createdResponse?.data || createdResponse
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollForExecutions(agentId, strategyInstanceId) {
  const startedAt = Date.now()
  while ((Date.now() - startedAt) < traceWaitMs) {
    const executionsResponse = await request(`/strategies/agents/${encodeURIComponent(agentId)}/executions?limit=10&strategyInstanceId=${encodeURIComponent(strategyInstanceId)}`)
    const executions = executionsResponse?.data || executionsResponse || []
    if (Array.isArray(executions) && executions.length > 0) return executions
    await sleep(tracePollIntervalMs)
  }
  return []
}

function buildDefinition() {
  return {
    kind: 'rule_v1',
    rules: [
      {
        id: 'always-hold',
        name: 'Always Hold',
        enabled: true,
        then: {
          action: 'hold',
          confidence: 0.92,
          reasoning: 'Smoke test fallback-free direct execution event',
        },
      },
    ],
    fallback: {
      action: 'hold',
      confidence: 0.51,
      reasoning: 'Smoke test fallback',
    },
  }
}

function buildParameterSchema() {
  return {
    fields: [
      {
        key: 'confidenceBias',
        label: 'Confidence Bias',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.92,
      },
    ],
    defaults: {
      confidenceBias: 0.92,
    },
  }
}

async function main() {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const slug = `smoke-custom-${suffix}`
  const strategyName = `Smoke Custom ${suffix.slice(-8)}`

  console.log('🧪 Custom strategy pipeline smoke test')
  console.log(`Wallet: ${wallet}`)
  console.log(`API: ${base}`)
  console.log(`Slug: ${slug}`)

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
  assert.ok(Array.isArray(agent.indexSubscriptions) && agent.indexSubscriptions.length > 0, 'Wallet agent has no index subscriptions; cannot verify strategy executions')

  const templateResponse = await request('/strategies/templates', {
    method: 'POST',
    payload: {
      slug,
      name: strategyName,
      shortDescription: 'Automated smoke test custom strategy pipeline',
      category: 'automation',
      type: 'custom',
      visibility: 'public',
      complexityScore: 24,
      explainabilityScore: 88,
    },
  })
  const template = templateResponse?.data || templateResponse
  assert.ok(template?.id, 'Template creation did not return an id')

  const versionResponse = await request(`/strategies/templates/${encodeURIComponent(template.id)}/versions`, {
    method: 'POST',
    payload: {
      changelog: 'Initial smoke-test version',
      definition: buildDefinition(),
      parameterSchema: buildParameterSchema(),
      triggerSchema: {
        wizardPersona: 'smoke-test',
        importantSignals: ['oracleChangePct', 'spreadPct'],
      },
      requiredChannels: [
        {
          channelType: 'topic',
          sourceRef: 'smoke-test',
          name: 'Smoke Test Topic',
          description: 'Synthetic topic channel for smoke verification',
          subscriptionKind: 'signal',
          weight: 1,
          priority: 0,
          lockMode: 'managed',
        },
      ],
      runtimeRequirements: {
        engine: 'custom_strategy_runtime',
        executionMode: 'direct',
      },
      riskDefaults: {
        maxPositionPct: 12,
        stopLossPct: 3,
        maxDailyTrades: 6,
        maxPositionAgeMs: 3600000,
      },
      rotationDefaults: {
        goalMode: 'balanced',
        intervalTicks: 20,
        maxActiveChannels: 2,
        minChannelLifetimeTicks: 10,
        churnBudgetPerDay: 4,
        maxCandidateChannels: 8,
        scoreWeights: {
          volume: 1,
          trades: 1,
        },
        filters: {},
      },
    },
  })
  const version = versionResponse?.data || versionResponse
  assert.ok(version?.id, 'Version creation did not return an id')

  const publishResponse = await request(`/strategies/templates/${encodeURIComponent(template.id)}/publish`, {
    method: 'POST',
    payload: {
      currentVersionId: version.id,
      priceMode: 'free',
      rankingScore: 68,
      verifiedBadge: false,
    },
  })
  const listing = publishResponse?.data || publishResponse
  assert.equal(listing?.strategyTemplateId, template.id, 'Published listing template id mismatch')
  assert.equal(listing?.currentVersionId, version.id, 'Published listing version id mismatch')

  const publishedTemplateResponse = await request(`/strategies/templates/${encodeURIComponent(template.id)}`)
  const publishedTemplate = publishedTemplateResponse?.data || publishedTemplateResponse
  assert.equal(publishedTemplate?.status, 'published', 'Published template status should be published')
  assert.equal(publishedTemplate?.visibility, 'public', 'Published template visibility should be public')

  const installResponse = await request('/strategies/install', {
    method: 'POST',
    payload: {
      agentId: agent.id,
      templateId: template.id,
      versionId: version.id,
      customParams: {
        confidenceBias: 0.97,
      },
      customRisk: {
        maxDailyTrades: 5,
      },
      customRotation: {
        intervalTicks: 18,
      },
      channelSubscriptions: [
        {
          channelType: 'topic',
          sourceRef: 'smoke-test',
          name: 'Smoke Test Topic',
          description: 'Synthetic topic channel for install verification',
          subscriptionKind: 'signal',
          weight: 1,
          priority: 1,
          lockMode: 'managed',
          metadata: {
            source: 'verify-custom-strategy-pipeline',
          },
        },
      ],
      rotationPolicy: {
        enabled: true,
        goalMode: 'balanced',
        profileName: 'smoke-balanced',
        intervalTicks: 18,
        maxActiveChannels: 2,
        minChannelLifetimeTicks: 10,
        churnBudgetPerDay: 4,
        maxCandidateChannels: 8,
        scoreWeights: {
          volume: 1,
          trades: 1,
        },
        filters: {},
      },
    },
  })

  const installedInstance = installResponse?.data?.instance
  assert.ok(installedInstance?.id, 'Install response did not return an instance id')
  assert.equal(installedInstance?.strategyTemplateId, template.id, 'Installed instance template id mismatch')
  assert.equal(installedInstance?.strategyVersionId, version.id, 'Installed instance version id mismatch')

  const instancesResponse = await request(`/strategies/agents/${encodeURIComponent(agent.id)}/instances`)
  const instances = instancesResponse?.data || instancesResponse || []
  const instance = instances.find((item) => item.id === installedInstance.id)
  assert.ok(instance, 'Installed instance not returned by instances endpoint')

  const agentAfterResponse = await request(`/engine/agents/${encodeURIComponent(agent.id)}`)
  const agentAfter = agentAfterResponse?.data || {}
  assert.equal(agentAfter.activeStrategyInstanceId, installedInstance.id, 'Agent activeStrategyInstanceId mismatch')
  assert.equal(agentAfter.activeStrategyTemplateId, template.id, 'Agent activeStrategyTemplateId mismatch')
  assert.equal(agentAfter.activeStrategyMode, 'direct', 'Agent activeStrategyMode should be direct after install')
  assert.equal(agentAfter.strategySource, 'custom_public', 'Published custom strategy should install with custom_public source semantics')

  const executions = await pollForExecutions(agent.id, installedInstance.id)
  assert.ok(executions.length > 0, `No executions observed for installed instance within ${traceWaitMs}ms`)
  const latestExecution = executions[0]
  assert.equal(latestExecution.strategyInstanceId, installedInstance.id, 'Execution trace instance id mismatch')
  assert.equal(latestExecution.strategyTemplateId, template.id, 'Execution trace template id mismatch')
  assert.equal(latestExecution.strategyVersionId, version.id, 'Execution trace version id mismatch')

  const summary = {
    createdTemplate: {
      id: publishedTemplate.id,
      slug: publishedTemplate.slug,
      visibility: publishedTemplate.visibility,
      status: publishedTemplate.status,
    },
    createdVersion: {
      id: version.id,
      versionNumber: version.versionNumber,
    },
    publishedListing: {
      id: listing.id,
      strategyTemplateId: listing.strategyTemplateId,
      currentVersionId: listing.currentVersionId,
    },
    install: {
      agentId: agent.id,
      instanceId: installedInstance.id,
      strategySource: agentAfter.strategySource,
      activeStrategyMode: agentAfter.activeStrategyMode,
    },
    traces: {
      observedCount: executions.length,
      latestOutcome: latestExecution.outcome,
      latestSignalCount: latestExecution.signalCount,
      latestIndexId: latestExecution.indexId,
    },
  }

  console.log(JSON.stringify(summary, null, 2))
  console.log('✅ Custom strategy pipeline smoke test passed')
}

main().catch((error) => {
  console.error('❌ Custom strategy pipeline smoke test failed')
  console.error(error.message)
  process.exit(1)
})
