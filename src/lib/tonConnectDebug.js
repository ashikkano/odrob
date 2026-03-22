export function isTonConnectDebugEnabled() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage?.getItem('odrob:debug:tonconnect') === '1'
  } catch {
    return false
  }
}

export function tonConnectDebugLog(...args) {
  if (!isTonConnectDebugEnabled()) return
  console.log(...args)
}
