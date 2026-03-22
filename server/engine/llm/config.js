// ═══════════════════════════════════════════════════════════════════════
// LLM Agent Config — ENV configuration with sensible defaults
// ═══════════════════════════════════════════════════════════════════════

const env = (key, fallback) => process.env[key] || fallback

export const LLM_CONFIG = {
  // ── Provider keys ────────────────────────────────────────────────
  openaiApiKey:       env('OPENAI_API_KEY', ''),
  anthropicApiKey:    env('ANTHROPIC_API_KEY', ''),
  openrouterApiKey:   env('OPENROUTER_API_KEY', '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'),
  ollamaBaseUrl:      env('OLLAMA_BASE_URL', 'http://localhost:11434'),

  // ── Defaults ─────────────────────────────────────────────────────
  defaultProvider:  env('LLM_DEFAULT_PROVIDER', 'openai'),     // openai | anthropic | openrouter | ollama
  defaultModel:     env('LLM_DEFAULT_MODEL', 'gpt-4o-mini'),

  // ── Timing ───────────────────────────────────────────────────────
  tickInterval:     parseInt(env('LLM_TICK_INTERVAL', '10'), 10),      // call LLM every N ticks
  timeoutMs:        parseInt(env('LLM_TIMEOUT_MS', '15000'), 10),      // abort after Nms
  cooldownMs:       parseInt(env('LLM_COOLDOWN_MS', '5000'), 10),

  // ── Generation params ────────────────────────────────────────────
  maxTokens:        parseInt(env('LLM_MAX_TOKENS', '1024'), 10),
  temperature:      parseFloat(env('LLM_TEMPERATURE', '0.3')),

  // ── Rate limiting ────────────────────────────────────────────────
  rateLimitPerMin:  parseInt(env('LLM_RATE_LIMIT_PER_MIN', '6'), 10),

  // ── Safety ───────────────────────────────────────────────────────
  maxConsecutiveErrors:  parseInt(env('LLM_MAX_ERRORS', '5'), 10),
  errorBackoffMultiplier: 2,
  fallbackStrategy:      'mean_reversion',

  // ── Memory ───────────────────────────────────────────────────────
  memoryLimit:          parseInt(env('LLM_MEMORY_LIMIT', '50'), 10),
  reflectionInterval:   parseInt(env('LLM_REFLECTION_INTERVAL', '20'), 10),  // every N decisions
  insightDecayFactor:   parseFloat(env('LLM_INSIGHT_DECAY', '0.95')),
  pruneKeepLast:        parseInt(env('LLM_PRUNE_KEEP', '1000'), 10),

  // ── Sizing ───────────────────────────────────────────────────────
  defaultOrderSizePct:  parseFloat(env('LLM_ORDER_SIZE_PCT', '0.05')),  // 5% of balance
  confidenceThreshold:  parseFloat(env('LLM_CONFIDENCE_THRESHOLD', '0.4')),  // hold if below
}

export default LLM_CONFIG
