// ═══════════════════════════════════════════════════════════════════════
// Request Logger Middleware — Structured request logging
// ═══════════════════════════════════════════════════════════════════════

import config from '../config.js'

/**
 * Simple request logger. Logs method, path, status, and response time.
 * In production, this could be replaced with pino-http or morgan.
 */
export function requestLogger(req, res, next) {
  const start = Date.now()

  // Log on response finish
  res.on('finish', () => {
    const duration = Date.now() - start
    const status = res.statusCode

    // Skip health check spam in logs
    if (req.path === '/api/engine/status' || req.path === '/api/health') return

    // Color-code by status
    const statusColor = status >= 500 ? '🔴' : status >= 400 ? '🟡' : '🟢'

    // Only log slow requests or errors in production
    if (config.isProd && status < 400 && duration < 1000) return

    console.log(`${statusColor} ${req.method} ${req.path} ${status} ${duration}ms`)
  })

  next()
}
