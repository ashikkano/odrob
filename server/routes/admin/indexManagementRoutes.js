import { adminLimiter } from '../../middleware/index.js'
import { requireAdminPermission } from '../../middleware/adminAuth.js'
import {
  validate,
  ok,
  fail,
  notFound,
  createIndexSchema,
  updateIndexSchema,
} from '../../validation/index.js'
import { INDEX_FORMULAS } from '../../engine/indexFormulas.js'

export function registerIndexManagementRoutes(router, context) {
  const { engine, indexRegistry, systemMMs, IndexMarketMaker, writeAudit } = context

  router.post('/indexes', adminLimiter, requireAdminPermission('admin:write'), validate(createIndexSchema), (req, res) => {
    try {
      const {
        id,
        name,
        symbol,
        description,
        formulaId,
        icon,
        initialPrice,
        maxSupply,
        bandWidthPct,
        oracleIntervalMs,
        params,
        mmConfig,
      } = req.body

      if (!INDEX_FORMULAS[formulaId]) {
        return fail(res, `Unknown formula: ${formulaId}`, 400, { available: Object.keys(INDEX_FORMULAS) })
      }
      if (indexRegistry.indexes.has(id)) {
        return fail(res, `Index ${id} already exists`, 409)
      }

      const state = indexRegistry.registerIndex({
        id,
        name,
        symbol: symbol.toUpperCase(),
        description: description || '',
        formulaId,
        icon: icon || '📊',
        initialPrice: parseFloat(initialPrice) || 1,
        maxSupply: parseFloat(maxSupply) || 1_000_000,
        bandWidthPct: parseFloat(bandWidthPct) || 3,
        oracleIntervalMs: parseInt(oracleIntervalMs, 10) || 30_000,
        params: params || {},
      })

      indexRegistry.seedLiquidity(id)
      indexRegistry._startOracle(state)
      engine.autoSubscribeSeedAgents(id, 3)

      if (mmConfig !== false) {
        const mm = new IndexMarketMaker({
          indexId: id,
          registry: indexRegistry,
          config: {
            minSpreadBps: mmConfig?.minSpreadBps || 50,
            maxSpreadBps: mmConfig?.maxSpreadBps || 250,
            maxInventoryPct: mmConfig?.maxInventoryPct || 8,
            targetInventoryPct: mmConfig?.targetInventoryPct || 2,
            baseSizePct: mmConfig?.baseSizePct || 0.3,
            maxLevels: mmConfig?.maxLevels || 6,
            levelSpacingBps: mmConfig?.levelSpacingBps || 20,
            profitCapPct: mmConfig?.profitCapPct || 0.5,
            profitDonateRatio: 0.8,
            tickIntervalMs: mmConfig?.tickIntervalMs || 15_000,
            mintEnabled: true,
          },
        })
        mm.start()
        systemMMs[id] = mm
      }

      console.log(`🆕 Admin created new index: ${name} (${symbol}) formula=${formulaId}`)
      writeAudit(req, 'index.create', 'index', id, {
        summary: `Created index ${symbol} using formula ${formulaId}`,
        formulaId,
        created: {
          name,
          symbol: symbol.toUpperCase(),
          formulaId,
          initialPrice: parseFloat(initialPrice) || 1,
          maxSupply: parseFloat(maxSupply) || 1_000_000,
          bandWidthPct: parseFloat(bandWidthPct) || 3,
          oracleIntervalMs: parseInt(oracleIntervalMs, 10) || 30_000,
          hasParams: Boolean(params && Object.keys(params).length > 0),
          marketMakerEnabled: mmConfig !== false,
        },
      })
      ok(res, indexRegistry.getIndexSnapshot(id), 201)
    } catch (err) {
      fail(res, err.message, 500)
    }
  })

  router.patch('/indexes/:id', adminLimiter, requireAdminPermission('admin:write'), validate(updateIndexSchema), (req, res) => {
    try {
      const state = indexRegistry.indexes.get(req.params.id)
      if (!state) return notFound(res, 'Index')

      const before = {
        status: state.status,
        description: state.description,
        bandWidthPct: state.bandWidthPct,
        oracleIntervalMs: state.oracleIntervalMs,
        params: state.params || {},
      }

      const { status, bandWidthPct, oracleIntervalMs, params, description } = req.body
      if (status) {
        state.status = status
        if (status === 'active') state.pauseReason = null
      }
      if (description !== undefined) state.description = description
      if (bandWidthPct !== undefined) {
        state.bandWidthPct = Math.min(Math.max(parseFloat(bandWidthPct), 0.5), 10)
        indexRegistry._updateBand(state)
      }
      if (oracleIntervalMs !== undefined) state.oracleIntervalMs = Math.max(parseInt(oracleIntervalMs, 10), 5000)
      if (params) state.params = { ...state.params, ...params }

      if (oracleIntervalMs !== undefined) {
        indexRegistry._startOracle(state)
      }

      if (indexRegistry.db?.upsertIndex) {
        indexRegistry.db.upsertIndex(indexRegistry._serializeIndex(state))
      }

      console.log(`⚙️ Admin updated index ${req.params.id}: bandWidth=${state.bandWidthPct}%`)
      const after = {
        status: state.status,
        description: state.description,
        bandWidthPct: state.bandWidthPct,
        oracleIntervalMs: state.oracleIntervalMs,
        params: state.params || {},
      }
      writeAudit(req, 'index.update', 'index', req.params.id, {
        summary: `Updated index ${req.params.id}`,
        status: state.status,
        changes: {
          before,
          after,
          patch: req.body,
        },
      })
      ok(res, indexRegistry.getIndexSnapshot(req.params.id))
    } catch (err) {
      fail(res, err.message, 500)
    }
  })

  router.post('/agents/:id/start', adminLimiter, requireAdminPermission('admin:write'), (req, res) => {
    const agent = engine.startAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')
    writeAudit(req, 'agent.start', 'agent', req.params.id, {
      summary: `Started agent ${req.params.id}`,
      nextStatus: agent.status,
    })
    ok(res, engine._sanitizeAgent(agent))
  })
}
