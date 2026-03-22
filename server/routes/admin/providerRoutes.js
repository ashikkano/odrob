import { adminLimiter } from '../../middleware/index.js'
import { requireAdminPermission } from '../../middleware/adminAuth.js'
import {
  validate,
  ok,
  fail,
  notFound,
  createExternalProviderSchema,
  previewExternalProviderSchema,
  updateExternalProviderSchema,
} from '../../validation/index.js'

export function registerProviderRoutes(router, context) {
  const { indexRegistry, writeAudit } = context

  router.get('/external-providers', (req, res) => {
    ok(res, indexRegistry.getExternalProviders())
  })

  router.post('/external-providers', adminLimiter, requireAdminPermission('admin:write'), validate(createExternalProviderSchema), (req, res) => {
    try {
      const { id, name, type, url, jsonPath, coin, intervalMs, defaultValue, transform } = req.body
      const provider = indexRegistry.registerExternalProvider({
        id,
        name,
        type: type || 'static',
        url,
        jsonPath,
        coin,
        intervalMs,
        defaultValue,
        transform,
      })
      writeAudit(req, 'provider.create', 'provider', id, {
        summary: `Created provider ${name || id}`,
        providerType: type || 'static',
        created: {
          id,
          name,
          type: type || 'static',
          url: url || null,
          jsonPath: jsonPath || null,
          coin: coin || null,
          intervalMs: intervalMs || null,
          defaultValue: defaultValue ?? null,
          hasTransform: Boolean(transform),
        },
      })
      ok(res, provider, 201)
    } catch (err) {
      fail(res, err.message, 500)
    }
  })

  router.post('/external-providers/preview', adminLimiter, requireAdminPermission('admin:diagnostics'), validate(previewExternalProviderSchema), async (req, res) => {
    try {
      const preview = await indexRegistry.previewExternalProvider(req.body || {})
      writeAudit(req, 'provider.preview', 'provider', req.body?.id || req.body?.name || 'preview', {
        summary: 'Previewed external provider request',
        providerType: req.body?.type || 'unknown',
        request: {
          type: req.body?.type || 'unknown',
          url: req.body?.url || null,
          jsonPath: req.body?.jsonPath || null,
          coin: req.body?.coin || null,
        },
      })
      ok(res, preview)
    } catch (err) {
      fail(res, err.message, 400)
    }
  })

  router.patch('/external-providers/:id', adminLimiter, requireAdminPermission('admin:write'), validate(updateExternalProviderSchema), (req, res) => {
    const before = indexRegistry.getExternalProviders().find((provider) => provider.id === req.params.id) || null
    const result = indexRegistry.setExternalValue(req.params.id, req.body.value)
    if (!result) return notFound(res, 'Provider')
    const after = indexRegistry.getExternalProviders().find((provider) => provider.id === req.params.id) || null
    writeAudit(req, 'provider.update', 'provider', req.params.id, {
      summary: `Updated provider ${req.params.id} value`,
      changes: {
        before: before ? { lastValue: before.lastValue, lastRawValue: before.lastRawValue } : null,
        after: after ? { lastValue: after.lastValue, lastRawValue: after.lastRawValue } : null,
        nextValue: req.body.value,
      },
    })
    ok(res, { providerId: req.params.id, value: req.body.value })
  })

  router.delete('/external-providers/:id', adminLimiter, requireAdminPermission('admin:write'), (req, res) => {
    const before = indexRegistry.getExternalProviders().find((provider) => provider.id === req.params.id) || null
    const result = indexRegistry.removeExternalProvider(req.params.id)
    if (!result) return notFound(res, 'Provider')
    writeAudit(req, 'provider.delete', 'provider', req.params.id, {
      summary: `Deleted provider ${req.params.id}`,
      deleted: before ? {
        id: before.id,
        name: before.name,
        type: before.type,
      } : null,
    })
    ok(res, { deleted: true })
  })

  router.get('/external-providers/:id/candles', (req, res) => {
    ok(res, indexRegistry.getProviderCandleHistory(req.params.id))
  })

  router.get('/external-providers/:id/history', (req, res) => {
    ok(res, indexRegistry.getProviderValueHistory(req.params.id))
  })
}
