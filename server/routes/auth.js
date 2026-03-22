import { randomUUID } from 'crypto'
import { Router } from 'express'
import { authLimiter } from '../middleware/index.js'
import { fail, ok, validate, privyVerifySchema, setActiveWalletSchema } from '../validation/index.js'
import { setSessionCookie } from '../utils/sessionCookies.js'

export default function authRoutes({
  auth,
  config,
  privyAuthService,
  managedWalletProvisioning,
  createAppUser,
  getAppUser,
  getAppUserByPrimaryWallet,
  updateAppUserPrimaryWallet,
  getAuthIdentity,
  upsertAuthIdentity,
  listAuthIdentitiesByUserId,
  listUserWalletsByUserId,
  getUserWalletByAddress,
  listWalletConnectionsByOwner,
  listManagedWalletsByOwner,
  createAuthSession,
  updateAuthSessionActiveWallet,
}) {
  const router = Router()
  const cookieName = config.auth.sessionCookieName
  const sessionTtlMs = config.auth.sessionTtlMs

  function resolvePrivyAccessToken(req) {
    const authorizationHeader = typeof req.headers.authorization === 'string'
      ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim()
      : ''
    const bodyAccessToken = typeof req.body?.accessToken === 'string'
      ? req.body.accessToken.trim()
      : ''
    return bodyAccessToken || authorizationHeader || null
  }

  function summarizeManagedWallet(wallets = []) {
    return wallets.find((wallet) => wallet.walletKind === 'managed' && wallet.walletProvider === 'wdk-ton') || null
  }

  function summarizePrivyWallets(authIdentities = []) {
    const walletMap = new Map()

    authIdentities
      .filter((identity) => identity.provider === 'privy')
      .forEach((identity) => {
        const wallets = Array.isArray(identity.metadata?.wallets) ? identity.metadata.wallets : []
        wallets.forEach((wallet, index) => {
          const address = typeof wallet?.address === 'string' ? wallet.address.trim() : ''
          if (!address) return
          const chainType = typeof wallet?.chainType === 'string'
            ? wallet.chainType
            : (typeof wallet?.chain_type === 'string' ? wallet.chain_type : null)
          const walletClient = typeof wallet?.walletClient === 'string'
            ? wallet.walletClient
            : (typeof wallet?.wallet_client === 'string' ? wallet.wallet_client : 'privy')
          const dedupeKey = `${String(chainType || '').toLowerCase()}:${address.toLowerCase()}`
          if (walletMap.has(dedupeKey)) return
          walletMap.set(dedupeKey, {
            id: wallet.id || `${identity.identityType || 'privy'}:${address}:${index}`,
            address,
            chainType,
            walletClient,
            walletClientType: wallet.walletClientType || wallet.wallet_client_type || walletClient,
          })
        })
      })

    return Array.from(walletMap.values())
  }

  function summarizePrivyIdentity(authIdentities = []) {
    const privyIdentity = authIdentities.find((identity) => identity.provider === 'privy' && identity.providerUserId)
    if (!privyIdentity) return null

    const wallets = summarizePrivyWallets(authIdentities)

    return {
      userId: privyIdentity.providerUserId,
      imported: privyIdentity.identityType === 'custom_auth',
      customAuthLinked: authIdentities.some((identity) => identity.provider === 'privy' && identity.identityType === 'custom_auth'),
      accessTokenLinked: authIdentities.some((identity) => identity.provider === 'privy' && identity.identityType === 'privy-access-token'),
      wallets,
    }
  }

  async function resolveAppUserForPrivyVerification({ verifiedUserId, requestAuth }) {
    const privyAccessIdentity = await getAuthIdentity('privy', verifiedUserId, 'privy-access-token')
    if (privyAccessIdentity?.userId) {
      return {
        identity: privyAccessIdentity,
        appUser: await getAppUser(privyAccessIdentity.userId),
      }
    }

    const importedPrivyIdentity = await getAuthIdentity('privy', verifiedUserId, 'custom_auth')
    if (importedPrivyIdentity?.userId) {
      return {
        identity: importedPrivyIdentity,
        appUser: await getAppUser(importedPrivyIdentity.userId),
      }
    }

    if (requestAuth?.userId) {
      return {
        identity: null,
        appUser: await getAppUser(requestAuth.userId),
      }
    }

    if (requestAuth?.activeWalletAddress) {
      return {
        identity: null,
        appUser: await getAppUserByPrimaryWallet(requestAuth.activeWalletAddress),
      }
    }

    return {
      identity: null,
      appUser: null,
    }
  }

  function buildSessionPayload({ session, appUser, authIdentities, linkedWallets }) {
    const managedWallet = summarizeManagedWallet(linkedWallets)
    const activeWalletAddress = session?.activeWalletAddress || session?.address || appUser?.primaryWalletAddress || null
    const privy = summarizePrivyIdentity(authIdentities)
    return {
      authenticated: true,
      userId: appUser?.id || session?.userId || null,
      authSource: session?.authProvider || 'session',
      authLevel: session?.authLevel || 'wallet_verified',
      privyUserId: session?.privyUserId || session?.privy_user_id || privy?.userId || null,
      privy,
      authMethods: authIdentities.map((identity) => ({
        provider: identity.provider,
        type: identity.identityType,
        providerUserId: identity.providerUserId,
        email: identity.email || null,
      })),
      linkedWallets,
      managedWallet,
      activeWalletAddress,
      canTrade: Boolean(activeWalletAddress),
      canCreateAgent: Boolean(activeWalletAddress),
      canPublishStrategy: Boolean(activeWalletAddress),
      session: {
        id: session?.id || null,
        expiresAt: session?.expiresAt || null,
      },
      user: appUser ? {
        id: appUser.id,
        primaryWalletAddress: appUser.primaryWalletAddress,
        status: appUser.status,
        metadata: appUser.metadata,
      } : null,
    }
  }

  router.post('/auth/privy/verify', authLimiter, async (req, res) => {
    try {
      if (!privyAuthService.isConfigured) {
        return fail(res, 'Privy authentication is not configured on the server', 503)
      }

      const parseResult = privyVerifySchema.safeParse(req.body || {})
      if (!parseResult.success) {
        const accessTokenFromHeader = resolvePrivyAccessToken(req)
        if (!accessTokenFromHeader) {
          return fail(res, parseResult.error.issues[0]?.message || 'Privy access token is required', 400, parseResult.error.flatten())
        }
      }

      const accessToken = resolvePrivyAccessToken(req)
      if (!accessToken) return fail(res, 'Privy access token is required', 400)

      const verified = await privyAuthService.verifyAccessToken(accessToken)
      let { identity, appUser } = await resolveAppUserForPrivyVerification({
        verifiedUserId: verified.userId,
        requestAuth: req.auth,
      })

      if (!appUser) {
        appUser = await createAppUser({
          id: randomUUID(),
          primaryWalletAddress: req.auth?.activeWalletAddress || null,
          metadata: {
            createdBy: 'privy-auth',
            privyUserId: verified.userId,
          },
        })
      }

      identity = await upsertAuthIdentity({
        id: identity?.id,
        userId: appUser.id,
        provider: 'privy',
        providerUserId: verified.userId,
        identityType: 'privy-access-token',
        subject: verified.userId,
        verifiedAt: Date.now(),
        metadata: {
          sessionId: verified.sessionId,
          appId: verified.appId,
          issuer: verified.issuer,
        },
      })

      let provisioning = null
      if (config.privy.autoProvisionWdkWallet) {
        try {
          provisioning = await managedWalletProvisioning.ensureManagedWalletForUser({
            userId: appUser.id,
            ownerAddress: appUser.primaryWalletAddress || req.auth?.activeWalletAddress || null,
            source: 'privy-auth-auto-provision',
            label: 'Privy managed wallet',
          })
          appUser = provisioning.appUser
        } catch (provisioningError) {
          console.warn('Privy managed wallet auto-provision skipped:', provisioningError.message)
        }
      }

      const activeWalletAddress = req.auth?.activeWalletAddress
        || provisioning?.managedWallet?.walletAddress
        || appUser.primaryWalletAddress
        || null

      if (!appUser.primaryWalletAddress && activeWalletAddress) {
        appUser = await updateAppUserPrimaryWallet(appUser.id, activeWalletAddress)
      }

      const session = await createAuthSession({
        address: activeWalletAddress,
        activeWalletAddress,
        userAgent: req.headers['user-agent'] || '',
        ip: req.ip || req.socket?.remoteAddress || '',
        ttlMs: sessionTtlMs,
        userId: appUser.id,
        authProvider: 'privy',
        authLevel: 'wallet_verified',
        privyUserId: verified.userId,
      })
      setSessionCookie(res, cookieName, session.id, { isProd: config.isProd, maxAge: sessionTtlMs })

      const linkedWallets = await listUserWalletsByUserId(appUser.id)
      const authIdentities = await listAuthIdentitiesByUserId(appUser.id)

      ok(res, {
        ...buildSessionPayload({ session, appUser, authIdentities, linkedWallets }),
        managedWalletProvisioned: Boolean(provisioning?.created),
      }, provisioning?.created ? 201 : 200)
    } catch (err) {
      console.error('Privy auth verify failed:', err.message)
      fail(res, 'Failed to verify Privy authentication', 401, err.message)
    }
  })

  router.get('/auth/session', async (req, res, next) => {
    try {
    if (!req.sessionId && !req.userAddress) {
      return ok(res, {
        authenticated: false,
        userId: null,
        authSource: null,
        privyUserId: null,
        privy: null,
        authMethods: [],
        linkedWallets: [],
        managedWallet: null,
        activeWalletAddress: null,
        canTrade: false,
        canCreateAgent: false,
        canPublishStrategy: false,
      })
    }

    if (req.auth?.userId) {
      const appUser = await getAppUser(req.auth.userId)
      const linkedWallets = await listUserWalletsByUserId(req.auth.userId)
      const authIdentities = await listAuthIdentitiesByUserId(req.auth.userId)
      return ok(res, buildSessionPayload({
        session: {
          id: req.sessionId,
          userId: req.auth.userId,
          authProvider: req.auth.authSource,
          authLevel: req.auth.authLevel,
          activeWalletAddress: req.auth.activeWalletAddress,
        },
        appUser,
        authIdentities,
        linkedWallets,
      }))
    }

    const linkedWallets = req.userAddress ? await listWalletConnectionsByOwner(req.userAddress) : []
    const managedWallets = req.userAddress ? await listManagedWalletsByOwner(req.userAddress) : []
    return ok(res, {
      authenticated: Boolean(req.userAddress),
      userId: null,
      authSource: 'session',
      privyUserId: req.auth?.privyUserId || null,
      privy: req.auth?.privyUserId ? { userId: req.auth.privyUserId, imported: false, customAuthLinked: false, accessTokenLinked: false } : null,
      authMethods: [],
      linkedWallets,
      managedWallet: managedWallets[0] || null,
      activeWalletAddress: req.userAddress || null,
      canTrade: Boolean(req.userAddress),
      canCreateAgent: Boolean(req.userAddress),
      canPublishStrategy: Boolean(req.userAddress),
    })
    } catch (error) {
      next(error)
    }
  })

  router.post('/auth/active-wallet', auth, validate(setActiveWalletSchema), async (req, res, next) => {
    try {
    const walletAddress = req.body.walletAddress
    const walletProvider = req.body.walletProvider || 'wdk-ton'

    if (!req.sessionId) return fail(res, 'Active session required', 401)

    if (req.auth?.userId) {
      const linkedWallet = await getUserWalletByAddress(walletAddress, walletProvider)
      if (!linkedWallet || linkedWallet.userId !== req.auth.userId || !linkedWallet.isActive) {
        return fail(res, 'Wallet is not linked to the current user', 403)
      }
      await updateAuthSessionActiveWallet(req.sessionId, walletAddress)
      return ok(res, { activeWalletAddress: walletAddress, linkedWallet })
    }

    const linkedWallet = (await listWalletConnectionsByOwner(req.userAddress || '')).find((candidate) => candidate.walletAddress === walletAddress)
    if (!linkedWallet) return fail(res, 'Wallet is not linked to the current session owner', 403)

    await updateAuthSessionActiveWallet(req.sessionId, walletAddress)
    ok(res, { activeWalletAddress: walletAddress, linkedWallet })
    } catch (error) {
      next(error)
    }
  })

  return router
}
