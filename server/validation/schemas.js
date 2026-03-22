// ═══════════════════════════════════════════════════════════════════════
// Zod Schemas — Request validation for all POST/PATCH endpoints
//
// NOTE (Zod v4 compat): Always use z.record(z.string(), z.any()) instead
// of z.record(z.unknown()). Single-arg z.record() in Zod v4 treats the
// argument as the KEY type, leaving VALUE type undefined → _zod crash.
// ═══════════════════════════════════════════════════════════════════════

import { z } from 'zod'

// ── Reusable primitives ──

const positiveNumber = z.number().positive()
const nonEmptyString = z.string().min(1).max(200)
const optionalString = z.string().max(500).optional()
const percentage = z.number().min(0).max(100)
const walletAddress = z.string().min(10).max(128)
const agentId = z.string().min(1).max(100)
const indexId = z.string().min(1).max(100)

// ── User Routes ──

export const authSchema = z.object({
  address: walletAddress,
  nonce: z.string().min(8).max(256).optional(),
})

export const privyVerifySchema = z.object({
  accessToken: z.string().min(20).max(10000).optional(),
  identityToken: z.string().min(20).max(20000).optional(),
}).refine((data) => Boolean(data.accessToken || data.identityToken), {
  message: 'accessToken or identityToken is required',
})

export const setActiveWalletSchema = z.object({
  walletAddress,
  walletProvider: z.string().min(2).max(80).optional(),
})

export const createLegacyAgentSchema = z.object({
  name: nonEmptyString,
  preset: nonEmptyString,
  strategy: z.string().max(50).optional(),
  index: z.string().max(50).optional(),
  icon: z.string().max(10).optional(),
  config: z.record(z.string(), z.any()).optional(),
  riskParams: z.record(z.string(), z.any()).optional(),
})

export const updateLegacyAgentSchema = z.object({
  name: nonEmptyString.optional(),
  config: z.record(z.string(), z.any()).optional(),
  riskParams: z.record(z.string(), z.any()).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field required' })

export const depositSchema = z.object({
  amount: positiveNumber,
  txHash: z.string().max(200).optional(),
})

export const upsertOnboardingProfileSchema = z.object({
  ownerAddress: walletAddress.optional(),
  displayName: z.string().min(2).max(80).optional(),
  username: z.string().min(2).max(40).regex(/^[a-zA-Z0-9_.-]+$/, 'Username must be alphanumeric with . _ -').optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).refine(data => Object.keys(data).some((key) => key !== 'ownerAddress'), { message: 'At least one profile field required' })

export const registerOnboardingSchema = z.object({
  ownerAddress: walletAddress.optional(),
  displayName: z.string().min(2).max(80),
  username: z.string().min(2).max(40).regex(/^[a-zA-Z0-9_.-]+$/, 'Username must be alphanumeric with . _ -').optional(),
  autoProvisionManagedWallet: z.boolean().optional(),
  managedWalletLabel: z.string().max(80).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

export const linkWalletSchema = z.object({
  id: z.string().max(100).optional(),
  ownerAddress: walletAddress.optional(),
  walletAddress,
  walletKind: z.enum(['external', 'managed', 'readonly']),
  walletProvider: z.string().min(2).max(80),
  walletRef: z.string().max(120).optional(),
  label: z.string().max(80).optional(),
  isPrimary: z.boolean().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

export const createManagedWalletSchema = z.object({
  ownerAddress: walletAddress.optional(),
  providerId: z.enum(['wdk-ton']).optional(),
  mode: z.enum(['create', 'import']).default('create'),
  mnemonic: z.string().min(12).max(500).optional(),
  label: z.string().max(80).optional(),
  accountIndex: z.number().int().min(0).max(100000).optional(),
  derivationPath: z.string().max(120).optional(),
  setPrimary: z.boolean().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).superRefine((data, ctx) => {
  if (data.mode === 'import' && !data.mnemonic) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mnemonic is required when importing a managed wallet', path: ['mnemonic'] })
  }
})

export const createAdminManagedWalletSchema = z.object({
  ownerAddress: walletAddress.optional(),
  providerId: z.enum(['wdk-ton']).optional(),
  mode: z.enum(['create', 'import']).default('create'),
  mnemonic: z.string().min(12).max(500).optional(),
  label: z.string().max(80).optional(),
  accountIndex: z.number().int().min(0).max(100000).optional(),
  derivationPath: z.string().max(120).optional(),
  setPrimary: z.boolean().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).superRefine((data, ctx) => {
  if (data.mode === 'import' && !data.mnemonic) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mnemonic is required when importing a managed wallet', path: ['mnemonic'] })
  }
})

export const createAdminSessionSchema = z.object({
  apiKey: z.string().max(500).optional(),
  actorLabel: z.string().max(64).optional(),
  persist: z.boolean().optional(),
  allowLocalBypass: z.boolean().optional(),
}).refine((data) => Boolean(String(data.apiKey || '').trim() || data.allowLocalBypass), {
  message: 'apiKey or allowLocalBypass is required',
})

// ── Engine Routes ──

export const createEngineAgentSchema = z.object({
  name: nonEmptyString,
  strategy: nonEmptyString,
  icon: z.string().max(10).optional(),
  virtualBalance: positiveNumber.max(1_000_000).optional(),
  config: z.record(z.string(), z.any()).optional(),
  isUserAgent: z.boolean().optional(),
  walletAddress: walletAddress.optional().nullable(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  bio: z.string().max(1000).optional(),
  llmProvider: z.string().max(50).optional(),
  llmModel: z.string().max(100).optional(),
  llmApiKey: z.string().max(500).optional(),
})

export const updateEngineAgentSchema = z.object({
  name: nonEmptyString.optional(),
  config: z.record(z.string(), z.any()).optional(),
  virtualBalance: positiveNumber.max(1_000_000).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field required' })

// ── Index Routes ──

export const placeOrderSchema = z.object({
  agentId: agentId,
  side: z.enum(['buy', 'sell']),
  price: positiveNumber,
  size: positiveNumber,
  reasoning: z.string().max(500).optional(),
})

export const subscribeSchema = z.object({
  agentId: agentId,
  allocationPct: percentage.optional(),
})

export const createByAgentSchema = z.object({
  agentId: agentId,
  templateId: nonEmptyString,
  name: nonEmptyString.optional(),
  symbol: z.string().min(2).max(10).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(10).optional(),
  params: z.record(z.string(), z.any()).optional(),
})

// ── Admin Routes ──

export const createIndexSchema = z.object({
  id: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/, 'ID must be uppercase alphanumeric with underscores'),
  name: nonEmptyString,
  symbol: z.string().min(2).max(10),
  formulaId: nonEmptyString,
  description: z.string().max(500).optional(),
  icon: z.string().max(10).optional(),
  initialPrice: positiveNumber.max(10000).optional(),
  maxSupply: positiveNumber.max(100_000_000).optional(),
  bandWidthPct: z.number().min(0.5).max(10).optional(),
  oracleIntervalMs: z.number().int().min(5000).max(600_000).optional(),
  params: z.record(z.string(), z.any()).optional(),
  mmConfig: z.union([
    z.literal(false),
    z.object({
      minSpreadBps: z.number().int().min(1).max(1000).optional(),
      maxSpreadBps: z.number().int().min(1).max(5000).optional(),
      maxInventoryPct: percentage.optional(),
      targetInventoryPct: percentage.optional(),
      baseSizePct: z.number().min(0.01).max(10).optional(),
      maxLevels: z.number().int().min(1).max(20).optional(),
      levelSpacingBps: z.number().int().min(1).max(500).optional(),
      profitCapPct: z.number().min(0).max(50).optional(),
      tickIntervalMs: z.number().int().min(1000).max(300_000).optional(),
    }),
  ]).optional(),
})

export const updateIndexSchema = z.object({
  status: z.enum(['active', 'paused', 'delisted']).optional(),
  description: z.string().max(500).optional(),
  bandWidthPct: z.number().min(0.5).max(10).optional(),
  oracleIntervalMs: z.number().int().min(5000).max(600_000).optional(),
  params: z.record(z.string(), z.any()).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field required' })

export const createExternalProviderSchema = z.object({
  id: z.string().min(1).max(50),
  name: nonEmptyString,
  type: z.enum(['static', 'rest_json', 'hyperliquid', 'api', 'coingecko', 'websocket']).optional(),
  url: z.string().url().max(500).optional(),
  jsonPath: z.string().max(200).optional(),
  coin: z.string().max(50).optional(),
  intervalMs: z.number().int().min(1000).max(3_600_000).optional(),
  defaultValue: z.number().optional(),
  transform: z.string().max(500).optional(),
})

export const previewExternalProviderSchema = z.object({
  type: z.enum(['static', 'rest_json', 'hyperliquid', 'api', 'coingecko', 'websocket']).optional(),
  url: z.string().url().max(500).optional(),
  jsonPath: z.string().max(200).optional(),
  coin: z.string().max(50).optional(),
  intervalMs: z.number().int().min(1000).max(3_600_000).optional(),
  defaultValue: z.number().optional(),
  transform: z.string().max(500).optional(),
})

export const updateExternalProviderSchema = z.object({
  value: z.number(),
})

export const updateSystemParamsSchema = z.object({
  agentIndex: z.record(z.string(), z.any()).optional(),
  indexPolicies: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  engine: z.object({
    tickIntervalMs: z.number().int().min(1000).max(30000).optional(),
  }).optional(),
  wallets: z.object({
    externalWalletsEnabled: z.boolean().optional(),
    managedWalletsEnabled: z.boolean().optional(),
    managedWalletCreationMode: z.enum(['self-service', 'admin-only', 'disabled']).optional(),
    autoProvisionManagedWalletOnRegistration: z.boolean().optional(),
    requireSessionForManagedWallets: z.boolean().optional(),
    allowProfileWithoutWallet: z.boolean().optional(),
    allowReadonlyWalletLinking: z.boolean().optional(),
  }).optional(),
  safeguards: z.object({
    indexRegistry: z.record(z.string(), z.any()).optional(),
    agentManager: z.record(z.string(), z.any()).optional(),
  }).optional(),
  marketMaker: z.record(z.string(), z.record(z.string(), z.any())).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one param to update' })

export const stressTestSchema = z.object({
  agents: z.coerce.number().int().min(1).max(100000).optional(),
  ordersPerAgent: z.coerce.number().int().min(1).max(10000).optional(),
  persistTrades: z.coerce.number().int().min(100).max(200000).optional(),
  basePrice: z.coerce.number().positive().optional(),
  priceRange: z.coerce.number().positive().max(10).optional(),
  enableMarket: z.boolean().optional(),
  enableIOC: z.boolean().optional(),
  enableFOK: z.boolean().optional(),
  enableStop: z.boolean().optional(),
  enableTrailing: z.boolean().optional(),
  enableSTP: z.boolean().optional(),
  enableCancel: z.boolean().optional(),
})

// ── Strategy Marketplace / Custom Strategies ──

const strategyVisibility = z.enum(['private', 'unlisted', 'public'])
const strategyType = z.enum(['custom', 'hybrid', 'signal_only', 'llm'])
const strategyMode = z.literal('direct')
const channelType = z.enum(['index', 'feed', 'external_provider', 'creator', 'strategy_signal', 'topic'])
const lockMode = z.enum(['locked', 'managed', 'temporary'])
const genericJsonObject = z.record(z.string(), z.any())

export const createStrategyTemplateSchema = z.object({
  slug: z.string().min(3).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be kebab-case'),
  name: nonEmptyString.max(120),
  shortDescription: z.string().max(500).optional(),
  category: z.string().min(2).max(50).optional(),
  type: strategyType.optional(),
  visibility: strategyVisibility.optional(),
  complexityScore: z.number().min(0).max(100).optional(),
  explainabilityScore: z.number().min(0).max(100).optional(),
})

export const createStrategyVersionSchema = z.object({
  versionNumber: z.number().int().min(1).max(10000).optional(),
  changelog: z.string().max(5000).optional(),
  definition: genericJsonObject,
  parameterSchema: genericJsonObject.optional(),
  triggerSchema: genericJsonObject.optional(),
  requiredChannels: z.array(genericJsonObject).max(100).optional(),
  runtimeRequirements: genericJsonObject.optional(),
  riskDefaults: genericJsonObject.optional(),
  rotationDefaults: genericJsonObject.optional(),
})

export const publishStrategySchema = z.object({
  currentVersionId: z.string().max(100).optional(),
  priceMode: z.enum(['free', 'paid', 'invite']).optional(),
  priceValue: z.number().min(0).max(1_000_000).optional().nullable(),
  verifiedBadge: z.boolean().optional(),
  featuredRank: z.number().int().min(1).max(1000).optional().nullable(),
  rankingScore: z.number().min(0).max(1_000_000).optional(),
})

const installChannelSchema = z.object({
  channelType,
  sourceRef: z.string().max(120).optional().nullable(),
  name: nonEmptyString.max(120),
  description: z.string().max(500).optional(),
  topicTags: z.array(z.string().max(60)).max(20).optional(),
  qualityScore: z.number().min(0).max(100).optional(),
  subscriptionKind: z.enum(['trading', 'signal', 'preference']).optional(),
  weight: z.number().min(0).max(100).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  lockMode: lockMode.optional(),
  metadata: genericJsonObject.optional(),
})

const rotationPolicySchema = z.object({
  enabled: z.boolean().optional(),
  goalMode: z.enum(['balanced', 'aggressive', 'sticky', 'conservative']).optional(),
  profileName: z.string().min(2).max(80).optional(),
  intervalTicks: z.number().int().min(1).max(100000).optional(),
  maxActiveChannels: z.number().int().min(1).max(8).optional(),
  minChannelLifetimeTicks: z.number().int().min(1).max(100000).optional(),
  churnBudgetPerDay: z.number().int().min(0).max(1000).optional(),
  maxCandidateChannels: z.number().int().min(1).max(500).optional(),
  scoreWeights: genericJsonObject.optional(),
  filters: genericJsonObject.optional(),
})

export const installStrategySchema = z.object({
  agentId: agentId,
  templateId: z.string().max(100),
  versionId: z.string().max(100).optional(),
  mode: strategyMode.optional(),
  customParams: genericJsonObject.optional(),
  customRisk: genericJsonObject.optional(),
  customRotation: genericJsonObject.optional(),
  channelSubscriptions: z.array(installChannelSchema).max(50).optional(),
  rotationPolicy: rotationPolicySchema.optional(),
})
