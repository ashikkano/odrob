// ═══════════════════════════════════════════════════════════════════════
// Admin Authentication Middleware
// Protects admin routes with server-issued admin session cookies
// ═══════════════════════════════════════════════════════════════════════

import config from '../config.js'
import { getAdminSession, touchAdminSession } from '../runtimeAuthStore.js'
import { parseCookies } from './cookies.js'

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const ADMIN_ROLE_PERMISSIONS = Object.freeze({
  owner: ['admin:read', 'admin:write', 'admin:system', 'admin:diagnostics', 'admin:audit'],
  operator: ['admin:read', 'admin:write', 'admin:diagnostics', 'admin:audit'],
  auditor: ['admin:read', 'admin:audit'],
  developer: ['admin:read', 'admin:write', 'admin:diagnostics', 'admin:audit'],
  viewer: ['admin:read'],
})

function isLoopbackRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || ''
  return LOOPBACK_IPS.has(ip)
}

function sanitizeAdminActor(value) {
  return String(value || '').trim().slice(0, 64) || null
}

function resolveAdminRole(role, fallback = 'viewer') {
  const normalized = String(role || '').trim().toLowerCase()
  return ADMIN_ROLE_PERMISSIONS[normalized] ? normalized : fallback
}

function buildAdminAccess({ actor, mode, hasKey, localBypassEnabled, role }) {
  const resolvedRole = resolveAdminRole(role, mode === 'localhost-bypass' ? 'developer' : 'owner')
  return {
    actor,
    mode,
    hasKey,
    localBypassEnabled,
    role: resolvedRole,
    permissions: [...(ADMIN_ROLE_PERMISSIONS[resolvedRole] || ADMIN_ROLE_PERMISSIONS.viewer)],
  }
}

function getAdminSessionId(req) {
  const cookies = parseCookies(req)
  req.cookies = { ...(req.cookies || {}), ...cookies }
  return cookies[config.adminSessionCookie] || null
}

export function hasAdminSessionCookie(req) {
  return Boolean(getAdminSessionId(req))
}

export function validateAdminSessionRequest({ req, apiKey, actorLabel, allowLocalBypass = false }) {
  const actor = sanitizeAdminActor(actorLabel)
  const normalizedApiKey = String(apiKey || '').trim()

  if (!config.isProd && config.adminAllowLocalBypass && allowLocalBypass && isLoopbackRequest(req) && !normalizedApiKey) {
    return buildAdminAccess({
      actor: actor || 'Local development operator',
      mode: 'localhost-bypass',
      hasKey: false,
      localBypassEnabled: true,
      role: config.adminLocalBypassRole,
    })
  }

  if (!config.adminApiKey) {
    const error = new Error('Admin API not configured. Set ADMIN_API_KEY or explicitly enable ALLOW_DEV_ADMIN_LOCAL_ONLY=true for localhost-only development access.')
    error.status = 503
    throw error
  }

  if (!normalizedApiKey || normalizedApiKey !== config.adminApiKey) {
    const error = new Error('Invalid or missing admin API key')
    error.status = 403
    throw error
  }

  return buildAdminAccess({
    actor: actor || 'Admin operator',
    mode: 'api-key',
    hasKey: true,
    localBypassEnabled: false,
    role: config.adminDefaultRole,
  })
}

export function requireAdminPermission(permission) {
  return function requireAdminPermissionMiddleware(req, res, next) {
    const permissions = req.adminAccess?.permissions || []
    if (!permissions.includes(permission)) {
      return res.status(403).json({ error: `Missing admin permission: ${permission}` })
    }
    next()
  }
}

/**
 * Admin auth middleware — checks the server-issued admin session cookie.
 */
export async function adminAuth(req, res, next) {
  try {
    const sessionId = getAdminSessionId(req)
    if (!sessionId) {
      return res.status(401).json({ error: 'Admin session required' })
    }

    const session = await getAdminSession(sessionId)
    if (!session || session.expiresAt <= Date.now()) {
      return res.status(401).json({ error: 'Admin session expired or invalid' })
    }

    req.adminSessionId = sessionId
    req.adminAccess = buildAdminAccess({
      actor: session.actorLabel,
      mode: session.authMode,
      hasKey: session.authMode === 'api-key',
      localBypassEnabled: session.localBypassEnabled,
      role: session.role,
    })
    await touchAdminSession(sessionId)

    next()
  } catch (error) {
    next(error)
  }
}

export default adminAuth
