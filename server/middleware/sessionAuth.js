import { parseCookies } from './cookies.js'

export function createSessionAuth({ getAuthSession, touchAuthSession, getUser, sessionCookieName, normalizeAddr }) {

  async function attachSessionUser(req, _res, next) {
    try {
      const cookies = parseCookies(req)
      req.cookies = cookies
      const sid = cookies[sessionCookieName]
      if (!sid) return next()

      const session = await getAuthSession(sid)
      if (!session || Number(session.expires_at) <= Date.now()) return next()

      const activeWalletAddress = session.active_wallet_address || session.address || null
      req.sessionId = sid
      req.auth = {
        userId: session.user_id || null,
        authSource: session.auth_provider || 'session',
        authLevel: session.auth_level || 'wallet_verified',
        privyUserId: session.privy_user_id || null,
        activeWalletAddress: activeWalletAddress ? normalizeAddr(activeWalletAddress) : null,
      }
      req.userId = req.auth.userId
      req.userAddress = req.auth.activeWalletAddress
      req.authSource = 'session'
      await touchAuthSession(sid)
      next()
    } catch (error) {
      next(error)
    }
  }

  async function auth(req, res, next) {
    try {
      if (req.auth?.userId) {
        if (req.auth.activeWalletAddress) req.userAddress = req.auth.activeWalletAddress
        return next()
      }

      const address = req.userAddress
      if (!address) return res.status(401).json({ error: 'Not authenticated. Call POST /api/auth first.' })

      const user = await getUser(address)
      if (!user) return res.status(401).json({ error: 'User not found. Call POST /api/auth first.' })

      req.userAddress = address
      next()
    } catch (error) {
      next(error)
    }
  }

  return { attachSessionUser, auth, parseCookies }
}
