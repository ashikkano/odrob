// ═══════════════════════════════════════════════════════════════════════
// Validation Middleware — Zod-powered request validation
// ═══════════════════════════════════════════════════════════════════════

import { ZodError } from 'zod'

/**
 * Express middleware factory: validates req.body against a Zod schema.
 * On success, replaces req.body with the parsed (sanitized) data.
 * On failure, returns 400 with structured error details.
 *
 * @param {import('zod').ZodSchema} schema
 * @returns {import('express').RequestHandler}
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const formatted = formatZodError(result.error)
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: formatted,
      })
    }
    // Replace body with parsed (typed, stripped of unknowns) data
    req.body = result.data
    next()
  }
}

/**
 * Format ZodError into a flat, human-readable array.
 * @param {ZodError} error
 * @returns {Array<{ field: string, message: string }>}
 */
function formatZodError(error) {
  return error.issues.map(issue => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }))
}
