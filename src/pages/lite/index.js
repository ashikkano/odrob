// ═══════════════════════════════════════════════════════════════════════
// ARC-002: Barrel export for extracted LitePage components
// ═══════════════════════════════════════════════════════════════════════

// Constants & formatters
export {
  POLL_MS, FEED_LIMIT, CHART_PTS, ORACLE_HISTORY_LIMIT, NEW_BADGE_MS,
  normalizeWalletAddr,
  fmt$, fmtPct, fmtVol, fmtSize, timeAgo, isNewAgent,
  STRAT, LLM_PROVIDERS, LLM_MODELS, RISK_LEVELS,
  createInitialLiteUiState, liteUiReducer,
} from './constants'

// Chart components
export { Sparkline, MiniBarChart, Metric, DepthChart } from './charts'

// Strategy map
export { StrategyMap } from './StrategyMap'
