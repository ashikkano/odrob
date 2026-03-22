import dns from 'node:dns/promises'
import net from 'node:net'

const UNSAFE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
])

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase()
  return normalized === 'localhost' || normalized.endsWith('.localhost')
}

function isUnsafeIpv4(address) {
  const parts = String(address || '').split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true

  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function isUnsafeIpv6(address) {
  const normalized = String(address || '').trim().toLowerCase()
  if (!normalized) return true
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    if (net.isIP(mapped) === 4) return isUnsafeIpv4(mapped)
  }
  return false
}

function isUnsafeIp(address) {
  const ipVersion = net.isIP(address)
  if (ipVersion === 4) return isUnsafeIpv4(address)
  if (ipVersion === 6) return isUnsafeIpv6(address)
  return true
}

export function assertExternalUrlPolicy(urlString, { allowLoopbackHttp = false } = {}) {
  let parsed
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error('Invalid external provider URL')
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('External provider URL must use http or https')
  }

  if (parsed.username || parsed.password) {
    throw new Error('External provider URL cannot include credentials')
  }

  const hostname = parsed.hostname.trim().toLowerCase()
  if (!hostname) {
    throw new Error('External provider URL must include a hostname')
  }

  if (UNSAFE_HOSTNAMES.has(hostname)) {
    if (!(allowLoopbackHttp && parsed.protocol === 'http:' && isLoopbackHostname(hostname))) {
      throw new Error('External provider URL cannot target local or metadata hosts')
    }
  }

  if (parsed.protocol !== 'https:') {
    if (!(allowLoopbackHttp && isLoopbackHostname(hostname))) {
      throw new Error('External provider URL must use https unless explicit loopback development access is enabled')
    }
  }

  if (net.isIP(hostname) && isUnsafeIp(hostname)) {
    throw new Error('External provider URL cannot target private or loopback IP ranges')
  }

  return parsed
}

export async function assertExternalUrlResolvesSafe(urlString, options = {}) {
  const parsed = assertExternalUrlPolicy(urlString, options)
  const hostname = parsed.hostname.trim().toLowerCase()

  if (net.isIP(hostname)) {
    return parsed
  }

  const results = await dns.lookup(hostname, { all: true, verbatim: true })
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('External provider host could not be resolved')
  }

  if (results.some((entry) => isUnsafeIp(entry.address))) {
    throw new Error('External provider host resolves to a private or loopback address')
  }

  return parsed
}

export async function fetchSafeJson(urlString, {
  allowLoopbackHttp = false,
  timeoutMs = 8000,
  maxBytes = 256 * 1024,
  headers,
  method = 'GET',
  body,
} = {}) {
  await assertExternalUrlResolvesSafe(urlString, { allowLoopbackHttp })

  const response = await fetch(urlString, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`External request HTTP ${response.status}`)
  }

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`External response too large (${contentLength} bytes)`)
  }

  const rawText = await response.text()
  if (rawText.length > maxBytes) {
    throw new Error(`External response exceeded ${maxBytes} bytes`)
  }

  let payload
  try {
    payload = JSON.parse(rawText)
  } catch {
    throw new Error('External response was not valid JSON')
  }

  return { response, payload }
}
