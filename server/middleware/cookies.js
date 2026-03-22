export function parseCookies(req) {
  const cookie = req.headers?.cookie
  if (!cookie) return {}

  const out = {}
  const parts = cookie.split(';')
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = decodeURIComponent(part.slice(0, idx).trim())
    const value = decodeURIComponent(part.slice(idx + 1).trim())
    if (key) out[key] = value
  }

  return out
}