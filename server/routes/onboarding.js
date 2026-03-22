import { randomUUID } from 'crypto'
import { Router } from 'express'
import { authLimiter } from '../middleware/index.js'
import {
  validate, ok, fail,
  createManagedWalletSchema,
  linkWalletSchema,
  registerOnboardingSchema,
  upsertOnboardingProfileSchema,
} from '../validation/index.js'
import {
  createAuthSession,
  getUserProfile,
  insertManagedWalletRecord,
  listManagedWalletsByOwner,
  listWalletConnectionsByOwner,
  loadSystemState,
  upsertUser,
  upsertUserProfile,
  upsertWalletConnection,
} from '../runtimeAuthStore.js'
import { DEFAULT_WALLET_POLICY, describeWalletPolicy, mergeWalletPolicy } from '../services/walletPolicy.js'
import { setSessionCookie } from '../utils/sessionCookies.js'

export default function onboardingRoutes({ config, normalizeAddr, walletProviderRegistry }) {
  const router = Router()
  const cookieName = config.auth.sessionCookieName
  const sessionTtlMs = config.auth.sessionTtlMs

  async function getWalletPolicy() {
    return describeWalletPolicy(mergeWalletPolicy(await loadSystemState('wallet_policy', DEFAULT_WALLET_POLICY)))
  }

  function resolveOwnerAddress(req, explicitAddress) {
    const source = explicitAddress || req.userAddress || null
    return source ? normalizeAddr(source) : null
  }

  router.get('/onboarding/bootstrap', async (req, res, next) => {
    try {
      const ownerAddress = resolveOwnerAddress(req, req.query.address)
      const profile = ownerAddress ? await getUserProfile(ownerAddress) : null
      const linkedWallets = ownerAddress ? await listWalletConnectionsByOwner(ownerAddress) : []
      const managedWallets = ownerAddress ? await listManagedWalletsByOwner(ownerAddress) : []
      const walletPolicy = await getWalletPolicy()

      ok(res, {
        session: {
          authenticated: Boolean(req.userAddress),
          address: req.userAddress || null,
        },
        ownerAddress,
        profile,
        linkedWallets,
        managedWallets,
        walletPolicy,
        providers: walletProviderRegistry.listProviders().map((provider) => {
          if (provider.id === 'external-tonconnect') {
            return {
              ...provider,
              enabled: walletPolicy.externalWalletsEnabled,
            }
          }
          if (provider.id === 'wdk-ton') {
            return {
              ...provider,
              enabled: walletPolicy.managedWalletsEnabled,
              creationMode: walletPolicy.managedWalletCreationMode,
              publicCreateAllowed: walletPolicy.publicManagedWalletCreationAllowed,
            }
          }
          return provider
        }),
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/onboarding/wallets/managed/runtime', authLimiter, async (req, res) => {
    try {
      const ownerAddress = resolveOwnerAddress(req, req.query.address)
      if (!ownerAddress) {
        return fail(res, 'ownerAddress, connected wallet, or authenticated session required', 400)
      }

      const managedWallets = await listManagedWalletsByOwner(ownerAddress)
      const requestedWalletId = typeof req.query.walletId === 'string' ? req.query.walletId : null
      const managedWallet = requestedWalletId
        ? managedWallets.find((candidate) => candidate.id === requestedWalletId)
        : managedWallets.find((candidate) => candidate.status === 'active') || managedWallets[0]

      if (!managedWallet) {
        return fail(res, 'Managed wallet not found for owner', 404)
      }

      const runtime = await walletProviderRegistry.getManagedWalletRuntime({
        providerId: managedWallet.provider || 'wdk-ton',
        managedWallet,
      })

      ok(res, {
        ownerAddress,
        managedWallet,
        runtime,
        topUp: {
          targetAddress: runtime.address,
          suggestedComment: `ODROB top-up${managedWallet.label ? ` · ${managedWallet.label}` : ''}`,
          tonConnectSupported: true,
        },
      })
    } catch (err) {
      fail(res, 'Failed to load managed wallet runtime', 500, err.message)
    }
  })

  router.post('/onboarding/profile', authLimiter, validate(upsertOnboardingProfileSchema), async (req, res, next) => {
    try {
    const walletPolicy = getWalletPolicy()
    const ownerAddress = resolveOwnerAddress(req, req.body.ownerAddress)
    if (!walletPolicy.allowProfileWithoutWallet && !ownerAddress) return fail(res, 'Wallet or session required for profile registration', 400)
    if (!ownerAddress) return fail(res, 'ownerAddress or authenticated session required', 400)

    const profile = await upsertUserProfile({
      ownerAddress,
      displayName: req.body.displayName || null,
      username: req.body.username || null,
      registrationMode: 'optional',
      metadata: req.body.metadata || {},
    })

    ok(res, { profile })
    } catch (error) {
      next(error)
    }
  })

  router.post('/onboarding/register', authLimiter, validate(registerOnboardingSchema), async (req, res) => {
    try {
      const walletPolicy = await getWalletPolicy()
      const autoProvisionAllowedByPolicy = walletPolicy.managedWalletsEnabled
        && walletPolicy.autoProvisionManagedWalletOnRegistration
        && walletPolicy.managedWalletCreationMode === 'admin-only'
      if (req.body.autoProvisionManagedWallet === true && !autoProvisionAllowedByPolicy) {
        return fail(res, 'Managed wallet auto-provisioning is disabled by policy', 403)
      }
      const shouldAutoProvision = autoProvisionAllowedByPolicy

      let ownerAddress = resolveOwnerAddress(req, req.body.ownerAddress)
      let managedWallet = null
      let linkedWallet = null
      let recoveryPhrase = null

      if (!ownerAddress && !shouldAutoProvision && !walletPolicy.allowProfileWithoutWallet) {
        return fail(res, 'Wallet or managed wallet provisioning required for registration', 400)
      }

      if (shouldAutoProvision) {
        const created = await walletProviderRegistry.createManagedWallet({
          providerId: 'wdk-ton',
          ownerAddress,
          mode: 'create',
          label: req.body.managedWalletLabel || req.body.displayName,
        })

        if (!ownerAddress) ownerAddress = created.wallet.address

        managedWallet = await insertManagedWalletRecord({
          id: randomUUID(),
          ownerAddress,
          walletId: created.wallet.id,
          walletAddress: created.wallet.address,
          provider: created.providerId,
          mode: created.mode,
          label: req.body.managedWalletLabel || req.body.displayName || null,
          accountIndex: created.managedWallet.accountIndex || 0,
          derivationPath: created.managedWallet.derivationPath || null,
          status: 'active',
          metadata: {
            ...created.managedWallet.metadata,
            source: 'registration-auto-provision',
          },
        })

        linkedWallet = await upsertWalletConnection({
          id: randomUUID(),
          ownerAddress,
          walletAddress: created.wallet.address,
          walletKind: 'managed',
          walletProvider: created.providerId,
          walletRef: created.wallet.id,
          label: req.body.managedWalletLabel || req.body.displayName || null,
          isPrimary: ownerAddress === created.wallet.address,
          metadata: {
            managedWalletId: managedWallet.id,
            provisionedBy: 'system-registration',
            accountIndex: created.managedWallet.accountIndex || 0,
            derivationPath: created.managedWallet.derivationPath || null,
          },
        })

        recoveryPhrase = created.recoveryPhrase
      }

      if (!ownerAddress) {
        return fail(res, 'Unable to resolve owner identity for registration', 400)
      }

      const user = await upsertUser(ownerAddress)
      const profile = await upsertUserProfile({
        ownerAddress,
        displayName: req.body.displayName || null,
        username: req.body.username || null,
        registrationMode: shouldAutoProvision ? 'managed-auto' : 'optional',
        metadata: {
          ...(req.body.metadata || {}),
          autoProvisionManagedWallet: shouldAutoProvision,
        },
      })

      const session = await createAuthSession({
        address: ownerAddress,
        userAgent: req.headers['user-agent'] || '',
        ip: req.ip || req.socket?.remoteAddress || '',
        ttlMs: sessionTtlMs,
      })
      setSessionCookie(res, cookieName, session.id, { isProd: config.isProd, maxAge: sessionTtlMs })

      ok(res, {
        user: { address: user.address, createdAt: user.created_at },
        profile,
        linkedWallet,
        managedWallet,
        recoveryPhrase,
        session: {
          address: ownerAddress,
          expiresAt: session.expiresAt,
        },
      }, 201)
    } catch (err) {
      fail(res, 'Failed to register user', 500, err.message)
    }
  })

  router.post('/onboarding/wallets/link', authLimiter, validate(linkWalletSchema), async (req, res, next) => {
    try {
    const walletPolicy = await getWalletPolicy()
    const ownerAddress = resolveOwnerAddress(req, req.body.ownerAddress)
    const walletAddress = normalizeAddr(req.body.walletAddress)

    if (req.body.walletKind === 'readonly' && !walletPolicy.allowReadonlyWalletLinking) {
      return fail(res, 'Readonly wallet linking is disabled by policy', 403)
    }
    if (req.body.walletKind === 'external' && !walletPolicy.externalWalletsEnabled) {
      return fail(res, 'External wallet linking is disabled by policy', 403)
    }
    if (req.body.walletKind === 'managed' && !walletPolicy.managedWalletsEnabled) {
      return fail(res, 'Managed wallet linking is disabled by policy', 403)
    }

    const linkedWallet = await upsertWalletConnection({
      id: req.body.id || randomUUID(),
      ownerAddress,
      walletAddress,
      walletKind: req.body.walletKind,
      walletProvider: req.body.walletProvider,
      walletRef: req.body.walletRef || null,
      label: req.body.label || null,
      isPrimary: req.body.isPrimary ? 1 : 0,
      metadata: req.body.metadata || {},
    })

    ok(res, { linkedWallet }, 201)
    } catch (error) {
      next(error)
    }
  })

  router.post('/onboarding/wallets/managed', authLimiter, validate(createManagedWalletSchema), async (req, res) => {
    try {
      const walletPolicy = await getWalletPolicy()
      if (!walletPolicy.managedWalletsEnabled) {
        return fail(res, 'Managed wallets are disabled by policy', 403)
      }
      if (walletPolicy.managedWalletCreationMode === 'disabled') {
        return fail(res, 'Managed wallet creation is disabled', 403)
      }
      if (walletPolicy.managedWalletCreationMode === 'admin-only') {
        return fail(res, 'Managed wallet creation is admin-only in the current policy', 403)
      }
      if (walletPolicy.requireSessionForManagedWallets && !req.userAddress) {
        return fail(res, 'Authenticated session required for managed wallet creation', 401)
      }

      const ownerAddress = resolveOwnerAddress(req, req.body.ownerAddress)
      const created = await walletProviderRegistry.createManagedWallet({
        providerId: req.body.providerId || 'wdk-ton',
        ownerAddress,
        mode: req.body.mode,
        mnemonic: req.body.mnemonic,
        label: req.body.label,
        accountIndex: req.body.accountIndex,
        derivationPath: req.body.derivationPath,
      })

      const managedWallet = await insertManagedWalletRecord({
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
          source: 'onboarding',
        },
      })

      const linkedWallet = await upsertWalletConnection({
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
          accountIndex: created.managedWallet.accountIndex || 0,
          derivationPath: created.managedWallet.derivationPath || null,
        },
      })

      ok(res, {
        wallet: created.wallet,
        managedWallet,
        linkedWallet,
        recoveryPhrase: created.recoveryPhrase,
      }, 201)
    } catch (err) {
      fail(res, 'Failed to create managed wallet', 500, err.message)
    }
  })

  return router
}