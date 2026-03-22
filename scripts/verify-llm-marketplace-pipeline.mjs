#!/usr/bin/env node

import assert from 'assert'
import { randomUUID } from 'crypto'

const wallet = process.env.MARKETPLACE_TEST_WALLET || '0:dce21276027c17f76577b690c155aac660960c944b79665be382d611f5970b21'
const base = process.env.MARKETPLACE_API_BASE || 'http://localhost:3001/api'
const decisionWaitMs = Number(process.env.LLM_STRATEGY_DECISION_WAIT_MS || 45000)
const decisionPollIntervalMs = Number(process.env.LLM_STRATEGY_DECISION_POLL_MS || 2500)
const jar = []

function updateCookieJar(response) {
  const raw = response.headers.get('set-cookie')
  if (!raw) return
  const cookie = raw.split(';')[0]
  if (!jar.includes(cookie)) jar.push(cookie)
}

async function request(path, { method = 'GET', payload, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jar.length ? { cookie: jar.join('; ') } : {}),
      ...headers,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureWalletAgent(walletAddress) {
  const ownedResponse = await request(`/engine/agents/by-wallet/${encodeURIComponent(walletAddress)}`)
  const existing = ownedResponse?.data?.agent
  if (existing?.id) return existing

  const createdResponse = await request('/engine/agents', {
    method: 'POST',
    payload: {
      name: 'LLM Marketplace Smoke Agent',
      strategy: 'vwap',
      isUserAgent: true,
      walletAddress,
      virtualBalance: 1000,
      riskLevel: 'medium',
      bio: 'Auto-created for LLM marketplace smoke verification',
    },
  })

  return createdResponse?.data || createdResponse
}

function buildRequiredChannels() {
  return [
    {
      channelType: 'index',
      name: 'Index oracle',
      description: 'Base market context for oracle price and spread.',
      subscriptionKind: 'trading',
    },
    {
      channelType: 'feed',
      name: 'Index feed',
      description: 'Catalyst feed for severity-aware LLM context.',
      subscriptionKind: 'signal',
    },
    {
      channelType: 'strategy_signal',
      name: 'Order-book depth',
      description: 'Execution quality signal for spread and depth imbalance.',
      subscriptionKind: 'signal',
    },
  ]
}

function buildRuntimeRequirements(requiredChannels) {
  const channelTypes = new Set(requiredChannels.map((channel) => channel.channelType))
  return {
    marketContext: channelTypes.has('index') || channelTypes.size === 0,
    orderbook: channelTypes.has('strategy_signal') || channelTypes.has('index'),
    feed: channelTypes.has('feed') || channelTypes.has('creator'),
  }
}

function buildDefinition() {
  return {
    kind: 'rule_v1',
    summary: 'LLM-ready operator that waits for aligned market, feed, and execution-quality signals.',
    rules: [
      {
        id: 'llm-conviction-buy',
        when: {
          all: [
            { source: '$market.oracleChangePct', op: 'gte', value: '$params.entryThreshold' },
            { source: '$market.spreadPct', op: 'lte', value: '$params.maxSpreadPct' },
            { source: '$feed.severityCounts.high', op: 'gte', value: '$params.highSeverityCount' },
          ],
        },
        then: {
          action: 'buy',
          orderType: 'limit',
          priceSource: 'bestAsk',
          priceOffsetPct: 0.05,
          sizePct: '$params.buySizePct',
          confidence: '$params.confidence',
          reasoning: 'Context, catalyst, and execution quality align strongly enough for an LLM-style conviction entry.',
        },
      },
      {
        id: 'llm-risk-off-sell',
        when: {
          any: [
            {
              all: [
                { source: '$agent.position', op: 'truthy' },
                { source: '$market.oracleChangePct', op: 'lte', value: '$params.exitThreshold' },
              ],
            },
            {
              all: [
                { source: '$agent.position', op: 'truthy' },
                { source: '$orderbook.askDepth', op: 'gt', value: '$orderbook.bidDepth' },
              ],
            },
          ],
        },
        then: {
          action: 'sell',
          orderType: 'limit',
          priceSource: 'bestBid',
          sizePct: '$params.sellSizePct',
          confidence: '$params.confidence',
          reasoning: 'Risk-off exit when market context weakens or execution quality deteriorates.',
        },
      },
    ],
    fallback: { action: 'hold', reasoning: 'LLM-style signal stack is not aligned yet.' },
  }
}

function buildParameterSchema() {
  return {
    defaults: {
      entryThreshold: 0.85,
      exitThreshold: -0.55,
      maxSpreadPct: 1.6,
      buySizePct: 18,
      sellSizePct: 100,
      confidence: 0.8,
      minVolume: 0,
      highSeverityCount: 1,
    },
    fields: [
      { key: 'entryThreshold', label: 'LLM conviction trigger (%)', type: 'number', min: 0.05, max: 6, step: 0.05 },
      { key: 'exitThreshold', label: 'Risk-off trigger (%)', type: 'number', min: -6, max: 0, step: 0.05 },
      { key: 'maxSpreadPct', label: 'Макс. спред (%)', type: 'number', min: 0.1, max: 5, step: 0.05 },
      { key: 'buySizePct', label: 'Размер входа (%)', type: 'number', min: 1, max: 100, step: 1 },
      { key: 'confidence', label: 'Уверенность сигнала', type: 'number', min: 0.2, max: 1, step: 0.01 },
    ],
  }
}

function buildRiskDefaults() {
  return {
    maxPositionPct: 20,
    stopLossPct: 4.2,
    maxDailyTrades: 9,
    maxPositionAgeMs: 30 * 60 * 1000,
  }
}

function buildRotationDefaults() {
  return {
    goalMode: 'balanced',
    intervalTicks: 24,
    maxActiveChannels: 3,
    minChannelLifetimeTicks: 20,
    churnBudgetPerDay: 6,
    maxCandidateChannels: 12,
    scoreWeights: {
      volume: 0,
      trades: 0,
      holders: 0,
      oracleMove: 0,
      bandWidth: 0,
    },
    filters: {},
  }
}

async function pollForLlmRuntimeEvidence(agentId, startedAt) {
  const deadline = Date.now() + decisionWaitMs
  let lastEngineSnapshot = null
  let lastLlmDecisions = []

  while (Date.now() < deadline) {
    const [agentResponse, llmResponse, decisionResponse] = await Promise.all([
      request(`/engine/agents/${encodeURIComponent(agentId)}`),
      request(`/llm/agents/${encodeURIComponent(agentId)}/decisions?limit=10`),
      request(`/engine/agents/${encodeURIComponent(agentId)}/decisions?limit=10`),
    ])

    const agent = agentResponse?.data || agentResponse || {}
    const llmDecisions = llmResponse?.data || llmResponse || []
    const engineDecisions = decisionResponse?.data || decisionResponse || []

    lastEngineSnapshot = agent
    lastLlmDecisions = llmDecisions

    const idleReason = String(agent?.lastIdleReason || '')
    const lastIdleAt = Number(agent?.lastIdleAt || 0)
    if (lastIdleAt >= startedAt && /LLM /i.test(idleReason)) {
      return {
        kind: 'agent_idle_reason',
        agent,
        idleReason,
        lastIdleAt,
      }
    }

    const freshLlmDecision = llmDecisions.find((item) => Number(item?.timestamp || 0) >= startedAt)
    if (freshLlmDecision) {
      return {
        kind: 'llm_memory',
        agent,
        llmDecision: freshLlmDecision,
      }
    }

    const freshEngineDecision = engineDecisions.find((item) => Number(item?.timestamp || 0) >= startedAt)
    if (freshEngineDecision && /LLM /i.test(String(freshEngineDecision.reasoning || ''))) {
      return {
        kind: 'engine_reasoning',
        agent,
        engineDecision: freshEngineDecision,
      }
    }

    await sleep(decisionPollIntervalMs)
  }

  return {
    kind: 'timeout',
    agent: lastEngineSnapshot,
    llmDecisions: lastLlmDecisions,
  }
}

async function main() {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const slug = `smoke-llm-${suffix}`
  const strategyName = `Smoke LLM ${suffix.slice(-8)}`
  const requiredChannels = buildRequiredChannels()
  const runtimeRequirements = buildRuntimeRequirements(requiredChannels)

  console.log('🧪 LLM marketplace pipeline smoke test')
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
  assert.ok(Array.isArray(agent.indexSubscriptions) && agent.indexSubscriptions.length > 0, 'Wallet agent has no index subscriptions; cannot verify live LLM runtime')

  await request(`/engine/agents/${encodeURIComponent(agent.id)}`, {
    method: 'PATCH',
    payload: {
      config: {
        llmProvider: 'openrouter',
        llmModel: 'gpt-4o-mini',
      },
    },
    headers: {
      'X-Wallet-Address': wallet,
    },
  })

  const templateResponse = await request('/strategies/templates', {
    method: 'POST',
    payload: {
      slug,
      name: strategyName,
      shortDescription: 'Automated smoke test for live LLM marketplace pipeline',
      category: 'llm',
      type: 'llm',
      visibility: 'public',
      complexityScore: 36,
      explainabilityScore: 74,
    },
  })
  const template = templateResponse?.data || templateResponse
  assert.ok(template?.id, 'Template creation did not return an id')
  assert.equal(template?.type, 'llm', 'Template type should be llm')

  const versionResponse = await request(`/strategies/templates/${encodeURIComponent(template.id)}/versions`, {
    method: 'POST',
    payload: {
      changelog: 'Initial smoke-test LLM version',
      definition: buildDefinition(),
      parameterSchema: buildParameterSchema(),
      triggerSchema: {
        wizardPersona: 'llm_operator',
        importantSignals: ['oracleChangePct', 'spreadPct', 'volatility', 'feedSeverity', 'depthImbalance'],
      },
      requiredChannels,
      runtimeRequirements,
      riskDefaults: buildRiskDefaults(),
      rotationDefaults: buildRotationDefaults(),
    },
  })
  const version = versionResponse?.data || versionResponse
  assert.ok(version?.id, 'Version creation did not return an id')

  const publishResponse = await request(`/strategies/templates/${encodeURIComponent(template.id)}/publish`, {
    method: 'POST',
    payload: {
      currentVersionId: version.id,
      priceMode: 'free',
      rankingScore: 73,
      verifiedBadge: false,
    },
  })
  const listing = publishResponse?.data || publishResponse
  assert.equal(listing?.strategyTemplateId, template.id, 'Published listing template id mismatch')
  assert.equal(listing?.currentVersionId, version.id, 'Published listing version id mismatch')

  const templateDetailResponse = await request(`/strategies/templates/${encodeURIComponent(template.id)}`)
  const templateDetail = templateDetailResponse?.data || templateDetailResponse
  assert.equal(templateDetail?.status, 'published', 'Published template status should be published')
  assert.equal(templateDetail?.visibility, 'public', 'Published template visibility should be public')
  assert.equal(templateDetail?.type, 'llm', 'Published template type should remain llm')
  assert.equal(templateDetail?.category, 'llm', 'Published template category should remain llm')

  const marketplaceResponse = await request('/strategies/marketplace?limit=100&sort=newest')
  const marketplace = marketplaceResponse?.data || marketplaceResponse || []
  const createdListing = marketplace.find((item) => item?.strategyTemplateId === template.id)
  assert.ok(createdListing, 'Created LLM listing not found in marketplace feed')
  assert.equal(createdListing?.template?.type, 'llm', 'Marketplace listing template type should be llm')
  assert.equal(createdListing?.template?.category, 'llm', 'Marketplace listing template category should be llm')

  const runtimeStartedAt = Date.now()
  const installResponse = await request('/strategies/install', {
    method: 'POST',
    payload: {
      agentId: agent.id,
      templateId: template.id,
      versionId: version.id,
      customParams: {
        entryThreshold: 0.8,
        exitThreshold: -0.5,
        maxSpreadPct: 1.5,
        buySizePct: 16,
        sellSizePct: 100,
        confidence: 0.77,
        highSeverityCount: 1,
      },
      customRisk: {
        maxDailyTrades: 7,
      },
      customRotation: {
        intervalTicks: 20,
      },
      channelSubscriptions: requiredChannels,
      rotationPolicy: {
        enabled: true,
        ...buildRotationDefaults(),
      },
    },
  })

  const installedInstance = installResponse?.data?.instance
  const installedAgent = installResponse?.data?.agent || {}
  assert.ok(installedInstance?.id, 'Install response did not return an instance id')
  assert.equal(installedInstance?.strategyTemplateId, template.id, 'Installed instance template id mismatch')
  assert.equal(installedInstance?.strategyVersionId, version.id, 'Installed instance version id mismatch')
  assert.equal(installedAgent?.activeStrategyMode, 'direct', 'Installed agent activeStrategyMode should be direct')
  assert.equal(installedAgent?.strategySource, 'custom_public', 'LLM marketplace install should use custom_public source semantics')
  assert.equal(installedAgent?.executionOwner, 'llm', 'Installed LLM template should hand execution to llm runtime')

  await request(`/engine/agents/${encodeURIComponent(agent.id)}/start`, {
    method: 'POST',
    headers: {
      'X-Wallet-Address': wallet,
    },
  })

  const instancesResponse = await request(`/strategies/agents/${encodeURIComponent(agent.id)}/instances`)
  const instances = instancesResponse?.data || instancesResponse || []
  const instance = instances.find((item) => item.id === installedInstance.id)
  assert.ok(instance, 'Installed instance not returned by instances endpoint')

  const agentAfterResponse = await request(`/engine/agents/${encodeURIComponent(agent.id)}`)
  const agentAfter = agentAfterResponse?.data || agentAfterResponse || {}
  assert.equal(agentAfter.activeStrategyInstanceId, installedInstance.id, 'Agent activeStrategyInstanceId mismatch')
  assert.equal(agentAfter.activeStrategyTemplateId, template.id, 'Agent activeStrategyTemplateId mismatch')
  assert.equal(agentAfter.activeStrategyMode, 'direct', 'Agent activeStrategyMode should be direct after install')
  assert.equal(agentAfter.strategySource, 'custom_public', 'Agent strategySource should be custom_public after public LLM install')
  assert.equal(agentAfter.executionOwner, 'llm', 'Agent executionOwner should be llm after LLM install')

  const runtimeEvidence = await pollForLlmRuntimeEvidence(agent.id, runtimeStartedAt)
  assert.notEqual(runtimeEvidence.kind, 'timeout', `No live llm_trader runtime evidence observed within ${decisionWaitMs}ms`)

  const summary = {
    createdTemplate: {
      id: template.id,
      slug: template.slug,
      type: template.type,
      category: template.category,
      visibility: templateDetail.visibility,
      status: templateDetail.status,
    },
    createdVersion: {
      id: version.id,
      versionNumber: version.versionNumber,
    },
    publishedListing: {
      id: listing.id,
      strategyTemplateId: listing.strategyTemplateId,
      currentVersionId: listing.currentVersionId,
      templateType: createdListing?.template?.type,
      templateCategory: createdListing?.template?.category,
    },
    install: {
      agentId: agent.id,
      instanceId: installedInstance.id,
      activeStrategyMode: agentAfter.activeStrategyMode,
      strategySource: agentAfter.strategySource,
      executionOwner: agentAfter.executionOwner,
    },
    runtimeEvidence: runtimeEvidence.kind === 'llm_memory'
      ? {
          source: runtimeEvidence.kind,
          timestamp: runtimeEvidence.llmDecision.timestamp,
          action: runtimeEvidence.llmDecision.action,
          confidence: runtimeEvidence.llmDecision.confidence,
          reasoning: runtimeEvidence.llmDecision.reasoning,
        }
      : runtimeEvidence.kind === 'engine_reasoning'
      ? {
          source: runtimeEvidence.kind,
          timestamp: runtimeEvidence.engineDecision.timestamp,
          action: runtimeEvidence.engineDecision.action,
          reasoning: runtimeEvidence.engineDecision.reasoning,
        }
      : {
          source: runtimeEvidence.kind,
          timestamp: runtimeEvidence.lastIdleAt,
          reasoning: runtimeEvidence.idleReason,
          executionOwner: runtimeEvidence.agent?.executionOwner,
        },
  }

  console.log(JSON.stringify(summary, null, 2))
  console.log('✅ LLM marketplace pipeline smoke test passed')
}

main().catch((error) => {
  console.error('❌ LLM marketplace pipeline smoke test failed')
  console.error(error.message)
  process.exit(1)
})