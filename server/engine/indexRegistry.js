// ═══════════════════════════════════════════════════════════════════════
// Index Registry — Manages custom indexes with oracle pricing,
// per-index order books, emission, holders, and trading bands
//
// Architecture:
//   IndexRegistry ─┬─ index[0] ─ OrderBook ─ Oracle (periodic)
//                   ├─ index[1] ─ OrderBook ─ Oracle
//                   └─ ...
//
// Each index has:
//   • Own OrderBook (bids/asks in index contracts)
//   • Oracle timer that recalculates fair price from formula
//   • Dynamic trading band [oraclePrice ± bandWidth%]
//   • Emission system (mint new contracts on buy if supply allows)
//   • Holder tracking (who owns how many contracts)
//   • Feed events for agent context
//
// SECURITY:
//   • Orders outside trading band are rejected
//   • Max position per agent enforced
//   • Rate limiting on oracle updates (min interval)
//   • All trades are atomic DB transactions
//   • Supply cap is enforced (no over-minting)
//   • Agents can only sell what they hold
// ═══════════════════════════════════════════════════════════════════════

import { OrderBook } from './orderbook-v2/index.js'  // v2: RBTree + O(1) cancel
import { INDEX_FORMULAS } from './indexFormulas.js'
import { AGENT_INDEX_CONFIG } from './agentIndexFactory.js'
import { randomUUID } from 'crypto'
import { AsyncMutex } from '../utils/asyncMutex.js'  // ARC-004: per-index lock
import serverConfig from '../config.js'
import { assertExternalUrlPolicy, fetchSafeJson } from '../utils/externalUrlSafety.js'

// Default settings
const MIN_ORACLE_INTERVAL = 5000        // safety: no faster than 5s
const MAX_BAND_WIDTH = 10               // max ±10%
const MAX_POSITION_PER_AGENT = 0.05     // 5% of max supply per agent
const MAX_POSITION_SYSTEM_AGENT = 0.20  // 20% of max supply for system MM
const FEED_MAX_EVENTS = 200             // per index
const DEFAULT_INDEX_SAFETY_CONFIG = Object.freeze({
  enabled: true,
  quarantineIndexes: true,
  excludeSelfIndexHoldings: true,
  clampBasketMetrics: true,
  maxOraclePrice: 1_000_000,
  maxHoldingValue: 10_000_000,
  maxAgentEquity: 10_000_000,
  maxBasketPnlPct: 10_000,
  maxVolumeGrowthPct: 1_000,
})

/** System agents start with `__sys_` prefix */
function isSystemAgent(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('__sys_')
}

/** Pretty names for protocol-level agents */
const SYSTEM_AGENT_META = {
  '__mint__':  { name: 'Mint (Protocol)', icon: '🏦' },
  '__burn__':  { name: 'Burn (Protocol)', icon: '🔥' },
}

const EXTERNAL_PROVIDER_HISTORY_LIMIT = 240
const EXTERNAL_PROVIDER_LOOPBACK_ALLOWED = !serverConfig.isProd && serverConfig.adminAllowProviderLoopback

function normalizeExternalProviderType(type) {
  if (type === 'api' || type === 'coingecko') return 'rest_json'
  if (type === 'hyperliquid') return 'hyperliquid'
  return type || 'static'
}

function systemAgentMeta(agentId) {
  if (SYSTEM_AGENT_META[agentId]) return SYSTEM_AGENT_META[agentId]
  if (typeof agentId === 'string' && agentId.startsWith('__sys_mm_')) {
    return { name: 'Market Maker', icon: '🏛️' }
  }
  return null
}

export class IndexRegistry {
  constructor(opts = {}) {
    this.indexes = new Map()             // id → IndexState
    this.db = opts.db || null            // persistence callbacks
    this.agentManager = opts.agentManager || null  // reference to AgentManager for metrics

    // ARC-004: Per-index async mutex — serializes oracle ticks + trade execution
    this._mutex = new AsyncMutex()

    // AgentIndexFactory reference — set via setFactory() after both are created
    this.agentIndexFactory = null

    // In-memory feed cache (per index, last N events)
    this.feeds = new Map()               // indexId → [events]

    // External data providers — for oracle formulas that need off-chain data
    // Map: providerId → { name, type, fetchFn, lastValue, lastFetchAt, intervalMs, timer }
    this.externalDataProviders = new Map()
    this.externalDataCache = new Map()   // providerId → { value, fetchedAt }
    this.safetyConfig = { ...DEFAULT_INDEX_SAFETY_CONFIG, ...(opts.safetyConfig || {}) }
    this.safetyEvents = []
  }

  getSafetyConfig() {
    return { ...this.safetyConfig }
  }

  updateSafetyConfig(patch = {}) {
    const next = { ...this.safetyConfig }
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in DEFAULT_INDEX_SAFETY_CONFIG)) continue
      if (typeof DEFAULT_INDEX_SAFETY_CONFIG[key] === 'boolean') {
        next[key] = Boolean(value)
        continue
      }
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) continue
      next[key] = numeric
    }
    this.safetyConfig = next
    return this.getSafetyConfig()
  }

  getSafetyEvents(limit = 50) {
    if (!limit || limit <= 0) return [...this.safetyEvents]
    return this.safetyEvents.slice(0, limit)
  }

  _getPersistedIndexConfig(indexId) {
    if (!this.db?.getIndex) return null
    try {
      return this.db.getIndex(indexId)
    } catch {
      return null
    }
  }

  _hydratePersistedHolders(state) {
    if (!this.db?.getHoldersByIndex || !state?.id) return 0
    let restored = 0
    try {
      const holders = this.db.getHoldersByIndex(state.id) || []
      for (const holder of holders) {
        if (!holder?.agentId || !Number.isFinite(Number(holder.balance)) || Number(holder.balance) <= 0) continue
        state.holders.set(holder.agentId, {
          balance: Number(holder.balance) || 0,
          avgEntryPrice: Number(holder.avgEntryPrice) || 0,
          realizedPnl: Number(holder.realizedPnl) || 0,
          totalBought: Number(holder.totalBought) || 0,
          totalSold: Number(holder.totalSold) || 0,
          openedAt: holder.openedAt || null,
          openedTick: null,
          lastBuyAt: null,
          lastSellAt: null,
          updatedAt: holder.updatedAt || null,
        })
        restored++
      }
      this._syncHolderCount(state)
    } catch {}
    return restored
  }

  _recordSafetyEvent(event) {
    this.safetyEvents.unshift({
      id: randomUUID(),
      timestamp: Date.now(),
      source: 'index',
      ...event,
    })
    if (this.safetyEvents.length > 200) this.safetyEvents = this.safetyEvents.slice(0, 200)
  }

  // ═══════════════════════════════════════════════════════════════════
  // EXTERNAL DATA PROVIDERS — Interface for external data sources
  // ═══════════════════════════════════════════════════════════════════

  /** Get or compile the transform function for a provider (cached). */
  _getTransformFn(provider) {
    if (!provider.transform) return null
    if (!provider._transformFn) {
      try {
        provider._transformFn = new Function('x', `return ${provider.transform}`)
      } catch { provider._transformFn = null }
    }
    return provider._transformFn
  }

  _extractExternalJsonValue(payload, jsonPath) {
    if (!jsonPath) return payload
    const parts = String(jsonPath).split('.').filter(Boolean)
    let value = payload
    for (const part of parts) {
      value = value?.[part]
    }
    return value
  }

  _applyExternalTransform(provider, value) {
    let nextValue = value
    if (provider?.transform) {
      try {
        const fn = this._getTransformFn(provider)
        if (fn) nextValue = fn(nextValue)
      } catch {
        return nextValue
      }
    }
    return nextValue
  }

  async _fetchHyperliquidPreview(provider) {
    const HL_API = 'https://api.hyperliquid.xyz/info'
    const coin = provider.coin
    const isXyzDex = coin.includes(':')
    const dexName = isXyzDex ? coin.split(':')[0] : null
    let responsePayload
    let rawValue

    if (isXyzDex) {
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: dexName }),
      })
      if (!res.ok) throw new Error(`Hyperliquid dex:${dexName} HTTP ${res.status}`)
      const [meta, ctxs] = await res.json()
      responsePayload = [meta, ctxs]
      const perps = meta?.universe || []
      const idx = perps.findIndex(p => p.name === coin)
      if (idx === -1 || !ctxs[idx]) {
        throw new Error(`'${coin}' not found on Hyperliquid ${dexName} dex (${perps.length} assets)`)
      }
      const ctx = ctxs[idx]
      const raw = ctx.markPx ?? ctx.oraclePx ?? ctx.midPx
      if (raw == null) throw new Error(`No price data for ${coin} on ${dexName} dex`)
      rawValue = Number(raw)
      if (!Number.isFinite(rawValue)) throw new Error(`Non-numeric markPx for ${coin}: ${raw}`)
    } else {
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      })
      if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`)
      const mids = await res.json()
      responsePayload = mids
      let raw = mids[coin]
      if (raw === undefined) {
        for (const key of Object.keys(mids)) {
          if (key.toUpperCase() === coin.toUpperCase()) {
            raw = mids[key]
            break
          }
        }
      }
      if (raw == null) throw new Error(`Coin '${coin}' not found on Hyperliquid (${Object.keys(mids).length} assets)`) 
      rawValue = Number(raw)
      if (!Number.isFinite(rawValue)) throw new Error(`Non-numeric mid price for ${coin}: ${raw}`)
    }

    let sampleCandles = []
    try {
      const startTime = Date.now() - 24 * 60 * 60 * 1000
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval: '1h', startTime },
        }),
      })
      if (res.ok) {
        const candles = await res.json()
        sampleCandles = Array.isArray(candles)
          ? candles.map(c => ({
              t: c.t,
              o: Number(c.o),
              h: Number(c.h),
              l: Number(c.l),
              c: Number(c.c),
              v: Number(c.v),
            }))
          : []
      }
    } catch {}

    return {
      rawValue,
      responsePreview: this._makeExternalResponsePreview(responsePayload),
      sampleCandles,
    }
  }

  async previewExternalProvider(config = {}) {
    const type = normalizeExternalProviderType(config.type)
    const provider = {
      type,
      url: config.url || null,
      jsonPath: config.jsonPath || null,
      coin: config.coin || null,
      defaultValue: config.defaultValue ?? 0,
      transform: config.transform || null,
      _transformFn: null,
    }
    const fetchedAt = Date.now()

    if (type === 'static') {
      const rawValue = Number(provider.defaultValue ?? 0)
      if (!Number.isFinite(rawValue)) throw new Error('Default value must be numeric for static preview')
      const value = this._applyExternalTransform(provider, rawValue)
      return {
        type,
        rawValue,
        value,
        fetchedAt,
        responsePreview: this._makeExternalResponsePreview(rawValue),
        sampleCandles: [],
      }
    }

    if (type === 'rest_json') {
      if (!provider.url) throw new Error('URL is required for REST JSON preview')
      const { payload } = await fetchSafeJson(provider.url, {
        allowLoopbackHttp: EXTERNAL_PROVIDER_LOOPBACK_ALLOWED,
        timeoutMs: serverConfig.externalProviders?.fetchTimeoutMs || 8000,
        maxBytes: serverConfig.externalProviders?.maxResponseBytes || (256 * 1024),
      })
      const extracted = this._extractExternalJsonValue(payload, provider.jsonPath)
      if (extracted == null) throw new Error(`JSON path '${provider.jsonPath}' returned null`)
      const rawValue = Number(extracted)
      if (!Number.isFinite(rawValue)) throw new Error(`Non-numeric value: ${extracted}`)
      const value = this._applyExternalTransform(provider, rawValue)
      return {
        type,
        rawValue,
        value,
        fetchedAt,
        responsePreview: this._makeExternalResponsePreview(payload),
        sampleCandles: [],
      }
    }

    if (type === 'hyperliquid') {
      if (!provider.coin) throw new Error('Coin ticker is required for Hyperliquid preview')
      const preview = await this._fetchHyperliquidPreview(provider)
      return {
        type,
        rawValue: preview.rawValue,
        value: this._applyExternalTransform(provider, preview.rawValue),
        fetchedAt,
        responsePreview: preview.responsePreview,
        sampleCandles: preview.sampleCandles || [],
      }
    }

    throw new Error(`Preview is not supported for provider type: ${type}`)
  }

  /**
   * Register an external data provider.
   * @param {Object} config
   *   - id: unique provider ID (e.g. 'coingecko_btc_usd')
   *   - name: human-readable name
   *   - type: 'rest_json' | 'static' | 'websocket'
   *   - url: endpoint URL (for rest_json)
   *   - jsonPath: dot-path to extract value from JSON response (e.g. 'bitcoin.usd')
   *   - intervalMs: how often to fetch (min 10s)
   *   - defaultValue: fallback if fetch fails
   *   - transform: optional fn string (e.g. 'x * 100') applied to raw value
   */
  registerExternalProvider(config) {
    if (!config.id) throw new Error('Provider id required')
    if (this.externalDataProviders.has(config.id)) {
      throw new Error(`Provider ${config.id} already registered`)
    }

    const normalizedType = normalizeExternalProviderType(config.type)
    if (normalizedType === 'rest_json') {
      if (!config.url) throw new Error('Provider URL required for REST JSON type')
      assertExternalUrlPolicy(config.url, { allowLoopbackHttp: EXTERNAL_PROVIDER_LOOPBACK_ALLOWED })
    }

    const provider = {
      id: config.id,
      name: config.name || config.id,
      type: normalizedType,
      url: config.url || null,
      jsonPath: config.jsonPath || null,
      coin: config.coin || null,             // for hyperliquid type: asset ticker (e.g. 'CL', 'BTC')
      intervalMs: Math.max(config.intervalMs || 30000, 10000),
      defaultValue: config.defaultValue ?? 0,
      transform: config.transform || null,
      _transformFn: null,  // cached compiled transform function
      lastValue: config.defaultValue ?? 0,
      lastRawValue: config.defaultValue ?? 0,
      lastResponsePreview: null,
      lastFetchAt: 0,
      fetchCount: 0,
      errorCount: 0,
      lastError: null,
      status: 'active',
      timer: null,
      valueHistory: [],
      candleHistory: [],
    }

    this.externalDataProviders.set(config.id, provider)
    this.externalDataCache.set(config.id, {
      value: provider.defaultValue,
      fetchedAt: 0,
    })

    this._recordExternalProviderSample(provider, {
      value: provider.defaultValue ?? 0,
      rawValue: provider.defaultValue ?? 0,
      source: 'bootstrap',
    })

    // Start auto-fetching for REST providers
    if (provider.type === 'rest_json' && provider.url) {
      this._startExternalFetch(provider)
    }

    // Start auto-fetching for Hyperliquid providers
    if (provider.type === 'hyperliquid' && provider.coin) {
      this._startHyperliquidFetch(provider)
    }

    console.log(`🌐 External data provider registered: ${provider.name} (${provider.type})`)
    return provider
  }

  /**
   * Remove an external data provider
   */
  removeExternalProvider(providerId) {
    const provider = this.externalDataProviders.get(providerId)
    if (!provider) return false
    if (provider.timer) clearInterval(provider.timer)
    this.externalDataProviders.delete(providerId)
    this.externalDataCache.delete(providerId)
    return true
  }

  /**
   * Manually set value for a static provider
   */
  setExternalValue(providerId, value) {
    const provider = this.externalDataProviders.get(providerId)
    if (!provider) return false
    provider.lastValue = value
    provider.lastRawValue = value
    provider.lastFetchAt = Date.now()
    provider.fetchCount++
    provider.lastError = null
    provider.lastResponsePreview = String(value)
    this.externalDataCache.set(providerId, { value, fetchedAt: Date.now() })
    this._recordExternalProviderSample(provider, {
      value,
      rawValue: value,
      source: 'manual',
      responsePreview: String(value),
    })
    return true
  }

  /**
   * Get current value from external provider
   */
  getExternalValue(providerId) {
    const cached = this.externalDataCache.get(providerId)
    if (cached) return cached.value
    const provider = this.externalDataProviders.get(providerId)
    return provider?.defaultValue ?? 0
  }

  /**
   * Get all external providers (for API)
   */
  getExternalProviders() {
    const result = []
    for (const [, p] of this.externalDataProviders) {
      result.push({
        id: p.id, name: p.name, type: p.type, url: p.url,
        jsonPath: p.jsonPath, coin: p.coin, intervalMs: p.intervalMs,
        defaultValue: p.defaultValue,
        transform: p.transform,
        lastValue: p.lastValue, lastFetchAt: p.lastFetchAt,
        lastRawValue: p.lastRawValue,
        lastResponsePreview: p.lastResponsePreview,
        fetchCount: p.fetchCount, errorCount: p.errorCount,
        lastError: p.lastError, status: p.status,
        historyPoints: p.valueHistory?.length || 0,
        candlePoints: p.candleHistory?.length || 0,
        supportsCandles: (p.candleHistory?.length || 0) > 0,
      })
    }
    return result
  }

  _makeExternalResponsePreview(payload) {
    if (payload == null) return null
    try {
      const asString = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
      return asString.length > 2000 ? `${asString.slice(0, 2000)}…` : asString
    } catch {
      return String(payload)
    }
  }

  _recordExternalProviderSample(provider, sample = {}) {
    if (!provider) return
    const timestamp = sample.timestamp || Date.now()
    const value = Number(sample.value)
    if (!Number.isFinite(value)) return
    provider.valueHistory.push({
      t: timestamp,
      value,
      rawValue: Number.isFinite(Number(sample.rawValue)) ? Number(sample.rawValue) : value,
      source: sample.source || provider.type || 'external',
    })
    if (provider.valueHistory.length > EXTERNAL_PROVIDER_HISTORY_LIMIT) {
      provider.valueHistory = provider.valueHistory.slice(-EXTERNAL_PROVIDER_HISTORY_LIMIT)
    }
    if (sample.responsePreview !== undefined) {
      provider.lastResponsePreview = sample.responsePreview
    }
  }

  /** Auto-fetch loop for REST JSON providers */
  async _startExternalFetch(provider) {
    const doFetch = async () => {
      try {
        const { payload: json } = await fetchSafeJson(provider.url, {
          allowLoopbackHttp: EXTERNAL_PROVIDER_LOOPBACK_ALLOWED,
          timeoutMs: serverConfig.externalProviders?.fetchTimeoutMs || 8000,
          maxBytes: serverConfig.externalProviders?.maxResponseBytes || (256 * 1024),
        })
        const responsePreview = this._makeExternalResponsePreview(json)
        let value = json

        // Navigate JSON path (e.g. 'bitcoin.usd')
        value = this._extractExternalJsonValue(value, provider.jsonPath)

        if (value === undefined || value === null) {
          throw new Error(`JSON path '${provider.jsonPath}' returned null`)
        }

        const rawValue = Number(value)
        if (isNaN(rawValue)) throw new Error(`Non-numeric value: ${value}`)
        value = rawValue

        // Apply transform (cached)
        value = this._applyExternalTransform(provider, value)

        provider.lastValue = value
        provider.lastRawValue = rawValue
        provider.lastFetchAt = Date.now()
        provider.fetchCount++
        provider.lastError = null
        this.externalDataCache.set(provider.id, { value, fetchedAt: Date.now() })
        this._recordExternalProviderSample(provider, {
          value,
          rawValue,
          source: 'rest_json',
          responsePreview,
        })
      } catch (err) {
        provider.errorCount++
        provider.lastError = err.message
        // Keep last known value
      }
    }

    await doFetch()
    provider.timer = setInterval(doFetch, provider.intervalMs)
  }

  /**
   * Auto-fetch loop for Hyperliquid providers.
   * Uses POST https://api.hyperliquid.xyz/info
   *   - {"type":"allMids"} for current mid-prices
   *   - {"type":"candleSnapshot", "req":{...}} for historical candle data
   */
  async _startHyperliquidFetch(provider) {
    const HL_API = 'https://api.hyperliquid.xyz/info'
    const coin = provider.coin   // e.g. 'BTC' or 'xyz:CL'

    // Detect XYZ dex coins (format "xyz:SYMBOL")
    const isXyzDex = coin.includes(':')
    const dexName = isXyzDex ? coin.split(':')[0] : null  // 'xyz'

    // ── Fetch historical candles on startup ──
    const fetchHistory = async () => {
      try {
        const now = Date.now()
        const startTime = now - 7 * 24 * 60 * 60 * 1000
        const res = await fetch(HL_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'candleSnapshot',
            req: { coin, interval: '1h', startTime },
          }),
        })
        if (!res.ok) throw new Error(`Hyperliquid candles HTTP ${res.status}`)
        const candles = await res.json()

        if (Array.isArray(candles) && candles.length > 0) {
          provider.candleHistory = candles.map(c => ({
            t: c.t,
            o: Number(c.o),
            h: Number(c.h),
            l: Number(c.l),
            c: Number(c.c),
            v: Number(c.v),
          }))
          provider.valueHistory = provider.candleHistory.map(candle => ({
            t: candle.t,
            value: candle.c,
            rawValue: candle.c,
            source: 'hyperliquid_candle',
          })).slice(-EXTERNAL_PROVIDER_HISTORY_LIMIT)
          const lastClose = Number(candles[candles.length - 1].c)
          if (lastClose > 0 && provider.fetchCount === 0) {
            provider.lastValue = lastClose
            provider.lastRawValue = lastClose
            this.externalDataCache.set(provider.id, { value: lastClose, fetchedAt: Date.now() })
          }
          console.log(`📊 Hyperliquid ${coin}: loaded ${candles.length} candles ($${provider.candleHistory[0].c} → $${provider.candleHistory.at(-1).c})`)
        }
      } catch (err) {
        console.log(`⚠️  Hyperliquid ${coin} candle history unavailable: ${err.message}`)
        provider.candleHistory = []
      }
    }

    // ── Periodic price fetch ──
    // XYZ dex coins: use metaAndAssetCtxs with dex param → markPx
    // Main dex coins: use allMids → mid price
    const doFetch = async () => {
      try {
        let value

        if (isXyzDex) {
          // ─── XYZ / HIP-3 dex: metaAndAssetCtxs with dex parameter ───
          const res = await fetch(HL_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: dexName }),
          })
          if (!res.ok) throw new Error(`Hyperliquid dex:${dexName} HTTP ${res.status}`)
          const [meta, ctxs] = await res.json()
          const perps = meta?.universe || []
          const idx = perps.findIndex(p => p.name === coin)
          if (idx === -1 || !ctxs[idx]) {
            throw new Error(`'${coin}' not found on Hyperliquid ${dexName} dex (${perps.length} assets)`)
          }
          const ctx = ctxs[idx]
          // Prefer markPx (what HyperScreener shows), fall back to oraclePx, midPx
          const raw = ctx.markPx ?? ctx.oraclePx ?? ctx.midPx
          if (raw === undefined || raw === null) {
            throw new Error(`No price data for ${coin} on ${dexName} dex`)
          }
          value = Number(raw)
          if (isNaN(value)) throw new Error(`Non-numeric markPx for ${coin}: ${raw}`)
        } else {
          // ─── Main dex: allMids ───
          const res = await fetch(HL_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'allMids' }),
          })
          if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`)
          const mids = await res.json()
          let rawValue = mids[coin]
          if (rawValue === undefined) {
            for (const key of Object.keys(mids)) {
              if (key.toUpperCase() === coin.toUpperCase()) {
                rawValue = mids[key]
                break
              }
            }
          }
          if (rawValue === undefined || rawValue === null) {
            throw new Error(`Coin '${coin}' not found on Hyperliquid (${Object.keys(mids).length} assets)`)
          }
          value = Number(rawValue)
          if (isNaN(value)) throw new Error(`Non-numeric mid price for ${coin}: ${rawValue}`)
        }

        // Apply transform if configured (cached)
        if (provider.transform) {
          try {
            const fn = this._getTransformFn(provider)
            if (fn) value = fn(value)
          } catch (e) { /* keep raw value */ }
        }

        provider.lastValue = value
        provider.lastRawValue = value
        provider.lastFetchAt = Date.now()
        provider.fetchCount++
        provider.lastError = null
        this.externalDataCache.set(provider.id, { value, fetchedAt: Date.now() })
        this._recordExternalProviderSample(provider, {
          value,
          rawValue: value,
          source: 'hyperliquid',
          responsePreview: `${coin}: ${value}`,
        })

        if (provider.fetchCount === 1) {
          console.log(`🌐 Hyperliquid ${coin} first price: $${value}`)
        }
      } catch (err) {
        provider.errorCount++
        provider.lastError = err.message
      }
    }

    // Run candle history fetch first, then start price polling
    await fetchHistory()
    await doFetch()
    provider.timer = setInterval(doFetch, provider.intervalMs)
  }

  /**
   * Get candle history for a Hyperliquid provider (for charts)
   */
  getProviderCandleHistory(providerId) {
    const provider = this.externalDataProviders.get(providerId)
    return provider?.candleHistory || []
  }

  getProviderValueHistory(providerId) {
    const provider = this.externalDataProviders.get(providerId)
    return provider?.valueHistory || []
  }

  /** Stop all external provider fetch timers */
  stopExternalProviders() {
    for (const [, p] of this.externalDataProviders) {
      if (p.timer) { clearInterval(p.timer); p.timer = null }
    }
  }

  /** Resolve agent name & icon for display in trades */
  _resolveAgent(agentId) {
    // System agents
    const sys = systemAgentMeta(agentId)
    if (sys) return sys
    // AgentManager agents
    if (this.agentManager) {
      const a = this.agentManager.agents.get(agentId)
      if (a) return { name: a.name, icon: a.icon }
    }
    return { name: 'Unknown', icon: '🤖' }
  }

  // ═══════════════════════════════════════════════════════════════════
  // INDEX LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register a new index (or restore from DB)
   */
  registerIndex(config) {
    const formula = INDEX_FORMULAS[config.formulaId]
    if (!formula) throw new Error(`Unknown formula: ${config.formulaId}`)

    if (this.indexes.has(config.id)) {
      throw new Error(`Index ${config.id} already registered`)
    }

    const persisted = this._getPersistedIndexConfig(config.id)

    const state = {
      // Identity
      id: config.id,
      name: config.name || persisted?.name,
      symbol: config.symbol || persisted?.symbol,
      description: config.description || persisted?.description || '',
      formulaId: config.formulaId || persisted?.formulaId,
      icon: config.icon || persisted?.icon || '📊',
      status: persisted?.status || config.status || 'active',

      // Oracle
      oracleIntervalMs: Math.max(persisted?.oracleIntervalMs || config.oracleIntervalMs || 30000, MIN_ORACLE_INTERVAL),
      lastOracleAt: persisted?.lastOracleAt || config.lastOracleAt || null,
      oraclePrice: persisted?.oraclePrice || config.oraclePrice || config.initialPrice || 1.0,
      prevOraclePrice: persisted?.prevOraclePrice || config.prevOraclePrice || 0,
      oracleTimer: null,

      // Trading band
      bandWidthPct: Math.min(persisted?.bandWidthPct ?? config.bandWidthPct ?? 3.0, MAX_BAND_WIDTH),
      bandLow: 0,
      bandHigh: 0,

      // Emission
      maxSupply: persisted?.maxSupply || config.maxSupply || 1_000_000,
      circulatingSupply: persisted?.circulatingSupply || config.circulatingSupply || 0,
      initialPrice: persisted?.initialPrice || config.initialPrice || 1.0,

      // Stats
      totalVolume: persisted?.totalVolume || config.totalVolume || 0,
      totalTrades: persisted?.totalTrades || config.totalTrades || 0,
      holderCount: persisted?.holderCount || config.holderCount || 0,

      // Protocol Treasury — collects mint proceeds, redistributes to holders
      treasury: persisted?.treasury || config.treasury || {
        balance: 0,              // current treasury balance ($)
        totalCollected: 0,       // lifetime mint proceeds collected
        totalRedistributed: 0,   // lifetime redistributed to holders
        totalBurned: 0,          // lifetime value burned (supply reduction)
        lastRedistributionAt: 0, // timestamp of last redistribution
        redistributionCount: 0,  // number of redistributions performed
        creatorStakeTarget: 0,
        creatorStakeAccrued: 0,
        creatorStakeLockUntil: 0,
      },

      // Agent-created index metadata (restored from DB on restart)
      creationType: persisted?.creationType || config.creationType || 'system',
      creatorAgentId: persisted?.creatorAgentId || config.creatorAgentId || config.params?.creatorAgentId || null,
      creatorFees: persisted?.creatorFees || config.creatorFees || null,
      platformFees: persisted?.platformFees || config.platformFees || {
        totalEarned: 0,
        tradingFees: 0,
        mintFees: 0,
        performanceFees: 0,
      },
      policyOverrides: persisted?.policyOverrides || config.policyOverrides || {
        feePolicy: {},
        treasuryPolicy: {},
        accountingPolicy: {},
        marketMaker: {},
      },

      // Formula params (custom weights, etc.)
      params: persisted?.params || config.params || {},

      // Own order book
      orderBook: new OrderBook(),

      // In-memory holders cache for fast lookup
      holders: new Map(),  // agentId → { balance, avgEntryPrice, realizedPnl, totalBought, totalSold, openedAt, openedTick, lastBuyAt, lastSellAt, updatedAt }

      // Recent trades (in-memory, last 200)
      recentTrades: [],

      // Price history for agent context
      priceHistory: [],
      // Volume history (per oracle tick) for VWAP and other strategies
      volumeHistory: [],

      // Oracle tick counter (monotonically increasing, for dividend scheduling)
      oracleTickCount: 0,

      // Timestamps
      createdAt: persisted?.createdAt || config.createdAt || Date.now(),
      updatedAt: persisted?.updatedAt || Date.now(),
    }

    // Calculate initial band
    this._updateBand(state)

    // Wire up trade handler
    state.orderBook.on('trade', (trade) => this._onIndexTrade(state, trade))

    this.indexes.set(state.id, state)
    this.feeds.set(state.id, [])
    this._hydratePersistedHolders(state)

    // Persist to DB
    if (this.db?.upsertIndex) {
      this.db.upsertIndex(this._serializeIndex(state))
    }

    console.log(`📊 Index registered: ${state.name} (${state.symbol}) P0=${state.initialPrice} band=±${state.bandWidthPct}%`)
    return state
  }

  /**
   * Start oracle timers for all active indexes
   */
  startOracles() {
    for (const [id, state] of this.indexes) {
      if (state.status !== 'active') continue
      this._startOracle(state)
    }
    console.log(`🔮 Oracles started for ${this.indexes.size} index(es)`)
  }

  /**
   * Stop all oracle timers
   */
  stopOracles() {
    for (const [id, state] of this.indexes) {
      if (state.oracleTimer) {
        clearInterval(state.oracleTimer)
        state.oracleTimer = null
      }
    }
    this.stopExternalProviders()
  }

  // ═══════════════════════════════════════════════════════════════════
  // ORACLE — Periodic price calculation
  // ═══════════════════════════════════════════════════════════════════

  _startOracle(state) {
    if (state.oracleTimer) clearInterval(state.oracleTimer)

    // Run once immediately
    this._runOracleSafe(state)

    // Then periodically — ARC-004: serialized via mutex
    state.oracleTimer = setInterval(
      () => this._runOracleSafe(state),
      state.oracleIntervalMs,
    )
  }

  /** ARC-004: Oracle tick wrapped in per-index mutex to prevent interleaving with trades */
  _runOracleSafe(state) {
    this._mutex.runExclusive(state.id, () => {
      this._runOracle(state)
    })
  }

  _runOracle(state) {
    const formula = INDEX_FORMULAS[state.formulaId]
    if (!formula) return
    const cfg = this.getSafetyConfig()

    // Gather inputs from system state
    const inputs = this._gatherFormulaInputs(state)
    const result = formula.fn(inputs)
    const nextPrice = Number(result?.price)

    if (!Number.isFinite(nextPrice) || nextPrice <= 0 || (cfg.enabled && nextPrice > cfg.maxOraclePrice)) {
      this._quarantineIndex(state, `Oracle price out of bounds: ${Number.isFinite(nextPrice) ? nextPrice.toFixed(6) : String(result?.price)}`)
      return
    }

    // Update state
    state.prevOraclePrice = state.oraclePrice
    state.oraclePrice = nextPrice
    state.lastOracleAt = Date.now()
    state.lastOracleResult = { ...result, price: nextPrice }  // factors + inputs for LLM context

    // Update trading band
    this._updateBand(state)

    // ── Check trigger orders (stop/trailing) on oracle price update ──
    if (state.orderBook && typeof state.orderBook.checkTriggers === 'function') {
      state.orderBook.checkTriggers(nextPrice)
    }

    // Push to price history
    state.priceHistory.push(nextPrice)
    if (state.priceHistory.length > 500) state.priceHistory.shift()

    // Push to volume history (trading volume since last tick)
    const obStats = state.orderBook?.stats
    const currentVol = obStats?.totalVolume || 0
    const tickVolume = currentVol - (state._lastVolSnapshot || 0)
    state._lastVolSnapshot = currentVol
    state.volumeHistory.push(Math.max(0, tickVolume))
    if (state.volumeHistory.length > 500) state.volumeHistory.shift()

    state.oracleTickCount++

    // Periodically redistribute treasury to holders
    this._redistributeTreasury(state)

    // Persist oracle snapshot
    if (this.db?.saveOracleSnapshot) {
      this.db.saveOracleSnapshot({
        indexId: state.id,
        price: nextPrice,
        formulaInputs: result.inputs,
        bandLow: state.bandLow,
        bandHigh: state.bandHigh,
        circulating: state.circulatingSupply,
        holderCount: state.holderCount,
        timestamp: state.lastOracleAt,
      })
    }

    // Feed event: oracle update
    const changePct = state.prevOraclePrice > 0
      ? ((state.oraclePrice - state.prevOraclePrice) / state.prevOraclePrice) * 100
      : 0

    this._emitFeed(state, {
      eventType: 'oracle_update',
      severity: Math.abs(changePct) > 2 ? 'warning' : 'info',
      title: `Oracle: ${state.symbol} = $${nextPrice.toFixed(4)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`,
      detail: { price: nextPrice, changePct, factors: result.factors, inputs: result.inputs },
    })

    // Persist index state
    if (this.db?.upsertIndex) {
      this.db.upsertIndex(this._serializeIndex(state))
    }
  }

  /**
   * Gather all inputs for the formula from live system state
   */
  _gatherFormulaInputs(state) {
    const cfg = this.getSafetyConfig()
    const now = Date.now()
    const daysSinceLaunch = (now - state.createdAt) / (1000 * 60 * 60 * 24)

    // Get agent metrics from AgentManager
    let activeAgents = 0
    let volume24h = state.totalVolume  // index's own volume
    let trades24h = state.totalTrades

    // Performance metrics (for agent_momentum formula)
    let avgPnlPct = 0
    let avgWinRate = 0.5
    let totalEquity = 0
    let tradingAgentsPct = 0

    if (this.agentManager) {
      // Count active agents that subscribe to this index
      const allAgents = Array.from(this.agentManager.agents.values())
      const realAgents = allAgents.filter(a => a.status === 'active' && a.id !== '__seed__')
      const subscribedAgents = realAgents.filter(a =>
        (a.indexSubscriptions || []).some(sub => sub.status === 'active' && sub.indexId === state.id)
      )
      activeAgents = subscribedAgents.length

      // Also add FLOOR trading volume as a bonus input
      const metrics = this.agentManager.getMetrics()
      volume24h += metrics.totalVolume * 0.1  // 10% spillover from main market

      // Compute fleet performance metrics
      const apiAgents = this.agentManager.getAllAgents ? this.agentManager.getAllAgents().filter(a => a.status === 'active') : []
      if (apiAgents.length > 0) {
        let sumPnlPct = 0, sumWR = 0, sumEquity = 0, tradingCount = 0
        for (const a of apiAgents) {
          sumPnlPct += a.pnlPercent || 0
          const closed = (a.winningTrades || 0) + (a.losingTrades || 0)
          sumWR += closed > 0 ? (a.winningTrades || 0) / closed : 0.5
          sumEquity += a.equity || ((a.virtualBalance || 0) + (a.positionValue || 0))
          if (a.totalTrades > 0) tradingCount++
        }
        avgPnlPct = sumPnlPct / apiAgents.length
        avgWinRate = sumWR / apiAgents.length
        totalEquity = sumEquity
        tradingAgentsPct = tradingCount / apiAgents.length
      }
    }

    // Gather all external data provider values
    const externalData = {}
    for (const [providerId, cached] of this.externalDataCache) {
      externalData[providerId] = cached.value
    }

    // ── Creator-specific metrics (for agent-created index formulas) ──
    let creatorPnlPct = 0, creatorWinRate = 0.5, creatorTotalTrades = 0
    let creatorEquity = 1000, creatorInitialBalance = 1000, creatorPositionValue = 0
    let creatorSharpe = 0, fleetAvgPnlPct = avgPnlPct, fleetAvgWinRate = avgWinRate
    let basketAvgPnlPct = 0, basketAvgWinRate = 0.5, basketAgentPnls = []
    let uniqueTraders = 0, volumeGrowthRate = 0

    const creatorAgentId = state.params?.creatorAgentId
    if (creatorAgentId && this.agentManager) {
      const creator = this.agentManager.agents.get(creatorAgentId)
      if (creator) {
        creatorTotalTrades = creator.totalTrades || 0
        const closed = (creator.winningTrades || 0) + (creator.losingTrades || 0)
        creatorWinRate = closed > 0 ? (creator.winningTrades || 0) / closed : 0.5
        creatorInitialBalance = creator.initialBalance || 1000

        // Compute equity via index holdings (same as _sanitizeAgent)
        let holdingsValue = 0
        for (const [iid, iState] of this.indexes) {
          if (cfg.excludeSelfIndexHoldings && iid === state.id) continue
          if (iState.status !== 'active') continue
          const h = iState.holders.get(creatorAgentId)
          const safePrice = this._getSafeOraclePrice(iState)
          if (!safePrice) continue
          if (h && h.balance > 0) {
            const holdingValue = h.balance * safePrice
            if (Number.isFinite(holdingValue) && (!cfg.enabled || holdingValue <= cfg.maxHoldingValue)) {
              holdingsValue += holdingValue
            }
          }
        }
        creatorEquity = cfg.enabled
          ? Math.min(cfg.maxAgentEquity, Math.max(0, (creator.virtualBalance || 0) + holdingsValue))
          : Math.max(0, (creator.virtualBalance || 0) + holdingsValue)
        creatorPositionValue = holdingsValue
        creatorPnlPct = creatorInitialBalance > 0
          ? this._clampMetric(
              ((creatorEquity - creatorInitialBalance) / creatorInitialBalance) * 100,
              cfg.clampBasketMetrics ? -cfg.maxBasketPnlPct : Number.NEGATIVE_INFINITY,
              cfg.clampBasketMetrics ? cfg.maxBasketPnlPct : Number.POSITIVE_INFINITY,
            ) : 0

        // Simple Sharpe approximation from equity curve
        const curve = creator.equityCurve || []
        if (curve.length > 5) {
          const returns = []
          for (let i = 1; i < curve.length; i++) {
            const prev = curve[i - 1].equity || curve[i - 1].value || 0
            const curr = curve[i].equity || curve[i].value || 0
            if (prev > 0) returns.push((curr - prev) / prev)
          }
          if (returns.length > 2) {
            const mean = returns.reduce((s, r) => s + r, 0) / returns.length
            const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
            const stdDev = Math.sqrt(variance)
            creatorSharpe = stdDev > 0 ? mean / stdDev : 0
          }
        }
      }
    }

    // Multi-agent basket: top-N agents by PnL
    if (this.agentManager) {
      const allAgents = Array.from(this.agentManager.agents.values())
      const realAgents = allAgents.filter(a => a.status === 'active' && !a.id.startsWith('__'))
      const basketSize = state.params?.basketSize || 5

      // Compute PnL% for each agent
      const agentPnls = realAgents.map(a => {
        const init = a.initialBalance || 1000
        let holdVal = 0
        for (const [iid, iState] of this.indexes) {
          if (cfg.excludeSelfIndexHoldings && iid === state.id) continue
          if (iState.status !== 'active') continue
          const safePrice = this._getSafeOraclePrice(iState)
          if (!safePrice) continue
          const h = iState.holders.get(a.id)
          if (h && h.balance > 0) {
            const holdingValue = h.balance * safePrice
            if (Number.isFinite(holdingValue) && (!cfg.enabled || holdingValue <= cfg.maxHoldingValue)) {
              holdVal += holdingValue
            }
          }
        }
        const eq = cfg.enabled
          ? Math.min(cfg.maxAgentEquity, Math.max(0, (a.virtualBalance || 0) + holdVal))
          : Math.max(0, (a.virtualBalance || 0) + holdVal)
        return {
          pnlPct: init > 0
            ? this._clampMetric(
                ((eq - init) / init) * 100,
                cfg.clampBasketMetrics ? -cfg.maxBasketPnlPct : Number.NEGATIVE_INFINITY,
                cfg.clampBasketMetrics ? cfg.maxBasketPnlPct : Number.POSITIVE_INFINITY,
              )
            : 0,
          wr: ((a.winningTrades || 0) + (a.losingTrades || 0)) > 0 ? (a.winningTrades || 0) / ((a.winningTrades || 0) + (a.losingTrades || 0)) : 0.5,
        }
      }).sort((a, b) => b.pnlPct - a.pnlPct)

      const topN = agentPnls.slice(0, basketSize)
      basketAgentPnls = topN.map(a => a.pnlPct)
      basketAvgPnlPct = topN.length > 0 ? topN.reduce((s, a) => s + a.pnlPct, 0) / topN.length : 0
      basketAvgWinRate = topN.length > 0 ? topN.reduce((s, a) => s + a.wr, 0) / topN.length : 0.5

      // Unique traders for this index
      uniqueTraders = 0
      for (const [agentId, h] of state.holders) {
        if (!agentId.startsWith('__') && h.totalBought > 0) uniqueTraders++
      }

      // Volume growth rate (compare current volume to half-life ago)
      const volHistory = state.volumeHistory || []
      if (volHistory.length > 10) {
        const recent = volHistory.slice(-5).reduce((s, v) => s + (v.volume || v || 0), 0)
        const older = volHistory.slice(-10, -5).reduce((s, v) => s + (v.volume || v || 0), 0)
        volumeGrowthRate = older > 0
          ? this._clampMetric(
              ((recent - older) / older) * 100,
              cfg.clampBasketMetrics ? -cfg.maxVolumeGrowthPct : Number.NEGATIVE_INFINITY,
              cfg.clampBasketMetrics ? cfg.maxVolumeGrowthPct : Number.POSITIVE_INFINITY,
            )
          : 0
      }
    }

    return {
      P0: state.initialPrice,
      activeAgents,
      volume24h,
      trades24h,
      daysSinceLaunch,
      holderCount: state.holderCount,
      circulatingSupply: state.circulatingSupply,
      maxSupply: state.maxSupply,
      // Performance metrics (used by agent_momentum formula)
      avgPnlPct,
      avgWinRate,
      totalEquity,
      tradingAgentsPct,
      recentVolume: volume24h,
      // External data feeds (available to all formulas)
      external: externalData,
      // Creator-specific metrics (for agent-created index formulas)
      creatorPnlPct,
      creatorWinRate,
      creatorTotalTrades,
      creatorEquity,
      creatorInitialBalance,
      creatorPositionValue,
      creatorSharpe,
      fleetAvgPnlPct,
      fleetAvgWinRate,
      // Multi-agent basket
      basketAgentPnls,
      basketAvgPnlPct,
      basketAvgWinRate,
      totalAgents: activeAgents,
      // Volume flywheel
      totalVolume: state.totalVolume,
      totalTrades: state.totalTrades,
      uniqueTraders,
      volumeGrowthRate,
      // Merge custom params (weights, etc.)
      ...state.params,
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // TRADING BAND — Dynamic price corridor
  // ═══════════════════════════════════════════════════════════════════

  _updateBand(state) {
    const safePrice = this._getSafeOraclePrice(state)
    if (!safePrice) {
      this._quarantineIndex(state, `Band update received invalid oracle price: ${String(state.oraclePrice)}`)
      return
    }
    const w = state.bandWidthPct / 100
    state.bandLow = safePrice * (1 - w)
    state.bandHigh = safePrice * (1 + w)
  }

  /**
   * Check if a price is within the trading band
   */
  isWithinBand(indexId, price) {
    const state = this.indexes.get(indexId)
    if (!state) return false
    return price >= state.bandLow && price <= state.bandHigh
  }

  // ═══════════════════════════════════════════════════════════════════
  // TRADING — Place orders on index order book
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Place an order on an index's order book.
   * Handles band validation, emission (mint), and holder tracking.
   * ARC-004: Serialized per-index via async mutex.
   *
   * @returns { order, fills, error? }
   */
  placeOrder(indexId, order) {
    // ARC-004: Synchronous fast-path — placeOrder is synchronous in SQLite-backed engine,
    // so the mutex here is a no-op guard for future async extensions.
    // The real protection is in _runOracleSafe which prevents oracle recalculation
    // from interleaving with in-flight order processing.
    const state = this.indexes.get(indexId)
    if (!state) return { error: 'Index not found' }
    if (state.status !== 'active') return { error: 'Index is not active' }

    // ── Band validation ──
    if (!this.isWithinBand(indexId, order.price)) {
      return {
        error: `Price ${order.price.toFixed(6)} outside trading band [${state.bandLow.toFixed(6)}, ${state.bandHigh.toFixed(6)}]`,
      }
    }

    // ── Sell validation: can only sell what you hold minus pending sell orders ──
    if (order.side === 'sell') {
      const holding = state.holders.get(order.agentId)
      if (!holding || holding.balance <= 0) {
        return { error: 'No contracts to sell' }
      }
      const pendingSellSize = this._getPendingSellSize(state, order.agentId)
      const availableToSell = holding.balance - pendingSellSize
      if (availableToSell <= 0) return { error: 'No contracts to sell (all reserved by pending orders)' }
      order.size = Math.min(order.size, availableToSell)
      if (order.size <= 0) return { error: 'No contracts to sell' }
    }

    // ── Buy validation: check max position per agent ──
    if (order.side === 'buy') {
      const posLimit = isSystemAgent(order.agentId)
        ? MAX_POSITION_SYSTEM_AGENT
        : MAX_POSITION_PER_AGENT
      const maxPos = state.maxSupply * posLimit
      const currentHolding = state.holders.get(order.agentId)?.balance || 0
      if (currentHolding + order.size > maxPos) {
        order.size = Math.max(0, maxPos - currentHolding)
        if (order.size <= 0) return { error: 'Max position reached for this index' }
      }
    }

    // ── Place on order book ──
    const result = state.orderBook.placeOrder({
      agentId: order.agentId,
      side: order.side,
      price: order.price,
      size: order.size,
      reasoning: order.reasoning || '',
    })

    // If buy didn't fully fill and we need emission (mint new contracts)
    if (order.side === 'buy' && result.order.remaining > 0) {
      const mintResult = this._tryMint(state, order.agentId, result.order.remaining, order.price)
      if (mintResult.fills.length > 0) {
        result.fills.push(...mintResult.fills)
        result.order.filled += mintResult.filled
        result.order.remaining -= mintResult.filled
        if (result.order.remaining <= 0) {
          result.order.status = 'filled'
          // Remove the now-filled order from the order book to prevent zombie bids
          // (the order object in result.order is the same reference sitting in bids[])
          state.orderBook.cancelOrder(result.order.id)
        }
      }
    }

    return result
  }

  /**
   * Place a MARKET order — immediate execution at best available price.
   * No price needed; the order sweeps the book.
   * Handles sell validation, position cap, emission (mint) for buys.
   *
   * @param {string} indexId
   * @param {{ agentId, side, size, reasoning? }} order
   * @returns {{ order, fills, error? }}
   */
  placeMarketOrder(indexId, order) {
    const state = this.indexes.get(indexId)
    if (!state) return { error: 'Index not found' }
    if (state.status !== 'active') return { error: 'Index is not active' }

    // ── Sell validation: subtract pending resting sells ──
    if (order.side === 'sell') {
      const holding = state.holders.get(order.agentId)
      if (!holding || holding.balance <= 0) return { error: 'No contracts to sell' }
      const pendingSellSize = this._getPendingSellSize(state, order.agentId)
      const availableToSell = holding.balance - pendingSellSize
      if (availableToSell <= 0) return { error: 'No contracts to sell (all reserved by pending orders)' }
      order.size = Math.min(order.size, availableToSell)
      if (order.size <= 0) return { error: 'No contracts to sell' }
    }

    // ── Buy validation: position cap ──
    if (order.side === 'buy') {
      const posLimit = isSystemAgent(order.agentId) ? MAX_POSITION_SYSTEM_AGENT : MAX_POSITION_PER_AGENT
      const maxPos = state.maxSupply * posLimit
      const currentHolding = state.holders.get(order.agentId)?.balance || 0
      if (currentHolding + order.size > maxPos) {
        order.size = Math.max(0, maxPos - currentHolding)
        if (order.size <= 0) return { error: 'Max position reached for this index' }
      }
    }

    const result = state.orderBook.placeMarketOrder({
      agentId: order.agentId,
      side: order.side,
      size: order.size,
      reasoning: order.reasoning || '',
    })

    // Emission (mint) for unfilled buy remainder
    if (order.side === 'buy' && result.order.remaining > 0) {
      const mintPrice = state.oraclePrice // market order uses oracle as fallback mint price
      const mintResult = this._tryMint(state, order.agentId, result.order.remaining, mintPrice)
      if (mintResult.fills.length > 0) {
        result.fills.push(...mintResult.fills)
        result.order.filled += mintResult.filled
        result.order.remaining -= mintResult.filled
        if (result.order.remaining <= 0) result.order.status = 'filled'
      }
    }

    return result
  }

  /**
   * Place an IOC (Immediate Or Cancel) limit order.
   * Fills what it can immediately, cancels the rest. No resting.
   *
   * @param {string} indexId
   * @param {{ agentId, side, price, size, reasoning? }} order
   * @returns {{ order, fills, error? }}
   */
  placeIOCOrder(indexId, order) {
    const state = this.indexes.get(indexId)
    if (!state) return { error: 'Index not found' }
    if (state.status !== 'active') return { error: 'Index is not active' }

    // Band validation still applies for IOC
    if (!this.isWithinBand(indexId, order.price)) {
      return { error: `Price ${order.price.toFixed(6)} outside trading band` }
    }

    if (order.side === 'sell') {
      const holding = state.holders.get(order.agentId)
      if (!holding || holding.balance <= 0) return { error: 'No contracts to sell' }
      const pendingSellSize = this._getPendingSellSize(state, order.agentId)
      const availableToSell = holding.balance - pendingSellSize
      if (availableToSell <= 0) return { error: 'No contracts to sell (all reserved by pending orders)' }
      order.size = Math.min(order.size, availableToSell)
      if (order.size <= 0) return { error: 'No contracts to sell' }
    }

    if (order.side === 'buy') {
      const posLimit = isSystemAgent(order.agentId) ? MAX_POSITION_SYSTEM_AGENT : MAX_POSITION_PER_AGENT
      const maxPos = state.maxSupply * posLimit
      const currentHolding = state.holders.get(order.agentId)?.balance || 0
      if (currentHolding + order.size > maxPos) {
        order.size = Math.max(0, maxPos - currentHolding)
        if (order.size <= 0) return { error: 'Max position reached for this index' }
      }
    }

    const result = state.orderBook.placeIOCOrder({
      agentId: order.agentId,
      side: order.side,
      price: order.price,
      size: order.size,
      reasoning: order.reasoning || '',
    })

    // Emission (mint) for unfilled buy remainder
    if (order.side === 'buy' && result.order.remaining > 0) {
      const mintPrice = state.oraclePrice
      const mintResult = this._tryMint(state, order.agentId, result.order.remaining, mintPrice)
      if (mintResult.fills.length > 0) {
        result.fills.push(...mintResult.fills)
        result.order.filled += mintResult.filled
        result.order.remaining -= mintResult.filled
        if (result.order.remaining <= 0) result.order.status = 'filled'
      }
    }

    return result
  }

  /**
   * Place a FOK (Fill Or Kill) limit order.
   * Either fills entirely or is rejected completely.
   */
  placeFOKOrder(indexId, order) {
    const state = this.indexes.get(indexId)
    if (!state) return { error: 'Index not found' }
    if (state.status !== 'active') return { error: 'Index is not active' }

    if (!this.isWithinBand(indexId, order.price)) {
      return { error: `Price ${order.price.toFixed(6)} outside trading band` }
    }

    if (order.side === 'sell') {
      const holding = state.holders.get(order.agentId)
      if (!holding || holding.balance <= 0) return { error: 'No contracts to sell' }
      const pendingSellSize = this._getPendingSellSize(state, order.agentId)
      const availableToSell = holding.balance - pendingSellSize
      if (availableToSell <= 0) return { error: 'No contracts to sell (all reserved by pending orders)' }
      order.size = Math.min(order.size, availableToSell)
      if (order.size <= 0) return { error: 'No contracts to sell' }
    }

    if (order.side === 'buy') {
      const posLimit = isSystemAgent(order.agentId) ? MAX_POSITION_SYSTEM_AGENT : MAX_POSITION_PER_AGENT
      const maxPos = state.maxSupply * posLimit
      const currentHolding = state.holders.get(order.agentId)?.balance || 0
      if (currentHolding + order.size > maxPos) {
        order.size = Math.max(0, maxPos - currentHolding)
        if (order.size <= 0) return { error: 'Max position reached for this index' }
      }
    }

    const result = state.orderBook.placeFOKOrder({
      agentId: order.agentId,
      side: order.side,
      price: order.price,
      size: order.size,
      reasoning: order.reasoning || '',
    })

    // Emission (mint) for unfilled buy remainder
    if (order.side === 'buy' && result.order.remaining > 0) {
      const mintPrice = state.oraclePrice
      const mintResult = this._tryMint(state, order.agentId, result.order.remaining, mintPrice)
      if (mintResult.fills.length > 0) {
        result.fills.push(...mintResult.fills)
        result.order.filled += mintResult.filled
        result.order.remaining -= mintResult.filled
        if (result.order.remaining <= 0) result.order.status = 'filled'
      }
    }

    return result
  }

  /**
   * Mint new index contracts (emission) when buy demand exceeds order book supply.
   * Minted contracts come from "the index" (protocol) — no counterparty.
   */
  _tryMint(state, buyerId, size, price) {
    const remaining = state.maxSupply - state.circulatingSupply
    if (remaining <= 0) return { fills: [], filled: 0 }

    const reservedCreatorSupply = this.agentIndexFactory && state.creationType === 'agent'
      ? this.agentIndexFactory.getReservedCreatorSupply(state)
      : 0
    const buyerMintCapacity = Math.max(0, remaining - reservedCreatorSupply)
    if (buyerMintCapacity <= 0) return { fills: [], filled: 0 }

    const mintSize = Math.min(size, buyerMintCapacity)
    const value = mintSize * price
    const mintFeePreview = this.agentIndexFactory
      ? this.agentIndexFactory.getFeePreview(state.id, value, 'mint')
      : null
    const treasuryCredit = mintFeePreview ? value - mintFeePreview.payableFee : value

    state.circulatingSupply += mintSize
    state.totalVolume += value
    state.totalTrades++

    // Credit protocol treasury with mint proceeds
    state.treasury.balance += treasuryCredit
    state.treasury.totalCollected += treasuryCredit

    const buyerMeta = this._resolveAgent(buyerId)
    const trade = {
      id: randomUUID(),
      indexId: state.id,
      buyerId: buyerId,
      sellerId: '__mint__',
      buyAgentId: buyerId,
      sellAgentId: '__mint__',
      buyerName: buyerMeta.name,
      buyerIcon: buyerMeta.icon,
      sellerName: 'Mint (Protocol)',
      sellerIcon: '🏦',
      side: 'buy',
      aggressorSide: 'buy',
      price,
      size: mintSize,
      value,
      isMint: true,
      isBurn: false,
      timestamp: Date.now(),
    }

    // Update holder
    this._updateHolderOnBuy(state, buyerId, mintSize, price)

    // ── Fee hook for agent-created indexes (mint fee) ──
    if (this.agentIndexFactory) {
      this.agentIndexFactory.applyFees(state.id, value, 'mint', mintFeePreview)
      if (state.creationType === 'agent') {
        this.agentIndexFactory.accrueCreatorStakeOnMint(state.id, mintSize, price)
      }
    }

    // Persist trade
    if (this.db?.saveIndexTrade) {
      this.db.saveIndexTrade(trade)
    }

    state.recentTrades.unshift(trade)
    if (state.recentTrades.length > 200) state.recentTrades = state.recentTrades.slice(0, 200)

    // Feed event
    this._emitFeed(state, {
      eventType: 'emission',
      severity: 'info',
      title: `Minted ${mintSize.toFixed(2)} ${state.symbol} @ $${price.toFixed(4)}`,
      detail: { mintSize, price, buyerId, newCirculating: state.circulatingSupply },
    })

    return { fills: [trade], filled: mintSize }
  }

  /**
   * Cancel all resting orders for an agent on a specific index.
   * @returns number of orders cancelled
   */
  cancelOrdersForAgent(indexId, agentId) {
    const state = this.indexes.get(indexId)
    if (!state) return 0
    return state.orderBook.cancelAllForAgent(agentId)
  }

  /**
   * Cancel specific orders on an index order book by orderId list.
   * @returns number of orders cancelled
   */
  cancelOrders(indexId, orderIds) {
    const state = this.indexes.get(indexId)
    if (!state) return 0
    let count = 0
    for (const oid of orderIds) {
      if (state.orderBook.cancelOrder(oid)) count++
    }
    return count
  }

  /**
   * Get total size of pending (resting) SELL orders for an agent on an index.
   * Used to prevent overselling: available = holding.balance - pendingSellSize.
   */
  _getPendingSellSize(state, agentId) {
    const orders = state.orderBook.getOrdersForAgent(agentId)
    let total = 0
    for (const o of orders) {
      if (o.side === 'sell') total += o.remaining
    }
    return total
  }

  /**
   * Get total cash reserved by pending (resting) BUY orders for an agent on an index.
   * Used to prevent overbooking: available = cash - reservedBuyCash.
   */
  _getPendingBuyCash(state, agentId) {
    const orders = state.orderBook.getOrdersForAgent(agentId)
    let total = 0
    for (const o of orders) {
      if (o.side === 'buy') total += o.remaining * o.price
    }
    return total
  }

  /**
   * Get all pending (resting) orders for an agent on a specific index.
   */
  getAgentPendingOrders(indexId, agentId) {
    const state = this.indexes.get(indexId)
    if (!state) return []
    return state.orderBook.getOrdersForAgent(agentId)
  }

  // ═══════════════════════════════════════════════════════════════════
  // TRADE HANDLER — Process matched trades
  // ═══════════════════════════════════════════════════════════════════

  _onIndexTrade(state, trade) {
    const value = trade.price * trade.size
    state.totalVolume += value
    state.totalTrades++

    // ── Capture pre-trade state for passive seller's PnL ──
    let passivePreAvgEntry = 0
    let passivePreBalance = 0
    const passiveAgentId = trade.aggressorSide === 'buy' ? trade.sellAgentId : trade.buyAgentId
    if (trade.aggressorSide === 'buy') {
      // Passive side is the seller — capture avgEntryPrice and balance before _updateHolderOnSell modifies it
      const h = state.holders.get(passiveAgentId)
      passivePreAvgEntry = h?.avgEntryPrice || 0
      passivePreBalance = h?.balance || 0
    }

    const tradeFeePreview = this.agentIndexFactory
      ? this.agentIndexFactory.getFeePreview(state.id, value, 'trade')
      : null

    // Update buyer
    this._updateHolderOnBuy(state, trade.buyAgentId, trade.size, trade.price)

    // Update seller
    this._updateHolderOnSell(state, trade.sellAgentId, trade.size, trade.price)

    // ── Update passive (maker) agent's cash balance ──
    // The aggressor's virtualBalance is updated in agentManager._processIndexSignals
    // or in the manual order handler. Here we handle the PASSIVE (resting) side.
    if (this.agentManager && trade.aggressorSide && !passiveAgentId.startsWith('__')) {
      const passiveAgent = this.agentManager.agents.get(passiveAgentId)
      if (passiveAgent) {
        if (trade.aggressorSide === 'buy') {
          // Passive is selling → receives cash
          // Defense-in-depth: only credit for contracts the seller actually owned
          const actualSellSize = Math.min(trade.size, passivePreBalance)
          if (actualSellSize > 0) {
            const actualValue = trade.price * actualSellSize
            const passiveFee = tradeFeePreview ? tradeFeePreview.payableFee * (actualSellSize / trade.size) : 0
            passiveAgent.virtualBalance += actualValue - passiveFee
            // PnL tracking for the passive seller
            if (passivePreAvgEntry > 0) {
              const tradePnl = ((trade.price - passivePreAvgEntry) * actualSellSize) - passiveFee
              passiveAgent.realizedPnl += tradePnl
              if (tradePnl > 0)      passiveAgent.winningTrades++
              else if (tradePnl < 0) passiveAgent.losingTrades++
            }
            passiveAgent.totalTrades++
            passiveAgent.totalVolume += actualValue
          }
        } else {
          // Passive is buying → pays cash
          passiveAgent.virtualBalance -= value
          passiveAgent.totalTrades++
          passiveAgent.totalVolume += value
        }
      }
    }

    // Resolve agent names for display
    const buyerMeta = this._resolveAgent(trade.buyAgentId)
    const sellerMeta = this._resolveAgent(trade.sellAgentId)

    // Persist
    const indexTrade = {
      id: trade.id,
      indexId: state.id,
      buyerId: trade.buyAgentId,
      sellerId: trade.sellAgentId,
      buyAgentId: trade.buyAgentId,
      sellAgentId: trade.sellAgentId,
      buyerName: buyerMeta.name,
      buyerIcon: buyerMeta.icon,
      sellerName: sellerMeta.name,
      sellerIcon: sellerMeta.icon,
      side: trade.aggressorSide,
      aggressorSide: trade.aggressorSide,
      price: trade.price,
      size: trade.size,
      value,
      isMint: false,
      isBurn: false,
      timestamp: trade.timestamp,
    }

    if (this.db?.saveIndexTrade) {
      if (!Number.isFinite(indexTrade.price) || indexTrade.price <= 0) {
        console.warn(`⚠️ Skipping index trade save — invalid price: ${indexTrade.price} for ${state.id}`)
        return
      }
      this.db.saveIndexTrade(indexTrade)
    }

    state.recentTrades.unshift(indexTrade)
    if (state.recentTrades.length > 200) state.recentTrades = state.recentTrades.slice(0, 200)

    // ── Fee hook for agent-created indexes ──
    if (this.agentIndexFactory) {
      this.agentIndexFactory.applyFees(state.id, value, 'trade', tradeFeePreview, {
        payerAgentId: trade.sellAgentId,
        sourceTradeId: trade.id,
      })
    }

    // Large trade alert
    const avgTradeSize = state.totalTrades > 1 ? state.totalVolume / state.totalTrades : value
    if (value > avgTradeSize * 3) {
      this._emitFeed(state, {
        eventType: 'large_trade',
        severity: 'warning',
        title: `Large trade: ${trade.size.toFixed(2)} ${state.symbol} @ $${trade.price.toFixed(4)} ($${value.toFixed(2)})`,
        detail: { trade: indexTrade },
      })
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // HOLDER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  _updateHolderOnBuy(state, agentId, size, price) {
    const now = Date.now()
    const tick = Number(this.agentManager?.tickCount || 0)
    let h = state.holders.get(agentId) || {
      balance: 0, avgEntryPrice: 0, realizedPnl: 0, totalBought: 0, totalSold: 0,
      openedAt: null, openedTick: null, lastBuyAt: null, lastSellAt: null, updatedAt: null,
    }
    const wasFlat = !(h.balance > 0)

    // Weighted average entry price
    if (h.balance + size > 0) {
      h.avgEntryPrice = (h.avgEntryPrice * h.balance + price * size) / (h.balance + size)
    }
    h.balance += size
    h.totalBought += size
    if (wasFlat && h.balance > 0) {
      h.openedAt = now
      h.openedTick = tick
    }
    h.lastBuyAt = now
    h.updatedAt = now

    state.holders.set(agentId, h)
    this._syncHolderCount(state)

    // Persist
    if (this.db?.upsertHolder) {
      this.db.upsertHolder({
        indexId: state.id, agentId, holderType: 'agent',
        balance: h.balance, avgEntryPrice: h.avgEntryPrice,
        realizedPnl: h.realizedPnl, totalBought: h.totalBought, totalSold: h.totalSold,
        openedAt: h.openedAt, openedTick: h.openedTick, updatedAt: h.updatedAt,
      })
    }
  }

  _updateHolderOnSell(state, agentId, size, price) {
    const h = state.holders.get(agentId)
    if (!h || h.balance <= 0) return

    const now = Date.now()
    const sellSize = Math.min(size, h.balance)
    const pnl = (price - h.avgEntryPrice) * sellSize
    h.realizedPnl += pnl
    h.balance -= sellSize
    h.totalSold += sellSize
    h.lastSellAt = now
    h.updatedAt = now

    if (h.balance <= 0) {
      h.balance = 0
      h.avgEntryPrice = 0
      h.openedAt = null
      h.openedTick = null
    }

    state.holders.set(agentId, h)
    this._syncHolderCount(state)

    // Persist
    if (this.db?.upsertHolder) {
      this.db.upsertHolder({
        indexId: state.id, agentId, holderType: 'agent',
        balance: h.balance, avgEntryPrice: h.avgEntryPrice,
        realizedPnl: h.realizedPnl, totalBought: h.totalBought, totalSold: h.totalSold,
        openedAt: h.openedAt, openedTick: h.openedTick, updatedAt: h.updatedAt,
      })
    }
  }

  _syncHolderCount(state) {
    let count = 0
    for (const [, h] of state.holders) {
      if (h.balance > 0) count++
    }
    state.holderCount = count
  }

  // ═══════════════════════════════════════════════════════════════════
  // FEED SYSTEM — Events for agent context
  // ═══════════════════════════════════════════════════════════════════

  _emitFeed(state, event) {
    const evt = {
      id: randomUUID(),
      indexId: state.id,
      ...event,
      timestamp: Date.now(),
    }

    let feed = this.feeds.get(state.id) || []
    feed.unshift(evt)
    if (feed.length > FEED_MAX_EVENTS) feed = feed.slice(0, FEED_MAX_EVENTS)
    this.feeds.set(state.id, feed)

    // Persist
    if (this.db?.saveFeedEvent) {
      this.db.saveFeedEvent(evt)
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONTEXT — Data for agents to read
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Build index context for an agent's decision-making.
   * This is injected into the agent's strategy context.
   */
  getIndexContext(indexId) {
    const state = this.indexes.get(indexId)
    if (!state) return null

    const ob = state.orderBook.getSnapshot(10)
    const feed = this.feeds.get(indexId) || []

    // Formula metadata from registry
    const formulaDef = INDEX_FORMULAS[state.formulaId] || {}

    // Last oracle calculation result (factors + inputs)
    const oracleResult = state.lastOracleResult || {}

    return {
      indexId: state.id,
      symbol: state.symbol,
      name: state.name,
      description: state.description || '',
      creationType: state.creationType || 'system',
      oraclePrice: state.oraclePrice,
      prevOraclePrice: state.prevOraclePrice,
      oracleChangePct: state.prevOraclePrice > 0
        ? ((state.oraclePrice - state.prevOraclePrice) / state.prevOraclePrice) * 100 : 0,
      bandLow: state.bandLow,
      bandHigh: state.bandHigh,
      bandWidthPct: state.bandWidthPct,
      circulatingSupply: state.circulatingSupply,
      maxSupply: state.maxSupply,
      supplyPct: state.maxSupply > 0 ? (state.circulatingSupply / state.maxSupply) * 100 : 0,
      holderCount: state.holderCount,
      totalVolume: state.totalVolume,
      totalTrades: state.totalTrades,
      priceHistory: state.priceHistory.slice(-100),
      volumeHistory: (state.volumeHistory || []).slice(-100),
      orderBook: {
        bestBid: ob.bids[0]?.price || 0,
        bestAsk: ob.asks[0]?.price || Infinity,
        spread: ob.spread,
        mid: ob.mid || state.oraclePrice,
      },
      // ── Formula metadata — tells LLM HOW price is calculated ──
      formula: {
        id: state.formulaId,
        name: formulaDef.name || state.formulaId,
        description: formulaDef.desc || '',
        formulaString: formulaDef.formula || '',
        behavior: formulaDef.behavior || '',
        drivers: (formulaDef.drivers || []).map(d => ({
          name: d.name,
          icon: d.icon,
          effect: d.effect,  // 'up', 'both', etc.
          desc: d.desc,
        })),
      },
      // ── Last oracle factors — shows which components push price up/down ──
      oracleFactors: oracleResult.factors || {},
      // ── Oracle inputs — actual values used in formula calculation ──
      oracleInputs: oracleResult.inputs || {},
      // ── Custom formula params (weights, tuning) ──
      params: state.params || {},
      // ── Protocol Treasury ──
      treasury: {
        balance: state.treasury?.balance || 0,
        totalCollected: state.treasury?.totalCollected || 0,
        totalRedistributed: state.treasury?.totalRedistributed || 0,
        totalBurned: state.treasury?.totalBurned || 0,
        hwmPrice: state.treasury?.hwmPrice || 0,
        backingRatio: (state.circulatingSupply * state.oraclePrice) > 0
          ? state.treasury.balance / (state.circulatingSupply * state.oraclePrice)
          : 0,
        redistributionCount: state.treasury?.redistributionCount || 0,
      },
      // Last 10 feed events for agent to "read"
      feed: feed.slice(0, 10).map(e => ({
        type: e.eventType, severity: e.severity,
        title: e.title, timestamp: e.timestamp,
      })),
      // Recent trades
      recentTrades: state.recentTrades.slice(0, 10).map(t => ({
        side: t.side, price: t.price, size: t.size, isMint: t.isMint, timestamp: t.timestamp,
      })),
    }
  }

  /**
   * Get context for ALL active indexes (injected into agent tick)
   */
  getAllIndexContexts() {
    const contexts = {}
    for (const [id, state] of this.indexes) {
      if (state.status !== 'active') continue
      contexts[id] = this.getIndexContext(id)
    }
    return contexts
  }

  // ═══════════════════════════════════════════════════════════════════
  // SEED LIQUIDITY — Provide initial order book depth
  // ═══════════════════════════════════════════════════════════════════

  seedLiquidity(indexId) {
    const state = this.indexes.get(indexId)
    if (!state) return
    if ((state.circulatingSupply || 0) > 0) return

    const mid = state.oraclePrice
    const seederId = `__index_seed_${indexId}__`

    const seedAmount = state.maxSupply * 0.01
    // Create a virtual liquidity provider for this index
    state.holders.set(seederId, {
      balance: seedAmount,  // 1% of supply as initial liquidity
      avgEntryPrice: mid,
      realizedPnl: 0,
      totalBought: 0,
      totalSold: 0,
    })
    // Account seed tokens in circulating supply
    state.circulatingSupply += seedAmount

    // ── Treasury credit for seed liquidity ──
    const seedValue = seedAmount * mid
    if (state.treasury) {
      state.treasury.balance += seedValue
      state.treasury.totalCollected += seedValue
    }

    // Place initial orders
    for (let i = 1; i <= 10; i++) {
      const spread = 0.002 * i  // 0.2% steps
      state.orderBook.placeOrder({
        agentId: seederId,
        side: 'buy',
        price: mid * (1 - spread),
        size: 50 + Math.random() * 200,
      })
      state.orderBook.placeOrder({
        agentId: seederId,
        side: 'sell',
        price: mid * (1 + spread),
        size: 50 + Math.random() * 200,
      })
    }

    console.log(`  💧 Seeded liquidity for ${state.symbol}: 20 orders around $${mid.toFixed(4)}`)
  }

  // ═══════════════════════════════════════════════════════════════════
  // PROTOCOL TREASURY — Redistribution mechanism
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Redistribute a portion of treasury to index holders.
   * Runs every 5th oracle tick (~2.5 min). Distributes 2% of treasury
   * balance pro-rata to all non-system holders based on their share.
   *
   * This makes mint proceeds flow BACK into the economy:
   *   Agent buys → mint → $ into treasury → treasury → % back to holders
   */
  _redistributeTreasury(state) {
    const treasuryPolicy = {
      ...(AGENT_INDEX_CONFIG.treasuryPolicy || {}),
      ...((state?.policyOverrides?.treasuryPolicy) || {}),
    }
    const REDIST_INTERVAL = Math.max(1, Number(treasuryPolicy.redistributionIntervalTicks || 5))
    const REDIST_PCT = Math.max(0, Math.min(1, Number(treasuryPolicy.redistributionPct ?? 0.02)))
    const MIN_TREASURY_BALANCE = Math.max(0, Number(treasuryPolicy.minTreasuryBalanceUsd || 10))
    const MIN_DISTRIBUTION_USD = Math.max(0, Number(treasuryPolicy.minDistributionUsd || 1))
    const ENABLE_BACKING_GATE = Boolean(treasuryPolicy.enableBackingGate)
    const MIN_BACKING_RATIO_PCT = Math.max(0, Number(treasuryPolicy.minBackingRatioPct || 0))

    // Only redistribute every Nth oracle tick
    const oracleTicks = state.oracleTickCount
    if (oracleTicks % REDIST_INTERVAL !== 0) return

    const treasury = state.treasury
    if (treasury.balance < MIN_TREASURY_BALANCE) return

    if (ENABLE_BACKING_GATE) {
      const circulatingValue = state.circulatingSupply * state.oraclePrice
      const backingRatioPct = circulatingValue > 0 ? (treasury.balance / circulatingValue) * 100 : 0
      if (backingRatioPct < MIN_BACKING_RATIO_PCT) return
    }

    // Calculate distribution pool
    const pool = treasury.balance * REDIST_PCT
    if (pool < MIN_DISTRIBUTION_USD) return

    // ── Performance fee for agent-created indexes ──
    let performanceFeeDeducted = 0
    if (this.agentIndexFactory && state.creationType === 'agent') {
      performanceFeeDeducted = this.agentIndexFactory.applyPerformanceFee(state.id, pool)
    }
    const distributablePool = pool - performanceFeeDeducted

    // Gather eligible holders (non-system, positive balance)
    const eligible = []
    let totalHolding = 0
    for (const [agentId, h] of state.holders) {
      if (agentId.startsWith('__')) continue  // skip __mint__, __burn__, __sys_mm_*
      if (h.balance <= 0) continue
      eligible.push({ agentId, balance: h.balance })
      totalHolding += h.balance
    }

    if (eligible.length === 0 || totalHolding <= 0) return

    // Distribute pro-rata and credit each holder's virtualBalance via agentManager
    let totalDistributed = 0
    for (const holder of eligible) {
      const share = holder.balance / totalHolding
      const reward = distributablePool * share

      // Credit holder's realized PnL (treasury dividend = pure profit)
      const h = state.holders.get(holder.agentId)
      if (h && h.balance > 0) {
        h.realizedPnl += reward
        state.holders.set(holder.agentId, h)
      }

      // Also credit agent's cash balance and record transaction
      if (this.agentManager) {
        const agent = this.agentManager.agents.get(holder.agentId)
        if (agent) {
          agent.virtualBalance += reward
          if (!agent.dividendIncome) agent.dividendIncome = 0
          agent.dividendIncome += reward

          // Record identifiable treasury dividend in agent's trade history
          agent.trades.unshift({
            id: `treasury-${state.id}-${Date.now()}-${holder.agentId.slice(0, 6)}`,
            side: 'treasury_dividend',
            price: state.oraclePrice,
            size: reward,                          // dollar amount received
            value: reward,
            pnl: reward,                           // pure profit
            indexId: state.id,
            indexSymbol: state.symbol,
            position: h ? h.balance : 0,
            balance: Math.round(agent.virtualBalance * 100) / 100,
            holdingBalance: h ? h.balance : 0,     // contracts held
            treasuryPool: pool,                    // total pool this cycle
            recipientCount: eligible.length,
            timestamp: Date.now(),
          })
          if (agent.trades.length > 100) agent.trades = agent.trades.slice(0, 100)

          // Record as decision for visibility in agent decisions tab
          if (agent.decisions) {
            agent.decisions.unshift({
              action: 'treasury_dividend',
              price: state.oraclePrice,
              size: reward,
              confidence: 1,
              reasoning: `Received $${reward.toFixed(4)} treasury dividend from ${state.symbol} (holding ${h ? h.balance.toFixed(2) : 0} contracts, pool $${pool.toFixed(2)} split among ${eligible.length} holders)`,
              timestamp: Date.now(),
            })
            if (agent.decisions.length > 50) agent.decisions = agent.decisions.slice(0, 50)
          }
        }
      }

      totalDistributed += reward
    }

    // Debit treasury (distributed amount + performance fee)
    treasury.balance -= (totalDistributed + performanceFeeDeducted)
    treasury.totalRedistributed += totalDistributed
    treasury.lastRedistributionAt = Date.now()
    treasury.redistributionCount++

    // Feed event
    this._emitFeed(state, {
      eventType: 'treasury_redistribution',
      severity: 'info',
      title: `Treasury distributed $${totalDistributed.toFixed(2)} to ${eligible.length} holders`,
      detail: {
        pool: totalDistributed,
        recipientCount: eligible.length,
        treasuryRemaining: treasury.balance,
        totalRedistributed: treasury.totalRedistributed,
      },
    })
  }

  /**
   * Get treasury snapshot for API
   */
  getTreasurySnapshot(indexId) {
    const state = this.indexes.get(indexId)
    if (!state) return null
    const t = state.treasury
    const circulatingValue = state.circulatingSupply * state.oraclePrice
    return {
      indexId: state.id,
      symbol: state.symbol,
      balance: Math.round(t.balance * 100) / 100,
      totalCollected: Math.round(t.totalCollected * 100) / 100,
      totalRedistributed: Math.round(t.totalRedistributed * 100) / 100,
      totalBurned: Math.round(t.totalBurned * 100) / 100,
      lastRedistributionAt: t.lastRedistributionAt,
      redistributionCount: t.redistributionCount,
      treasuryPctOfMarketCap: circulatingValue > 0
        ? Math.round(t.balance / circulatingValue * 10000) / 100
        : 0,
      backingRatio: circulatingValue > 0
        ? Math.round(t.balance / circulatingValue * 10000) / 100
        : 0,
      creatorStakeTarget: Math.round((t.creatorStakeTarget || 0) * 1e6) / 1e6,
      creatorStakeAccrued: Math.round((t.creatorStakeAccrued || 0) * 1e6) / 1e6,
      creatorStakeProgressPct: (t.creatorStakeTarget || 0) > 0
        ? Math.round(((t.creatorStakeAccrued || 0) / t.creatorStakeTarget) * 10000) / 100
        : 0,
      creatorStakeLockUntil: t.creatorStakeLockUntil || 0,
      hwmPrice: Math.round((t.hwmPrice || 0) * 1e6) / 1e6,
      creatorFees: state.creatorFees || null,
      platformFees: state.platformFees || null,
      creationType: state.creationType || 'system',
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SERIALIZATION — For DB persistence & API responses
  // ═══════════════════════════════════════════════════════════════════

  _serializeIndex(state) {
    const formula = INDEX_FORMULAS[state.formulaId]
    return {
      id: state.id,
      name: state.name,
      symbol: state.symbol,
      description: state.description,
      formulaId: state.formulaId,
      formulaName: formula?.name || state.formulaId,
      formulaDesc: formula?.desc || '',
      formulaText: formula?.formula || '',
      formulaBehavior: formula?.behavior || '',
      formulaDrivers: formula?.drivers || [],
      icon: state.icon,
      status: state.status,
      pauseReason: state.pauseReason || null,
      oracleIntervalMs: state.oracleIntervalMs,
      lastOracleAt: state.lastOracleAt,
      oraclePrice: state.oraclePrice,
      prevOraclePrice: state.prevOraclePrice,
      bandWidthPct: state.bandWidthPct,
      bandLow: state.bandLow,
      bandHigh: state.bandHigh,
      maxSupply: state.maxSupply,
      circulatingSupply: state.circulatingSupply,
      initialPrice: state.initialPrice,
      totalVolume: state.totalVolume,
      totalTrades: state.totalTrades,
      holderCount: state.holderCount,
      params: state.params,
      treasury: {
        balance: Math.round(state.treasury.balance * 100) / 100,
        totalCollected: Math.round(state.treasury.totalCollected * 100) / 100,
        totalRedistributed: Math.round(state.treasury.totalRedistributed * 100) / 100,
        totalBurned: Math.round(state.treasury.totalBurned * 100) / 100,
        lastRedistributionAt: state.treasury.lastRedistributionAt,
        redistributionCount: state.treasury.redistributionCount,
        creatorStakeTarget: state.treasury.creatorStakeTarget || 0,
        creatorStakeAccrued: state.treasury.creatorStakeAccrued || 0,
        creatorStakeLockUntil: state.treasury.creatorStakeLockUntil || 0,
        // Persisted for agent-created indexes
        hwmPrice: state.treasury.hwmPrice || 0,
        creatorFees: state.creatorFees || null,
        platformFees: state.platformFees || null,
        policyOverrides: state.policyOverrides || {
          feePolicy: {},
          treasuryPolicy: {},
          accountingPolicy: {},
          marketMaker: {},
        },
      },
      // Agent-created index fields
      creationType: state.creationType || 'system',
      creatorAgentId: state.creatorAgentId || null,
      creatorFees: state.creatorFees || null,
      platformFees: state.platformFees || null,
      policyOverrides: state.policyOverrides || null,
      createdAt: state.createdAt,
      updatedAt: Date.now(),
    }
  }

  _clampMetric(value, min, max, fallback = 0) {
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, value))
  }

  _getSafeOraclePrice(state) {
    const cfg = this.getSafetyConfig()
    const price = Number(state?.oraclePrice)
    if (!Number.isFinite(price) || price <= 0) return null
    if (cfg.enabled && price > cfg.maxOraclePrice) return null
    return price
  }

  _quarantineIndex(state, reason) {
    const cfg = this.getSafetyConfig()
    if (!state) return
    if (cfg.enabled && !cfg.quarantineIndexes) return
    if (state.status !== 'paused') {
      console.warn(`🚨 Pausing index ${state.symbol} (${state.id}): ${reason}`)
    }
    state.status = 'paused'
    state.pauseReason = reason
    state.bandLow = 0
    state.bandHigh = 0
    this._recordSafetyEvent({
      targetType: 'index',
      targetId: state.id,
      label: state.symbol,
      reason,
      status: state.status,
    })

    this._emitFeed(state, {
      eventType: 'index_paused',
      severity: 'critical',
      title: `${state.symbol} paused by safety guard`,
      detail: { reason },
    })

    if (this.db?.upsertIndex) {
      this.db.upsertIndex(this._serializeIndex(state))
    }
  }

  /**
   * Full API-safe snapshot of an index
   */

  getIndexSnapshot(indexId) {
    const state = this.indexes.get(indexId)
    if (!state) return null

    const ob = state.orderBook.getSnapshot(15)
    // changePct: session-wide change from first recorded price
    // (more meaningful than single-tick delta)
    const firstPrice = state.priceHistory.length > 0 ? state.priceHistory[0] : state.initialPrice
    const changePct = firstPrice > 0
      ? ((state.oraclePrice - firstPrice) / firstPrice) * 100 : 0

    return {
      ...this._serializeIndex(state),
      changePct: Math.round(changePct * 100) / 100,
      // Also send last-tick delta for directional arrow
      tickChangePct: state.prevOraclePrice > 0
        ? Math.round(((state.oraclePrice - state.prevOraclePrice) / state.prevOraclePrice) * 10000) / 100
        : 0,
      orderBook: ob,
      recentTrades: state.recentTrades.slice(0, 20),
      priceHistory: state.priceHistory.slice(-200),
    }
  }

  /**
   * Lightweight price-only data (~200 bytes instead of 16KB full snapshot)
   */
  getIndexPrice(indexId) {
    const state = this.indexes.get(indexId)
    if (!state) return null

    const firstPrice = state.priceHistory.length > 0 ? state.priceHistory[0] : state.initialPrice
    const changePct = firstPrice > 0
      ? ((state.oraclePrice - firstPrice) / firstPrice) * 100 : 0

    return {
      oraclePrice: state.oraclePrice,
      prevOraclePrice: state.prevOraclePrice,
      changePct: Math.round(changePct * 100) / 100,
      tickChangePct: state.prevOraclePrice > 0
        ? Math.round(((state.oraclePrice - state.prevOraclePrice) / state.prevOraclePrice) * 10000) / 100
        : 0,
      bandLow: state.bandLow,
      bandHigh: state.bandHigh,
      lastOracleAt: state.lastOracleAt,
      totalVolume: state.totalVolume,
      totalTrades: state.totalTrades,
    }
  }

  /**
   * List all indexes (summary for listing)
   */
  getAllIndexSnapshots() {
    const result = []
    for (const [id, state] of this.indexes) {
      const changePct = state.prevOraclePrice > 0
        ? ((state.oraclePrice - state.prevOraclePrice) / state.prevOraclePrice) * 100 : 0
      const formula = INDEX_FORMULAS[state.formulaId]
      result.push({
        id: state.id,
        name: state.name,
        symbol: state.symbol,
        description: state.description,
        icon: state.icon,
        status: state.status,
        formulaId: state.formulaId,
        formulaName: formula?.name || state.formulaId,
        formulaDesc: formula?.desc || '',
        formulaText: formula?.formula || '',
        formulaBehavior: formula?.behavior || '',
        formulaDrivers: formula?.drivers || [],
        oraclePrice: state.oraclePrice,
        prevOraclePrice: state.prevOraclePrice,
        changePct: Math.round(changePct * 100) / 100,
        bandWidthPct: state.bandWidthPct,
        bandLow: state.bandLow,
        bandHigh: state.bandHigh,
        initialPrice: state.initialPrice,
        oracleIntervalMs: state.oracleIntervalMs,
        circulatingSupply: state.circulatingSupply,
        maxSupply: state.maxSupply,
        totalVolume: Math.round(state.totalVolume * 100) / 100,
        totalTrades: state.totalTrades,
        holderCount: state.holderCount,
        treasury: {
          balance: Math.round(state.treasury.balance * 100) / 100,
          totalCollected: Math.round(state.treasury.totalCollected * 100) / 100,
          totalRedistributed: Math.round(state.treasury.totalRedistributed * 100) / 100,
          totalBurned: Math.round(state.treasury.totalBurned * 100) / 100,
          creatorStakeTarget: Math.round((state.treasury.creatorStakeTarget || 0) * 1e6) / 1e6,
          creatorStakeAccrued: Math.round((state.treasury.creatorStakeAccrued || 0) * 1e6) / 1e6,
          creatorStakeLockUntil: state.treasury.creatorStakeLockUntil || 0,
          backingRatio: (state.circulatingSupply * state.oraclePrice) > 0
            ? Math.round(state.treasury.balance / (state.circulatingSupply * state.oraclePrice) * 10000) / 100
            : 0,
        },
        creationType: state.creationType || 'system',
        creatorAgentId: state.creatorAgentId || null,
        creatorFees: state.creatorFees || null,
        platformFees: state.platformFees || null,
        pauseReason: state.pauseReason || null,
        createdAt: state.createdAt,
      })
    }
    return result
  }

  /**
   * Get order book snapshot for a specific index
   */
  getOrderBook(indexId, depth = 15) {
    const state = this.indexes.get(indexId)
    if (!state) return null
    return state.orderBook.getSnapshot(depth)
  }

  /**
   * Get holders list for an index
   */
  getHolders(indexId) {
    const state = this.indexes.get(indexId)
    if (!state) return []
    const result = []
    for (const [agentId, h] of state.holders) {
      if (h.balance > 0 && !agentId.startsWith('__')) {
        result.push({
          agentId,
          balance: Math.round(h.balance * 100) / 100,
          avgEntryPrice: Math.round(h.avgEntryPrice * 1e6) / 1e6,
          realizedPnl: Math.round(h.realizedPnl * 100) / 100,
          unrealizedPnl: state.oraclePrice
            ? Math.round((state.oraclePrice - h.avgEntryPrice) * h.balance * 100) / 100
            : 0,
          holdingValueUsd: Math.round(h.balance * state.oraclePrice * 100) / 100,
          pctOfSupply: state.circulatingSupply > 0
            ? Math.round((h.balance / state.circulatingSupply) * 10000) / 100
            : 0,
        })
      }
    }
    return result.sort((a, b) => b.balance - a.balance)
  }

  /**
   * Persist all index states (called on shutdown or periodically)
   */
  saveAll() {
    if (!this.db?.saveIndexStateBatch) return
    const states = []
    for (const [, state] of this.indexes) {
      states.push(this._serializeIndex(state))
    }
    if (states.length > 0) {
      this.db.saveIndexStateBatch(states)
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN — Comprehensive dashboard data
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get admin dashboard: aggregated metrics across ALL indexes
   */
  getAdminDashboard() {
    const indexes = []
    let totalVolume = 0, totalTrades = 0, totalMintValue = 0, totalBurnValue = 0
    let totalTreasuryBalance = 0, totalTreasuryCollected = 0, totalTreasuryRedistributed = 0

    for (const [id, state] of this.indexes) {
      totalVolume += state.totalVolume
      totalTrades += state.totalTrades
      totalTreasuryBalance += state.treasury.balance
      totalTreasuryCollected += state.treasury.totalCollected
      totalTreasuryRedistributed += state.treasury.totalRedistributed

      // Count mints and burns from recent trades
      let mintCount = 0, burnCount = 0, mintValue = 0, burnValue = 0
      for (const t of state.recentTrades) {
        if (t.isMint) { mintCount++; mintValue += t.value }
        if (t.isBurn) { burnCount++; burnValue += t.value }
      }
      totalMintValue += mintValue
      totalBurnValue += burnValue

      const ob = state.orderBook.getSnapshot(10)
      const changePct = state.prevOraclePrice > 0
        ? ((state.oraclePrice - state.prevOraclePrice) / state.prevOraclePrice) * 100 : 0

      indexes.push({
        id: state.id,
        symbol: state.symbol,
        name: state.name,
        icon: state.icon,
        description: state.description,
        formulaId: state.formulaId,
        initialPrice: state.initialPrice,
        status: state.status,
        pauseReason: state.pauseReason || null,
        bandWidthPct: state.bandWidthPct,
        params: state.params || {},
        oraclePrice: state.oraclePrice,
        changePct: Math.round(changePct * 100) / 100,
        bandLow: state.bandLow,
        bandHigh: state.bandHigh,
        circulatingSupply: Math.round(state.circulatingSupply),
        maxSupply: state.maxSupply,
        supplyPct: state.maxSupply > 0 ? Math.round(state.circulatingSupply / state.maxSupply * 10000) / 100 : 0,
        totalVolume: Math.round(state.totalVolume * 100) / 100,
        totalTrades: state.totalTrades,
        holderCount: state.holderCount,
        oracleIntervalMs: state.oracleIntervalMs,
        lastOracleAt: state.lastOracleAt,
        treasury: {
          balance: Math.round(state.treasury.balance * 100) / 100,
          totalCollected: Math.round(state.treasury.totalCollected * 100) / 100,
          totalRedistributed: Math.round(state.treasury.totalRedistributed * 100) / 100,
          totalBurned: Math.round(state.treasury.totalBurned * 100) / 100,
          redistributionCount: state.treasury.redistributionCount,
        },
        orderBook: {
          bidCount: ob.bids.length,
          askCount: ob.asks.length,
          bestBid: ob.bids[0]?.price || 0,
          bestAsk: ob.asks[0]?.price || 0,
          spread: ob.spread,
          bidDepth: ob.bids.reduce((s, o) => s + (o.volume || 0), 0),
          askDepth: ob.asks.reduce((s, o) => s + (o.volume || 0), 0),
        },
        recentActivity: {
          mintCount,
          burnCount,
          mintValue: Math.round(mintValue * 100) / 100,
          burnValue: Math.round(burnValue * 100) / 100,
          lastTrade: state.recentTrades[0] || null,
        },
        priceHistory: state.priceHistory.slice(-100),
        createdAt: state.createdAt,
      })
    }

    return {
      timestamp: Date.now(),
      totalIndexes: this.indexes.size,
      activeIndexes: indexes.filter(i => i.status === 'active').length,
      totalVolume: Math.round(totalVolume * 100) / 100,
      totalTrades,
      totalMintValue: Math.round(totalMintValue * 100) / 100,
      totalBurnValue: Math.round(totalBurnValue * 100) / 100,
      treasury: {
        totalBalance: Math.round(totalTreasuryBalance * 100) / 100,
        totalCollected: Math.round(totalTreasuryCollected * 100) / 100,
        totalRedistributed: Math.round(totalTreasuryRedistributed * 100) / 100,
      },
      externalProviders: this.getExternalProviders(),
      indexes,
    }
  }

  /**
   * Get global activity feed from ALL indexes (merged + sorted)
   */
  getGlobalActivity(limit = 100) {
    const all = []
    for (const [indexId, feed] of this.feeds) {
      const state = this.indexes.get(indexId)
      for (const evt of feed) {
        all.push({ ...evt, indexSymbol: state?.symbol || indexId })
      }
    }
    all.sort((a, b) => b.timestamp - a.timestamp)
    return all.slice(0, limit)
  }
}
