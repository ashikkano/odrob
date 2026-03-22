import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useConnectOrCreateWallet, useLoginWithOAuth, usePrivy } from '@privy-io/react-auth'
import { fetchAuthSession, invalidateAuthSessionCache, logoutAuth, verifyPrivyAuth } from '@/services/authApi'

const AuthContext = createContext(null)
const AUTH_SESSION_REFRESH_EVENT = 'odrob:auth-session-refresh'

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function dispatchSessionChanged(detail) {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent('odrob:onboarding-session-changed', { detail }))
  } catch {
    try {
      const event = document.createEvent('CustomEvent')
      event.initCustomEvent('odrob:onboarding-session-changed', false, false, detail)
      window.dispatchEvent(event)
    } catch {}
  }
}

function serializeSession(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return ''
  }
}

function emptySession() {
  return {
    authenticated: false,
    userId: null,
    authSource: null,
    authMethods: [],
    linkedWallets: [],
    managedWallet: null,
    activeWalletAddress: null,
    canTrade: false,
    canCreateAgent: false,
    canPublishStrategy: false,
  }
}

async function verifyPrivyAccessTokenWithRetry(getAccessToken, verifyToken, attempts = 3) {
  let lastError = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const accessToken = await getAccessToken()
      const normalizedToken = typeof accessToken === 'string' ? accessToken.trim() : ''
      if (!normalizedToken) {
        throw new Error('Unable to obtain Privy access token')
      }
      return await verifyToken(normalizedToken)
    } catch (error) {
      lastError = error
      const shouldRetry = attempt < attempts && (!error?.status || error.status === 400 || error.status === 401)
      if (!shouldRetry) break
      await wait(200 * attempt)
    }
  }

  throw lastError || new Error('Failed to verify Privy session with backend')
}

function DisabledAuthProvider({ children }) {
  const value = useMemo(() => ({
    privyEnabled: false,
    ready: true,
    authenticated: false,
    isPrivyAuthenticated: false,
    isSyncing: false,
    error: '',
    session: emptySession(),
    user: null,
    loginWithPrivy: async () => {},
    loginWithGoogle: async () => {},
    loginWithPhone: async () => {},
    logout: async () => {
      await logoutAuth().catch(() => {})
      dispatchSessionChanged({ authenticated: false })
    },
    refreshSession: async () => emptySession(),
  }), [])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function EnabledAuthProvider({ children }) {
  const { ready, authenticated, user, login, logout: privyLogout, getAccessToken } = usePrivy()
  const [session, setSession] = useState(emptySession())
  const [isSyncing, setIsSyncing] = useState(false)
  const [error, setError] = useState('')
  const lastSyncedRef = useRef(null)
  const sessionRef = useRef(session)
  const lastBroadcastRef = useRef(serializeSession(session))
  const { connectOrCreateWallet } = useConnectOrCreateWallet({
    onError: (nextError) => {
      setError(nextError?.message || nextError?.toString?.() || 'Failed to open Privy wallet flow')
    },
  })
  const { initOAuth } = useLoginWithOAuth({
    onError: (nextError) => {
      setError(nextError?.message || nextError?.toString?.() || 'Failed to open Google login')
    },
  })

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const commitSession = useCallback((nextSession) => {
    const serialized = serializeSession(nextSession)
    setSession((previous) => {
      const prevSerialized = serializeSession(previous)
      return prevSerialized === serialized ? previous : nextSession
    })
    if (lastBroadcastRef.current !== serialized) {
      lastBroadcastRef.current = serialized
      dispatchSessionChanged(nextSession)
    }
    return nextSession
  }, [])

  const refreshSession = useCallback(async ({ force = false } = {}) => {
    try {
      const data = await fetchAuthSession({ force })
      return commitSession(data)
    } catch {
      const next = emptySession()
      return commitSession(next)
    }
  }, [commitSession])

  const syncPrivySession = useCallback(async ({ force = false } = {}) => {
    if (!authenticated) return refreshSession()

    const syncKey = user?.id || 'privy-user'
    const currentSession = sessionRef.current
    if (!force && lastSyncedRef.current === syncKey && currentSession.authenticated && currentSession.authSource === 'privy') {
      return currentSession
    }

    setIsSyncing(true)
    setError('')
    try {
      const data = await verifyPrivyAccessTokenWithRetry(getAccessToken, verifyPrivyAuth)
      commitSession(data)
      lastSyncedRef.current = syncKey
      return data
    } catch (err) {
      setError(err.message || 'Failed to verify Privy session with backend')
      throw err
    } finally {
      setIsSyncing(false)
    }
  }, [authenticated, commitSession, getAccessToken, refreshSession, user?.id])

  useEffect(() => {
    if (!ready) return
    if (authenticated) {
      syncPrivySession().catch(() => {})
      return
    }

    lastSyncedRef.current = null
    refreshSession().catch(() => {})
  }, [authenticated, ready, refreshSession, syncPrivySession])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleForcedSessionRefresh = () => {
      invalidateAuthSessionCache()
      refreshSession({ force: true }).catch(() => {})
    }

    window.addEventListener(AUTH_SESSION_REFRESH_EVENT, handleForcedSessionRefresh)
    return () => window.removeEventListener(AUTH_SESSION_REFRESH_EVENT, handleForcedSessionRefresh)
  }, [refreshSession])

  const loginWithPrivy = useCallback(async (options = {}) => {
    setError('')
    if (options?.loginMethods?.length === 1 && options.loginMethods[0] === 'wallet') {
      try {
        await login({ loginMethods: ['wallet'] })
        return
      } catch (error) {
        try {
          await connectOrCreateWallet()
          return
        } catch (fallbackError) {
          setError(fallbackError?.message || error?.message || 'Failed to open Privy wallet flow')
          throw fallbackError
        }
      }
    }
    await login(options)
  }, [connectOrCreateWallet, login])

  const loginWithGoogle = useCallback(async () => {
    setError('')
    await initOAuth({ provider: 'google' })
  }, [initOAuth])

  const loginWithPhone = useCallback(async () => {
    setError('')
    try {
      await login({ loginMethods: ['sms'] })
    } catch (nextError) {
      setError(nextError?.message || nextError?.toString?.() || 'Failed to open SMS login')
      throw nextError
    }
  }, [login])

  const logout = useCallback(async () => {
    setIsSyncing(true)
    try {
      await Promise.allSettled([
        logoutAuth(),
        privyLogout(),
      ])
      const next = emptySession()
      commitSession(next)
      lastSyncedRef.current = null
    } finally {
      setIsSyncing(false)
    }
  }, [commitSession, privyLogout])

  const value = useMemo(() => ({
    privyEnabled: true,
    ready,
    authenticated: Boolean(session?.authenticated),
    isPrivyAuthenticated: authenticated,
    isSyncing,
    error,
    session,
    user,
    loginWithPrivy,
    loginWithGoogle,
    loginWithPhone,
    logout,
    refreshSession,
    syncPrivySession,
  }), [authenticated, error, isSyncing, loginWithGoogle, loginWithPhone, loginWithPrivy, logout, ready, refreshSession, session, syncPrivySession, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function notifyAuthSessionRefresh() {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(AUTH_SESSION_REFRESH_EVENT))
  } catch {
    try {
      const event = document.createEvent('CustomEvent')
      event.initCustomEvent(AUTH_SESSION_REFRESH_EVENT, false, false, null)
      window.dispatchEvent(event)
    } catch {}
  }
}

export function AuthProvider({ children, privyEnabled = false }) {
  if (!privyEnabled) return <DisabledAuthProvider>{children}</DisabledAuthProvider>
  return <EnabledAuthProvider>{children}</EnabledAuthProvider>
}

export function useAuthSession() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuthSession must be used within AuthProvider')
  return context
}

export default AuthContext