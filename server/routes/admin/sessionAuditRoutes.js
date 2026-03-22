import config from '../../config.js'
import { createAdminSession, deleteAdminSession, getAdminSession } from '../../runtimeAuthStore.js'
import { adminAuth, requireAdminPermission, validateAdminSessionRequest } from '../../middleware/adminAuth.js'
import { parseCookies } from '../../middleware/cookies.js'
import { adminLimiter } from '../../middleware/index.js'
import { countAdminAuditEvents, listAdminAuditEvents, recordAdminAuditEvent } from '../../utils/adminAuditLog.js'
import { createAdminSessionSchema, ok, validate } from '../../validation/index.js'
import { clearSessionCookie, setSessionCookie } from '../../utils/sessionCookies.js'

export function registerSessionAuditRoutes(router, context) {
  router.post('/session', adminLimiter, validate(createAdminSessionSchema), async (req, res) => {
    try {
      const access = validateAdminSessionRequest({
        req,
        apiKey: req.body.apiKey,
        actorLabel: req.body.actorLabel,
        allowLocalBypass: req.body.allowLocalBypass,
      })

      const session = await createAdminSession({
        actorLabel: access.actor,
        role: access.role,
        authMode: access.mode,
        localBypassEnabled: access.localBypassEnabled,
        userAgent: req.headers['user-agent'] || '',
        ip: req.ip || req.socket?.remoteAddress || '',
        ttlMs: config.adminSessionTtlMs,
      })

      setSessionCookie(res, config.adminSessionCookie, session.id, {
        isProd: config.isProd,
        maxAge: config.adminSessionTtlMs,
        persist: req.body.persist !== false,
      })

      await recordAdminAuditEvent({
        action: 'admin.session.create',
        actor: session.actorLabel,
        authMode: session.authMode,
        role: session.role,
        targetType: 'session',
        targetId: session.id,
        details: {
          summary: 'Created admin session for admin-v2 workspace',
          localBypassEnabled: session.localBypassEnabled,
          persisted: req.body.persist !== false,
        },
        ip: req.ip || req.socket?.remoteAddress || null,
      })

      ok(res, {
        authenticated: true,
        actor: session.actorLabel,
        authMode: session.authMode,
        role: session.role,
        permissions: access.permissions,
        auditEnabled: true,
        localBypassEnabled: session.localBypassEnabled,
        timestamp: Date.now(),
      })
    } catch (err) {
      res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Unable to create admin session',
      })
    }
  })

  router.get('/session', adminAuth, (req, res) => {
    ok(res, {
      authenticated: true,
      actor: req.adminAccess?.actor || 'Admin operator',
      authMode: req.adminAccess?.mode || 'unknown',
      role: req.adminAccess?.role || 'viewer',
      permissions: req.adminAccess?.permissions || [],
      auditEnabled: true,
      localBypassEnabled: !!req.adminAccess?.localBypassEnabled,
      timestamp: Date.now(),
    })
  })

  router.delete('/session', async (req, res, next) => {
    try {
      const cookies = parseCookies(req)
      const sessionId = cookies[config.adminSessionCookie]
      const existing = sessionId ? await getAdminSession(sessionId) : null

      if (sessionId) {
        await deleteAdminSession(sessionId)
      }

      clearSessionCookie(res, config.adminSessionCookie, { isProd: config.isProd })

      if (existing) {
        await recordAdminAuditEvent({
          action: 'admin.session.delete',
          actor: existing.actorLabel,
          authMode: existing.authMode,
          role: existing.role,
          targetType: 'session',
          targetId: existing.id,
          details: {
            summary: 'Deleted admin session',
          },
          ip: req.ip || req.socket?.remoteAddress || null,
        })
      }

      ok(res, { authenticated: false })
    } catch (error) {
      next(error)
    }
  })

  router.get('/audit/events', adminAuth, requireAdminPermission('admin:audit'), async (req, res, next) => {
    try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200)
    const filters = {
      authMode: req.query.authMode ? String(req.query.authMode) : null,
      action: req.query.action ? String(req.query.action) : null,
      actor: req.query.actor ? String(req.query.actor) : null,
      targetType: req.query.targetType ? String(req.query.targetType) : null,
      query: req.query.query ? String(req.query.query) : null,
    }

    ok(res, {
      items: await listAdminAuditEvents(limit, filters),
      total: await countAdminAuditEvents(filters),
      filters,
    })
    } catch (error) {
      next(error)
    }
  })
}
