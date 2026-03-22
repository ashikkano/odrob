// ═══════════════════════════════════════════════════════════════════════
// Response Helpers — Standardized API response envelope
// ═══════════════════════════════════════════════════════════════════════

/**
 * Standard success response.
 * @param {import('express').Response} res
 * @param {*} data
 * @param {number} [status=200]
 */
export function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data })
}

/**
 * Standard error response.
 * @param {import('express').Response} res
 * @param {string} message
 * @param {number} [status=400]
 * @param {*} [details]
 */
export function fail(res, message, status = 400, details) {
  const body = { success: false, error: message }
  if (details !== undefined) body.details = details
  return res.status(status).json(body)
}

/**
 * Not found response.
 * @param {import('express').Response} res
 * @param {string} [what='Resource']
 */
export function notFound(res, what = 'Resource') {
  return fail(res, `${what} not found`, 404)
}
