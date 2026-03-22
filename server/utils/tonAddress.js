export function normalizeAddr(addr) {
  if (!addr) return ''
  addr = addr.trim()

  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(addr)) {
    return addr.toLowerCase()
  }

  try {
    let b64 = addr.replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const buf = Buffer.from(b64, 'base64')
    if (buf.length === 36) {
      const workchain = buf[1] === 0xff ? -1 : buf[1]
      const hash = buf.subarray(2, 34).toString('hex')
      return `${workchain}:${hash}`
    }
  } catch {}

  return addr.toLowerCase()
}
