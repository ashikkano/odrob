export const STRAT = {
  llm_trader:     { short: 'LLM',   color: '#a78bfa', label: 'LLM Agent',       desc: 'AI-powered trading via large language model. Analyzes market context and makes autonomous decisions.', icon: '🧠', isLLM: true },
  market_maker:   { short: 'MM',    color: '#818cf8', label: 'Market Maker',    desc: 'Provides two-sided liquidity with bid/ask spread capture. Profits from trading flow.', icon: '🏦' },
  trend_follower: { short: 'TREND', color: '#f59e0b', label: 'Trend Follower',  desc: 'Identifies momentum direction via SMA and rides confirmed trends up or down.', icon: '📈' },
  mean_reversion: { short: 'MR',    color: '#06b6d4', label: 'Mean Reversion',  desc: 'Buys when price deviates below moving average, sells when it returns. Statistical edge.', icon: '🔄' },
  momentum:       { short: 'MOM',   color: '#ec4899', label: 'Momentum',        desc: 'Trades fast/slow moving average crossovers. Catches explosive breakout moves.', icon: '🚀' },
  grid_trader:    { short: 'GRID',  color: '#8b5cf6', label: 'Grid Trader',     desc: 'Places layered orders at fixed price intervals. Profits from range-bound volatility.', icon: '📊' },
  scalper:        { short: 'SCALP', color: '#f97316', label: 'Scalper',         desc: 'Ultra-fast micro-trades capturing tiny price movements. High frequency, small edge.', icon: '⚡' },
  contrarian:     { short: 'CTR',   color: '#14b8a6', label: 'Contrarian',      desc: 'Fades short-term price moves, betting on mean reversion after overreaction.', icon: '🔮' },
  vwap:           { short: 'VWAP',  color: '#64748b', label: 'VWAP Trader',     desc: 'Trades deviations from volume-weighted average price. Institutional execution style.', icon: '🎯' },
}

export const LLM_PROVIDERS = [
  { id: 'odrob', label: '🟢 ODROB (free)', needsKey: false },
  { id: 'openai', label: 'OpenAI', needsKey: true },
  { id: 'anthropic', label: 'Anthropic', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', needsKey: false },
]

export const LLM_MODELS = {
  odrob: [
    { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
    { id: 'google/gemini-2.5-pro-preview', label: 'Gemini 2.5 Pro' },
    { id: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3' },
    { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  ],
  openrouter: [
    { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
    { id: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3' },
    { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
  ],
  ollama: [
    { id: 'llama3', label: 'Llama 3' },
    { id: 'mistral', label: 'Mistral' },
  ],
}

export const RISK_LEVELS = [
  { id: 'conservative', label: 'Conservative', desc: 'Small positions, tight stops', color: '#6ee7b7', icon: '🛡️', mult: 0.5 },
  { id: 'medium', label: 'Moderate', desc: 'Balanced risk/reward', color: '#818cf8', icon: '⚖️', mult: 1.0 },
  { id: 'aggressive', label: 'Aggressive', desc: 'Large positions, wide stops', color: '#f59e0b', icon: '🔥', mult: 1.8 },
  { id: 'degen', label: 'DEGEN', desc: 'Max leverage, no limits', color: '#ef4444', icon: '💀', mult: 3.0 },
]

export const LITE_RISK_TO_ENGINE_RISK = {
  conservative: 'low',
  medium: 'medium',
  aggressive: 'high',
  degen: 'high',
}

const LITE_RISK_PROFILE = {
  conservative: { sensitivity: 0.8, size: 0.8, cooldown: 1.4 },
  medium: { sensitivity: 1.0, size: 1.0, cooldown: 1.0 },
  aggressive: { sensitivity: 1.25, size: 1.35, cooldown: 0.7 },
  degen: { sensitivity: 1.5, size: 1.7, cooldown: 0.45 },
}

export function resolveLiteRiskMeta(riskLevel) {
  const normalized = {
    low: 'conservative',
    medium: 'medium',
    high: 'aggressive',
  }[riskLevel] || riskLevel
  return RISK_LEVELS.find((risk) => risk.id === normalized) || RISK_LEVELS[1]
}

export function buildLiteStrategyConfig(strategy, risk, llm = null) {
  const profile = LITE_RISK_PROFILE[risk] || LITE_RISK_PROFILE.medium
  const scale = (value) => Math.round(value * profile.size * 100) / 100
  const faster = (value) => Math.max(4, Math.round(value * profile.cooldown))
  const tighter = (value) => Math.max(0.08, Math.round((value / profile.sensitivity) * 100) / 100)

  if (strategy === 'trend_follower') {
    return {
      lookback: Math.max(5, Math.round(8 / profile.sensitivity)),
      momentumThreshold: tighter(1.0),
      orderSizePct: scale(2.8),
      cooldownMs: faster(16000),
    }
  }
  if (strategy === 'mean_reversion') {
    return {
      lookback: Math.max(10, Math.round(18 / profile.sensitivity)),
      entryZScore: tighter(1.35),
      exitZScore: tighter(0.35),
      orderSizePct: scale(6),
      cooldownMs: faster(20000),
    }
  }
  if (strategy === 'momentum') {
    return {
      fastPeriod: Math.max(4, Math.round(5 / profile.sensitivity)),
      slowPeriod: Math.max(8, Math.round(14 / profile.sensitivity)),
      crossThreshold: tighter(0.8),
      orderSizePct: scale(2.5),
      cooldownMs: faster(16000),
    }
  }
  if (strategy === 'market_maker') {
    return {
      minSpreadPct: tighter(0.35),
      spreadMultiplier: 1,
      orderSizePct: scale(3),
      maxInventory: Math.max(4, Math.round(6 * profile.size)),
      cooldownMs: faster(12000),
    }
  }
  if (strategy === 'grid_trader') {
    return {
      gridLevels: profile.size >= 1.3 ? 4 : 3,
      gridSizePct: scale(0.8),
      orderSizePct: scale(2.4),
      cooldownMs: faster(18000),
    }
  }
  if (strategy === 'scalper') {
    return {
      microThreshold: tighter(0.16),
      orderSizePct: scale(1.8),
      maxOrderAgeSec: Math.max(8, Math.round(18 * profile.cooldown)),
      randomTradePct: Math.min(12, Math.round(4 * profile.size)),
      cooldownMs: faster(8000),
    }
  }
  if (strategy === 'contrarian') {
    return {
      lookback: Math.max(5, Math.round(8 / profile.sensitivity)),
      fadeThreshold: tighter(0.8),
      orderSizePct: scale(7),
      cooldownMs: faster(18000),
    }
  }
  if (strategy === 'vwap') {
    return {
      deviationPct: tighter(0.5),
      orderSizePct: scale(6),
      cooldownMs: faster(15000),
    }
  }
  if (strategy === 'llm_trader') {
    return {
      llmProvider: llm?.provider || 'odrob',
      llmModel: llm?.model || 'google/gemini-2.0-flash-001',
      llmTickInterval: 10,
      orderSizePct: scale(0.08),
      cooldownMs: faster(12000),
      ...(llm?.apiKey ? { llmApiKey: llm.apiKey } : {}),
    }
  }
  return {}
}
