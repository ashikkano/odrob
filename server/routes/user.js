// ═══════════════════════════════════════════════════════════════════════
// User Routes — Wallet-gated legacy agent management
// ═══════════════════════════════════════════════════════════════════════

import { Router } from 'express'
import { randomUUID } from 'crypto'
import { authLimiter } from '../middleware/index.js'
import {
  validate, ok, fail, notFound,
  authSchema, createLegacyAgentSchema, updateLegacyAgentSchema, depositSchema,
} from '../validation/index.js'
import {
  countLegacyByOwner,
  consumeAuthNonce,
  createAppUser,
  createAuthSession,
  deleteAuthSession,
  deleteLegacyAgent,
  getAppUserByPrimaryWallet,
  getLegacyAgent,
  getLegacyAgentsByOwner,
  getUser,
  insertLegacyAgent,
  insertManagedWalletRecord,
  issueAuthNonce,
  listManagedWalletsByOwner,
  loadSystemState,
  updateLegacyAgent,
  upsertAuthIdentity,
  upsertUser,
  upsertUserWallet,
  upsertWalletConnection,
} from '../runtimeAuthStore.js'
import { DEFAULT_WALLET_POLICY, mergeWalletPolicy } from '../services/walletPolicy.js'
import { clearSessionCookie, setSessionCookie } from '../utils/sessionCookies.js'

/**
 * @param {{ auth, config, normalizeAddr, createTonWallet, getTonBalance, deleteTonWalletById, walletProviderRegistry, privyAuthService }} deps
 */
export default function userRoutes({ auth, config, normalizeAddr, createTonWallet, getTonBalance, deleteTonWalletById, walletProviderRegistry, privyAuthService }) {
  const router = Router()
  const cookieName = config.auth.sessionCookieName
  const sessionTtlMs = config.auth.sessionTtlMs
  const challengeTtlMs = config.auth.challengeTtlMs

  async function getWalletPolicy() {
    return mergeWalletPolicy(await loadSystemState('wallet_policy', DEFAULT_WALLET_POLICY))
  }

  async function ensureAppUserForTonConnect(address) {
    let appUser = await getAppUserByPrimaryWallet(address)
    if (!appUser) {
      appUser = await createAppUser({
        id: randomUUID(),
        primaryWalletAddress: address,
        metadata: {
          createdBy: 'tonconnect-auth',
          tonAddress: address,
        },
      })
    }

    await upsertAuthIdentity({
      userId: appUser.id,
      provider: 'tonconnect',
      providerUserId: address,
      identityType: 'wallet',
      subject: address,
      verifiedAt: Date.now(),
      metadata: {
        authSource: 'tonconnect',
      },
    })

    await upsertUserWallet({
      id: `ton-${address}`,
      userId: appUser.id,
      walletAddress: address,
      walletKind: 'external',
      walletProvider: 'external-tonconnect',
      walletRef: address,
      label: 'TonConnect wallet',
      isPrimary: true,
      isActive: true,
      metadata: {
        authSource: 'tonconnect',
        autoLinked: true,
      },
    })

    return appUser
  }

  async function ensureWalletIdentitiesForTonConnect(address, appUser) {
    const walletPolicy = await getWalletPolicy()

    const externalLink = await upsertWalletConnection({
      id: `ext-${address}`,
      ownerAddress: address,
      walletAddress: address,
      walletKind: 'external',
      walletProvider: 'external-tonconnect',
      walletRef: address,
      label: 'TonConnect wallet',
      isPrimary: true,
      metadata: {
        authSource: 'tonconnect',
        autoLinked: true,
      },
    })

    let managedWallet = null
    const shouldAutoProvisionManagedWallet = walletPolicy.managedWalletsEnabled
      && walletPolicy.managedWalletCreationMode === 'admin-only'
      && walletPolicy.autoProvisionManagedWalletOnRegistration

    if (shouldAutoProvisionManagedWallet) {
      const existingManaged = await listManagedWalletsByOwner(address)
      if (!existingManaged.length) {
        const created = await walletProviderRegistry.createManagedWallet({
          providerId: 'wdk-ton',
          ownerAddress: address,
          mode: 'create',
          label: 'Auto-provisioned managed wallet',
        })

        managedWallet = await insertManagedWalletRecord({
          id: `managed-${created.wallet.id}`,
          ownerAddress: address,
          walletId: created.wallet.id,
          walletAddress: created.wallet.address,
          provider: created.providerId,
          mode: created.mode,
          label: 'Auto-provisioned managed wallet',
          accountIndex: created.managedWallet.accountIndex || 0,
          derivationPath: created.managedWallet.derivationPath || null,
          status: 'active',
          metadata: {
            ...created.managedWallet.metadata,
            source: 'tonconnect-auth-auto-provision',
          },
        })

        await upsertWalletConnection({
          id: `managed-link-${created.wallet.id}`,
          ownerAddress: address,
          walletAddress: created.wallet.address,
          walletKind: 'managed',
          walletProvider: created.providerId,
          walletRef: created.wallet.id,
          label: 'Platform-managed custody wallet',
          isPrimary: false,
          metadata: {
            managedWalletId: managedWallet.id,
            provisionedBy: 'tonconnect-auth-auto',
            accountIndex: created.managedWallet.accountIndex || 0,
          },
        })

        if (appUser?.id) {
          await upsertUserWallet({
            id: `managed-user-${created.wallet.id}`,
            userId: appUser.id,
            walletAddress: created.wallet.address,
            walletKind: 'managed',
            walletProvider: created.providerId,
            walletRef: created.wallet.id,
            label: 'Platform-managed custody wallet',
            isPrimary: false,
            isActive: true,
            metadata: {
              managedWalletId: managedWallet.id,
              provisionedBy: 'tonconnect-auth-auto',
              accountIndex: created.managedWallet.accountIndex || 0,
            },
          })
        }
      } else {
        managedWallet = existingManaged[0]
        if (appUser?.id && managedWallet?.walletAddress) {
          await upsertUserWallet({
            id: `managed-user-existing-${managedWallet.id}`,
            userId: appUser.id,
            walletAddress: managedWallet.walletAddress,
            walletKind: 'managed',
            walletProvider: managedWallet.provider,
            walletRef: managedWallet.walletId,
            label: managedWallet.label || 'Platform-managed custody wallet',
            isPrimary: false,
            isActive: true,
            metadata: {
              managedWalletId: managedWallet.id,
              provisionedBy: 'tonconnect-auth-auto',
              restoredFromOwnerRecord: true,
              accountIndex: managedWallet.accountIndex || 0,
            },
          })
        }
      }
    }

    return {
      walletPolicy,
      externalLink,
      managedWallet,
    }
  }

  async function ensurePrivyUserForTonConnect(address, appUser) {
    if (!privyAuthService?.isUserProvisioningConfigured || !appUser?.id) return null

    const provisioned = await privyAuthService.getImportedUserByTonAddress(address)
    if (!provisioned?.userId) return null

    await upsertAuthIdentity({
      userId: appUser.id,
      provider: 'privy',
      providerUserId: provisioned.userId,
      identityType: 'custom_auth',
      subject: provisioned.customUserId,
      verifiedAt: Date.now(),
      metadata: {
        importedFrom: 'tonconnect',
        tonAddress: address,
        walletCount: Array.isArray(provisioned.wallets) ? provisioned.wallets.length : 0,
        wallets: provisioned.wallets || [],
      },
    })

    return provisioned
  }

  // Helper: get agent owned by authenticated user
  async function getOwnedAgent(req, res) {
    const agent = await getLegacyAgent(req.params.id)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return null }
    if (normalizeAddr(agent.ownerAddress) !== normalizeAddr(req.userAddress)) { res.status(403).json({ error: 'Access denied' }); return null }
    return agent
  }

  // Wallet challenge (nonce)
  router.post('/auth/challenge', authLimiter, validate(authSchema), async (req, res) => {
    const norm = normalizeAddr(req.body.address)
    const issued = await issueAuthNonce(norm, challengeTtlMs)
    ok(res, { address: norm, nonce: issued.nonce, expiresAt: issued.expiresAt })
  })

  // Auth endpoint (session issue) — nonce is mandatory (SEC-003)
  router.post('/auth', authLimiter, validate(authSchema), async (req, res) => {
    const norm = normalizeAddr(req.body.address)

    // SEC-003: Mandatory nonce verification — prevents replay attacks
    if (!req.body.nonce) return fail(res, 'Nonce is required. Call POST /api/auth/challenge first.', 400)
    const valid = await consumeAuthNonce(norm, String(req.body.nonce))
    if (!valid) return fail(res, 'Invalid or expired auth challenge', 401)

    const user = await upsertUser(norm)
    const appUser = await ensureAppUserForTonConnect(norm)

    let privyProvisioning = null
    try {
      privyProvisioning = await ensurePrivyUserForTonConnect(norm, appUser)
    } catch (err) {
      console.error('TonConnect Privy provisioning failed:', err.message)
    }

    const session = await createAuthSession({
      address: norm,
      userAgent: req.headers['user-agent'] || '',
      ip: req.ip || req.socket?.remoteAddress || '',
      ttlMs: sessionTtlMs,
      userId: appUser.id,
      authProvider: 'tonconnect',
      authLevel: 'wallet_verified',
      activeWalletAddress: norm,
      privyUserId: privyProvisioning?.userId || null,
    })
    setSessionCookie(res, cookieName, session.id, { isProd: config.isProd, maxAge: sessionTtlMs })

    let onboarding = null
    try {
      onboarding = await ensureWalletIdentitiesForTonConnect(norm, appUser)
    } catch (err) {
      console.error('TonConnect auto-onboarding failed:', err.message)
    }

    console.log(`👤 Auth: ${norm.slice(0, 12)}...`)
    const agentCount = await countLegacyByOwner(norm)
    ok(res, {
      user: { address: user.address, createdAt: user.created_at },
      agentCount,
      session: { expiresAt: session.expiresAt },
      privy: privyProvisioning ? {
        userId: privyProvisioning.userId,
        customUserId: privyProvisioning.customUserId,
        created: privyProvisioning.created,
        wallets: privyProvisioning.wallets,
      } : null,
      onboarding: onboarding ? {
        policy: onboarding.walletPolicy,
        externalWalletLinked: Boolean(onboarding.externalLink),
        managedWalletProvisioned: Boolean(onboarding.managedWallet),
        managedWalletAddress: onboarding.managedWallet?.walletAddress || null,
      } : null,
    })
  })

  router.post('/auth/logout', async (req, res) => {
    const sid = req.cookies?.[cookieName]
    if (sid) await deleteAuthSession(sid)
    clearSessionCookie(res, cookieName, { isProd: config.isProd })
    ok(res, { loggedOut: true })
  })

  // Current user
  router.get('/me', auth, async (req, res, next) => {
    try {
      const user = await getUser(req.userAddress)
      const agentCount = await countLegacyByOwner(req.userAddress)
      ok(res, { user: { address: user.address, createdAt: user.created_at }, agentCount })
    } catch (error) {
      next(error)
    }
  })

  // Legacy agents CRUD
  router.get('/agents', auth, async (req, res, next) => {
    try {
      ok(res, await getLegacyAgentsByOwner(req.userAddress))
    } catch (error) {
      next(error)
    }
  })

  router.post('/agents', auth, validate(createLegacyAgentSchema), async (req, res) => {
    try {
      const { name, preset, strategy, index, icon, config, riskParams } = req.body
      const wallet = await createTonWallet()
      const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const agent = {
        id, ownerAddress: req.userAddress, name, preset,
        strategy: strategy || 'mean_reversion', index: index || 'FLOOR',
        icon: icon || '🤖', status: 'funding',
        walletId: wallet.id, walletAddress: wallet.address,
        walletAddressBounceable: wallet.addressBounceable,
        walletPublicKey: wallet.publicKey,
        balance: 0, initialBalance: 0,
        config: config || {}, riskParams: riskParams || {},
        deposits: [], createdAt: Date.now(), startedAt: null,
      }
      await insertLegacyAgent(agent)
      ok(res, agent, 201)
    } catch (err) { fail(res, 'Failed to create agent', 500, err.message) }
  })

  router.get('/agents/:id', auth, async (req, res) => {
    const agent = await getOwnedAgent(req, res)
    if (!agent) return
    ok(res, agent)
  })

  router.patch('/agents/:id', auth, validate(updateLegacyAgentSchema), async (req, res) => {
    const agent = await getOwnedAgent(req, res)
    if (!agent) return
    const allowed = ['name', 'config', 'riskParams']
    for (const key of allowed) {
      if (req.body[key] !== undefined) agent[key] = req.body[key]
    }
    await updateLegacyAgent(agent)
    ok(res, agent)
  })

  router.delete('/agents/:id', auth, async (req, res) => {
    const agent = await getOwnedAgent(req, res)
    if (!agent) return
    await deleteLegacyAgent(req.params.id)
    if (agent.walletId) await deleteTonWalletById(agent.walletId)
    ok(res, { deleted: true })
  })

  router.post('/agents/:id/start', auth, async (req, res) => {
    const agent = await getOwnedAgent(req, res)
    if (!agent) return
    agent.status = 'active'
    agent.startedAt = Date.now()
    await updateLegacyAgent(agent)
    ok(res, agent)
  })

  router.post('/agents/:id/pause', auth, async (req, res) => {
    const agent = await getOwnedAgent(req, res)
    if (!agent) return
    agent.status = 'paused'
    await updateLegacyAgent(agent)
    ok(res, agent)
  })

  router.post('/agents/:id/stop', auth, async (req, res) => {
    const agent = await getOwnedAgent(req, res)
    if (!agent) return
    agent.status = 'stopped'
    await updateLegacyAgent(agent)
    ok(res, agent)
  })

  router.get('/agents/:id/balance', auth, async (req, res) => {
    const agent = await getOwnedAgent(req, res)
    if (!agent) return
    const { balance, balanceNano } = await getTonBalance(agent.walletId)
    agent.balance = balance
    if (balance > 0 && agent.status === 'funding') agent.status = 'idle'
    if (!agent.initialBalance && balance > 0) agent.initialBalance = balance
    await updateLegacyAgent(agent)
    ok(res, { balance, balanceNano, agent })
  })

  router.post('/agents/:id/deposit', auth, validate(depositSchema), async (req, res) => {
    const agent = await getOwnedAgent(req, res)
    if (!agent) return
    const { amount, txHash } = req.body
    agent.deposits = [...(agent.deposits || []), { amount, txHash, timestamp: Date.now() }]
    await updateLegacyAgent(agent)
    ok(res, agent)
  })

  return router
}
