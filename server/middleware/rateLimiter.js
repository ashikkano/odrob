// ═══════════════════════════════════════════════════════════════════════
// Rate Limiter Middleware — Configurable per-route rate limiting
// ═══════════════════════════════════════════════════════════════════════

import rateLimit from 'express-rate-limit'
import config from '../config.js'

// In development, use generous limits to avoid blocking during HMR/polling
const devMultiplier = config.isProd ? 1 : 10

/**
 * Standard rate limiter for public API endpoints (reads).
 * 600 req/min per IP in production, 6000/min in dev.
 * The production UI polls several read-only engine endpoints in parallel,
 * so lower limits start blocking normal dashboards and lite screens.
 */
export const standardLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests * devMultiplier,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
})

/**
 * Strict rate limiter for auth and write endpoints.
 * 20 req/min per IP in production, 200/min in dev.
 */
export const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMaxRequests * devMultiplier,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later' },
})

/**
 * Admin rate limiter.
 * 50 req/min per IP in production, 500/min in dev.
 */
export const adminLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.adminMaxRequests * devMultiplier,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Admin rate limit exceeded' },
})
