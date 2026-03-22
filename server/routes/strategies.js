import { Router } from 'express'
import { randomUUID } from 'crypto'
import {
  createStrategyTemplate,
  getStrategyTemplate,
  listStrategyTemplates,
  createStrategyVersion,
  getStrategyVersion,
  listStrategyVersions,
  getLatestStrategyVersionForTemplate,
  markStrategyVersionPublished,
  updateStrategyTemplateLifecycle,
  upsertStrategyMarketplaceListing,
  getStrategyMarketplaceListing,
  listStrategyMarketplaceListings,
  listStrategyMarketplaceListingsPage,
  ensureLlmSharedStrategyScope,
  updateLlmSharedStrategyScopePlan,
  createAgentStrategyInstance,
  listAgentStrategyInstances,
  listStrategyExecutionEventsByAgent,
  getStrategyRevenueSummaryByOwner,
  listStrategyRevenueEventsByOwner,
  registerSignalChannel,
  upsertAgentChannelSubscription,
  upsertAgentRotationPolicy,
  incrementStrategyInstallCounts,
} from '../runtimeStrategyStore.js'
import {
  validate, ok, fail, notFound,
  createStrategyTemplateSchema,
  createStrategyVersionSchema,
  publishStrategySchema,
  installStrategySchema,
} from '../validation/index.js'
import { buildStrategyTemplateMetrics } from '../services/strategyMarketplaceService.js'

function normalizeSort(sort) {
  if (sort === 'installCount') return 'installs'
  if (sort === 'activeInstallCount') return 'installs'
  return ['ranking', 'newest', 'installs'].includes(sort) ? sort : 'ranking'
}

function resolveUniqueTemplateSlug(baseSlug) {
  const normalizedBase = String(baseSlug || '').trim().toLowerCase()
  if (!normalizedBase) return normalizedBase
  if (!getStrategyTemplate(normalizedBase)) return normalizedBase

  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`
    const trimmedBase = normalizedBase.slice(0, Math.max(1, 80 - suffix.length)).replace(/-+$/g, '')
    const candidate = `${trimmedBase}${suffix}`
    if (!getStrategyTemplate(candidate)) return candidate
  }

  return `${normalizedBase.slice(0, 68)}-${Date.now()}`.slice(0, 80)
}

function toOptionalInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.round(numeric)
  if (rounded < min || rounded > max) return undefined
  return rounded
}

function sanitizeRotationPolicy(policy) {
  if (!policy || typeof policy !== 'object') return null

  const cleaned = {
    enabled: policy.enabled !== false,
    goalMode: ['balanced', 'aggressive', 'sticky', 'conservative'].includes(policy.goalMode) ? policy.goalMode : 'balanced',
    profileName: typeof policy.profileName === 'string' && policy.profileName.trim().length >= 2
      ? policy.profileName.trim().slice(0, 80)
      : undefined,
    intervalTicks: toOptionalInt(policy.intervalTicks, { min: 1, max: 100000 }),
    maxActiveChannels: toOptionalInt(policy.maxActiveChannels, { min: 1, max: 8 }),
    minChannelLifetimeTicks: toOptionalInt(policy.minChannelLifetimeTicks, { min: 1, max: 100000 }),
    churnBudgetPerDay: toOptionalInt(policy.churnBudgetPerDay, { min: 0, max: 1000 }),
    maxCandidateChannels: toOptionalInt(policy.maxCandidateChannels, { min: 1, max: 500 }),
    scoreWeights: policy.scoreWeights && typeof policy.scoreWeights === 'object' ? policy.scoreWeights : {},
    filters: policy.filters && typeof policy.filters === 'object' ? policy.filters : {},
  }

  if (!cleaned.profileName) cleaned.profileName = cleaned.goalMode
  if (cleaned.maxActiveChannels != null && cleaned.maxCandidateChannels != null) {
    cleaned.maxCandidateChannels = Math.max(cleaned.maxActiveChannels, cleaned.maxCandidateChannels)
  }
  return cleaned
}

/**
 * @param {{ engine, auth, normalizeAddr, customStrategyRuntime }} deps
 */
export default function strategyRoutes({ engine, auth, normalizeAddr, customStrategyRuntime }) {
  const router = Router()

  function resolveInstalledStrategySource(template) {
    const listing = getStrategyMarketplaceListing(template?.id)
    if (!listing) return 'custom'
    if (normalizeAddr(template?.ownerUserAddress || '') === 'system:marketplace') return 'marketplace_seed'
    return 'custom_public'
  }

  function getOwnedAgent(req, res, agentId) {
    const agent = engine.getAgent(agentId)
    if (!agent) {
      notFound(res, 'Agent')
      return null
    }
    const reqWallet = normalizeAddr(req.userAddress || '')
    if (agent.isUserAgent && agent.walletAddress && reqWallet !== normalizeAddr(agent.walletAddress)) {
      fail(res, 'Access denied — not your agent', 403)
      return null
    }
    return agent
  }

  function findUserAgentByWallet(walletAddress) {
    const normalizedWallet = normalizeAddr(walletAddress || '')
    if (!normalizedWallet) return null

    const allAgents = Array.from(engine.agents?.values?.() || [])
    return allAgents.find((agent) => agent?.isUserAgent && normalizeAddr(agent.walletAddress || '') === normalizedWallet) || null
  }

  function ensureTemplateOwnership(req, res, templateId) {
    const template = getStrategyTemplate(templateId)
    if (!template) {
      notFound(res, 'Strategy template')
      return null
    }
    if (normalizeAddr(template.ownerUserAddress) !== normalizeAddr(req.userAddress)) {
      fail(res, 'Access denied — not your strategy', 403)
      return null
    }
    return template
  }

  router.get('/marketplace', (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0)
    const category = typeof req.query.category === 'string' ? req.query.category : null
    const sort = normalizeSort(typeof req.query.sort === 'string' ? req.query.sort : 'ranking')
    const includeMeta = String(req.query.includeMeta || '').toLowerCase() === '1' || String(req.query.includeMeta || '').toLowerCase() === 'true'
    if (includeMeta || offset > 0) {
      ok(res, listStrategyMarketplaceListingsPage({ limit, offset, category, sort }))
      return
    }
    ok(res, listStrategyMarketplaceListings({ limit, category, sort }))
  })

  router.get('/templates/:id', (req, res) => {
    const template = getStrategyTemplate(req.params.id)
    if (!template) return notFound(res, 'Strategy template')
    const listing = getStrategyMarketplaceListing(req.params.id)
    ok(res, { ...template, listing })
  })

  router.get('/templates/:id/versions', (req, res) => {
    ok(res, listStrategyVersions(req.params.id))
  })

  router.get('/templates/:id/metrics', (req, res) => {
    const template = getStrategyTemplate(req.params.id)
    if (!template) return notFound(res, 'Strategy template')
    ok(res, buildStrategyTemplateMetrics({ templateId: template.id, engine }))
  })

  router.get('/mine/templates', auth, (req, res) => {
    ok(res, listStrategyTemplates({ ownerUserAddress: normalizeAddr(req.userAddress) }))
  })

  router.get('/mine/revenue', auth, (req, res) => {
    const ownerUserAddress = normalizeAddr(req.userAddress)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))
    ok(res, {
      ownerUserAddress,
      summary: getStrategyRevenueSummaryByOwner(ownerUserAddress),
      recentEvents: listStrategyRevenueEventsByOwner(ownerUserAddress, { limit }),
    })
  })

  router.post('/templates', auth, validate(createStrategyTemplateSchema), (req, res) => {
    const now = Date.now()
    const uniqueSlug = resolveUniqueTemplateSlug(req.body.slug)
    const template = createStrategyTemplate({
      id: randomUUID(),
      ownerUserAddress: normalizeAddr(req.userAddress),
      slug: uniqueSlug,
      name: req.body.name,
      shortDescription: req.body.shortDescription || '',
      category: req.body.category || 'custom',
      type: req.body.type || 'custom',
      visibility: req.body.visibility || 'private',
      status: 'draft',
      complexityScore: req.body.complexityScore || 0,
      explainabilityScore: req.body.explainabilityScore || 0,
      createdAt: now,
      updatedAt: now,
    })
    ok(res, template, 201)
  })

  router.post('/templates/:id/versions', auth, validate(createStrategyVersionSchema), (req, res) => {
    const template = ensureTemplateOwnership(req, res, req.params.id)
    if (!template) return

    const versions = listStrategyVersions(template.id)
    const nextVersionNumber = versions.length > 0 ? Math.max(...versions.map((item) => item.versionNumber)) + 1 : 1
    const now = Date.now()

    const version = createStrategyVersion({
      id: randomUUID(),
      strategyTemplateId: template.id,
      versionNumber: req.body.versionNumber || nextVersionNumber,
      changelog: req.body.changelog || '',
      definition: req.body.definition || {},
      parameterSchema: req.body.parameterSchema || {},
      triggerSchema: req.body.triggerSchema || {},
      requiredChannels: req.body.requiredChannels || [],
      runtimeRequirements: req.body.runtimeRequirements || {},
      riskDefaults: req.body.riskDefaults || {},
      rotationDefaults: req.body.rotationDefaults || {},
      publishedAt: null,
      createdAt: now,
    })
    ok(res, version, 201)
  })

  router.post('/templates/:id/publish', auth, validate(publishStrategySchema), (req, res) => {
    const template = ensureTemplateOwnership(req, res, req.params.id)
    if (!template) return

    const version = req.body.currentVersionId
      ? getStrategyVersion(req.body.currentVersionId)
      : getLatestStrategyVersionForTemplate(template.id)
    if (!version || version.strategyTemplateId !== template.id) {
      return fail(res, 'Valid strategy version required for publish', 400)
    }

    const now = Date.now()
    markStrategyVersionPublished(version.id, now)
    updateStrategyTemplateLifecycle(template.id, { visibility: 'public', status: 'published' })
    const listing = upsertStrategyMarketplaceListing({
      id: randomUUID(),
      strategyTemplateId: template.id,
      currentVersionId: version.id,
      authorUserAddress: template.ownerUserAddress,
      priceMode: req.body.priceMode || 'free',
      priceValue: req.body.priceValue ?? null,
      installCount: 0,
      activeInstallCount: 0,
      forkCount: 0,
      reviewCount: 0,
      avgRating: 0,
      verifiedBadge: req.body.verifiedBadge ? 1 : 0,
      featuredRank: req.body.featuredRank ?? null,
      rankingScore: req.body.rankingScore ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    ok(res, listing)
  })

  router.get('/agents/:id/instances', auth, (req, res) => {
    const agent = getOwnedAgent(req, res, req.params.id)
    if (!agent) return
    ok(res, listAgentStrategyInstances(agent.id))
  })

  router.get('/agents/:id/executions', auth, (req, res) => {
    const agent = getOwnedAgent(req, res, req.params.id)
    if (!agent) return

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))
    const strategyInstanceId = typeof req.query.strategyInstanceId === 'string' && req.query.strategyInstanceId
      ? req.query.strategyInstanceId
      : null

    ok(res, listStrategyExecutionEventsByAgent(agent.id, { limit, strategyInstanceId }))
  })

  router.post('/install', auth, validate(installStrategySchema), (req, res) => {
    const agent = getOwnedAgent(req, res, req.body.agentId)
    if (!agent) return

    const template = getStrategyTemplate(req.body.templateId)
    if (!template) return notFound(res, 'Strategy template')

    const version = req.body.versionId
      ? getStrategyVersion(req.body.versionId)
      : (getStrategyMarketplaceListing(template.id)?.currentVersionId
          ? getStrategyVersion(getStrategyMarketplaceListing(template.id).currentVersionId)
          : getLatestStrategyVersionForTemplate(template.id))

    if (!version || version.strategyTemplateId !== template.id) {
      return fail(res, 'Strategy version not found for template', 400)
    }

    const defaultParams = version.parameterSchema?.defaults || {}
    const defaultRisk = version.riskDefaults || {}
    const defaultRotation = version.rotationDefaults || {}
    const installedStrategySource = resolveInstalledStrategySource(template)
    const isLlmTemplate = template.type === 'llm'
    const creatorWalletAddress = normalizeAddr(template.ownerUserAddress || '')
    const creatorAgent = isLlmTemplate ? findUserAgentByWallet(creatorWalletAddress) : null
    const llmSharedExecution = isLlmTemplate && installedStrategySource === 'custom_public'
    const llmSharedKey = llmSharedExecution && creatorWalletAddress
      ? `llm-template:${template.id}:owner:${creatorWalletAddress}`
      : null
    const llmSharedRotationPolicy = isLlmTemplate && llmSharedExecution
      ? sanitizeRotationPolicy(Object.keys(defaultRotation).length > 0 ? {
          enabled: true,
          goalMode: defaultRotation.goalMode || 'balanced',
          profileName: defaultRotation.profileName || defaultRotation.goalMode || 'balanced',
          intervalTicks: defaultRotation.intervalTicks,
          maxActiveChannels: defaultRotation.maxActiveChannels,
          minChannelLifetimeTicks: defaultRotation.minChannelLifetimeTicks,
          churnBudgetPerDay: defaultRotation.churnBudgetPerDay,
          maxCandidateChannels: defaultRotation.maxCandidateChannels,
          scoreWeights: defaultRotation.scoreWeights || {},
          filters: defaultRotation.filters || {},
        } : null)
      : null
    const normalizedRotationPolicy = isLlmTemplate
      ? null
      : sanitizeRotationPolicy(req.body.rotationPolicy || (Object.keys(defaultRotation).length > 0 ? {
      enabled: true,
      goalMode: defaultRotation.goalMode || 'balanced',
      profileName: defaultRotation.profileName || defaultRotation.goalMode || 'balanced',
      intervalTicks: defaultRotation.intervalTicks,
      maxActiveChannels: defaultRotation.maxActiveChannels,
      minChannelLifetimeTicks: defaultRotation.minChannelLifetimeTicks,
      churnBudgetPerDay: defaultRotation.churnBudgetPerDay,
      maxCandidateChannels: defaultRotation.maxCandidateChannels,
      scoreWeights: defaultRotation.scoreWeights || {},
      filters: defaultRotation.filters || {},
    } : null))

    const now = Date.now()
    const llmSharedScope = llmSharedExecution
      ? ensureLlmSharedStrategyScope({
          id: randomUUID(),
          scopeKey: llmSharedKey,
          strategyTemplateId: template.id,
          ownerUserAddress: creatorWalletAddress,
          creatorAgentId: creatorAgent?.id || null,
          creatorAgentName: creatorAgent?.name || null,
          executionMode: 'strategy_scope',
          memoryKey: llmSharedKey,
          stateKey: llmSharedKey,
          status: 'active',
          subscriptionPlan: [],
          metadata: {
            templateName: template.name || null,
            templateSlug: template.slug || null,
            rotationPolicy: llmSharedRotationPolicy || null,
          },
          createdAt: now,
          updatedAt: now,
        })
      : null
    const hydratedLlmSharedScope = llmSharedExecution && llmSharedScope
      ? updateLlmSharedStrategyScopePlan(llmSharedScope.id, {
          subscriptionPlan: Array.isArray(llmSharedScope.subscriptionPlan) ? llmSharedScope.subscriptionPlan : [],
          metadata: {
            ...(llmSharedScope.metadata || {}),
            templateName: template.name || null,
            templateSlug: template.slug || null,
            rotationPolicy: llmSharedRotationPolicy || null,
          },
          status: 'active',
          lastSyncedAt: llmSharedScope.lastSyncedAt || now,
        })
      : llmSharedScope
    const instance = createAgentStrategyInstance({
      id: randomUUID(),
      agentId: agent.id,
      strategyTemplateId: template.id,
      strategyVersionId: version.id,
      mode: 'direct',
      status: 'active',
      customParams: {
        ...defaultParams,
        ...(req.body.customParams || {}),
        ...(llmSharedExecution ? {
          __llmSharedExecution: true,
          __llmSharedExecutionMode: hydratedLlmSharedScope?.executionMode || 'strategy_scope',
          __llmSharedTemplateId: template.id,
          __llmSharedTemplateName: template.name || null,
          __llmSharedScopeId: hydratedLlmSharedScope?.id || null,
          __llmSharedScopeKey: hydratedLlmSharedScope?.scopeKey || llmSharedKey,
          __llmSharedOwnerWallet: creatorWalletAddress || null,
          __llmSharedMemoryKey: hydratedLlmSharedScope?.memoryKey || llmSharedKey,
          __llmSharedStateKey: hydratedLlmSharedScope?.stateKey || llmSharedKey,
          __llmSharedCreatorAgentId: creatorAgent?.id || null,
          __llmSharedCreatorAgentName: creatorAgent?.name || null,
        } : {}),
      },
      customRisk: { ...defaultRisk, ...(req.body.customRisk || {}) },
      customRotation: isLlmTemplate ? {} : { ...defaultRotation, ...(req.body.customRotation || {}) },
      installedFromMarketplace: installedStrategySource !== 'custom' ? 1 : 0,
      installedByUser: normalizeAddr(req.userAddress),
      createdAt: now,
      updatedAt: now,
    })

    const installChannels = isLlmTemplate
      ? []
      : (Array.isArray(req.body.channelSubscriptions)
          ? req.body.channelSubscriptions
          : (Array.isArray(version.requiredChannels) ? version.requiredChannels : []))

    for (const channelInput of installChannels) {
      const channel = registerSignalChannel({
        id: randomUUID(),
        channelType: channelInput.channelType,
        sourceRef: channelInput.sourceRef || null,
        name: channelInput.name,
        description: channelInput.description || '',
        topicTags: channelInput.topicTags || [],
        qualityScore: channelInput.qualityScore || 0,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      upsertAgentChannelSubscription({
        id: randomUUID(),
        agentId: agent.id,
        strategyInstanceId: instance.id,
        channelId: channel.id,
        subscriptionKind: channelInput.subscriptionKind || 'signal',
        source: 'marketplace_bundle',
        weight: channelInput.weight || 1,
        priority: channelInput.priority || 0,
        status: 'active',
        lockMode: channelInput.lockMode || 'managed',
        subscribedAt: now,
        subscribedTick: engine.tickCount,
        expiresAt: null,
        metadata: channelInput.metadata || {},
      })
    }

    if (normalizedRotationPolicy) {
      upsertAgentRotationPolicy({
        id: randomUUID(),
        agentId: agent.id,
        strategyInstanceId: instance.id,
        enabled: normalizedRotationPolicy.enabled !== false ? 1 : 0,
        goalMode: normalizedRotationPolicy.goalMode || 'balanced',
        profileName: normalizedRotationPolicy.profileName || 'balanced',
        intervalTicks: normalizedRotationPolicy.intervalTicks ?? 40,
        maxActiveChannels: normalizedRotationPolicy.maxActiveChannels ?? 4,
        minChannelLifetimeTicks: normalizedRotationPolicy.minChannelLifetimeTicks ?? 20,
        churnBudgetPerDay: normalizedRotationPolicy.churnBudgetPerDay ?? 6,
        maxCandidateChannels: normalizedRotationPolicy.maxCandidateChannels ?? 12,
        scoreWeights: normalizedRotationPolicy.scoreWeights || {},
        filters: normalizedRotationPolicy.filters || {},
        createdAt: now,
        updatedAt: now,
      })
    }

    const enableSubscriptionRotation = isLlmTemplate
      ? false
      : (normalizedRotationPolicy?.enabled ?? agent.config?.enableSubscriptionRotation ?? false)
    const nextLlmSharedScopeId = llmSharedExecution ? (hydratedLlmSharedScope?.id || null) : null
    const nextLlmSharedScopeKey = llmSharedExecution ? (hydratedLlmSharedScope?.scopeKey || llmSharedKey || null) : null
    const nextLlmSharedExecutionMode = llmSharedExecution ? (hydratedLlmSharedScope?.executionMode || 'strategy_scope') : null
    const nextLlmSharedMemoryKey = llmSharedExecution ? (hydratedLlmSharedScope?.memoryKey || llmSharedKey || null) : null
    const nextLlmSharedStateKey = llmSharedExecution ? (hydratedLlmSharedScope?.stateKey || llmSharedKey || null) : null

    agent.config = {
      ...(agent.config || {}),
      activeStrategyInstanceId: instance.id,
      strategyTemplateId: template.id,
      strategyVersionId: version.id,
      strategyMode: 'direct',
      strategySource: installedStrategySource,
      enableSubscriptionRotation,
      intervalTicks: isLlmTemplate ? null : (normalizedRotationPolicy?.intervalTicks ?? agent.config?.intervalTicks),
      maxActiveSubscriptions: isLlmTemplate ? null : (normalizedRotationPolicy?.maxActiveChannels ?? agent.config?.maxActiveSubscriptions),
      minSubLifetimeTicks: isLlmTemplate ? null : (normalizedRotationPolicy?.minChannelLifetimeTicks ?? agent.config?.minSubLifetimeTicks),
      maxCandidateIndexes: isLlmTemplate ? null : (normalizedRotationPolicy?.maxCandidateChannels ?? agent.config?.maxCandidateIndexes),
      rotationGoalMode: isLlmTemplate ? null : (normalizedRotationPolicy?.goalMode ?? agent.config?.rotationGoalMode),
      rotationProfileName: isLlmTemplate ? null : (normalizedRotationPolicy?.profileName ?? agent.config?.rotationProfileName),
      rotationScoreWeights: isLlmTemplate ? null : (normalizedRotationPolicy?.scoreWeights ?? agent.config?.rotationScoreWeights),
      rotationFilters: isLlmTemplate ? null : (normalizedRotationPolicy?.filters ?? agent.config?.rotationFilters),
      rotationChurnBudgetPerDay: isLlmTemplate ? null : (normalizedRotationPolicy?.churnBudgetPerDay ?? agent.config?.rotationChurnBudgetPerDay),
      llmSharedExecution: llmSharedExecution,
      llmSharedExecutionMode: nextLlmSharedExecutionMode,
      llmSharedTemplateId: isLlmTemplate ? template.id : null,
      llmSharedTemplateName: isLlmTemplate ? (template.name || null) : null,
      llmSharedScopeId: nextLlmSharedScopeId,
      llmSharedScopeKey: nextLlmSharedScopeKey,
      llmSharedMemoryKey: nextLlmSharedMemoryKey,
      llmSharedStateKey: nextLlmSharedStateKey,
      llmSharedCreatorAgentId: llmSharedExecution ? (creatorAgent?.id || null) : null,
      llmSharedCreatorAgentName: llmSharedExecution ? (creatorAgent?.name || null) : null,
      llmSharedOwnerWallet: llmSharedExecution ? (creatorWalletAddress || null) : null,
    }

    agent._llmSharedExecution = llmSharedExecution
    agent._llmSharedExecutionMode = nextLlmSharedExecutionMode
    agent._llmSharedTemplateId = isLlmTemplate ? template.id : null
    agent._llmSharedScopeId = nextLlmSharedScopeId
    agent._llmSharedScopeKey = nextLlmSharedScopeKey
    agent._llmSharedControllerAgentId = llmSharedExecution ? (creatorAgent?.id || null) : null
    agent._llmSharedControllerAgentName = llmSharedExecution ? (creatorAgent?.name || null) : null
    agent._llmSharedScopeMemberCount = llmSharedExecution ? 1 : 0
    agent._llmSharedPlanIndexIds = []
    agent._sharedLlmLeaderAgentId = llmSharedExecution ? (creatorAgent?.id || null) : null
    agent._sharedLlmLeaderAgentName = llmSharedExecution ? (creatorAgent?.name || null) : null
    agent._sharedLlmFollowerCount = 0
    agent._sharedLlmMirroredIndexIds = []
    agent._sharedLlmBlockedIndexIds = []
    agent._sharedLlmLastSyncAt = null

    if (agent.isUserAgent && engine._persist?.saveAgent) {
      try { engine._persist.saveAgent(agent) } catch {}
    }

    incrementStrategyInstallCounts(template.id)
    customStrategyRuntime?.invalidate?.(agent.id)

    ok(res, {
      instance,
      agent: engine._sanitizeAgent(agent),
      template,
      version,
    }, 201)
  })

  return router
}
