// ═══════════════════════════════════════════════════════════════════════
// ARC-002: Extracted shared constants and formatters from LitePage.jsx
// ═══════════════════════════════════════════════════════════════════════

export {
  STRAT,
  LLM_PROVIDERS,
  LLM_MODELS,
  RISK_LEVELS,
  LITE_RISK_TO_ENGINE_RISK,
  resolveLiteRiskMeta,
  buildLiteStrategyConfig,
} from '@/components/agents/liteAgentWizardShared'

export const POLL_MS = 2000
export const FEED_LIMIT = 23
export const CHART_PTS = 80
export const ORACLE_HISTORY_LIMIT = 260
export const NEW_BADGE_MS = 24 * 60 * 60 * 1000 // 24 hours

export const normalizeWalletAddr = (addr) => (addr || '').trim().toLowerCase()

// ── Formatters ──
export const fmt$ = n => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1000 ? `$${(n/1000).toFixed(1)}k` : a < 0.01 && a > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}` }
export const fmtPct = n => `${(Number(n)||0) >= 0 ? '+' : ''}${(Number(n)||0).toFixed(2)}%`
export const fmtVol = n => { n = Number(n) || 0; return n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1000 ? `${(n/1000).toFixed(1)}K` : n.toFixed(0) }
export const fmtSize = n => { n = Number(n) || 0; return n >= 1000 ? `${(n/1000).toFixed(2)}K` : n.toFixed(2) }

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 3) return 'now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  return `${Math.floor(s/3600)}h ago`
}

export function isNewAgent(createdAt) {
  return createdAt && (Date.now() - createdAt) < NEW_BADGE_MS
}

// ── Reducer for LitePage UI state ──
export function createInitialLiteUiState() {
  let pinned = []
  try { pinned = JSON.parse(localStorage.getItem('odrob_pinned_indexes') || '[]') } catch {}
  return {
    activeTab: null,
    indexList: [],
    indexSnap: null,
    indexOB: null,
    indexTrades: [],
    indexPriceHist: [],
    indexOracleHist: [],
    agentSubs: [],
    subPending: false,
    showIndexDetail: null,
    showCreateIndex: false,
    showMyIndexes: false,
    centerView: 'dashboard',
    pinnedIndexIds: pinned,
  }
}

export function liteUiReducer(state, action) {
  switch (action.type) {
    case 'SET': {
      const prev = state[action.key]
      const next = typeof action.value === 'function' ? action.value(prev) : action.value
      if (Object.is(prev, next)) return state
      return { ...state, [action.key]: next }
    }
    case 'MERGE':
      return { ...state, ...action.payload }
    default:
      return state
  }
}
