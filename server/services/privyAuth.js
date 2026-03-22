import { importSPKI, jwtVerify } from 'jose'

function normalizeVerificationKey(value) {
  if (!value) return null
  const trimmed = String(value).trim()
  if (trimmed.includes('BEGIN PUBLIC KEY')) return trimmed
  return `-----BEGIN PUBLIC KEY-----\n${trimmed}\n-----END PUBLIC KEY-----`
}

function coerceAudience(payload) {
  if (Array.isArray(payload.aud)) return payload.aud
  if (typeof payload.aud === 'string') return [payload.aud]
  if (typeof payload.appId === 'string') return [payload.appId]
  if (typeof payload.app_id === 'string') return [payload.app_id]
  return []
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function normalizeTonCustomAuthId(address) {
  const normalized = typeof address === 'string' ? address.trim().toLowerCase() : ''
  if (!normalized) return null
  return `ton:${normalized}`
}

function summarizePrivyWallets(user) {
  const linkedAccounts = Array.isArray(user?.linked_accounts) ? user.linked_accounts : []
  return linkedAccounts
    .filter((account) => account?.type === 'wallet' && account?.wallet_client === 'privy' && account?.address)
    .map((account) => ({
      address: account.address,
      chainType: account.chain_type || null,
      walletClient: account.wallet_client || 'privy',
      walletClientType: account.wallet_client_type || 'privy',
    }))
}

function resolvePrivyService(client, serviceName) {
  const value = client?.[serviceName]
  if (typeof value === 'function') return value.call(client)
  return value || null
}

function resolvePrivyAuthUtils(client) {
  const utils = resolvePrivyService(client, 'utils')
  if (!utils) return null
  const auth = utils?.auth
  if (typeof auth === 'function') return auth.call(utils)
  return auth || null
}

export function createPrivyAuthService({ config }) {
  let clientPromise = null
  let verificationPromise = null

  async function getPrivyClient() {
    if (clientPromise) return clientPromise
    if (!config?.appId || !config?.appSecret) {
      throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET are required for SDK verification')
    }

    clientPromise = import('@privy-io/node')
      .then(({ PrivyClient }) => new PrivyClient({
        appId: config.appId,
        appSecret: config.appSecret,
      }))
      .catch((error) => {
        clientPromise = null
        throw error
      })

    return clientPromise
  }

  async function getVerificationKey() {
    if (verificationPromise) return verificationPromise
    const pem = normalizeVerificationKey(config?.verificationKey)
    if (!pem) throw new Error('PRIVY_VERIFICATION_KEY is not configured')

    verificationPromise = importSPKI(pem, 'EdDSA').catch((error) => {
      verificationPromise = null
      throw error
    })
    return verificationPromise
  }

  async function verifyAccessToken(accessToken) {
    if (!config?.enabled) throw new Error('Privy authentication is disabled')
    if (!accessToken) throw new Error('Privy access token is required')

    if (config?.appId && config?.appSecret) {
      const client = await getPrivyClient()
      const authUtils = resolvePrivyAuthUtils(client)
      if (!authUtils?.verifyAccessToken) {
        throw new Error('Privy SDK auth utilities are unavailable')
      }
      const verified = await authUtils.verifyAccessToken(accessToken)
      const userId = pickString(verified.user_id, verified.userId, verified.sub)
      if (!userId) throw new Error('Privy token is missing user id')
      return {
        userId,
        sessionId: pickString(verified.session_id, verified.sessionId) || null,
        appId: pickString(verified.app_id, verified.appId, config.appId) || null,
        issuer: pickString(verified.issuer, verified.iss, 'privy.io') || 'privy.io',
        issuedAt: pickNumber(verified.issued_at, verified.issuedAt),
        expiration: pickNumber(verified.expiration, verified.exp),
        claims: verified.claims || {},
      }
    }

    const key = await getVerificationKey()
    const { payload } = await jwtVerify(accessToken, key, {
      issuer: 'privy.io',
    })

    const audience = coerceAudience(payload)
    if (config.appId && audience.length > 0 && !audience.includes(config.appId)) {
      throw new Error('Privy token audience does not match configured app id')
    }

    if (config.appId && audience.length === 0) {
      const appClaim = payload.appId || payload.app_id || null
      if (appClaim && appClaim !== config.appId) {
        throw new Error('Privy token app id does not match configured app id')
      }
    }

    const userId = typeof payload.sub === 'string' ? payload.sub : null
    if (!userId) throw new Error('Privy token is missing user subject')

    return {
      userId,
      sessionId: typeof payload.sid === 'string' ? payload.sid : null,
      appId: typeof payload.appId === 'string' ? payload.appId : (typeof payload.app_id === 'string' ? payload.app_id : config.appId || null),
      issuer: typeof payload.iss === 'string' ? payload.iss : 'privy.io',
      issuedAt: typeof payload.iat === 'number' ? payload.iat : null,
      expiration: typeof payload.exp === 'number' ? payload.exp : null,
      claims: payload,
    }
  }

  async function getImportedUserByTonAddress(address) {
    if (!config?.enabled || !config?.appId || !config?.appSecret) return null
    const customUserId = normalizeTonCustomAuthId(address)
    if (!customUserId) return null

    const client = await getPrivyClient()
    const users = resolvePrivyService(client, 'users')
    if (!users?.create || !users?.getByCustomAuthID) {
      throw new Error('Privy SDK users service is unavailable')
    }
    try {
      const user = await users.create({
        linked_accounts: [{ type: 'custom_auth', custom_user_id: customUserId }],
        custom_metadata: {
          tonAddress: address,
          source: 'tonconnect-auth-import',
        },
        wallets: [
          { chain_type: 'ethereum' },
          { chain_type: 'solana' },
        ],
      })

      return {
        created: true,
        userId: user.id,
        customUserId,
        wallets: summarizePrivyWallets(user),
      }
    } catch (error) {
      if (error?.status !== 409) throw error
      const user = await users.getByCustomAuthID({ custom_user_id: customUserId })
      return {
        created: false,
        userId: user.id,
        customUserId,
        wallets: summarizePrivyWallets(user),
      }
    }
  }

  return {
    verifyAccessToken,
    getImportedUserByTonAddress,
    isUserProvisioningConfigured: Boolean(config?.enabled && config?.appId && config?.appSecret),
    isConfigured: Boolean(config?.enabled && ((config?.appId && config?.appSecret) || config?.verificationKey)),
  }
}