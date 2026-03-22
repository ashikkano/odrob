// ═══════════════════════════════════════════════════════════════════════
// Admin Routes — composed from focused domain route modules
// Protected by adminAuth middleware applied here
// ═══════════════════════════════════════════════════════════════════════

import { Router } from 'express'
import { adminAuth } from '../middleware/index.js'
import { createTTLCache } from '../utils/hotCache.js'
import { recordAdminAuditEvent } from '../utils/adminAuditLog.js'
import { registerSessionAuditRoutes } from './admin/sessionAuditRoutes.js'
import { registerOverviewRoutes } from './admin/overviewRoutes.js'
import { registerIndexManagementRoutes } from './admin/indexManagementRoutes.js'
import { registerProviderRoutes } from './admin/providerRoutes.js'
import { registerSystemRoutes } from './admin/systemRoutes.js'
import { registerDiagnosticsRoutes } from './admin/diagnosticsRoutes.js'

/**
 * @param {{ engine, indexRegistry, agentIndexFactory, systemMMs, IndexMarketMaker, rawDb, normalizeAddr, walletProviderRegistry }} deps
 */
export default function adminRoutes({ engine, indexRegistry, agentIndexFactory, systemMMs, IndexMarketMaker, rawDb, normalizeAddr, walletProviderRegistry }) {
  const router = Router()
  const hotCache = createTTLCache(1500)

  function writeAudit(req, action, targetType, targetId, details = {}) {
    void Promise.resolve(recordAdminAuditEvent({
      action,
      actor: req.adminAccess?.actor || 'Unknown operator',
      authMode: req.adminAccess?.mode || 'unknown',
      role: req.adminAccess?.role || 'viewer',
      targetType,
      targetId,
      details,
      ip: req.ip || req.socket?.remoteAddress || null,
    })).catch((error) => {
      console.error('Admin audit write failed:', error.message)
    })
  }

  const insertStressTrade = rawDb?.prepare?.(`
    INSERT INTO index_trades (id, index_id, buyer_id, seller_id, side, price, size, value, is_mint, is_burn, timestamp)
    VALUES (@id, @index_id, @buyer_id, @seller_id, @side, @price, @size, @value, @is_mint, @is_burn, @timestamp)
  `)
  const deleteStressTradesByPrefix = rawDb?.prepare?.('DELETE FROM index_trades WHERE id LIKE ?')
  const insertStressTradesBatch = rawDb?.transaction?.((trades) => {
    for (const trade of trades) {
      insertStressTrade.run({
        id: trade.id,
        index_id: trade.indexId,
        buyer_id: trade.buyerId,
        seller_id: trade.sellerId || null,
        side: trade.side,
        price: trade.price,
        size: trade.size,
        value: trade.value,
        is_mint: trade.isMint ? 1 : 0,
        is_burn: trade.isBurn ? 1 : 0,
        timestamp: trade.timestamp,
      })
    }
  })

  const context = {
    engine,
    indexRegistry,
    agentIndexFactory,
    systemMMs,
    IndexMarketMaker,
    normalizeAddr,
    walletProviderRegistry,
    hotCache,
    writeAudit,
    stressPersistence: {
      insertTrade: insertStressTrade,
      deleteByPrefix: deleteStressTradesByPrefix,
      insertBatch: insertStressTradesBatch,
    },
  }

  registerSessionAuditRoutes(router, context)
  router.use(adminAuth)
  registerOverviewRoutes(router, context)
  registerIndexManagementRoutes(router, context)
  registerProviderRoutes(router, context)
  registerSystemRoutes(router, context)
  registerDiagnosticsRoutes(router, context)

  return router
}
