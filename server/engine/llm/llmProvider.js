// ═══════════════════════════════════════════════════════════════════════
// LLM Provider — Unified abstraction for OpenAI / Anthropic / Ollama
//
// Usage:
//   const provider = new LLMProvider(config?)
//   const { text, usage } = await provider.chat({ systemPrompt, userPrompt, ...opts })
// ═══════════════════════════════════════════════════════════════════════

import { LLM_CONFIG } from './config.js'

export class LLMProvider {
  constructor(configOverride = {}) {
    this.cfg = { ...LLM_CONFIG, ...configOverride }

    // Rate limiter state: Map<string, { timestamps: number[] }>
    this._rateBuckets = new Map()

    // LRU Response Cache: Map<hash, { result, ts }>
    this._cache = new Map()
    this._cacheMaxSize = 100
    this._cacheTtlMs = 60_000 // 1 minute TTL

    // Metrics
    this.metrics = {
      totalCalls: 0,
      totalErrors: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalLatencyMs: 0,
      cacheHits: 0,
      estimatedCostUsd: 0,
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  /**
   * Send a chat completion request to the configured LLM provider.
   *
   * @param {object} opts
   * @param {string} opts.systemPrompt
   * @param {string} opts.userPrompt
   * @param {string} [opts.provider]     - override provider per-call
   * @param {string} [opts.model]        - override model per-call
   * @param {number} [opts.temperature]
   * @param {number} [opts.maxTokens]
   * @param {string} [opts.agentId]      - for rate-limit bucketing
   * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number }, latencyMs: number }>}
   */
  async chat(opts) {
    const provider = opts.provider || this.cfg.defaultProvider
    const model    = opts.model    || this.cfg.defaultModel
    const agentId  = opts.agentId  || '__global__'

    // Cache check (skip for reflection/non-deterministic)
    if (!opts.skipCache) {
      const cached = this._cacheGet(opts.systemPrompt, opts.userPrompt, model)
      if (cached) {
        this.metrics.cacheHits++
        return { ...cached, latencyMs: 0, provider, model, cached: true }
      }
    }

    // Per-agent API key override (from user input)
    const apiKey = opts.apiKey || null

    // Rate limit check
    this._enforceRateLimit(agentId)

    const t0 = Date.now()
    this.metrics.totalCalls++

    try {
      let result
      switch (provider) {
        case 'openai':
          result = await this._callOpenAI(opts, model, apiKey)
          break
        case 'anthropic':
          result = await this._callAnthropic(opts, model, apiKey)
          break
        case 'openrouter':
          result = await this._callOpenRouter(opts, model, apiKey)
          break
        case 'odrob':
          // ODROB = OpenRouter with built-in platform key (never user key)
          result = await this._callOpenRouter(opts, model, null)
          break
        case 'ollama':
          result = await this._callOllama(opts, model)
          break
        default:
          throw new Error(`Unknown LLM provider: ${provider}`)
      }

      const latencyMs = Date.now() - t0
      this.metrics.totalLatencyMs += latencyMs
      this.metrics.totalTokensIn  += result.usage?.promptTokens || 0
      this.metrics.totalTokensOut += result.usage?.completionTokens || 0

      // Cost estimation
      this.metrics.estimatedCostUsd += this._estimateCost(
        provider, model,
        result.usage?.promptTokens || 0,
        result.usage?.completionTokens || 0
      )

      // Cache the result
      if (!opts.skipCache) {
        this._cachePut(opts.systemPrompt, opts.userPrompt, model, result)
      }

      return { ...result, latencyMs, provider, model }
    } catch (err) {
      this.metrics.totalErrors++
      err.provider = provider
      err.model = model
      err.latencyMs = Date.now() - t0
      throw err
    }
  }

  /** Aggregate stats */
  getStats() {
    const m = this.metrics
    return {
      totalCalls:    m.totalCalls,
      totalErrors:   m.totalErrors,
      avgLatencyMs:  m.totalCalls ? Math.round(m.totalLatencyMs / m.totalCalls) : 0,
      totalTokensIn: m.totalTokensIn,
      totalTokensOut: m.totalTokensOut,
      cacheHits:     m.cacheHits,
    }
  }

  // ─── OpenAI ──────────────────────────────────────────────────────

  async _callOpenAI({ systemPrompt, userPrompt, temperature, maxTokens }, model, overrideApiKey) {
    const apiKey = overrideApiKey || this.cfg.openaiApiKey
    if (!apiKey) throw new Error('OPENAI_API_KEY not set')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs)

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
          temperature: temperature ?? this.cfg.temperature,
          max_tokens:  maxTokens   ?? this.cfg.maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(`OpenAI ${res.status}: ${body.substring(0, 200)}`)
        err.status = res.status
        err.isRateLimit = res.status === 429
        throw err
      }

      const data = await res.json()
      const choice = data.choices?.[0]

      return {
        text:  choice?.message?.content || '',
        usage: {
          promptTokens:     data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── Anthropic ───────────────────────────────────────────────────

  async _callAnthropic({ systemPrompt, userPrompt, temperature, maxTokens }, model, overrideApiKey) {
    const apiKey = overrideApiKey || this.cfg.anthropicApiKey
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs)

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version':  '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens ?? this.cfg.maxTokens,
          temperature: temperature ?? this.cfg.temperature,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(`Anthropic ${res.status}: ${body.substring(0, 200)}`)
        err.status = res.status
        err.isRateLimit = res.status === 429
        throw err
      }

      const data = await res.json()
      const text = data.content?.[0]?.text || ''

      return {
        text,
        usage: {
          promptTokens:     data.usage?.input_tokens || 0,
          completionTokens: data.usage?.output_tokens || 0,
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── OpenRouter (multi-model gateway) ─────────────────────────────

  async _callOpenRouter({ systemPrompt, userPrompt, temperature, maxTokens }, model, overrideApiKey) {
    const apiKey = overrideApiKey || this.cfg.openrouterApiKey
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs)

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer':  'https://odrob.trading',
          'X-Title':       'ODROB Trading',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
          temperature: temperature ?? this.cfg.temperature,
          max_tokens:  maxTokens   ?? this.cfg.maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(`OpenRouter ${res.status}: ${body.substring(0, 200)}`)
        err.status = res.status
        err.isRateLimit = res.status === 429
        throw err
      }

      const data = await res.json()
      const choice = data.choices?.[0]

      return {
        text:  choice?.message?.content || '',
        usage: {
          promptTokens:     data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── Ollama (local) ──────────────────────────────────────────────

  async _callOllama({ systemPrompt, userPrompt, temperature }, model) {
    const baseUrl = this.cfg.ollamaBaseUrl

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs)

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
          stream: false,
          format: 'json',
          options: {
            temperature: temperature ?? this.cfg.temperature,
          },
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Ollama ${res.status}: ${body.substring(0, 200)}`)
      }

      const data = await res.json()

      return {
        text:  data.message?.content || '',
        usage: {
          promptTokens:     data.prompt_eval_count || 0,
          completionTokens: data.eval_count || 0,
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── Rate Limiter ────────────────────────────────────────────────

  _enforceRateLimit(agentId) {
    const limit = this.cfg.rateLimitPerMin
    if (!limit) return

    const now = Date.now()
    const windowMs = 60_000
    let bucket = this._rateBuckets.get(agentId)
    if (!bucket) {
      bucket = { timestamps: [] }
      this._rateBuckets.set(agentId, bucket)
    }

    // Purge old entries
    bucket.timestamps = bucket.timestamps.filter(t => now - t < windowMs)

    if (bucket.timestamps.length >= limit) {
      const err = new Error(`Rate limit exceeded for agent ${agentId}: ${limit}/min`)
      err.isRateLimit = true
      throw err
    }

    bucket.timestamps.push(now)
  }

  // ─── LRU Cache ───────────────────────────────────────────────────

  _cacheKey(systemPrompt, userPrompt, model) {
    // Simple hash from content
    const str = `${model}::${systemPrompt.length}::${userPrompt.slice(0, 500)}`
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return String(hash)
  }

  _cacheGet(systemPrompt, userPrompt, model) {
    const key = this._cacheKey(systemPrompt, userPrompt, model)
    const entry = this._cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.ts > this._cacheTtlMs) {
      this._cache.delete(key)
      return null
    }
    // Move to end (LRU freshness)
    this._cache.delete(key)
    this._cache.set(key, entry)
    return entry.result
  }

  _cachePut(systemPrompt, userPrompt, model, result) {
    const key = this._cacheKey(systemPrompt, userPrompt, model)
    // Evict oldest if full
    if (this._cache.size >= this._cacheMaxSize) {
      const oldest = this._cache.keys().next().value
      this._cache.delete(oldest)
    }
    this._cache.set(key, { result, ts: Date.now() })
  }

  // ─── Cost Estimation ─────────────────────────────────────────────

  _estimateCost(provider, model, promptTokens, completionTokens) {
    // Approximate $/1K token pricing
    const PRICING = {
      'gpt-4o-mini':    { input: 0.00015, output: 0.0006 },
      'gpt-4o':         { input: 0.0025,  output: 0.01 },
      'gpt-4-turbo':    { input: 0.01,    output: 0.03 },
      'claude-3-haiku': { input: 0.00025, output: 0.00125 },
      'claude-3-sonnet':{ input: 0.003,   output: 0.015 },
      'claude-3-opus':  { input: 0.015,   output: 0.075 },
      // OpenRouter models (approx pricing)
      'google/gemini-2.0-flash-001':       { input: 0.0001,  output: 0.0004 },
      'google/gemini-2.5-pro-preview':     { input: 0.00125, output: 0.01 },
      'deepseek/deepseek-chat-v3-0324':    { input: 0.0003,  output: 0.0009 },
      'meta-llama/llama-4-maverick':       { input: 0.0002,  output: 0.0006 },
      'qwen/qwen3-235b-a22b':             { input: 0.0002,  output: 0.0006 },
      'mistralai/mistral-medium-3':        { input: 0.0004,  output: 0.002 },
    }
    // 'odrob' is an OpenRouter alias — same pricing lookup
    const p = PRICING[model] || { input: 0.001, output: 0.002 } // fallback
    return (promptTokens / 1000 * p.input) + (completionTokens / 1000 * p.output)
  }
}

// Singleton for shared use (lazy init)
let _instance = null
export function getProvider(configOverride) {
  if (!_instance) _instance = new LLMProvider(configOverride)
  return _instance
}

export default LLMProvider
