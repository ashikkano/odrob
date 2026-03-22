import { randomUUID } from 'crypto'
import { adminLimiter } from '../../middleware/index.js'
import { requireAdminPermission } from '../../middleware/adminAuth.js'
import {
  validate,
  ok,
  fail,
  createAdminManagedWalletSchema,
  updateSystemParamsSchema,
} from '../../validation/index.js'
import { insertManagedWalletRecord, loadSystemState, saveSystemState, upsertWalletConnection } from '../../db.js'
import { AGENT_INDEX_CONFIG } from '../../engine/agentIndexFactory.js'
import { DEFAULT_WALLET_POLICY, mergeWalletPolicy } from '../../services/walletPolicy.js'
import config from '../../config.js'

export function registerSystemRoutes(router, context) {
  const { engine, indexRegistry, agentIndexFactory, systemMMs, writeAudit, normalizeAddr, walletProviderRegistry } = context
  const mergeableAgentIndexKeys = new Set(['globalPoolSplits', 'defaultMM', 'treasuryPolicy', 'globalPoolPolicy', 'accountingPolicy', 'marketplacePolicy'])

  function getWalletPolicySnapshot() {
    return mergeWalletPolicy(loadSystemState('wallet_policy', DEFAULT_WALLET_POLICY))
  }

  function getManagedWalletRuntimeSnapshot() {
    const masterSeedConfigured = Boolean(config.managedWallets?.masterSeed)
    return {
      masterSeedConfigured,
      custodyModel: masterSeedConfigured ? 'master-seed-derived' : 'not-configured',
      seedSource: masterSeedConfigured ? 'WDK_MASTER_SEED' : null,
      adminOnlyReady: masterSeedConfigured,
    }
  }

  router.post('/wallets/managed', adminLimiter, requireAdminPermission('admin:system'), validate(createAdminManagedWalletSchema), async (req, res) => {
    try {
      const walletPolicy = getWalletPolicySnapshot()
      if (!walletPolicy.managedWalletsEnabled) {
        return fail(res, 'Managed wallets are disabled by policy', 403)
      }

      const ownerAddress = req.body.ownerAddress ? normalizeAddr(req.body.ownerAddress) : null
      const created = await walletProviderRegistry.createManagedWallet({
        providerId: req.body.providerId || 'wdk-ton',
        ownerAddress,
        mode: req.body.mode,
        mnemonic: req.body.mnemonic,
        label: req.body.label,
        accountIndex: req.body.accountIndex,
        derivationPath: req.body.derivationPath,
      })

      const managedWallet = insertManagedWalletRecord({
        id: randomUUID(),
        ownerAddress,
        walletId: created.wallet.id,
        walletAddress: created.wallet.address,
        provider: created.providerId,
        mode: created.mode,
        label: req.body.label || null,
        accountIndex: created.managedWallet.accountIndex || 0,
        derivationPath: created.managedWallet.derivationPath || null,
        status: 'active',
        metadata: {
          ...created.managedWallet.metadata,
          source: 'admin-provisioned',
          adminActor: req.adminAccess?.actor || 'Admin operator',
          ...(req.body.metadata || {}),
        },
      })

      const linkedWallet = upsertWalletConnection({
        id: randomUUID(),
        ownerAddress,
        walletAddress: created.wallet.address,
        walletKind: 'managed',
        walletProvider: created.providerId,
        walletRef: created.wallet.id,
        label: req.body.label || null,
        isPrimary: req.body.setPrimary === false ? 0 : 1,
        metadata: {
          managedWalletId: managedWallet.id,
          provisionedBy: 'admin',
          adminActor: req.adminAccess?.actor || 'Admin operator',
          accountIndex: created.managedWallet.accountIndex || 0,
          derivationPath: created.managedWallet.derivationPath || null,
        },
      })

      writeAudit(req, 'wallet.managed.provision', 'wallet', created.wallet.id, {
        ownerAddress,
        walletAddress: created.wallet.address,
        provider: created.providerId,
        mode: created.mode,
        label: req.body.label || null,
      })

      ok(res, {
        wallet: created.wallet,
        managedWallet,
        linkedWallet,
        recoveryPhrase: created.recoveryPhrase,
      }, 201)
    } catch (err) {
      fail(res, err.message || 'Failed to provision managed wallet', 500)
    }
  })

  function getIndexPoliciesSnapshot() {
    return Object.fromEntries(
      Array.from(indexRegistry.indexes.entries()).map(([indexId, state]) => {
        const feePolicy = state?.policyOverrides?.feePolicy || {}
        return [indexId, {
          indexId,
          name: state.name,
          symbol: state.symbol,
          creationType: state.creationType || 'system',
          feePolicy: {
            tradingFeePct: Number.isFinite(feePolicy.tradingFeePct) ? feePolicy.tradingFeePct : AGENT_INDEX_CONFIG.tradingFeePct,
            creatorTradingShare: Number.isFinite(feePolicy.creatorTradingShare) ? feePolicy.creatorTradingShare : AGENT_INDEX_CONFIG.creatorTradingShare,
            mintFeePct: Number.isFinite(feePolicy.mintFeePct) ? feePolicy.mintFeePct : AGENT_INDEX_CONFIG.mintFeePct,
            creatorMintShare: Number.isFinite(feePolicy.creatorMintShare) ? feePolicy.creatorMintShare : AGENT_INDEX_CONFIG.creatorMintShare,
            strategyCreatorRoyaltyShare: Number.isFinite(feePolicy.strategyCreatorRoyaltyShare) ? feePolicy.strategyCreatorRoyaltyShare : AGENT_INDEX_CONFIG.strategyCreatorRoyaltyShare,
          },
          treasuryPolicy: {
            ...(AGENT_INDEX_CONFIG.treasuryPolicy || {}),
            ...((state?.policyOverrides?.treasuryPolicy) || {}),
          },
          accountingPolicy: {
            ...(AGENT_INDEX_CONFIG.accountingPolicy || {}),
            ...((state?.policyOverrides?.accountingPolicy) || {}),
          },
          marketMaker: systemMMs[indexId]?.getSnapshot?.().config || state?.policyOverrides?.marketMaker || {},
        }]
      })
    )
  }

  router.get('/system-params', (req, res) => {
    ok(res, {
      agentIndex: { ...AGENT_INDEX_CONFIG },
      engine: {
        tickIntervalMs: engine.TICK_INTERVAL || 3000,
        running: engine.running,
        agentCount: engine.agents.size,
      },
      indexRegistry: {
        minOracleIntervalMs: 5000,
        maxBandWidthPct: 10,
        maxPositionPerAgent: 0.05,
        maxPositionSystemAgent: 0.20,
        feedMaxEvents: 200,
      },
      safeguards: {
        indexRegistry: indexRegistry.getSafetyConfig?.() || {},
        agentManager: engine.getSafetyConfig?.() || {},
      },
      wallets: getWalletPolicySnapshot(),
      walletRuntime: getManagedWalletRuntimeSnapshot(),
      indexPolicies: getIndexPoliciesSnapshot(),
      marketMakers: Object.fromEntries(
        Object.entries(systemMMs).map(([id, mm]) => [id, mm.getSnapshot().config || {}])
      ),
    })
  })

  router.patch('/system-params', adminLimiter, requireAdminPermission('admin:system'), validate(updateSystemParamsSchema), (req, res) => {
    try {
      const { agentIndex, indexPolicies, engine: engineParams, safeguards, marketMaker, wallets } = req.body
      const changes = []
      const before = {
        tickIntervalMs: engine.TICK_INTERVAL || 3000,
        wallets: getWalletPolicySnapshot(),
        safeguards: {
          indexRegistry: indexRegistry.getSafetyConfig?.() || {},
          agentManager: engine.getSafetyConfig?.() || {},
        },
      }

      if (agentIndex && typeof agentIndex === 'object') {
        for (const [key, value] of Object.entries(agentIndex)) {
          if (key in AGENT_INDEX_CONFIG && typeof value === typeof AGENT_INDEX_CONFIG[key]) {
            if (typeof value === 'object' && value && mergeableAgentIndexKeys.has(key)) {
              Object.assign(AGENT_INDEX_CONFIG[key], value)
              changes.push(`agentIndex.${key} updated`)
            } else if (typeof value !== 'object') {
              AGENT_INDEX_CONFIG[key] = value
              changes.push(`agentIndex.${key} = ${value}`)
            }
          }
        }
      }

      if (engineParams?.tickIntervalMs && typeof engineParams.tickIntervalMs === 'number') {
        const newInterval = Math.max(1000, Math.min(30000, engineParams.tickIntervalMs))
        engine.TICK_INTERVAL = newInterval
        changes.push(`engine.tickIntervalMs = ${newInterval} (effective on next restart)`)
      }

      if (safeguards?.indexRegistry && typeof safeguards.indexRegistry === 'object' && indexRegistry.updateSafetyConfig) {
        indexRegistry.updateSafetyConfig(safeguards.indexRegistry)
        changes.push('safeguards.indexRegistry updated')
      }

      if (safeguards?.agentManager && typeof safeguards.agentManager === 'object' && engine.updateSafetyConfig) {
        engine.updateSafetyConfig(safeguards.agentManager)
        changes.push('safeguards.agentManager updated')
      }

      if (wallets && typeof wallets === 'object') {
        const nextWallets = mergeWalletPolicy({
          ...getWalletPolicySnapshot(),
          ...wallets,
        })
        if (nextWallets.managedWalletsEnabled && nextWallets.managedWalletCreationMode === 'admin-only' && !config.managedWallets?.masterSeed) {
          return fail(res, 'Admin-only managed custody requires backend env WDK_MASTER_SEED.', 400)
        }
        saveSystemState('wallet_policy', nextWallets)
        changes.push('wallets policy updated')
      }

      if (marketMaker && typeof marketMaker === 'object') {
        for (const [indexId, mmConfig] of Object.entries(marketMaker)) {
          const mm = systemMMs[indexId]
          if (mm && typeof mmConfig === 'object') {
            mm.updateConfig(mmConfig)
            changes.push(`marketMaker.${indexId} config updated`)
          }
        }
      }

      if (indexPolicies && typeof indexPolicies === 'object') {
        for (const [indexId, policy] of Object.entries(indexPolicies)) {
          const state = indexRegistry.indexes.get(indexId)
          if (!state || !policy || typeof policy !== 'object') continue

          const nextOverrides = {
            feePolicy: { ...(state.policyOverrides?.feePolicy || {}) },
            treasuryPolicy: { ...(state.policyOverrides?.treasuryPolicy || {}) },
            accountingPolicy: { ...(state.policyOverrides?.accountingPolicy || {}) },
            marketMaker: { ...(state.policyOverrides?.marketMaker || {}) },
          }

          if (policy.feePolicy && typeof policy.feePolicy === 'object') Object.assign(nextOverrides.feePolicy, policy.feePolicy)
          if (policy.treasuryPolicy && typeof policy.treasuryPolicy === 'object') Object.assign(nextOverrides.treasuryPolicy, policy.treasuryPolicy)
          if (policy.accountingPolicy && typeof policy.accountingPolicy === 'object') Object.assign(nextOverrides.accountingPolicy, policy.accountingPolicy)
          if (policy.marketMaker && typeof policy.marketMaker === 'object') {
            Object.assign(nextOverrides.marketMaker, policy.marketMaker)
            const mm = systemMMs[indexId]
            if (mm) mm.updateConfig(policy.marketMaker)
          }

          state.policyOverrides = nextOverrides
          if (indexRegistry.db?.upsertIndex) indexRegistry.db.upsertIndex(indexRegistry._serializeIndex(state))
          changes.push(`indexPolicies.${indexId} updated`)
        }
      }

      if (agentIndex && (agentIndex.autoDelistCheckIntervalMs || agentIndex.globalPoolRedistIntervalMs)) {
        agentIndexFactory.restartTimers()
        changes.push('factory timers restarted')
      }

      console.log(`⚙️  Admin updated system params: ${changes.join(', ')}`)
      writeAudit(req, 'system.params.update', 'system', 'runtime-config', {
        summary: changes.length > 0 ? changes.join(', ') : 'Submitted system parameter update',
        patch: req.body,
        changes,
        before,
        after: {
          tickIntervalMs: engine.TICK_INTERVAL || 3000,
          wallets: getWalletPolicySnapshot(),
          safeguards: {
            indexRegistry: indexRegistry.getSafetyConfig?.() || {},
            agentManager: engine.getSafetyConfig?.() || {},
          },
          indexPolicies: getIndexPoliciesSnapshot(),
        },
      })
      ok(res, { changes })
    } catch (err) {
      fail(res, err.message, 500)
    }
  })
}
