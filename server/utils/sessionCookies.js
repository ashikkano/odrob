function buildSessionCookieOptions({ isProd, path = '/', maxAge, persist = true }) {
  const options = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path,
  }

  if (persist && Number.isFinite(maxAge) && maxAge > 0) {
    options.maxAge = maxAge
  }

  return options
}

export function setSessionCookie(res, cookieName, sessionId, { isProd, maxAge, persist = true, path = '/' } = {}) {
  res.cookie(cookieName, sessionId, buildSessionCookieOptions({ isProd, path, maxAge, persist }))
}

export function clearSessionCookie(res, cookieName, { isProd, path = '/' } = {}) {
  res.clearCookie(cookieName, buildSessionCookieOptions({ isProd, path, persist: false }))
}