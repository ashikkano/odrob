// ═══════════════════════════════════════════════════════════════════════
// Global Error Handler — Catches unhandled errors in Express routes
// ═══════════════════════════════════════════════════════════════════════

import config from '../config.js'

/**
 * Express global error handler.
 * Must be registered AFTER all routes.
 * Signature: (err, req, res, next) — 4 args required for Express to treat as error handler.
 */
export function globalErrorHandler(err, req, res, _next) {
  // Log full error server-side
  console.error(`❌ Unhandled error [${req.method} ${req.path}]:`, err)

  // Determine status code
  const status = err.status || err.statusCode || 500

  // Build response — NEVER leak stack traces in production
  const response = {
    success: false,
    error: err.message || 'Internal server error',
  }

  // Only include stack trace in development
  if (!config.isProd && err.stack) {
    response.stack = err.stack
  }

  // Add request ID if present (for future tracing)
  if (req.id) {
    response.requestId = req.id
  }

  res.status(status).json(response)
}

/**
 * 404 handler — catches unmatched routes.
 * Must be registered AFTER all routes but BEFORE globalErrorHandler.
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
  })
}

/**
 * Setup process-level error handlers to prevent silent crashes.
 */
export function setupProcessErrorHandlers() {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️  Unhandled Promise Rejection:', reason)
    // In production, you might want to gracefully shutdown here
  })

  process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err)
    // Give the server a chance to finish pending requests before dying
    if (config.isProd) {
      console.error('Shutting down due to uncaught exception...')
      process.exit(1)
    }
  })
}
