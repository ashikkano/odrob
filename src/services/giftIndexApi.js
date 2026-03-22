// === GiftIndex Public API Client ===
// Fetches real Floor Index data from dev.giftindex.io

const BASE_URL = 'https://dev.giftindex.io/api'

/**
 * Fetch hourly Floor Index data (used for 1D chart).
 * Response: { count, data: [{ dt, index_price (int32), mcap, ton_rate }] }
 * Display price = index_price / 1000
 */
export async function fetchFloorIndexHourly() {
  const res = await fetch(`${BASE_URL}/floor_index`)
  if (!res.ok) throw new Error(`floor_index: ${res.status}`)
  const json = await res.json()

  if (!json?.data || !Array.isArray(json.data)) return []

  return json.data
    .filter((p) => p.dt != null && p.index_price != null)
    .map((p) => ({
      dt: p.dt,
      time: new Date(p.dt).getTime(),
      price: p.index_price / 1000,       // display price
      indexPrice: p.index_price,
      mcap: p.mcap,
      tonRate: p.ton_rate,
    }))
    .sort((a, b) => a.time - b.time)
}

/**
 * Fetch daily Floor Index OHLC data (used for 7D, 1M, 3M, All charts).
 * Response: { count, data: [{ dt, open_price, high_price, low_price, close_price, index_price, mcap, ton_rate }] }
 * Display prices = value / 1000
 */
export async function fetchFloorIndexOHLC() {
  const res = await fetch(`${BASE_URL}/floor_index_ohlc`)
  if (!res.ok) throw new Error(`floor_index_ohlc: ${res.status}`)
  const json = await res.json()

  if (!json?.data) return []

  const raw = json.data
  const points = Array.isArray(raw) ? raw : []

  return points
    .filter((p) => p.dt != null && (p.close_price != null || p.index_price != null))
    .map((p) => ({
      dt: p.dt,
      time: new Date(p.dt).getTime(),
      open: (p.open_price ?? p.index_price) / 1000,
      high: (p.high_price ?? p.index_price) / 1000,
      low: (p.low_price ?? p.index_price) / 1000,
      close: (p.close_price ?? p.index_price) / 1000,
      price: (p.close_price ?? p.index_price) / 1000,   // alias for chart
      indexPrice: p.index_price,
      mcap: p.mcap,
      tonRate: p.ton_rate,
    }))
    .sort((a, b) => a.time - b.time)
}

/**
 * Get Floor Index data filtered by timeframe.
 * @param {'1D'|'7D'|'1M'|'3M'|'ALL'} timeframe
 * @returns {Promise<Array>} chart-ready data points
 */
export async function getFloorIndexData(timeframe = '7D') {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000

  if (timeframe === '1D') {
    // Use hourly data, last 24h
    const hourly = await fetchFloorIndexHourly()
    const cutoff = now - 1 * DAY
    return hourly.filter((p) => p.time >= cutoff)
  }

  // For longer timeframes, use daily OHLC
  const ohlc = await fetchFloorIndexOHLC()

  let cutoff = 0
  switch (timeframe) {
    case '7D':  cutoff = now - 7 * DAY; break
    case '1M':  cutoff = now - 30 * DAY; break
    case '3M':  cutoff = now - 90 * DAY; break
    case 'ALL': cutoff = 0; break
    default:    cutoff = now - 7 * DAY
  }

  return ohlc.filter((p) => p.time >= cutoff)
}
