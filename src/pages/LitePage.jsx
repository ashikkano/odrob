import { useState, useEffect, useRef, useCallback, useMemo, useReducer, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { TrendingUp, Sparkles, BarChart2, Info } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { useTonConnectUI, useTonAddress, useTonWallet } from '@tonconnect/ui-react'
import { fetchMetrics, fetchEngineAgents, fetchRecentTrades, pauseEngineAgent, startEngineAgent, deleteEngineAgent, fetchAgentByWallet, setWalletAddress } from '@/services/engineApi'
import { fetchIndexes, fetchIndex, fetchIndexPrice, fetchIndexOrderBook, fetchIndexTrades, fetchIndexHolders, fetchIndexOracle, subscribeToIndex, unsubscribeFromIndex, fetchAgentIndexes, setIndexWalletAddress, fetchAgentTemplates, fetchCanCreateIndex, createAgentIndex, fetchCreatorStats, fetchAgentIndexHoldings } from '@/services/indexApi'
import { login as loginWallet } from '@/services/agentApi'
import LiteCreateAgentModal from '@/components/agents/LiteCreateAgentModal'
import OracleInteractiveChart from '@/components/charts/OracleInteractiveChart'
import { getStrategySourceLabel } from '@/components/agents/strategyRuntimeSummary'
import ConnectWalletModal from '@/components/wallet/ConnectWalletModal'
import ConnectedWalletMenu from '@/components/wallet/ConnectedWalletMenu'
import { getPrivyLinkedWalletEntries, getSessionWalletAddress, hasPrivyWalletSession, useConnectWalletChooser } from '@/components/wallet/useConnectWalletChooser'
import { useAuthSession } from '@/contexts/AuthContext'
import '@/styles/lite.css'

// ARC-002: Import extracted constants, formatters, and components from lite/
import {
  POLL_MS, FEED_LIMIT, CHART_PTS, ORACLE_HISTORY_LIMIT, NEW_BADGE_MS,
  normalizeWalletAddr,
  fmt$, fmtPct, fmtVol, fmtSize, timeAgo, isNewAgent,
  STRAT, resolveLiteRiskMeta,
  createInitialLiteUiState, liteUiReducer,
} from './lite/constants'
import { Sparkline, MiniBarChart, Metric, DepthChart } from './lite/charts'
import { StrategyMap } from './lite/StrategyMap'

const LITE_INDEX_FEED_SIDEBAR_LIMIT = 14

function normalizeAgentSubscriptions(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.indexes)) return payload.indexes
  return []
}

function buildIdleDiagnostics(meta, agent) {
  const metrics = Array.isArray(meta?.metrics) && meta.metrics.length
    ? meta.metrics
    : (typeof meta?.momentumPct === 'number' && typeof meta?.thresholdPct === 'number'
      ? [
          { label: 'Momentum', value: `${meta.momentumPct >= 0 ? '+' : ''}${meta.momentumPct.toFixed(2)}%` },
          { label: 'Threshold', value: `±${meta.thresholdPct.toFixed(2)}%` },
          { label: 'Lookback', value: `${meta.lookback || '—'} bars` },
        ]
      : [])

  const flags = Array.isArray(meta?.flags) ? [...meta.flags] : []
  if (typeof meta?.longTrendUp === 'boolean' && !flags.some(flag => /long trend/i.test(flag?.label || ''))) {
    flags.push({ label: `Long trend ${meta.longTrendUp ? 'confirmed' : 'not confirmed'}`, ok: meta.longTrendUp })
  }
  if (meta?.mode && !flags.some(flag => flag?.label === meta.mode.replace(/_/g, ' '))) {
    flags.push({ label: meta.mode.replace(/_/g, ' ') })
  }
  if (agent?.lastIdleIndexSymbol && !flags.some(flag => flag?.label === agent.lastIdleIndexSymbol)) {
    flags.push({ label: agent.lastIdleIndexSymbol })
  }

  return { metrics, flags }
}

function getLiteAgentStrategyMeta(agent) {
  if (agent?.activeStrategyTemplateId || agent?.activeStrategyName) {
    const label = agent.activeStrategyName || getStrategySourceLabel(agent.strategySource)
    const short = agent.activeStrategyName
      ? agent.activeStrategyName.slice(0, 12)
      : 'CUSTOM'
    return {
      short,
      color: '#c4b5fd',
      label,
      desc: agent.activeStrategyDescription || getStrategySourceLabel(agent.strategySource),
      isCustom: true,
    }
  }

  return {
    ...(STRAT[agent?.strategy] || { short: '?', color: '#888', label: 'Unknown', desc: '' }),
    isCustom: false,
  }
}

// ════════════════════════════════════════════════════════════════════════
// ODROB Lite v4 — Social Trading + Wallet + User Agents
// ARC-002: Constants, formatters, charts, StrategyMap → src/pages/lite/
// ════════════════════════════════════════════════════════════════════════

// ── SVG Sparkline, MiniBarChart, Metric, DepthChart → extracted to lite/charts.jsx ──
// ── StrategyMap → extracted to lite/StrategyMap.jsx ──

// ════════════════════════════════════════════════════════════════════════
// MY AGENT PANEL — Personal agent dashboard
// ════════════════════════════════════════════════════════════════════════
const AGENT_ACTIVITY_TRADE_SIDES = new Set([
  'treasury_dividend',
  'creator_trade_fee',
  'creator_mint_fee',
  'creator_perf_fee',
  'creator_pool_reward',
  'strategy_royalty',
])

function fmtActivityFee$(n) {
  const value = Number(n) || 0
  const abs = Math.abs(value)
  if (abs === 0) return '$0.00'
  if (abs >= 1000) return `$${(value / 1000).toFixed(1)}k`
  if (abs >= 0.01) return `$${value.toFixed(2)}`
  if (abs >= 0.0001) return `$${value.toFixed(4)}`
  return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
}


function getCreatorActivityLabel(action) {
  if (action === 'creator_trade_fee') return 'TRADE FEE'
  if (action === 'creator_mint_fee') return 'CREATOR FEE'
  if (action === 'creator_perf_fee') return 'PERF FEE'
  if (action === 'creator_pool_reward') return 'POOL REWARD'
  if (action === 'strategy_royalty') return 'ROYALTY'
  return action?.toUpperCase() || 'ACTIVITY'
}

function getCreatorTradeLabel(action) {
  if (action === 'creator_trade_fee') return '💱 TRADE FEE'
  if (action === 'creator_mint_fee') return '🪙 CREATOR FEE'
  if (action === 'creator_perf_fee') return '📈 PERF FEE'
  if (action === 'creator_pool_reward') return '🌊 POOL REWARD'
  if (action === 'strategy_royalty') return '👑 ROYALTY'
  return '💰 CREATOR FEE'
}

function getSubscriptionOwnerLockLabel(subscriptionOwner) {
  if (subscriptionOwner === 'llm_scope') return 'Subscriptions managed by shared LLM scope'
  if (subscriptionOwner === 'custom') return 'Subscriptions managed by strategy rotation'
  if (subscriptionOwner === 'classic') return 'Subscriptions managed by runtime rotation'
  return ''
}

function getAgentActivityKey(entry) {
  const action = entry?.action || entry?.side || ''
  const symbol = entry?.indexSymbol || entry?.indexId || ''
  const amount = Number(entry?.size ?? entry?.value ?? 0)
  const tsBucket = Math.floor((entry?.timestamp || 0) / 1000)
  return `${action}|${symbol}|${tsBucket}|${amount.toFixed(4)}`
}

function buildAgentActivityFeed(agent, agentTrades) {
  const decisions = agent?.decisions || []
  const seen = new Set(decisions.map(getAgentActivityKey))

  const syntheticTradeEvents = (agentTrades || [])
    .filter(trade => AGENT_ACTIVITY_TRADE_SIDES.has(trade.side))
    .map(trade => ({
      action: trade.side,
      price: trade.price,
      size: trade.size ?? trade.value ?? 0,
      value: trade.value,
      confidence: 1,
      timestamp: trade.timestamp,
      indexId: trade.indexId,
      indexSymbol: trade.indexSymbol,
      reasoning:
        trade.side === 'treasury_dividend'
          ? `Received treasury dividend from ${trade.indexSymbol || trade.indexId}`
          : trade.side === 'creator_trade_fee'
            ? `Earned trade fee from ${trade.indexSymbol || trade.indexId}`
            : trade.side === 'creator_mint_fee'
              ? `Earned creator fee from ${trade.indexSymbol || trade.indexId}`
              : trade.side === 'creator_perf_fee'
                ? `Earned perf fee from ${trade.indexSymbol || trade.indexId}`
                : trade.side === 'strategy_royalty'
                  ? `Earned marketplace royalty from ${trade.indexSymbol || trade.indexId}`
                  : `Received creator pool reward from ${trade.indexSymbol || trade.indexId}`,
    }))
    .filter(entry => {
      const key = getAgentActivityKey(entry)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  return [...decisions, ...syntheticTradeEvents].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
}

function useAgentIndexHoldings(agentId, enabled = true) {
  const [holdings, setHoldings] = useState([])
  const [loading, setLoading] = useState(enabled)

  useEffect(() => {
    if (!agentId || !enabled) {
      setHoldings([])
      setLoading(false)
      return undefined
    }

    let alive = true
    setLoading(true)

    const load = () => {
      fetchAgentIndexHoldings(agentId)
        .then(data => {
          if (!alive) return
          setHoldings(Array.isArray(data) ? data : [])
          setLoading(false)
        })
        .catch(() => {
          if (!alive) return
          setHoldings([])
          setLoading(false)
        })
    }

    load()
    const iv = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [agentId, enabled])

  return { holdings, loading }
}

function MyAgentPanel({ agent, trades, indexes = [], agentSubs = [], onClose, onPause, onResume, onDelete, onOpenIndex, onUnsubscribe, subPending = false }) {
  const [tab, setTab] = useState('overview')
  const [showTopUpMock, setShowTopUpMock] = useState(false)
  const [topUpAmount, setTopUpAmount] = useState('250')
  const [topUpRail, setTopUpRail] = useState('TON')
  const [topUpStep, setTopUpStep] = useState('form')
  if (!agent) return null
  const { holdings: assetHoldings, loading: assetsLoading } = useAgentIndexHoldings(agent.id)
  const assetCount = assetsLoading ? null : assetHoldings.length

  const strat = getLiteAgentStrategyMeta(agent)
  const subscriptionLocked = agent.subscriptionOwner && agent.subscriptionOwner !== 'manual'
  const subscriptionLockLabel = getSubscriptionOwnerLockLabel(agent.subscriptionOwner)
  const isLLM = agent.strategy === 'llm_trader'
  // Use agent's own trade history (from API) + merge any from global feed
  const ownTrades = agent.trades || []
  const feedTrades = trades.filter(t => t.buyAgentId === agent.id || t.sellAgentId === agent.id)
  const ownIds = new Set(ownTrades.map(t => t.id))
  const merged = [...ownTrades, ...feedTrades.filter(t => !ownIds.has(t.id))]
  const agentTrades = merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, 30)
  const equityData = agent.equityCurve?.length > 1 ? agent.equityCurve.map(e => e.equity) : null
  const equity = agent.equity || (agent.virtualBalance + (agent.positionValue || 0))
  const royaltyIncome = agent.royaltyIncome || 0
  const pnlColor = (agent.pnl || 0) >= 0 ? '#6ee7b7' : '#fca5a5'
  const closedTrades = (agent.winningTrades || 0) + (agent.losingTrades || 0)
  const winRate = closedTrades > 0 ? ((agent.winningTrades / closedTrades) * 100).toFixed(2) : '0.00'
  const decisions = agent.decisions || []
  const activityFeed = buildAgentActivityFeed(agent, agentTrades)
  const riskMeta = resolveLiteRiskMeta(agent.riskLevel)
  const subscriptions = (agentSubs?.length ? agentSubs : agent.indexSubscriptions) || []
  const subscribedIndexes = subscriptions.map(sub => {
    const index = (indexes || []).find(item => item.id === sub.indexId)
    const marketCap = (index?.oraclePrice || 0) * (index?.circulatingSupply || 0)
    return {
      ...sub,
      symbol: index?.symbol || sub.indexId,
      name: index?.name || sub.indexId,
      icon: index?.icon || '📊',
      oraclePrice: index?.oraclePrice,
      totalVolume: index?.totalVolume || 0,
      marketCap,
    }
  })

  // LLM-specific data
  const llmConfig = agent.config || {}
  const llmProvider = llmConfig.llmProvider || 'odrob'
  const llmModel = llmConfig.llmModel || ''
  const llmModelShort = llmModel.split('/').pop() || llmModel
  const lastThinking = agent.lastThinking || null
  const lastReasoning = agent.lastReasoning || (decisions[0]?.reasoning) || null
  const lastAction = agent.lastAction || (decisions[0]?.action) || null
  const lastConfidence = agent.lastConfidence ?? (decisions[0]?.confidence) ?? null
  const idleReason = agent.lastIdleReason || null
  const idleMeta = agent.lastIdleMeta || null
  const statusSummaryTitle = idleReason
    ? (agent.lastIdleIndexSymbol ? `Watching ${agent.lastIdleIndexSymbol}` : 'Waiting for setup')
    : agent.status === 'active'
      ? 'Scanning markets'
      : 'Agent paused'
  const statusSummaryText = idleReason
    || (agent.status === 'active'
      ? 'Agent is active and monitoring subscribed indexes for the next valid setup.'
      : (agent.pauseReason || 'Agent is currently paused.'))
  const idleDiagnostics = buildIdleDiagnostics(idleMeta, agent)

  // P/L bars: engine sell trades with pnl, OR decision outcomes for LLM agents
  const sellBars = agentTrades
    .filter(t => t.side === 'sell' && t.pnl != null && t.pnl !== 0)
    .slice(0, 20)
    .reverse()
  const decisionBars = isLLM && sellBars.length === 0 && (agent.llmDecisionOutcomes || []).length > 0
    ? agent.llmDecisionOutcomes.filter(d => d.pnl !== 0).slice(0, 20).reverse()
    : []
  const pnlBars = sellBars.length > 0 ? sellBars : decisionBars
  const pnlBarsFromDecisions = sellBars.length === 0 && decisionBars.length > 0
  const maxAbsPnl = pnlBars.length > 0 ? Math.max(...pnlBars.map(t => Math.abs(t.pnl))) : 1
  const normalizedTopUp = Number(topUpAmount)
  const topUpValue = Number.isFinite(normalizedTopUp) ? Math.max(0, normalizedTopUp) : 0
  const projectedCash = (agent.virtualBalance || 0) + topUpValue
  const openTopUpMock = () => {
    setTopUpStep('form')
    setShowTopUpMock(true)
  }
  const closeTopUpMock = () => {
    setShowTopUpMock(false)
    setTopUpStep('form')
  }

  return (
    <div className="lt-modal-overlay" onClick={onClose}>
      <div className="lt-modal lt-myagent-modal" onClick={e => e.stopPropagation()}>
        <button className="lt-modal-close" onClick={onClose}>✕</button>

        {showTopUpMock ? (
          <div className="lt-topup-shell">
            <div className="lt-topup-shell-head">
              <button type="button" className="lt-topup-back" onClick={closeTopUpMock}>
                ← Back to Agent
              </button>
              <div className="lt-topup-shell-agent">
                <span className="lt-topup-shell-kicker">Top Up Balance</span>
                <strong>{agent.name}</strong>
                <small>Cash {fmt$(agent.virtualBalance || 0)}</small>
              </div>
            </div>

            <div className="lt-topup-mock lt-topup-mock-standalone">
              <div className="lt-topup-mock-head">
                <div>
                  <strong>Top Up Balance</strong>
                  <small>
                    {topUpStep === 'form' && 'Mock flow inside My Agent — no real transfer yet.'}
                    {topUpStep === 'confirm' && 'Review the payment summary before confirming the mock transfer.'}
                    {topUpStep === 'success' && 'Mock transfer completed inside this panel.'}
                  </small>
                </div>
                <span className="lt-topup-mock-status">Sandbox</span>
              </div>

              {topUpStep === 'form' && (
                <>
                  <div className="lt-topup-mock-presets">
                    {[10, 25, 50, 100, 250, 500, 1000].map(value => (
                      <button
                        key={value}
                        type="button"
                        className={`lt-topup-preset ${topUpValue === value ? 'lt-topup-preset-active' : ''}`}
                        onClick={() => setTopUpAmount(String(value))}
                      >
                        {fmt$(value)}
                      </button>
                    ))}
                  </div>

                  <div className="lt-topup-mock-grid">
                    <label className="lt-topup-field">
                      <span>Amount</span>
                      <input
                        type="number"
                        min="0"
                        step="10"
                        value={topUpAmount}
                        onChange={e => setTopUpAmount(e.target.value)}
                        placeholder="250"
                      />
                    </label>
                    <div className="lt-topup-field">
                      <span>Rail</span>
                      <div className="lt-topup-rails">
                        {[
                          { value: 'TON', label: 'TON' },
                          { value: 'USDT', label: 'USDT' },
                          { value: 'CARD', label: 'Bank Card' },
                        ].map(rail => (
                          <button
                            key={rail.value}
                            type="button"
                            className={`lt-topup-rail ${topUpRail === rail.value ? 'lt-topup-rail-active' : ''}`}
                            onClick={() => setTopUpRail(rail.value)}
                          >
                            {rail.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="lt-topup-mock-summary">
                    <div className="lt-topup-sum-item">
                      <span>Current cash</span>
                      <strong>{fmt$(agent.virtualBalance || 0)}</strong>
                    </div>
                    <div className="lt-topup-sum-item">
                      <span>Top up amount</span>
                      <strong>{fmt$(topUpValue)}</strong>
                    </div>
                    <div className="lt-topup-sum-item">
                      <span>Projected cash</span>
                      <strong>{fmt$(projectedCash)}</strong>
                    </div>
                  </div>

                  <div className="lt-topup-mock-actions">
                    <button type="button" className="lt-topup-confirm" onClick={() => setTopUpStep('confirm')}>
                      Continue Top Up
                    </button>
                    <span className="lt-topup-note">Mock only — backend funding flow not connected yet.</span>
                  </div>
                </>
              )}

              {topUpStep === 'confirm' && (
                <div className="lt-topup-confirm-screen">
                  <div className="lt-topup-confirm-card">
                    <div className="lt-topup-confirm-row"><span>Amount</span><strong>{fmt$(topUpValue)}</strong></div>
                    <div className="lt-topup-confirm-row"><span>Funding rail</span><strong>{topUpRail}</strong></div>
                    <div className="lt-topup-confirm-row"><span>Destination</span><strong>{agent.name}</strong></div>
                    <div className="lt-topup-confirm-row"><span>Current cash</span><strong>{fmt$(agent.virtualBalance || 0)}</strong></div>
                    <div className="lt-topup-confirm-row"><span>Projected cash</span><strong>{fmt$(projectedCash)}</strong></div>
                  </div>
                  <div className="lt-topup-mock-actions">
                    <button type="button" className="lt-topup-secondary" onClick={() => setTopUpStep('form')}>
                      Back
                    </button>
                    <button type="button" className="lt-topup-confirm" onClick={() => setTopUpStep('success')}>
                      Confirm Payment
                    </button>
                  </div>
                </div>
              )}

              {topUpStep === 'success' && (
                <div className="lt-topup-success">
                  <div className="lt-topup-success-icon">✓</div>
                  <strong>Mock top up created</strong>
                  <small>{fmt$(topUpValue)} via {topUpRail} for {agent.name}</small>
                  <div className="lt-topup-mock-actions">
                    <button type="button" className="lt-topup-secondary" onClick={() => setTopUpStep('form')}>
                      Create another
                    </button>
                    <button type="button" className="lt-topup-confirm" onClick={closeTopUpMock}>
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>

        {/* Header */}
        <div className="lt-myagent-head">
          <div className="lt-myagent-badges">
            <span className="lt-badge-user">MY AGENT</span>
            {isNewAgent(agent.createdAt) && <span className="lt-badge-new">NEW</span>}
            <span className="lt-modal-status" data-active={agent.status === 'active'}>
              {agent.status === 'active' ? '● LIVE' : '○ ' + (agent.status || '').toUpperCase()}
            </span>
          </div>
          <div className="lt-myagent-identity">
            <span className="lt-modal-avatar">{agent.icon}</span>
            <div className="lt-myagent-info">
              <div className="lt-modal-name">
                <span>{agent.name}</span>
                <span className="lt-pill lt-myagent-cash-pill">Cash {fmt$(agent.virtualBalance || 0)}</span>
              </div>
              <div className="lt-modal-strat">
                <span className="lt-pill" style={{ background: `${strat.color}22`, color: strat.color, borderColor: `${strat.color}44` }}>
                  {strat.label}
                </span>
                {isLLM ? (
                  <span className="lt-pill lt-pill-llm" style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', borderColor: 'rgba(167,139,250,0.3)' }}>
                    {llmProvider.toUpperCase()} · {llmModelShort}
                  </span>
                ) : (
                  <span className="lt-pill" style={{ background: `${riskMeta.color}15`, color: riskMeta.color, borderColor: `${riskMeta.color}33` }}>
                    {riskMeta.icon} {riskMeta.label}
                  </span>
                )}
              </div>
            </div>
            <div className="lt-modal-pnl" style={{ color: pnlColor }}>
              {fmtPct(agent.pnlPercent || 0)}
            </div>
          </div>
        </div>

        {/* Hero Stats */}
        <div className="lt-modal-hero">
          <div className="lt-hero-item">
            <span className="lt-hero-label">EQUITY</span>
            <span className="lt-hero-value">{fmt$(equity)}</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">REALIZED</span>
            <span className="lt-hero-value" style={{ color: (agent.realizedPnl||0) >= 0 ? '#6ee7b7' : '#fca5a5' }}>{fmt$(agent.realizedPnl || 0)}</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">WIN RATE</span>
            <span className="lt-hero-value" style={{ color: parseFloat(winRate) >= 50 ? '#6ee7b7' : '#fca5a5' }}>{winRate}%</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">TRADES</span>
            <span className="lt-hero-value">{agent.totalTrades}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="lt-myagent-ctrls">
          {agent.status === 'active' ? (
            <button className="lt-ma-btn lt-ma-btn-pause" onClick={onPause}>⏸ Pause</button>
          ) : (
            <button className="lt-ma-btn lt-ma-btn-resume" onClick={onResume}>▶ Resume</button>
          )}
          <button className="lt-ma-btn lt-ma-btn-delete" onClick={onDelete}>🗑 Remove</button>
        </div>

        {/* Index Controls */}
        <div className="lt-myagent-idx-ctrls">
          <button
            className="lt-ma-btn lt-ma-btn-index"
            type="button"
            onClick={openTopUpMock}
            aria-expanded={showTopUpMock}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14.5a3.5 3.5 0 0 1 0 7H6"/></svg>
            <span>Top Up Balance</span>
            <span className="lt-ma-btn-soon">{showTopUpMock ? 'Close' : 'Open'}</span>
          </button>
          <button className="lt-ma-btn lt-ma-btn-mock lt-ma-btn-dashboard" type="button" disabled title="Coming soon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3v18"/><path d="M12 8v13"/><path d="M7 13v8"/><path d="M21 16c0 2.5-2 4.5-4.5 4.5S12 18.5 12 16c0-1.7.9-3.2 2.3-4l2.2-1.3L19 9.4V13c1.2.8 2 1.8 2 3Z"/></svg>
            <span>Withdraw</span>
            <span className="lt-ma-btn-soon">Coming soon</span>
          </button>
        </div>

        <div className="lt-myagent-idle">
          <div className="lt-myagent-idle-head">
            <span>{idleReason ? 'Idle reason' : 'Agent status'}</span>
            <span>{agent.lastIdleAt ? timeAgo(agent.lastIdleAt) : agent.status}</span>
          </div>
          {idleDiagnostics.metrics.length > 0 && (
            <div className="lt-myagent-idle-metrics">
              {idleDiagnostics.metrics.map((metric, idx) => (
                <div className="lt-idle-metric-card" key={`${metric.label}-${idx}`}>
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                </div>
              ))}
            </div>
          )}
          <strong>{statusSummaryTitle}</strong>
          <p>{statusSummaryText}</p>
          <div className="lt-myagent-idle-flags">
            <span className={`lt-myagent-idle-flag ${agent.status === 'active' ? 'lt-myagent-idle-flag-ok' : ''}`}>
              {agent.status === 'active' ? 'active' : (agent.status || 'unknown')}
            </span>
            {idleDiagnostics.flags.map((flag, idx) => (
              <span
                key={`${flag.label}-${idx}`}
                className={`lt-myagent-idle-flag ${flag.ok ? 'lt-myagent-idle-flag-ok' : ''}`}
              >
                {flag.label}
              </span>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div className="lt-modal-tabs">
          {[
            { id: 'overview', label: 'Overview', icon: '📊' },
            { id: 'subscriptions', label: 'Subscriptions', icon: '📡', count: subscribedIndexes.length },
            { id: 'assets', label: 'Assets', icon: '💼', count: assetCount },
            { id: 'activity', label: 'Activity', icon: '🧠', count: activityFeed.length },
            { id: 'trades', label: 'Trades', icon: '💱', count: agentTrades.length },
          ].map(t => (
            <button
              key={t.id}
              className={`lt-tab ${tab === t.id ? 'lt-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className="lt-tab-icon">{t.icon}</span>
              {t.label}
              {t.count != null && <span className="lt-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="lt-modal-body" key={tab}>
          {tab === 'overview' && (
            <>
              <div className="lt-modal-chart-wrap">
                <div className="lt-modal-chart-head">
                  <span>Equity Curve</span>
                  <span className="lt-modal-chart-delta" style={{ color: pnlColor }}>
                    {(agent.pnl || 0) >= 0 ? '▲' : '▼'} {fmt$(Math.abs(agent.pnl || 0))}
                  </span>
                </div>
                <div className="lt-modal-chart">
                  {equityData ? (
                    <Sparkline data={equityData} height={100} color={pnlColor} />
                  ) : (
                    <div className="lt-modal-chart-empty">Building equity history…</div>
                  )}
                </div>
              </div>

              <div className="lt-modal-grid2">
                <div className="lt-grid2-item"><span className="lt-grid2-l">Cash</span><span className="lt-grid2-v">{fmt$(agent.virtualBalance)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Contracts</span><span className="lt-grid2-v">{fmtSize(agent.position || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Pos Value</span><span className="lt-grid2-v">{fmt$(agent.positionValue || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Realized</span><span className="lt-grid2-v" style={{ color: (agent.realizedPnl||0) >= 0 ? '#6ee7b7' : '#fca5a5' }}>{fmt$(agent.realizedPnl || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Unrealized</span><span className="lt-grid2-v" style={{ color: (agent.unrealizedPnl||0) >= 0 ? '#6ee7b7' : '#fca5a5' }}>{fmt$(agent.unrealizedPnl || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Royalties</span><span className="lt-grid2-v" style={{ color: royaltyIncome > 0 ? '#f5c542' : undefined }}>{fmt$(royaltyIncome)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Max DD</span><span className="lt-grid2-v" style={{ color: agent.maxDrawdown > 5 ? '#fca5a5' : '#6ee7b7' }}>{(agent.maxDrawdown || 0).toFixed(2)}%</span></div>
              </div>

              <div className="lt-modal-strategy-desc">
                <span className="lt-modal-desc-icon" style={{ color: strat.color }}>◆</span>
                {strat.desc}
              </div>

              {/* LLM Agent — Thinking & Config */}
              {isLLM && (
                <div className="lt-llm-overview">
                  {/* Internal thinking (chain of thought) */}
                  {lastThinking && (
                    <div className="lt-llm-thinking">
                      <div className="lt-llm-thinking-head">
                        <span>🧠 Thinking</span>
                        {lastAction && (
                          <span className={`lt-llm-action ${lastAction === 'buy' ? 'lt-llm-act-buy' : lastAction === 'sell' ? 'lt-llm-act-sell' : 'lt-llm-act-hold'}`}>
                            {lastAction === 'buy' ? '🟢' : lastAction === 'sell' ? '🔴' : '⏸️'} {lastAction.toUpperCase()}
                            {lastConfidence != null && <span className="lt-llm-conf">{(lastConfidence * 100).toFixed(0)}%</span>}
                          </span>
                        )}
                      </div>
                      <div className="lt-llm-thinking-text">{lastThinking}</div>
                    </div>
                  )}

                  {/* Public reasoning */}
                  {lastReasoning && (
                    <div className="lt-llm-reasoning">
                      <div className="lt-llm-reasoning-head">💬 Reasoning</div>
                      <div className="lt-llm-reasoning-text">{lastReasoning}</div>
                    </div>
                  )}

                  {/* P/L Bar Chart */}
                  {pnlBars.length > 0 && (
                    <div className="lt-pnl-chart">
                      <div className="lt-pnl-chart-head">
                        <span>📊 {pnlBarsFromDecisions ? 'Decision P/L' : 'Profit / Loss'}</span>
                        <span className="lt-pnl-chart-sub">{pnlBars.length} {pnlBarsFromDecisions ? 'outcomes' : 'closed trades'}</span>
                      </div>
                      <div className="lt-pnl-bars">
                        {pnlBars.map((t, i) => {
                          const pct = Math.abs(t.pnl) / maxAbsPnl * 100
                          const isWin = t.pnl > 0
                          return (
                            <div key={i} className="lt-pnl-bar-wrap" title={`${isWin ? '+' : ''}$${t.pnl.toFixed(4)}${t.indexSymbol ? ' @ ' + t.indexSymbol : t.instrument ? ' · ' + t.instrument : ''}`}>
                              <div className={`lt-pnl-bar ${isWin ? 'lt-pnl-bar-win' : 'lt-pnl-bar-loss'}`}
                                style={{ height: `${Math.max(pct, 8)}%` }} />
                            </div>
                          )
                        })}
                      </div>
                      <div className="lt-pnl-legend">
                        <span className="lt-pnl-legend-win">● Win</span>
                        <span className="lt-pnl-legend-loss">● Loss</span>
                      </div>
                    </div>
                  )}

                  {/* Model info */}
                  <div className="lt-llm-config-row">
                    <div className="lt-llm-config-item">
                      <span className="lt-llm-config-l">Provider</span>
                      <span className="lt-llm-config-v">{llmProvider === 'odrob' ? '🟢 ODROB' : llmProvider.toUpperCase()}</span>
                    </div>
                    <div className="lt-llm-config-item">
                      <span className="lt-llm-config-l">Model</span>
                      <span className="lt-llm-config-v lt-mono">{llmModelShort}</span>
                    </div>
                    <div className="lt-llm-config-item">
                      <span className="lt-llm-config-l">Tick Int.</span>
                      <span className="lt-llm-config-v">{llmConfig.llmTickInterval || 10}</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'subscriptions' && (
            <div className="lt-myagent-subs">
              <div className="lt-myagent-subs-head">
                <span>📡 Subscribed Indexes</span>
                <span className="lt-myagent-subs-count">{subscribedIndexes.length}</span>
              </div>
              {subscriptionLocked && (
                <div className="lt-myagent-subs-empty" style={{ marginBottom: 10 }}>
                  {subscriptionLockLabel} — manual unsubscribe is locked in Lite.
                </div>
              )}
              {subscribedIndexes.length === 0 ? (
                <div className="lt-myagent-subs-empty">No subscriptions yet — use ⚡ Subscribe on a market to attach this agent.</div>
              ) : (
                <div className="lt-myagent-subs-list">
                  {subscribedIndexes.map(sub => (
                    <div key={sub.indexId} className="lt-myagent-subs-item">
                      <div className="lt-myagent-subs-main">
                        <span className="lt-myagent-subs-icon">{sub.icon}</span>
                        <div className="lt-myagent-subs-copy">
                          <strong>{sub.symbol}</strong>
                          <small>{sub.name}</small>
                          <div className="lt-myagent-subs-stats">
                            <span>Volume ${fmtVol(sub.totalVolume || 0)}</span>
                            <span>Mcap ${fmtVol(sub.marketCap || 0)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="lt-myagent-subs-side">
                        <div className="lt-myagent-subs-meta">
                          <span>Allocation {sub.allocationPct || 0}%</span>
                          <span>{sub.status || 'active'}</span>
                          {sub.oraclePrice ? <span>{fmt$(sub.oraclePrice)}</span> : null}
                        </div>
                        <div className="lt-myagent-subs-actions">
                          <button
                            type="button"
                            className="lt-myagent-subs-btn lt-myagent-subs-btn-open"
                            onClick={() => onOpenIndex?.(sub.indexId)}
                          >
                            Open market
                          </button>
                          <button
                            type="button"
                            className="lt-myagent-subs-btn lt-myagent-subs-btn-unsub"
                            onClick={() => onUnsubscribe?.(sub.indexId)}
                            disabled={subPending || subscriptionLocked}
                            title={subscriptionLocked ? subscriptionLockLabel : undefined}
                          >
                            {subscriptionLocked ? 'Strategy locked' : subPending ? '…' : 'Unsubscribe'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'assets' && (
            <AssetsTab agentId={agent.id} holdings={assetHoldings} loading={assetsLoading} />
          )}

          {tab === 'activity' && (
            <div className="lt-modal-decisions">
              {activityFeed.length === 0 ? (
                <div className="lt-modal-no-data">No activity yet — agent warming up</div>
              ) : (
                activityFeed.slice(0, 12).map((d, i) => (
                  <div
                    key={i}
                    className={`lt-decision lt-card-slide ${d.action === 'buy' ? 'lt-dec-buy' : d.action === 'sell' ? 'lt-dec-sell' : d.action === 'treasury_dividend' ? 'lt-dec-treasury' : d.action?.startsWith('creator_') ? 'lt-dec-fee' : 'lt-dec-hold'}`}
                    style={{ animationDelay: `${i * 0.07}s` }}
                  >
                    <div className="lt-dec-top">
                      <div className="lt-dec-action">
                        {d.action === 'buy' ? '🟢' : d.action === 'sell' ? '🔴' : d.action === 'treasury_dividend' ? '🏦' : d.action === 'creator_trade_fee' ? '💱' : d.action === 'creator_mint_fee' ? '🪙' : d.action === 'creator_perf_fee' ? '📈' : d.action === 'creator_pool_reward' ? '🌊' : d.action === 'strategy_royalty' ? '👑' : '⏸️'}
                        <span className="lt-dec-act-text">{d.action === 'treasury_dividend' ? 'DIVIDEND' : (d.action?.startsWith('creator_') || d.action === 'strategy_royalty') ? getCreatorActivityLabel(d.action) : d.action.toUpperCase()}</span>
                        {(d.action === 'treasury_dividend' || d.action?.startsWith('creator_') || d.action === 'strategy_royalty') && <span className="lt-dec-price" style={{ color: d.action === 'treasury_dividend' ? '#a78bfa' : d.action === 'strategy_royalty' ? '#f5c542' : '#6ee7b7' }}>+{fmtActivityFee$(d.size)}</span>}
                        {!(d.action?.startsWith('creator_') || d.action === 'strategy_royalty') && d.action !== 'treasury_dividend' && d.price > 0 && <span className="lt-dec-price">${d.price?.toFixed(4)}</span>}
                        {!(d.action?.startsWith('creator_') || d.action === 'strategy_royalty') && d.action !== 'treasury_dividend' && d.size > 0 && <span className="lt-dec-size">×{d.size?.toFixed(2)}</span>}
                        {d.outcomeTag && (
                          <span className={`lt-dec-outcome ${d.outcomeTag === 'win' ? 'lt-dec-outcome-win' : d.outcomeTag === 'loss' ? 'lt-dec-outcome-loss' : 'lt-dec-outcome-neutral'}`}>
                            {d.outcomeTag === 'win' ? '✓ WIN' : d.outcomeTag === 'loss' ? '✗ LOSS' : d.outcomeTag.toUpperCase()}
                            {d.outcomePnl != null && <span className="lt-dec-outcome-pnl">{d.outcomePnl > 0 ? '+' : ''}{fmt$(d.outcomePnl)}</span>}
                          </span>
                        )}
                      </div>
                      <span className="lt-dec-time">{timeAgo(d.timestamp)}</span>
                    </div>
                    <div className="lt-dec-conf-bar">
                      <div className="lt-dec-conf-fill" style={{
                        width: `${(d.confidence || 0) * 100}%`,
                        background: d.action === 'buy' ? '#6ee7b7' : d.action === 'sell' ? '#fca5a5' : d.action === 'treasury_dividend' ? '#a78bfa' : d.action === 'strategy_royalty' ? '#f5c542' : d.action?.startsWith('creator_') ? '#6ee7b7' : 'rgba(255,255,255,0.15)',
                      }} />
                      <span className="lt-dec-conf-label">{((d.confidence || 0) * 100).toFixed(0)}%</span>
                    </div>
                    {d.thinking && <div className="lt-dec-thinking">{d.thinking}</div>}
                    <div className="lt-dec-reason">{d.reasoning}</div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'trades' && (
            <div className="lt-modal-trades">
              {agentTrades.length === 0 ? (
                <div className="lt-modal-no-data">No trades executed yet</div>
              ) : (
                agentTrades.slice(0, 20).map((t, i) => {
                  // Treasury dividend — special rendering
                  if (t.side === 'treasury_dividend') {
                    return (
                      <div key={i} className="lt-modal-trade lt-mt-treasury">
                        <span className="lt-mt-side lt-mt-side-treasury">🏦 DIVIDEND</span>
                        {t.indexSymbol && <span className="lt-badge-idx">{t.indexSymbol}</span>}
                        <span className="lt-mt-val" style={{ color: '#a78bfa' }}>+{fmt$(t.value)}</span>
                        <span className="lt-mt-detail-sm">{t.holdingBalance?.toFixed(2)} contracts held</span>
                        <span className="lt-mt-time">{timeAgo(t.timestamp)}</span>
                      </div>
                    )
                  }
                  // Creator fee events — trade fee, mint fee, perf fee, pool reward
                  if (t.side?.startsWith('creator_')) {
                    const feeLabel = getCreatorTradeLabel(t.side)
                    return (
                      <div key={i} className="lt-modal-trade lt-mt-fee">
                        <span className="lt-mt-side lt-mt-side-fee">{feeLabel}</span>
                        {t.indexSymbol && <span className="lt-badge-idx">{t.indexSymbol}</span>}
                        <span className="lt-mt-val" style={{ color: '#6ee7b7' }}>+{fmtActivityFee$(t.value)}</span>
                        {t.tradeValue > 0 && <span className="lt-mt-detail-sm">source volume {fmt$(t.tradeValue)}</span>}
                        <span className="lt-mt-time">{timeAgo(t.timestamp)}</span>
                      </div>
                    )
                  }
                  const isBuyer = t.side === 'buy' || t.buyAgentId === agent.id
                  return (
                    <div key={i} className={`lt-modal-trade ${isBuyer ? 'lt-mt-buy' : 'lt-mt-sell'}`}>
                      <span className="lt-mt-side">{isBuyer ? 'BUY' : 'SELL'}</span>
                      {t.indexSymbol && <span className="lt-badge-idx">{t.indexSymbol}</span>}
                      <span className="lt-mt-qty">{t.size?.toFixed(2)}</span>
                      <span className="lt-mt-at">@</span>
                      <span className="lt-mt-price">${t.price?.toFixed(4)}</span>
                      <span className="lt-mt-val">${(t.price * t.size).toFixed(2)}</span>
                      <span className="lt-mt-time">{timeAgo(t.timestamp)}</span>
                    </div>
                  )
                })
              )}
            </div>
          )}

        </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Assets Tab (agent holdings across indexes) ──────────────────────
function AssetsTab({ agentId, holdings: providedHoldings, loading: providedLoading }) {
  const fallback = useAgentIndexHoldings(agentId)
  const hasProvidedData = Array.isArray(providedHoldings) && typeof providedLoading === 'boolean'
  const holdings = hasProvidedData ? providedHoldings : fallback.holdings
  const loading = hasProvidedData ? providedLoading : fallback.loading

  const totalValue = holdings.reduce((s, h) => s + (h.holdingValue || 0), 0)
  const totalUnrealized = holdings.reduce((s, h) => s + (h.unrealizedPnl || 0), 0)

  if (loading) return <div className="lt-modal-no-data"><div className="lt-spin" /> Loading holdings…</div>
  if (holdings.length === 0) return <div className="lt-modal-no-data">No index holdings yet</div>

  return (
    <div className="lt-assets-tab">
      {/* Summary bar */}
      <div className="lt-assets-summary">
        <div className="lt-assets-sum-item">
          <span className="lt-assets-sum-l">Portfolio Value</span>
          <span className="lt-assets-sum-v">{fmt$(totalValue)}</span>
        </div>
        <div className="lt-assets-sum-sep" />
        <div className="lt-assets-sum-item">
          <span className="lt-assets-sum-l">Unrealized P/L</span>
          <span className="lt-assets-sum-v" style={{ color: totalUnrealized >= 0 ? '#6ee7b7' : '#fca5a5' }}>
            {totalUnrealized >= 0 ? '+' : ''}{fmt$(totalUnrealized)}
          </span>
        </div>
      </div>

      {/* Holdings list */}
      <div className="lt-assets-list">
        {holdings
          .sort((a, b) => (b.holdingValue || 0) - (a.holdingValue || 0))
          .map(h => {
            const pnlColor = (h.unrealizedPnl || 0) >= 0 ? '#6ee7b7' : '#fca5a5'
            const pnlPct = h.avgEntryPrice > 0 ? ((h.currentPrice - h.avgEntryPrice) / h.avgEntryPrice * 100) : 0
            const sharePct = totalValue > 0 ? (h.holdingValue / totalValue * 100) : 0
            return (
              <div key={h.indexId} className="lt-asset-row">
                <div className="lt-asset-top">
                  <span className="lt-asset-sym">{h.symbol}</span>
                  <span className="lt-asset-val">{fmt$(h.holdingValue)}</span>
                </div>
                <div className="lt-asset-bar">
                  <div className="lt-asset-bar-fill" style={{ width: `${Math.min(sharePct, 100)}%` }} />
                </div>
                <div className="lt-asset-details">
                  <span className="lt-asset-detail">
                    <span className="lt-asset-dl">Balance</span>
                    <span className="lt-asset-dv">{h.balance?.toFixed(2)}</span>
                  </span>
                  <span className="lt-asset-detail">
                    <span className="lt-asset-dl">Avg Entry</span>
                    <span className="lt-asset-dv">${h.avgEntryPrice?.toFixed(4)}</span>
                  </span>
                  <span className="lt-asset-detail">
                    <span className="lt-asset-dl">Price</span>
                    <span className="lt-asset-dv">${h.currentPrice?.toFixed(4)}</span>
                  </span>
                  <span className="lt-asset-detail">
                    <span className="lt-asset-dl">P/L</span>
                    <span className="lt-asset-dv" style={{ color: pnlColor }}>
                      {h.unrealizedPnl >= 0 ? '+' : ''}{fmt$(h.unrealizedPnl)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                    </span>
                  </span>
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// CREATE INDEX MODAL — 3-step wizard for agent index creation
// ════════════════════════════════════════════════════════════════════════
const TEMPLATE_COLORS = {
  creator_pnl: '#6ee7b7',
  creator_equity: '#a78bfa',
  strategy_alpha: '#f59e0b',
  multi_agent_basket: '#60a5fa',
  volume_flywheel: '#f472b6',
  hybrid_external: '#34d399',
}

function CreateIndexModal({ agentId, onClose, onCreated }) {
  const [step, setStep] = useState(1)
  const [templates, setTemplates] = useState([])
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const [canCreate, setCanCreate] = useState(null)
  const [loading, setLoading] = useState(true)

  // Load templates + eligibility on mount
  useEffect(() => {
    Promise.all([
      fetchAgentTemplates().catch(() => []),
      fetchCanCreateIndex(agentId).catch(() => ({ allowed: false, reason: 'Server unavailable' })),
    ]).then(([tpls, eligibility]) => {
      setTemplates(Array.isArray(tpls) ? tpls : tpls?.templates || [])
      setCanCreate(eligibility)
      setLoading(false)
    })
  }, [agentId])

  const tplColor = selectedTemplate ? (TEMPLATE_COLORS[selectedTemplate.id] || '#60a5fa') : '#60a5fa'

  const handleCreate = async () => {
    setCreating(true)
    setError(null)
    try {
      const result = await createAgentIndex({
        agentId,
        templateId: selectedTemplate.id,
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
      })
      if (result.error) { setError(result.error); setCreating(false); return }
      onCreated(result)
    } catch (err) {
      setError(err.message)
      setCreating(false)
    }
  }

  // Auto-generate symbol from name
  const handleNameChange = (val) => {
    setName(val)
    if (!symbol || symbol === autoSymbol(name)) {
      setSymbol(autoSymbol(val))
    }
  }
  function autoSymbol(n) {
    return n.trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()
  }

  const STEPS = [
    { num: 1, label: 'Formula' },
    { num: 2, label: 'Identity' },
    { num: 3, label: 'Launch' },
  ]

  const canGoStep2 = !!selectedTemplate
  const canGoStep3 = name.trim().length >= 2 && symbol.trim().length >= 2

  return (
    <div className="lt-modal-overlay" onClick={onClose}>
      <div className="lt-modal lt-cidx-modal" onClick={e => e.stopPropagation()}>
        <button className="lt-modal-close" onClick={onClose}>✕</button>

        {/* ── Header ── */}
        <div className="lt-cidx-header">
          <div className="lt-cidx-header-glow" style={{ background: `radial-gradient(ellipse at center, ${tplColor}12 0%, transparent 70%)` }} />
          <span className="lt-cidx-header-icon">🏗️</span>
          <h3 className="lt-cidx-title">Create Your Index</h3>
          <p className="lt-cidx-subtitle">Launch a custom index and earn fees on every trade</p>
        </div>

        {/* ── Labeled Step Bar ── */}
        {!loading && canCreate?.eligible !== false && (
          <div className="lt-cidx-stepper">
            {STEPS.map((s, i) => (
              <Fragment key={s.num}>
                {i > 0 && <div className={`lt-cidx-stepper-line${step > s.num - 1 ? ' lt-cidx-stepper-line-done' : ''}`} />}
                <button
                  className={`lt-cidx-step-pill${step === s.num ? ' lt-cidx-step-active' : ''}${step > s.num ? ' lt-cidx-step-done' : ''}`}
                  onClick={() => { if (step > s.num) setStep(s.num) }}
                  disabled={step < s.num}
                  style={step === s.num ? { borderColor: tplColor, color: tplColor } : undefined}
                >
                  <span className="lt-cidx-step-num">{step > s.num ? '✓' : s.num}</span>
                  <span className="lt-cidx-step-label">{s.label}</span>
                </button>
              </Fragment>
            ))}
          </div>
        )}

        {loading ? (
          <div className="lt-cidx-loading">
            <div className="lt-spin-lg" />
            <span>Checking eligibility…</span>
          </div>
        ) : canCreate && !canCreate.eligible ? (
          <div className="lt-cidx-blocked">
            <div className="lt-cidx-blocked-icon">🔒</div>
            <h4 className="lt-cidx-blocked-title">Not Yet Eligible</h4>
            <p className="lt-cidx-blocked-reason">{(canCreate.reasons || []).join('. ')}</p>
            <div className="lt-cidx-blocked-hints">
              {canCreate.requirements && Object.entries(canCreate.requirements).map(([k, v]) => (
                <div key={k} className="lt-cidx-req-row">
                  <span className={`lt-cidx-req-icon ${v.met ? 'lt-cidx-req-ok' : 'lt-cidx-req-no'}`}>
                    {v.met ? '✓' : '✗'}
                  </span>
                  <span className="lt-cidx-req-label">{v.label || k}</span>
                  <span className="lt-cidx-req-val">{v.current} / {v.needed}</span>
                </div>
              ))}
            </div>
            <button className="lt-cidx-btn-close" onClick={onClose}>Got It</button>
          </div>
        ) : (
          <div className="lt-cidx-body">
            {/* ════ Step 1: Choose Formula ════ */}
            {step === 1 && (
              <div className="lt-cidx-step lt-cidx-step-enter">
                <div className="lt-cidx-step-header">
                  <h4 className="lt-cidx-step-title">Choose Formula</h4>
                  <p className="lt-cidx-step-desc">Select how your index price will be calculated</p>
                </div>

                <div className="lt-cidx-tpl-grid">
                  {templates.map(t => {
                    const color = TEMPLATE_COLORS[t.id] || '#60a5fa'
                    const sel = selectedTemplate?.id === t.id
                    return (
                      <div
                        key={t.id}
                        className={`lt-cidx-tpl${sel ? ' lt-cidx-tpl-on' : ''}`}
                        onClick={() => setSelectedTemplate(t)}
                        style={sel ? { borderColor: color, '--tpl-glow': color } : { '--tpl-glow': color }}
                      >
                        <div className="lt-cidx-tpl-left">
                          <span className="lt-cidx-tpl-icon">{t.icon}</span>
                          <span className={`lt-cidx-tpl-cat lt-cidx-cat-${t.category}`}>{t.category}</span>
                        </div>
                        <div className="lt-cidx-tpl-body">
                          <div className="lt-cidx-tpl-name" style={sel ? { color } : undefined}>{t.name}</div>
                          <div className="lt-cidx-tpl-desc">{t.desc}</div>
                        </div>
                        {sel && <span className="lt-cidx-tpl-check" style={{ color }}>✓</span>}
                      </div>
                    )
                  })}
                </div>

                <div className="lt-cidx-hint">
                  <span className="lt-cidx-hint-icon">💡</span>
                  <span>Your index earns you <strong>0.15%</strong> on each trade + <strong>0.5%</strong> on mints</span>
                </div>

                <div className="lt-cidx-nav">
                  <div />
                  <button className="lt-cidx-btn-next" disabled={!canGoStep2} onClick={() => setStep(2)}>
                    Continue
                    <span className="lt-cidx-btn-arrow">→</span>
                  </button>
                </div>
              </div>
            )}

            {/* ════ Step 2: Name & Symbol ════ */}
            {step === 2 && (
              <div className="lt-cidx-step lt-cidx-step-enter">
                <div className="lt-cidx-step-header">
                  <h4 className="lt-cidx-step-title">Name & Symbol</h4>
                  <p className="lt-cidx-step-desc">Give your index an identity for the market</p>
                </div>

                {/* Live Preview Card */}
                <div className="lt-cidx-preview" style={{ borderColor: `${tplColor}40` }}>
                  <div className="lt-cidx-preview-glow" style={{ background: `radial-gradient(ellipse, ${tplColor}15, transparent 70%)` }} />
                  <div className="lt-cidx-preview-row">
                    <span className="lt-cidx-preview-icon">{selectedTemplate?.icon}</span>
                    <div className="lt-cidx-preview-info">
                      <span className="lt-cidx-preview-sym" style={{ color: tplColor }}>{symbol || '???'}</span>
                      <span className="lt-cidx-preview-name">{name || 'Your Index Name'}</span>
                    </div>
                    <div className="lt-cidx-preview-tag">
                      <span className="lt-cidx-preview-formula">{selectedTemplate?.name}</span>
                    </div>
                  </div>
                  <div className="lt-cidx-preview-mock">
                    <span className="lt-cidx-preview-price">$1.0000</span>
                    <span className="lt-cidx-preview-change c-green">+0.00%</span>
                    <span className="lt-cidx-preview-vol">Vol $0</span>
                  </div>
                </div>

                {/* Form Fields */}
                <div className="lt-cidx-form">
                  <div className="lt-cidx-field">
                    <label className="lt-cidx-field-label">Index Name</label>
                    <input
                      className="lt-cidx-input"
                      type="text"
                      placeholder="e.g. Alpha Gains, My Tracker…"
                      value={name}
                      onChange={e => handleNameChange(e.target.value)}
                      maxLength={24}
                      autoFocus
                    />
                    <div className="lt-cidx-field-footer">
                      <span className="lt-cidx-field-hint">Choose a memorable name</span>
                      <span className="lt-cidx-field-count">{name.length}/24</span>
                    </div>
                  </div>
                  <div className="lt-cidx-field">
                    <label className="lt-cidx-field-label">Ticker Symbol</label>
                    <input
                      className="lt-cidx-input lt-cidx-input-sym"
                      type="text"
                      placeholder="ALPHA"
                      value={symbol}
                      onChange={e => setSymbol(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase())}
                      maxLength={6}
                    />
                    <div className="lt-cidx-field-footer">
                      <span className="lt-cidx-field-hint">2–6 uppercase characters</span>
                      <span className="lt-cidx-field-count">{symbol.length}/6</span>
                    </div>
                  </div>
                </div>

                <div className="lt-cidx-nav">
                  <button className="lt-cidx-btn-back" onClick={() => setStep(1)}>← Back</button>
                  <button className="lt-cidx-btn-next" disabled={!canGoStep3} onClick={() => setStep(3)}>
                    Continue
                    <span className="lt-cidx-btn-arrow">→</span>
                  </button>
                </div>
              </div>
            )}

            {/* ════ Step 3: Review & Launch ════ */}
            {step === 3 && (
              <div className="lt-cidx-step lt-cidx-step-enter">
                <div className="lt-cidx-step-header">
                  <h4 className="lt-cidx-step-title">🚀 Ready to Launch</h4>
                  <p className="lt-cidx-step-desc">Review everything and deploy to the market</p>
                </div>

                {/* Summary Card */}
                <div className="lt-cidx-summary" style={{ borderColor: `${tplColor}30` }}>
                  <div className="lt-cidx-summary-hero">
                    <span className="lt-cidx-summary-icon">{selectedTemplate?.icon}</span>
                    <div>
                      <div className="lt-cidx-summary-sym" style={{ color: tplColor }}>{symbol}</div>
                      <div className="lt-cidx-summary-name">{name}</div>
                    </div>
                  </div>
                  <div className="lt-cidx-summary-grid">
                    <div className="lt-cidx-summary-item">
                      <span className="lt-cidx-summary-label">Formula</span>
                      <span className="lt-cidx-summary-val" style={{ color: tplColor }}>{selectedTemplate?.name}</span>
                    </div>
                    <div className="lt-cidx-summary-item">
                      <span className="lt-cidx-summary-label">Category</span>
                      <span className="lt-cidx-summary-val">{selectedTemplate?.category}</span>
                    </div>
                    <div className="lt-cidx-summary-item">
                      <span className="lt-cidx-summary-label">Creation Fee</span>
                      <span className="lt-cidx-summary-val">$50.00</span>
                    </div>
                    <div className="lt-cidx-summary-item">
                      <span className="lt-cidx-summary-label">Initial Stake</span>
                      <span className="lt-cidx-summary-val">5% · locked 10m</span>
                    </div>
                  </div>
                </div>

                {/* Revenue Breakdown */}
                <div className="lt-cidx-revenue">
                  <div className="lt-cidx-revenue-title">💰 Your Revenue</div>
                  <div className="lt-cidx-revenue-items">
                    <div className="lt-cidx-revenue-row">
                      <div className="lt-cidx-rev-bar" style={{ background: '#6ee7b7', width: '60%' }} />
                      <span className="lt-cidx-rev-label">Trading Fees</span>
                      <span className="lt-cidx-rev-pct">0.15%</span>
                    </div>
                    <div className="lt-cidx-revenue-row">
                      <div className="lt-cidx-rev-bar" style={{ background: '#a78bfa', width: '40%' }} />
                      <span className="lt-cidx-rev-label">Mint Fees</span>
                      <span className="lt-cidx-rev-pct">0.50%</span>
                    </div>
                    <div className="lt-cidx-revenue-row">
                      <div className="lt-cidx-rev-bar" style={{ background: '#f59e0b', width: '30%' }} />
                      <span className="lt-cidx-rev-label">Performance</span>
                      <span className="lt-cidx-rev-pct">10%</span>
                    </div>
                  </div>
                </div>

                {error && <div className="lt-cidx-error">⚠️ {error}</div>}

                <div className="lt-cidx-nav">
                  <button className="lt-cidx-btn-back" onClick={() => setStep(2)}>← Back</button>
                  <button
                    className="lt-cidx-btn-launch"
                    disabled={creating}
                    onClick={handleCreate}
                    style={{ background: `linear-gradient(135deg, ${tplColor}, ${tplColor}cc)` }}
                  >
                    {creating ? (
                      <><span className="lt-cidx-btn-spinner" /> Deploying…</>
                    ) : (
                      <>🚀 Launch Index</>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// MY INDEX DASHBOARD — Creator's index management panel
// ════════════════════════════════════════════════════════════════════════
function MyIndexDashboard({ agentId, onClose, onViewIndex }) {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      fetchCreatorStats(agentId)
        .then(data => { if (alive) { setStats(data); setLoading(false) } })
        .catch(err => { if (alive) { setError(err.message); setLoading(false) } })
    }
    load()
    const iv = setInterval(load, 5000)
    return () => { alive = false; clearInterval(iv) }
  }, [agentId])

  const totalRevenue = stats?.totalRevenue || 0
  const indexes = stats?.indexes || []
  const tradingFeeRevenue = indexes.reduce((s, i) => s + (i.creatorFees?.tradingFees || 0), 0)
  const mintFeeRevenue = indexes.reduce((s, i) => s + (i.creatorFees?.mintFees || 0), 0)
  const performanceFeeRevenue = indexes.reduce((s, i) => s + (i.creatorFees?.performanceFees || 0), 0)
  const feeHistory = stats?.feeHistory || []

  const FEE_ICONS = {
    trading_fee: '💱',
    mint_fee: '🪙',
    performance_fee: '📈',
    pool_reward: '🌊',
  }
  const FEE_LABELS = {
    trading_fee: 'Trading Fee',
    mint_fee: 'Mint Fee',
    performance_fee: 'Performance Fee',
    pool_reward: 'Pool Reward',
  }
  const FEE_COLORS = {
    trading_fee: '#6ee7b7',
    mint_fee: '#60a5fa',
    performance_fee: '#fbbf24',
    pool_reward: '#a78bfa',
  }

  return (
    <div className="lt-modal-overlay" onClick={onClose}>
      <div className="lt-modal lt-myidx-modal" onClick={e => e.stopPropagation()}>
        <button className="lt-modal-close" onClick={onClose}>✕</button>

        {/* Header */}
        <div className="lt-myidx-header">
          <span className="lt-myidx-header-icon">📊</span>
          <h3 className="lt-cidx-title">My Indexes</h3>
          <p className="lt-cidx-subtitle">Revenue & performance dashboard</p>
        </div>

        {loading ? (
          <div className="lt-cidx-loading">
            <div className="lt-spin-lg" />
            <span>Loading dashboard…</span>
          </div>
        ) : error ? (
          <div className="lt-cidx-blocked">
            <div className="lt-cidx-blocked-icon">⚠️</div>
            <p className="lt-cidx-blocked-reason">{error}</p>
          </div>
        ) : indexes.length === 0 ? (
          <div className="lt-cidx-blocked">
            <div className="lt-cidx-blocked-icon">📭</div>
            <h4 className="lt-cidx-blocked-title">No Indexes Yet</h4>
            <p className="lt-cidx-blocked-reason">Create your first index to start earning fees</p>
          </div>
        ) : (
          <>
            {/* Revenue Summary */}
            <div className="lt-myidx-revenue">
              <div className="lt-myidx-rev-item">
                <span className="lt-myidx-rev-label">Total Revenue</span>
                <span className="lt-myidx-rev-value lt-myidx-rev-main">{fmt$(totalRevenue)}</span>
              </div>
              <div className="lt-myidx-rev-sep" />
              <div className="lt-myidx-rev-item">
                <span className="lt-myidx-rev-label">From Trading</span>
                <span className="lt-myidx-rev-value">{fmt$(tradingFeeRevenue)}</span>
              </div>
              <div className="lt-myidx-rev-sep" />
              <div className="lt-myidx-rev-item">
                <span className="lt-myidx-rev-label">From Mints</span>
                <span className="lt-myidx-rev-value">{fmt$(mintFeeRevenue)}</span>
              </div>
              <div className="lt-myidx-rev-sep" />
              <div className="lt-myidx-rev-item">
                <span className="lt-myidx-rev-label">Performance</span>
                <span className="lt-myidx-rev-value">{fmt$(performanceFeeRevenue)}</span>
              </div>
            </div>

            {/* Index Cards */}
            <div className="lt-myidx-list">
              {indexes.map(idx => {
                const priceChange = idx.priceChange24h || 0
                const changeColor = priceChange >= 0 ? '#6ee7b7' : '#fca5a5'
                return (
                  <div key={idx.indexId} className="lt-myidx-card" onClick={() => onViewIndex?.(idx)}>
                    <div className="lt-myidx-card-top">
                      <div className="lt-myidx-card-name">
                        <span className="lt-myidx-card-sym" style={{ color: TEMPLATE_COLORS[idx.templateId] || '#60a5fa' }}>
                          {idx.symbol}
                        </span>
                        <span className="lt-myidx-card-full">{idx.name}</span>
                      </div>
                      <div className="lt-myidx-card-price">
                        <span className="lt-myidx-card-price-val">${(idx.oraclePrice || 0).toFixed(4)}</span>
                        <span className="lt-myidx-card-change" style={{ color: changeColor }}>
                          {priceChange >= 0 ? '▲' : '▼'} {Math.abs(priceChange).toFixed(2)}%
                        </span>
                      </div>
                    </div>

                    <div className="lt-myidx-card-stats">
                      <div className="lt-myidx-stat">
                        <span className="lt-myidx-stat-l">Volume</span>
                        <span className="lt-myidx-stat-v">${fmtVol(idx.totalVolume || 0)}</span>
                      </div>
                      <div className="lt-myidx-stat">
                        <span className="lt-myidx-stat-l">Holders</span>
                        <span className="lt-myidx-stat-v">{idx.holderCount || 0}</span>
                      </div>
                      <div className="lt-myidx-stat">
                        <span className="lt-myidx-stat-l">Treasury</span>
                        <span className="lt-myidx-stat-v">{fmt$(idx.treasury?.balance || 0)}</span>
                      </div>
                      <div className="lt-myidx-stat">
                        <span className="lt-myidx-stat-l">Fees Earned</span>
                        <span className="lt-myidx-stat-v" style={{ color: '#6ee7b7' }}>{fmt$(idx.creatorFees?.totalEarned || 0)}</span>
                      </div>
                    </div>

                    <div className="lt-myidx-card-footer">
                      <span className={`lt-myidx-status ${idx.status === 'active' ? 'lt-myidx-status-on' : 'lt-myidx-status-off'}`}>
                        {idx.status === 'active' ? '● Active' : '○ Paused'}
                      </span>
                      <span className="lt-myidx-card-age">{timeAgo(idx.createdAt)}</span>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Fee History Feed */}
            {feeHistory.length > 0 && (
              <div className="lt-myidx-fee-section">
                <h4 className="lt-myidx-fee-title">💰 Fee Activity</h4>
                <div className="lt-myidx-fee-list">
                  {feeHistory.slice(0, 20).map((f, i) => (
                    <div key={i} className="lt-myidx-fee-row">
                      <span className="lt-myidx-fee-icon">{FEE_ICONS[f.type] || '💰'}</span>
                      <div className="lt-myidx-fee-info">
                        <span className="lt-myidx-fee-label">{FEE_LABELS[f.type] || f.type}</span>
                        {f.symbol && <span className="lt-myidx-fee-sym">{f.symbol}</span>}
                      </div>
                      <span className="lt-myidx-fee-amount" style={{ color: FEE_COLORS[f.type] || '#6ee7b7' }}>
                        +{fmt$(f.amount || 0)}
                      </span>
                      <span className="lt-myidx-fee-time">{timeAgo(f.timestamp)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// AGENT POPUP MODAL (for fleet agents — read-only)
// ════════════════════════════════════════════════════════════════════════
function AgentModal({ agent, trades, onClose }) {
  const [tab, setTab] = useState('overview')
  if (!agent) return null
  const strat = getLiteAgentStrategyMeta(agent)
  // Use agent's own trade history (from API) + merge any from global feed
  const ownTrades = agent.trades || []
  const feedTrades = trades.filter(t => t.buyAgentId === agent.id || t.sellAgentId === agent.id)
  // Merge: own trades first, add feed trades not already present
  const ownIds = new Set(ownTrades.map(t => t.id))
  const merged = [...ownTrades, ...feedTrades.filter(t => !ownIds.has(t.id))]
  const agentTrades = merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, 30)
  const equityData = agent.equityCurve?.length > 1 ? agent.equityCurve.map(e => e.equity) : null
  const equity = agent.equity || (agent.virtualBalance + (agent.positionValue || 0))
  const royaltyIncome = agent.royaltyIncome || 0
  const pnlColor = (agent.pnl || 0) >= 0 ? '#6ee7b7' : '#fca5a5'
  const closedTrades = (agent.winningTrades || 0) + (agent.losingTrades || 0)
  const winRate = closedTrades > 0 ? ((agent.winningTrades / closedTrades) * 100).toFixed(2) : '0.00'
  const decisions = agent.decisions || []
  const activityFeed = buildAgentActivityFeed(agent, agentTrades)
  const recentActivity = activityFeed.slice(0, 12)
  const wl = closedTrades > 0 ? `${agent.winningTrades}W · ${agent.losingTrades}L` : '—'
  const isLLM = agent.strategy === 'llm_trader'

  // P/L bars: engine sell trades with pnl, OR decision outcomes for LLM agents
  const sellBars = agentTrades
    .filter(t => t.side === 'sell' && t.pnl != null && t.pnl !== 0)
    .slice(0, 20)
    .reverse()
  const decisionBars = isLLM && sellBars.length === 0 && (agent.llmDecisionOutcomes || []).length > 0
    ? agent.llmDecisionOutcomes.filter(d => d.pnl !== 0).slice(0, 20).reverse()
    : []
  const pnlBars = sellBars.length > 0 ? sellBars : decisionBars
  const pnlBarsFromDecisions = sellBars.length === 0 && decisionBars.length > 0
  const maxAbsPnl = pnlBars.length > 0 ? Math.max(...pnlBars.map(t => Math.abs(t.pnl))) : 1

  return (
    <div className="lt-modal-overlay" onClick={onClose}>
      <div className="lt-modal" onClick={e => e.stopPropagation()}>
        <button className="lt-modal-close" onClick={onClose}>✕</button>

        <div className="lt-modal-header">
          <div className="lt-modal-avatar">{agent.icon}</div>
          <div className="lt-modal-hinfo">
            <div className="lt-modal-name">
              {agent.name}
              {isNewAgent(agent.createdAt) && <span className="lt-badge-new">NEW</span>}
              {agent.isUserAgent && <span className="lt-badge-user-sm">USER</span>}
              <span className="lt-modal-status" data-active={agent.status === 'active'}>
                {agent.status === 'active' ? '● LIVE' : '○ ' + agent.status.toUpperCase()}
              </span>
            </div>
            <div className="lt-modal-strat">
              <span className="lt-pill" style={{ background: `${strat.color}22`, color: strat.color, borderColor: `${strat.color}44` }}>
                {strat.label}
              </span>
              <span className="lt-modal-since">Trading {agent.tickCount} ticks</span>
            </div>
          </div>
          <div className="lt-modal-pnl" style={{ color: pnlColor }}>
            {fmtPct(agent.pnlPercent || 0)}
          </div>
        </div>

        <div className="lt-modal-hero">
          <div className="lt-hero-item">
            <span className="lt-hero-label">EQUITY</span>
            <span className="lt-hero-value">{fmt$(equity)}</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">REALIZED</span>
            <span className="lt-hero-value" style={{ color: (agent.realizedPnl||0) >= 0 ? '#6ee7b7' : '#fca5a5' }}>{fmt$(agent.realizedPnl || 0)}</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">WIN RATE</span>
            <span className="lt-hero-value" style={{ color: parseFloat(winRate) >= 50 ? '#6ee7b7' : '#fca5a5' }}>{winRate}%</span>
            <span className="lt-hero-sub">{wl}</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">TRADES</span>
            <span className="lt-hero-value">{agent.totalTrades}</span>
            <span className="lt-hero-sub">${fmtVol(agent.totalVolume || 0)} vol</span>
          </div>
        </div>

        <div className="lt-modal-tabs">
          {[
            { id: 'overview', label: 'Overview', icon: '📊' },
            { id: 'activity', label: 'Activity', icon: '🧠', count: activityFeed.length },
            { id: 'trades', label: 'Trades', icon: '💱', count: agentTrades.length },
            { id: 'assets', label: 'Assets', icon: '💼' },
          ].map(t => (
            <button key={t.id} className={`lt-tab ${tab === t.id ? 'lt-tab-active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="lt-tab-icon">{t.icon}</span>
              {t.label}
              {t.count != null && <span className="lt-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>

        <div className="lt-modal-body" key={tab}>
          {tab === 'overview' && (
            <>
              {agent.bio && <div className="lt-modal-bio">{agent.bio}</div>}
              <div className="lt-modal-strategy-desc">
                <span className="lt-modal-desc-icon" style={{ color: strat.color }}>◆</span>
                {strat.desc}
              </div>
              <div className="lt-modal-chart-wrap">
                <div className="lt-modal-chart-head">
                  <span>Equity Curve</span>
                  <span className="lt-modal-chart-delta" style={{ color: pnlColor }}>
                    {(agent.pnl || 0) >= 0 ? '▲' : '▼'} {fmt$(Math.abs(agent.pnl || 0))}
                  </span>
                </div>
                <div className="lt-modal-chart">
                  {equityData ? <Sparkline data={equityData} height={100} color={pnlColor} /> : <div className="lt-modal-chart-empty">Building equity history…</div>}
                </div>
              </div>
              <div className="lt-modal-grid2">
                <div className="lt-grid2-item"><span className="lt-grid2-l">Cash</span><span className="lt-grid2-v">{fmt$(agent.virtualBalance)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Contracts</span><span className="lt-grid2-v">{fmtSize(agent.position || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Pos Value</span><span className="lt-grid2-v">{fmt$(agent.positionValue || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Realized</span><span className="lt-grid2-v" style={{ color: (agent.realizedPnl||0) >= 0 ? '#6ee7b7' : '#fca5a5' }}>{fmt$(agent.realizedPnl || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Unrealized</span><span className="lt-grid2-v" style={{ color: (agent.unrealizedPnl||0) >= 0 ? '#6ee7b7' : '#fca5a5' }}>{fmt$(agent.unrealizedPnl || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Royalties</span><span className="lt-grid2-v" style={{ color: royaltyIncome > 0 ? '#f5c542' : undefined }}>{fmt$(royaltyIncome)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Max DD</span><span className="lt-grid2-v" style={{ color: agent.maxDrawdown > 5 ? '#fca5a5' : '#6ee7b7' }}>{(agent.maxDrawdown || 0).toFixed(2)}%</span></div>
              </div>
              {/* Index Holdings & Treasury Dividends */}
              {(() => {
                const divTrades = agentTrades.filter(t => t.side === 'treasury_dividend')
                const idxTrades = agentTrades.filter(t => t.indexSymbol && t.side !== 'treasury_dividend')
                const idxSymbols = [...new Set([...divTrades, ...idxTrades].map(t => t.indexSymbol).filter(Boolean))]
                if (idxSymbols.length === 0) return null
                return (
                  <div className="lt-agent-idx-holdings">
                    <div className="lt-idx-hold-title">🏦 Index Holdings & Dividends</div>
                    {idxSymbols.map(sym => {
                      const symDivs = divTrades.filter(t => t.indexSymbol === sym)
                      const totalDivs = symDivs.reduce((s, t) => s + (t.value || 0), 0)
                      const lastHolding = symDivs[0]?.holdingBalance || idxTrades.find(t => t.indexSymbol === sym)?.position || 0
                      return (
                        <div key={sym} className="lt-idx-hold-row">
                          <span className="lt-badge-idx">{sym}</span>
                          <span className="lt-idx-hold-pos">{fmtSize(lastHolding)} contracts</span>
                          {totalDivs > 0 && (
                            <span className="lt-idx-hold-divs" style={{ color: '#a78bfa' }}>
                              🏦 +{fmt$(totalDivs)} earned ({symDivs.length} payouts)
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}

              {/* LLM thinking (if LLM agent) */}
              {isLLM && agent.lastThinking && (
                <div className="lt-llm-thinking" style={{ marginTop: 12 }}>
                  <div className="lt-llm-thinking-head">
                    <span>🧠 Thinking</span>
                    {agent.lastAction && (
                      <span className={`lt-llm-action ${agent.lastAction === 'buy' ? 'lt-llm-act-buy' : agent.lastAction === 'sell' ? 'lt-llm-act-sell' : 'lt-llm-act-hold'}`}>
                        {agent.lastAction === 'buy' ? '🟢' : agent.lastAction === 'sell' ? '🔴' : '⏸️'} {agent.lastAction.toUpperCase()}
                        {agent.lastConfidence != null && <span className="lt-llm-conf">{(agent.lastConfidence * 100).toFixed(0)}%</span>}
                      </span>
                    )}
                  </div>
                  <div className="lt-llm-thinking-text">{agent.lastThinking}</div>
                </div>
              )}
              {isLLM && agent.lastReasoning && (
                <div className="lt-llm-reasoning">
                  <div className="lt-llm-reasoning-head">💬 Reasoning</div>
                  <div className="lt-llm-reasoning-text">{agent.lastReasoning}</div>
                </div>
              )}

              {/* P/L Bar Chart */}
              {pnlBars.length > 0 && (
                <div className="lt-pnl-chart">
                  <div className="lt-pnl-chart-head">
                    <span>📊 {pnlBarsFromDecisions ? 'Decision P/L' : 'Profit / Loss'}</span>
                    <span className="lt-pnl-chart-sub">{pnlBars.length} {pnlBarsFromDecisions ? 'outcomes' : 'closed trades'}</span>
                  </div>
                  <div className="lt-pnl-bars">
                    {pnlBars.map((t, i) => {
                      const pct = Math.abs(t.pnl) / maxAbsPnl * 100
                      const isWin = t.pnl > 0
                      return (
                        <div key={i} className="lt-pnl-bar-wrap" title={`${isWin ? '+' : ''}$${t.pnl.toFixed(4)}${t.indexSymbol ? ' @ ' + t.indexSymbol : t.instrument ? ' · ' + t.instrument : ''}`}>
                          <div className={`lt-pnl-bar ${isWin ? 'lt-pnl-bar-win' : 'lt-pnl-bar-loss'}`}
                            style={{ height: `${Math.max(pct, 8)}%` }} />
                        </div>
                      )
                    })}
                  </div>
                  <div className="lt-pnl-legend">
                    <span className="lt-pnl-legend-win">● Win</span>
                    <span className="lt-pnl-legend-loss">● Loss</span>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'activity' && (
            <div className="lt-modal-decisions">
              {recentActivity.length === 0 ? (
                <div className="lt-modal-no-data">No activity yet — agent warming up</div>
              ) : recentActivity.map((d, i) => {
                const isCancel = d.action === 'cancel_all' || d.action === 'cancel_stale'
                const isFee = d.action?.startsWith('creator_') || d.action === 'strategy_royalty'
                const decClass = d.action === 'buy' ? 'lt-dec-buy'
                  : d.action === 'sell' ? 'lt-dec-sell'
                  : d.action === 'treasury_dividend' ? 'lt-dec-treasury'
                  : isFee ? 'lt-dec-fee'
                  : isCancel ? 'lt-dec-cancel'
                  : 'lt-dec-hold'
                const decIcon = d.action === 'buy' ? '🟢'
                  : d.action === 'sell' ? '🔴'
                  : d.action === 'treasury_dividend' ? '🏦'
                  : d.action === 'creator_trade_fee' ? '💱'
                  : d.action === 'creator_mint_fee' ? '🪙'
                  : d.action === 'creator_perf_fee' ? '📈'
                  : d.action === 'creator_pool_reward' ? '🌊'
                  : d.action === 'strategy_royalty' ? '👑'
                  : isCancel ? '🚫'
                  : '⏸️'
                const decLabel = d.action === 'treasury_dividend' ? 'DIVIDEND'
                  : isFee ? getCreatorActivityLabel(d.action)
                  : d.action === 'cancel_all' ? 'CANCEL ALL'
                  : d.action === 'cancel_stale' ? 'CANCEL STALE'
                  : d.action.toUpperCase()
                const confColor = d.action === 'buy' ? '#6ee7b7'
                  : d.action === 'sell' ? '#fca5a5'
                  : d.action === 'treasury_dividend' ? '#a78bfa'
                  : d.action === 'strategy_royalty' ? '#f5c542'
                  : isFee ? '#6ee7b7'
                  : isCancel ? '#fbbf24'
                  : 'rgba(255,255,255,0.15)'
                return (
                <div key={i} className={`lt-decision ${decClass}`}>
                  <div className="lt-dec-top">
                    <div className="lt-dec-action">
                      {decIcon}
                      <span className="lt-dec-act-text">{decLabel}</span>
                      {(d.action === 'treasury_dividend' || isFee) && <span className="lt-dec-price" style={{ color: d.action === 'treasury_dividend' ? '#a78bfa' : d.action === 'strategy_royalty' ? '#f5c542' : '#6ee7b7' }}>+{fmtActivityFee$(d.size)}</span>}
                      {!isCancel && !isFee && d.action !== 'treasury_dividend' && d.price > 0 && <span className="lt-dec-price">${d.price?.toFixed(4)}</span>}
                      {!isCancel && !isFee && d.action !== 'treasury_dividend' && d.size > 0 && <span className="lt-dec-size">×{d.size?.toFixed(2)}</span>}
                      {d.outcomeTag && (
                        <span className={`lt-dec-outcome ${d.outcomeTag === 'win' ? 'lt-dec-outcome-win' : d.outcomeTag === 'loss' ? 'lt-dec-outcome-loss' : 'lt-dec-outcome-neutral'}`}>
                          {d.outcomeTag === 'win' ? '✓ WIN' : d.outcomeTag === 'loss' ? '✗ LOSS' : d.outcomeTag.toUpperCase()}
                          {d.outcomePnl != null && <span className="lt-dec-outcome-pnl">{d.outcomePnl > 0 ? '+' : ''}{fmt$(d.outcomePnl)}</span>}
                        </span>
                      )}
                    </div>
                    <span className="lt-dec-time">{timeAgo(d.timestamp)}</span>
                  </div>
                  <div className="lt-dec-conf-bar">
                    <div className="lt-dec-conf-fill" style={{
                      width: `${(d.confidence || 0) * 100}%`,
                      background: confColor,
                    }} />
                    <span className="lt-dec-conf-label">{((d.confidence || 0) * 100).toFixed(0)}%</span>
                  </div>
                  {d.thinking && <div className="lt-dec-thinking">{d.thinking}</div>}
                  <div className="lt-dec-reason">{d.reasoning}</div>
                </div>
                )
              })}
            </div>
          )}

          {tab === 'trades' && (
            <div className="lt-modal-trades">
              {agentTrades.length === 0 ? (
                <div className="lt-modal-no-data">No trades executed yet</div>
              ) : agentTrades.slice(0, 20).map((t, i) => {
                // Treasury dividend — special rendering
                if (t.side === 'treasury_dividend') {
                  return (
                    <div key={i} className="lt-modal-trade lt-mt-treasury">
                      <span className="lt-mt-side lt-mt-side-treasury">🏦 DIVIDEND</span>
                      {t.indexSymbol && <span className="lt-badge-idx">{t.indexSymbol}</span>}
                      <span className="lt-mt-val" style={{ color: '#a78bfa' }}>+{fmt$(t.value)}</span>
                      <span className="lt-mt-detail-sm">{t.holdingBalance?.toFixed(2)} contracts held</span>
                      <span className="lt-mt-time">{timeAgo(t.timestamp)}</span>
                    </div>
                  )
                }
                // Creator fee events
                if (t.side?.startsWith('creator_')) {
                  const feeLabel = getCreatorTradeLabel(t.side)
                  return (
                    <div key={i} className="lt-modal-trade lt-mt-fee">
                      <span className="lt-mt-side lt-mt-side-fee">{feeLabel}</span>
                      {t.indexSymbol && <span className="lt-badge-idx">{t.indexSymbol}</span>}
                      <span className="lt-mt-val" style={{ color: '#6ee7b7' }}>+{fmtActivityFee$(t.value)}</span>
                      {t.tradeValue > 0 && <span className="lt-mt-detail-sm">source volume {fmt$(t.tradeValue)}</span>}
                      <span className="lt-mt-time">{timeAgo(t.timestamp)}</span>
                    </div>
                  )
                }
                const isBuyer = t.side === 'buy' || t.buyAgentId === agent.id
                return (
                  <div key={i} className={`lt-modal-trade ${isBuyer ? 'lt-mt-buy' : 'lt-mt-sell'}`}>
                    <span className="lt-mt-side">{isBuyer ? 'BUY' : 'SELL'}</span>
                    {t.indexSymbol && <span className="lt-badge-idx">{t.indexSymbol}</span>}
                    <span className="lt-mt-qty">{t.size?.toFixed(2)}</span>
                    <span className="lt-mt-at">@</span>
                    <span className="lt-mt-price">${t.price?.toFixed(4)}</span>
                    <span className="lt-mt-val">${(t.price * t.size).toFixed(2)}</span>
                    <span className="lt-mt-time">{timeAgo(t.timestamp)}</span>
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'assets' && (
            <AssetsTab agentId={agent.id} />
          )}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// TRADE CARD
// ════════════════════════════════════════════════════════════════════════
function TradeCard({ trade, agents, isNew: isNewTrade, onAgentClick }) {
  const buyer = agents.find(a => a.id === trade.buyAgentId)
  const seller = agents.find(a => a.id === trade.sellAgentId)
  const isBuy = trade.aggressorSide === 'buy'
  const aggressor = isBuy ? buyer : seller
  const passive = isBuy ? seller : buyer
  const stratA = STRAT[aggressor?.strategy] || { short: '?', color: '#888' }
  const stratP = STRAT[passive?.strategy] || { short: '?', color: '#888' }
  const value = (trade.price * trade.size).toFixed(2)

  return (
    <div className={`lt-card ${isBuy ? 'lt-card-buy' : 'lt-card-sell'}${isNewTrade ? ' lt-card-slide' : ''}`}>
      <div className="lt-card-row" onClick={() => aggressor && onAgentClick(aggressor.id)}>
        <span className="lt-card-avatar">{aggressor?.icon || '🤖'}</span>
        <div className="lt-card-info">
          <div className="lt-card-name">
            {aggressor?.name || 'Unknown'}
            {aggressor?.isUserAgent
              ? <span className="lt-badge-user-sm">USER</span>
              : <span className="lt-badge-agent">AGENT</span>
            }
            {isNewAgent(aggressor?.createdAt) && <span className="lt-badge-new-sm">NEW</span>}
            <span className="lt-pill lt-pill-sm" style={{ background: `${stratA.color}22`, color: stratA.color, borderColor: `${stratA.color}44` }}>
              {stratA.short}
            </span>
          </div>
          <div className="lt-card-action">
            <span className={isBuy ? 'lt-act-buy' : 'lt-act-sell'}>
              {isBuy ? '● bought' : '● sold'}
            </span>
            {' '}
            <span className="lt-card-qty">{fmtSize(trade.size)}</span>
            {' @ '}
            <span className="lt-card-price">${trade.price.toFixed(4)}</span>
          </div>
        </div>
        <div className="lt-card-right">
          <div className="lt-card-val">${value}</div>
          <div className={`lt-card-pnl ${(aggressor?.pnl||0) >= 0 ? 'lt-card-pnl-up' : 'lt-card-pnl-down'}`}>
            {(aggressor?.pnl||0) >= 0 ? '▲ Profit' : '▼ Loss'} {fmtPct(aggressor?.pnlPercent || 0)}
          </div>
          <div className="lt-card-time">{timeAgo(trade.timestamp)}</div>
        </div>
      </div>

      {passive && (
        <div className="lt-card-counter" onClick={() => onAgentClick(passive.id)}>
          <span className="lt-counter-dir">{isBuy ? '→' : '←'}</span>
          <span className="lt-counter-icon">{passive.icon}</span>
          <span className="lt-counter-name">{passive.name}</span>
          {passive.isUserAgent
            ? <span className="lt-badge-user-sm">USER</span>
            : <span className="lt-badge-agent lt-badge-agent-sm">AGENT</span>
          }
          {isNewAgent(passive?.createdAt) && <span className="lt-badge-new-sm">NEW</span>}
          <span className="lt-pill lt-pill-xs" style={{ background: `${stratP.color}15`, color: stratP.color, borderColor: `${stratP.color}33` }}>
            {stratP.short}
          </span>
          <span className={`lt-counter-pnl ${(passive.pnl||0) >= 0 ? 'c-green' : 'c-red'}`}>
            {fmtPct(passive.pnlPercent || 0)}
          </span>
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// INDEX TRADE CARD — Shows trades with embedded buyer/seller names
// ════════════════════════════════════════════════════════════════════════
function IndexTradeCard({ trade, agents, onAgentClick }) {
  const isBuy = trade.side === 'buy' || trade.aggressorSide === 'buy'
  const value = (trade.price * trade.size).toFixed(2)
  const buyerId = trade.buyAgentId || trade.buyerId
  const sellerId = trade.sellAgentId || trade.sellerId
  const buyer = agents?.find(a => a.id === buyerId)
  const seller = agents?.find(a => a.id === sellerId)
  const isSystemBuyer = buyerId?.startsWith?.('__')
  const isSystemSeller = sellerId?.startsWith?.('__')

  const handleBuyerClick = () => {
    if (buyer && onAgentClick && !isSystemBuyer) onAgentClick(buyer.id)
  }
  const handleSellerClick = () => {
    if (seller && onAgentClick && !isSystemSeller) onAgentClick(seller.id)
  }

  const buyerStrat = buyer ? getLiteAgentStrategyMeta(buyer) : null
  const sellerStrat = seller ? getLiteAgentStrategyMeta(seller) : null

  return (
    <div className={`lt-card ${isBuy ? 'lt-card-buy' : 'lt-card-sell'}`}>
      <div className="lt-card-row" onClick={handleBuyerClick} style={buyer && !isSystemBuyer ? { cursor: 'pointer' } : undefined}>
        <span className="lt-card-avatar">{trade.buyerIcon || buyer?.icon || '🤖'}</span>
        <div className="lt-card-info">
          <div className="lt-card-name">
            {trade.buyerName || buyer?.name || 'Unknown'}
            {trade.isMint && <span className="lt-badge-mint">MINT</span>}
            {buyerStrat && <span className="lt-pill lt-pill-sm" style={{ background: `${buyerStrat.color}22`, color: buyerStrat.color, borderColor: `${buyerStrat.color}44` }}>{buyerStrat.short}</span>}
          </div>
          <div className="lt-card-action">
            <span className={isBuy ? 'lt-act-buy' : 'lt-act-sell'}>
              ● {isBuy ? 'bought' : 'sold'}
            </span>
            {' '}
            <span className="lt-card-qty">{fmtSize(trade.size)}</span>
            {' @ '}
            <span className="lt-card-price">${trade.price.toFixed(4)}</span>
          </div>
        </div>
        <div className="lt-card-right">
          <div className="lt-card-val">${value}</div>
          {buyer && <div className={`lt-card-pnl ${(buyer.pnl||0) >= 0 ? 'lt-card-pnl-up' : 'lt-card-pnl-down'}`}>{(buyer.pnl||0) >= 0 ? '▲' : '▼'} {fmtPct(buyer.pnlPercent || 0)}</div>}
          <div className="lt-card-time">{timeAgo(trade.timestamp)}</div>
        </div>
      </div>
      <div className="lt-card-counter" onClick={handleSellerClick} style={seller && !isSystemSeller ? { cursor: 'pointer' } : undefined}>
        <span className="lt-counter-dir">{isBuy ? '→' : '←'}</span>
        <span className="lt-counter-icon">{trade.sellerIcon || seller?.icon || '🏦'}</span>
        <span className="lt-counter-name">{trade.sellerName || seller?.name || 'Unknown'}</span>
        {sellerStrat && <span className="lt-pill lt-pill-xs" style={{ background: `${sellerStrat.color}15`, color: sellerStrat.color, borderColor: `${sellerStrat.color}33` }}>{sellerStrat.short}</span>}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// INDEX DETAIL MODAL — Beautiful popup matching agent modal design
// ════════════════════════════════════════════════════════════════════════
function IndexDetailModal({ index, trades, priceHistory, onClose }) {
  const [tab, setTab] = useState('overview')
  if (!index) return null

  const changePct = index.changePct || 0
  const cap = (index.oraclePrice || 0) * (index.circulatingSupply || 0)
  const supplyPct = index.maxSupply > 0
    ? ((index.circulatingSupply / index.maxSupply) * 100).toFixed(1) : '0'
  const pnlColor = changePct >= 0 ? '#6ee7b7' : '#fca5a5'
  const recentTrades = (trades || []).slice(0, 20)

  return (
    <div className="lt-modal-overlay" onClick={onClose}>
      <div className="lt-modal" onClick={e => e.stopPropagation()}>
        <button className="lt-modal-close" onClick={onClose}>✕</button>

        {/* Header — like agent modal header */}
        <div className="lt-modal-header">
          <div className="lt-modal-avatar">{index.icon || '📊'}</div>
          <div className="lt-modal-hinfo">
            <div className="lt-modal-name">
              {index.name}
              <span className="lt-badge-idx">{index.symbol}</span>
              <span className="lt-modal-status" data-active={index.status === 'active'}>
                {index.status === 'active' ? '● LIVE' : '○ ' + (index.status || '').toUpperCase()}
              </span>
            </div>
            <div className="lt-modal-strat">
              <span className="lt-pill" style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa', borderColor: 'rgba(139,92,246,0.3)' }}>
                {index.formulaName || index.formulaId || 'Index'}
              </span>
              <span className="lt-modal-since">{index.createdAt ? timeAgo(index.createdAt) : ''}</span>
            </div>
          </div>
          <div className="lt-modal-pnl" style={{ color: pnlColor }}>
            {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
          </div>
        </div>

        {/* Hero stats bar — same as agent */}
        <div className="lt-modal-hero">
          <div className="lt-hero-item">
            <span className="lt-hero-label">PRICE</span>
            <span className="lt-hero-value">${index.oraclePrice?.toFixed(4) || '—'}</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">MKT CAP</span>
            <span className="lt-hero-value">${fmtVol(cap)}</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">SUPPLY</span>
            <span className="lt-hero-value">{fmtVol(index.circulatingSupply || 0)}</span>
            <span className="lt-hero-sub">{supplyPct}% minted</span>
          </div>
          <div className="lt-hero-sep" />
          <div className="lt-hero-item">
            <span className="lt-hero-label">VOLUME</span>
            <span className="lt-hero-value">${fmtVol(index.totalVolume || 0)}</span>
            <span className="lt-hero-sub">{index.totalTrades || 0} trades</span>
          </div>
        </div>

        {/* Tabs — same as agent */}
        <div className="lt-modal-tabs">
          {[
            { id: 'overview', label: 'Overview', icon: '📊' },
            { id: 'formula', label: 'Formula', icon: '📐' },
            { id: 'trades', label: 'Trades', icon: '💱', count: recentTrades.length },
            { id: 'treasury', label: 'Treasury', icon: '🏦' },
            { id: 'params', label: 'Parameters', icon: '⚙️' },
          ].map(t => (
            <button key={t.id} className={`lt-tab ${tab === t.id ? 'lt-tab-active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="lt-tab-icon">{t.icon}</span>
              {t.label}
              {t.count != null && <span className="lt-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="lt-modal-body" key={tab}>
          {tab === 'overview' && (
            <>
              {/* Description */}
              {(index.description || index.formulaDesc) && (
                <div className="lt-modal-bio">
                  {index.description || index.formulaDesc}
                </div>
              )}

              {/* Price chart */}
              <div className="lt-modal-chart-wrap">
                <div className="lt-modal-chart-head">
                  <span>Oracle Price</span>
                  <span className="lt-modal-chart-delta" style={{ color: pnlColor }}>
                    {changePct >= 0 ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}%
                  </span>
                </div>
                <div className="lt-modal-chart">
                  {priceHistory && priceHistory.length > 1 ? (
                    <Sparkline data={priceHistory} height={100} color={pnlColor} />
                  ) : (
                    <div className="lt-modal-chart-empty">Building price history…</div>
                  )}
                </div>
              </div>

              {/* Key metrics grid — same style as agent grid */}
              <div className="lt-modal-grid2">
                <div className="lt-grid2-item"><span className="lt-grid2-l">Holders</span><span className="lt-grid2-v">{index.holderCount || 0}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Band</span><span className="lt-grid2-v">±{(index.bandWidthPct || 0).toFixed(1)}%</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Band Low</span><span className="lt-grid2-v c-red">${index.bandLow?.toFixed(4) || '—'}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Band High</span><span className="lt-grid2-v c-green">${index.bandHigh?.toFixed(4) || '—'}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Max Supply</span><span className="lt-grid2-v">{fmtVol(index.maxSupply || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Oracle</span><span className="lt-grid2-v">{index.oracleIntervalMs ? `${(index.oracleIntervalMs / 1000).toFixed(0)}s` : '—'}</span></div>
              </div>
            </>
          )}

          {tab === 'formula' && (
            <>
              {/* Formula equation */}
              <div className="lt-formula-card">
                <div className="lt-formula-eq">
                  <code>{index.formulaText || 'N/A'}</code>
                </div>
                {index.formulaBehavior && (
                  <div className="lt-formula-note">
                    💡 {index.formulaBehavior}
                  </div>
                )}
              </div>

              {/* Price drivers */}
              <div className="lt-formula-drivers-title">
                От чего зависит цена
              </div>

              <div className="lt-formula-drivers">
                {(index.formulaDrivers || []).map((d, i) => (
                  <div key={i} className={`lt-formula-driver ${d.effect === 'both' ? 'lt-fd-both' : d.effect === 'up' ? 'lt-fd-up' : 'lt-fd-down'}`}>
                    <div className="lt-fd-head">
                      <span className="lt-fd-icon">{d.icon}</span>
                      <span className="lt-fd-name">{d.name}</span>
                      <span className="lt-fd-effect">
                        {d.effect === 'up' ? '↑ price up' : d.effect === 'down' ? '↓ price down' : '↕ up or down'}
                      </span>
                    </div>
                    <div className="lt-fd-desc">{d.desc}</div>
                  </div>
                ))}
              </div>

              {(index.formulaDrivers || []).length === 0 && (
                <div className="lt-modal-no-data">Formula driver details not available</div>
              )}
            </>
          )}

          {tab === 'trades' && (
            <div className="lt-modal-trades">
              {recentTrades.length === 0 ? (
                <div className="lt-modal-no-data">No trades yet — waiting for agent activity</div>
              ) : (
                recentTrades.map((t, i) => {
                  const isBuy = t.side === 'buy' || t.aggressorSide === 'buy'
                  return (
                    <div key={t.id || i} className={`lt-modal-trade ${isBuy ? 'lt-mt-buy' : 'lt-mt-sell'}`}>
                      <span className="lt-mt-side">{isBuy ? 'BUY' : 'SELL'}</span>
                      <span className="lt-mt-agent">{t.buyerIcon || '🤖'} {t.buyerName || 'Unknown'}</span>
                      <span className="lt-mt-at">→</span>
                      <span className="lt-mt-agent">{t.sellerIcon || '🏦'} {t.sellerName || 'Unknown'}</span>
                      <span className="lt-mt-qty">{t.size?.toFixed(2)}</span>
                      <span className="lt-mt-price">${t.price?.toFixed(4)}</span>
                      <span className="lt-mt-time">{timeAgo(t.timestamp)}</span>
                      {t.isMint && <span className="lt-badge-mint">MINT</span>}
                    </div>
                  )
                })
              )}
            </div>
          )}

          {tab === 'treasury' && (() => {
            const t = index.treasury || {}
            const circulatingValue = (index.oraclePrice || 0) * (index.circulatingSupply || 0)
            const treasuryPct = circulatingValue > 0 ? (t.balance / circulatingValue * 100).toFixed(2) : '0'
            const redistPct = t.totalCollected > 0 ? (t.totalRedistributed / t.totalCollected * 100).toFixed(1) : '0'
            return (
              <>
                {/* Treasury overview card */}
                <div className="lt-treasury-card">
                  <div className="lt-treasury-balance">
                    <span className="lt-treasury-icon">🏦</span>
                    <div>
                      <div className="lt-treasury-title">Protocol Treasury</div>
                      <div className="lt-treasury-amt">${fmtVol(t.balance || 0)}</div>
                      <div className="lt-treasury-sub">{treasuryPct}% of market cap</div>
                    </div>
                  </div>
                </div>

                {/* Flow diagram */}
                <div className="lt-treasury-flow">
                  <div className="lt-treasury-flow-item lt-tf-in">
                    <span className="lt-tf-icon">📥</span>
                    <span className="lt-tf-label">Collected (Mints)</span>
                    <span className="lt-tf-val">${fmtVol(t.totalCollected || 0)}</span>
                  </div>
                  <div className="lt-treasury-flow-item lt-tf-out">
                    <span className="lt-tf-icon">📤</span>
                    <span className="lt-tf-label">Redistributed</span>
                    <span className="lt-tf-val">${fmtVol(t.totalRedistributed || 0)}</span>
                  </div>
                  <div className="lt-treasury-flow-item lt-tf-burn">
                    <span className="lt-tf-icon">🔥</span>
                    <span className="lt-tf-label">Burned</span>
                    <span className="lt-tf-val">${fmtVol(t.totalBurned || 0)}</span>
                  </div>
                </div>

                {/* Stats grid */}
                <div className="lt-modal-grid2">
                  <div className="lt-grid2-item"><span className="lt-grid2-l">Current Balance</span><span className="lt-grid2-v">${fmtVol(t.balance || 0)}</span></div>
                  <div className="lt-grid2-item"><span className="lt-grid2-l">Lifetime Collected</span><span className="lt-grid2-v">${fmtVol(t.totalCollected || 0)}</span></div>
                  <div className="lt-grid2-item"><span className="lt-grid2-l">Redistributed</span><span className="lt-grid2-v c-green">${fmtVol(t.totalRedistributed || 0)}</span></div>
                  <div className="lt-grid2-item"><span className="lt-grid2-l">Redist. Rate</span><span className="lt-grid2-v">{redistPct}%</span></div>
                  <div className="lt-grid2-item"><span className="lt-grid2-l">Redistributions</span><span className="lt-grid2-v">{t.redistributionCount || 0}</span></div>
                  <div className="lt-grid2-item"><span className="lt-grid2-l">Last Redistribution</span><span className="lt-grid2-v">{t.lastRedistributionAt ? timeAgo(t.lastRedistributionAt) : 'Never'}</span></div>
                </div>

                {/* How it works */}
                <div className="lt-treasury-how">
                  <div className="lt-treasury-how-title">Как работает Treasury</div>
                  <div className="lt-treasury-how-steps">
                    <div className="lt-treasury-step">📥 Агент покупает → протокол минтит контракты → деньги идут в Treasury</div>
                    <div className="lt-treasury-step">💰 Каждые ~5 тиков оракула Treasury распределяет 2% баланса холдерам</div>
                    <div className="lt-treasury-step">📊 Распределение пропорционально доле холдера в supply</div>
                    <div className="lt-treasury-step">🔥 MM может сжигать контракты при избыточной прибыли — сокращение supply</div>
                  </div>
                </div>
              </>
            )
          })()}

          {tab === 'params' && (
            <>
              <div className="lt-modal-grid2">
                <div className="lt-grid2-item"><span className="lt-grid2-l">Initial Price</span><span className="lt-grid2-v">${index.initialPrice?.toFixed(2) || '—'}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Current Price</span><span className="lt-grid2-v" style={{ color: pnlColor }}>${index.oraclePrice?.toFixed(4) || '—'}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Band Width</span><span className="lt-grid2-v">±{(index.bandWidthPct || 0).toFixed(1)}%</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Band Low</span><span className="lt-grid2-v c-red">${index.bandLow?.toFixed(4) || '—'}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Band High</span><span className="lt-grid2-v c-green">${index.bandHigh?.toFixed(4) || '—'}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Oracle Interval</span><span className="lt-grid2-v">{index.oracleIntervalMs ? `${(index.oracleIntervalMs / 1000).toFixed(0)}s` : '—'}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Max Supply</span><span className="lt-grid2-v">{fmtVol(index.maxSupply || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Circulating</span><span className="lt-grid2-v">{fmtVol(index.circulatingSupply || 0)} ({supplyPct}%)</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Market Cap</span><span className="lt-grid2-v">${fmtVol(cap)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Total Volume</span><span className="lt-grid2-v">${fmtVol(index.totalVolume || 0)}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Total Trades</span><span className="lt-grid2-v">{index.totalTrades || 0}</span></div>
                <div className="lt-grid2-item"><span className="lt-grid2-l">Holders</span><span className="lt-grid2-v">{index.holderCount || 0}</span></div>
              </div>

              {/* Formula section */}
              {index.formulaText && (
                <div style={{ marginTop: 14 }}>
                  <div className="lt-modal-strategy-desc">
                    <span className="lt-modal-desc-icon" style={{ color: '#a78bfa' }}>📐</span>
                    <code style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#c4b5fd' }}>{index.formulaText}</code>
                  </div>
                  {index.formulaBehavior && (
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.4, marginTop: 6, fontStyle: 'italic' }}>
                      💡 {index.formulaBehavior}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// AGENT CHIP for roster
// ════════════════════════════════════════════════════════════════════════
function AgentChip({ agent, rank, onClick }) {
  const strat = getLiteAgentStrategyMeta(agent)
  const hasTrades = agent.totalTrades > 0
  const pnlOk = agent.pnl >= 0
  const agentNew = isNewAgent(agent.createdAt)
  return (
    <div
      className={`lt-chip ${hasTrades ? (pnlOk ? 'lt-chip-up' : 'lt-chip-down') : 'lt-chip-idle'}`}
      style={{ animationDelay: `${rank * 0.06}s` }}
      onClick={() => onClick(agent.id)}
    >
      <span className="lt-chip-icon">{agent.icon}</span>
      <div className="lt-chip-body">
        <div className="lt-chip-name">
          {rank < 3 && <span className="lt-rank">{['🥇','🥈','🥉'][rank]}</span>}
          {agent.name}
          {agentNew && <span className="lt-badge-new-sm">NEW</span>}
          {agent.isUserAgent && <span className="lt-badge-user-xs">USER</span>}
        </div>
        <div className="lt-chip-row">
          <span className="lt-pill lt-pill-xs" style={{ background: `${strat.color}22`, color: strat.color, borderColor: `${strat.color}44` }}>
            {strat.short}
          </span>
          {hasTrades ? (
            <>
              <span className={`lt-chip-pnl ${pnlOk ? 'c-green' : 'c-red'}`}>{fmtPct(agent.pnlPercent || 0)}</span>
              {(agent.royaltyIncome || 0) > 0 ? <span className="lt-pill lt-pill-xs" style={{ background: 'rgba(245,197,66,0.12)', color: '#f5c542', borderColor: 'rgba(245,197,66,0.28)' }}>👑 {fmtActivityFee$(agent.royaltyIncome || 0)}</span> : null}
              <span className="lt-chip-cnt">{agent.totalTrades}</span>
            </>
          ) : (
            <span className="lt-chip-wait">scanning…</span>
          )}
        </div>
      </div>
      <div className="lt-chip-eq">{fmt$(agent.equity || agent.virtualBalance)}</div>
      {agent.status === 'active' && <span className="lt-chip-dot" />}
    </div>
  )
}

// ── Stats ticker ────────────────────────────────────────────────────
function StatsTicker({ metrics }) {
  if (!metrics) return null
  const items = [
    { label: 'FLEET P&L', value: fmt$(metrics.totalPnl || 0), cls: metrics.totalPnl >= 0 ? 'c-green' : 'c-red' },
    { label: 'EQUITY', value: fmt$(metrics.totalEquity || 0) },
    { label: 'TRADES', value: metrics.totalTrades || 0, pulse: true },
    { label: 'VOLUME', value: `$${fmtVol(metrics.totalVolume || 0)}` },
    { label: 'WIN RATE', value: `${((metrics.winRate || 0) * 100).toFixed(0)}%`, cls: metrics.winRate >= 0.5 ? 'c-green' : '' },
    { label: 'ACTIVE', value: `${metrics.activeAgents}/${metrics.totalAgents}` },
  ]
  return (
    <div className="lt-stats">
      {items.map((it, i) => (
        <div key={i} className="lt-stat">
          <span className="lt-stat-l">{it.label}</span>
          <span className={`lt-stat-v ${it.cls || ''} ${it.pulse ? 'lt-pulse' : ''}`}>{it.value}</span>
        </div>
      ))}
    </div>
  )
}

// ── Particles ───────────────────────────────────────────────────────
function Particles() {
  const dots = useMemo(() =>
    Array.from({ length: 25 }, (_, i) => ({
      id: i, x: Math.random()*100, y: Math.random()*100,
      sz: 1.5 + Math.random()*3, dur: 15+Math.random()*25, delay: Math.random()*12,
      hue: Math.random() > 0.5 ? '248' : '155',
    })), []
  )
  return (
    <div className="lt-particles">
      {dots.map(d => (
        <div key={d.id} className="lt-particle" style={{
          left:`${d.x}%`, top:`${d.y}%`, width:d.sz, height:d.sz,
          animationDuration:`${d.dur}s`, animationDelay:`${d.delay}s`,
          background:`radial-gradient(circle, hsla(${d.hue},80%,70%,0.4) 0%, transparent 70%)`,
        }} />
      ))}
    </div>
  )
}

// ── Wallet Button ───────────────────────────────────────────────────
function WalletButton({ onCreateAgent, hasAgent, onConnect }) {
  const [tonConnectUI] = useTonConnectUI()
  const wallet = useTonWallet()
  const { session, logout, user } = useAuthSession()
  const sessionAddress = normalizeWalletAddr(getSessionWalletAddress(session))
  const address = normalizeWalletAddr(wallet?.account?.address || sessionAddress || '')
  const isTonWallet = Boolean(wallet?.account?.address)
  const isManagedSession = Boolean(sessionAddress)
  const privyWalletEntries = hasPrivyWalletSession(session)
    ? getPrivyLinkedWalletEntries(user, address, session)
    : []

  if (!address) {
    return (
      <button className="lt-wallet-btn" onClick={onConnect}>
        <span className="lt-wallet-icon">💎</span>
        Connect Wallet
      </button>
    )
  }

  return (
    <div className="lt-wallet-group">
      {!hasAgent && (
        <button className="lt-wallet-btn lt-wallet-btn-create" onClick={onCreateAgent}>
          🤖 Create Agent
        </button>
      )}
      <ConnectedWalletMenu
        address={address}
        label={isManagedSession ? 'WDK wallet' : 'Wallet'}
        badgeText={isManagedSession ? 'WDK' : 'TON'}
        linkedWalletEntries={privyWalletEntries}
        icon={isManagedSession ? '✨' : '💎'}
        variant="lite"
        onTopUp={() => {
          if (typeof window !== 'undefined') window.location.assign('/lite/wallet')
        }}
        onLogout={async () => {
          await logout()
          if (isTonWallet) await tonConnectUI.disconnect().catch(() => {})
        }}
      />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// AGENT INDEX LIST — Exchange-style left panel with ranked indexes
// ════════════════════════════════════════════════════════════════════════
const MARKET_TABS = [
  { id: 'trend', label: 'Trend', icon: TrendingUp, sort: (a, b) => Math.abs(b.changePct||0) - Math.abs(a.changePct||0) },
  { id: 'new',   label: 'New', icon: Sparkles, sort: (a, b) => (b.createdAt||0) - (a.createdAt||0) },
  { id: 'volume',label: 'Volume', icon: BarChart2, sort: (a, b) => (b.totalVolume||0) - (a.totalVolume||0) },
]

function AgentIndexList({ indexes, onSelect, onPin, pinnedIds, activeId, myAgent, agentSubs, walletConnected, onConnect }) {
  const [tab, setTab] = useState('trend')
  const [search, setSearch] = useState('')

  const isMy = tab === 'my'

  // Subscribed index IDs from agent subs
  const subscribedIds = useMemo(() => new Set((agentSubs || []).map(s => s.indexId)), [agentSubs])

  const currentSort = MARKET_TABS.find(t => t.id === tab)?.sort || MARKET_TABS[0].sort
  const filtered = useMemo(() => {
    let list = [...(indexes || [])]
    // 'my' tab: filter only subscribed
    if (isMy) {
      list = list.filter(ix => subscribedIds.has(ix.id))
    }
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(ix => (ix.symbol||'').toLowerCase().includes(q) || (ix.name||'').toLowerCase().includes(q))
    }
    if (!isMy) list.sort(currentSort)
    return list
  }, [indexes, tab, search, currentSort, isMy, subscribedIds])

  const StarIcon = (props) => (
    <svg width={props.size || 18} height={props.size || 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
  const allTabs = [...MARKET_TABS, { id: 'my', label: 'My', icon: StarIcon }]

  return (
    <div className="lt-exchange-panel">
      {/* Panel header */}
      <div className="lt-ex-header">
        <span className="lt-ex-title">📋 Markets</span>
        <span className="lt-ex-count">{isMy ? filtered.length : (indexes?.length || 0)}</span>
      </div>

      {/* Search */}
      <div className="lt-ex-search-wrap">
        <input
          className="lt-ex-search"
          placeholder="Search index…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && <button className="lt-ex-search-clear" onClick={() => setSearch('')}>✕</button>}
      </div>

      {/* Tabs: Trend / New / Volume / My */}
      <div className="lt-ex-tabs">
        {allTabs.map(t => (
          <button
            key={t.id}
            className={`lt-ex-tab${tab === t.id ? ' lt-ex-tab-active' : ''}${t.id === 'my' ? ' lt-ex-tab-my' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="lt-ex-tab-inner">
              {t.icon ? <t.icon size={18} /> : null}
              <span className="lt-ex-tab-label">{t.label}</span>
            </span>
          </button>
        ))}
      </div>

      {/* ── "My" tab: auth gate or subscribed indexes ── */}
      {isMy ? (
        !walletConnected ? (
          /* Not logged in */
          <div className="lt-ex-auth-gate">
            <div className="lt-ex-auth-icon">🔒</div>
            <div className="lt-ex-auth-title">Wallet not connected</div>
            <div className="lt-ex-auth-desc">Connect your TON wallet to see indexes your agent is subscribed to</div>
            <button className="lt-ex-auth-btn" onClick={onConnect}>💎 Connect Wallet</button>
          </div>
        ) : !myAgent ? (
          /* Logged in but no agent */
          <div className="lt-ex-auth-gate">
            <div className="lt-ex-auth-icon">🤖</div>
            <div className="lt-ex-auth-title">No agent yet</div>
            <div className="lt-ex-auth-desc">Create an agent first, then subscribe it to indexes to see them here</div>
          </div>
        ) : filtered.length === 0 ? (
          /* Agent exists but no subscriptions */
          <div className="lt-ex-auth-gate">
            <div className="lt-ex-auth-icon">📭</div>
            <div className="lt-ex-auth-title">No subscriptions</div>
            <div className="lt-ex-auth-desc">Your agent isn't subscribed to any indexes yet. Use ⚡ Subscribe on an index to add it here.</div>
          </div>
        ) : (
          /* Subscribed indexes list */
          <>
            <div className="lt-ex-colheaders">
              <span className="lt-ex-col-name">Index</span>
              <span className="lt-ex-col-price">Price</span>
              <span className="lt-ex-col-change">Change</span>
              <span className="lt-ex-col-action"></span>
            </div>
            <div className="lt-ex-list">
              {filtered.map(ix => {
                const changePct = ix.changePct || 0
                const isUp = changePct >= 0
                const isPinned = pinnedIds?.includes(ix.id)
                const isActive = ix.id === activeId
                return (
                  <div
                    key={ix.id}
                    className={`lt-ex-row${isActive ? ' lt-ex-row-active' : ''}${isPinned ? ' lt-ex-row-pinned' : ''}`}
                    onClick={() => onSelect(ix.id)}
                  >
                    <div className="lt-ex-row-name">
                      <span className="lt-ex-row-icon">{ix.icon || '📊'}</span>
                      <div className="lt-ex-row-labels">
                        <span className="lt-ex-sym">{ix.symbol || ix.name}</span>
                        {ix.creatorName && <span className="lt-ex-creator">by {ix.creatorName}</span>}
                      </div>
                    </div>
                    <span className="lt-ex-row-price">${(ix.oraclePrice || 0).toFixed(4)}</span>
                    <span className={`lt-ex-row-change ${isUp ? 'c-green' : 'c-red'}`}>
                      {isUp ? '+' : ''}{changePct.toFixed(2)}%
                    </span>
                    <button
                      className={`lt-ex-pin${isPinned ? ' lt-ex-pin-on' : ''}`}
                      onClick={e => { e.stopPropagation(); onPin(ix.id) }}
                      title={isPinned ? 'Unpin' : 'Pin to dashboard'}
                    >
                      {isPinned ? '★' : '☆'}
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )
      ) : (
        /* ── Regular tabs: Trend / New / Volume ── */
        <>
          {/* Column headers */}
          <div className="lt-ex-colheaders">
            <span className="lt-ex-col-name">Index</span>
            <span className="lt-ex-col-price">Price</span>
            <span className="lt-ex-col-change">Change</span>
            <span className="lt-ex-col-action"></span>
          </div>

          {/* Index rows */}
          <div className="lt-ex-list">
            {filtered.length === 0 ? (
              <div className="lt-ex-empty">No indexes found</div>
            ) : (
              filtered.map(ix => {
                const changePct = ix.changePct || 0
                const isUp = changePct >= 0
                const isPinned = pinnedIds?.includes(ix.id)
                const isActive = ix.id === activeId
                return (
                  <div
                    key={ix.id}
                    className={`lt-ex-row${isActive ? ' lt-ex-row-active' : ''}${isPinned ? ' lt-ex-row-pinned' : ''}`}
                    onClick={() => onSelect(ix.id)}
                  >
                    <div className="lt-ex-row-name">
                      <span className="lt-ex-row-icon">{ix.icon || '📊'}</span>
                      <div className="lt-ex-row-labels">
                        <span className="lt-ex-sym">{ix.symbol || ix.name}</span>
                        {ix.creatorName && <span className="lt-ex-creator">by {ix.creatorName}</span>}
                      </div>
                    </div>
                    <span className="lt-ex-row-price">${(ix.oraclePrice || 0).toFixed(4)}</span>
                    <span className={`lt-ex-row-change ${isUp ? 'c-green' : 'c-red'}`}>
                      {isUp ? '+' : ''}{changePct.toFixed(2)}%
                    </span>
                    <button
                      className={`lt-ex-pin${isPinned ? ' lt-ex-pin-on' : ''}`}
                      onClick={e => { e.stopPropagation(); onPin(ix.id) }}
                      title={isPinned ? 'Unpin' : 'Pin to dashboard'}
                    >
                      {isPinned ? '★' : '☆'}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </>

      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// USER INDEX BADGES — Up to 5 user-created indexes as compact badges
// ════════════════════════════════════════════════════════════════════════
function UserIndexBadges({ indexes, activeId, onSelect, maxCount = 5 }) {
  const userIndexes = useMemo(() => {
    return (indexes || []).filter(ix => ix.creatorAgentId).slice(0, maxCount)
  }, [indexes, maxCount])

  if (userIndexes.length === 0) return null

  return (
    <div className="lt-user-badges">
      <div className="lt-ub-label">User Indexes</div>
      <div className="lt-ub-row">
        {userIndexes.map(ix => {
          const changePct = ix.changePct || 0
          const isUp = changePct >= 0
          return (
            <button
              key={ix.id}
              className={`lt-ub-badge${ix.id === activeId ? ' lt-ub-badge-active' : ''}`}
              onClick={() => onSelect(ix.id)}
            >
              <span className="lt-ub-icon">{ix.icon || '📊'}</span>
              <span className="lt-ub-sym">{ix.symbol}</span>
              <span className={`lt-ub-change ${isUp ? 'c-green' : 'c-red'}`}>
                {isUp ? '▲' : '▼'}{Math.abs(changePct).toFixed(1)}%
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// PINNED AGENT SLOTS — 2 slots for user-selected agent indexes
// ════════════════════════════════════════════════════════════════════════
function PinnedAgentSlots({ pinnedIds, indexes, onSelect, onUnpin, activeId }) {
  const slots = useMemo(() => {
    const items = pinnedIds.map(id => indexes.find(ix => ix.id === id)).filter(Boolean)
    // Always show 2 slots
    while (items.length < 2) items.push(null)
    return items.slice(0, 2)
  }, [pinnedIds, indexes])

  return (
    <div className="lt-pinned-slots">
      <div className="lt-ps-label">⭐ Pinned Indexes</div>
      <div className="lt-ps-grid">
        {slots.map((ix, i) => {
          if (!ix) {
            return (
              <div key={`empty-${i}`} className="lt-ps-slot lt-ps-empty">
                <div className="lt-ps-empty-icon">＋</div>
                <div className="lt-ps-empty-text">Pin from list</div>
              </div>
            )
          }
          const changePct = ix.changePct || 0
          const isUp = changePct >= 0
          const isActive = ix.id === activeId
          return (
            <div
              key={ix.id}
              className={`lt-ps-slot lt-ps-filled${isActive ? ' lt-ps-active' : ''}`}
              onClick={() => onSelect(ix.id)}
            >
              <div className="lt-ps-top">
                <span className="lt-ps-icon">{ix.icon || '📊'}</span>
                <span className="lt-ps-sym">{ix.symbol}</span>
                <button className="lt-ps-unpin" onClick={e => { e.stopPropagation(); onUnpin(ix.id) }} title="Unpin">✕</button>
              </div>
              <div className="lt-ps-price">${(ix.oraclePrice || 0).toFixed(4)}</div>
              <div className={`lt-ps-change ${isUp ? 'c-green' : 'c-red'}`}>
                {isUp ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}%
              </div>
              <div className="lt-ps-stats">
                <span>Vol ${fmtVol(ix.totalVolume || 0)}</span>
                <span>{ix.holderCount || 0} holders</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// INDEX LEADERBOARD — Per-index top-30 holders + per-index strategy metrics
// ════════════════════════════════════════════════════════════════════════
function IndexLeaderboard({ indexId, indexSymbol, agents, onBack, onAgentClick }) {
  const [holders, setHolders] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!indexId) return
    setLoading(true)
    fetchIndexHolders(indexId)
      .then(h => setHolders(h || []))
      .catch(() => setHolders([]))
      .finally(() => setLoading(false))
  }, [indexId])

  // Enrich holders with agent info
  const enriched = useMemo(() => {
    return holders.slice(0, 30).map(h => {
      const agent = agents.find(a => a.id === h.agentId)
      return { ...h, agent }
    })
  }, [holders, agents])

  // Per-index strategy breakdown (only agents that hold this index)
  const stratBreakdown = useMemo(() => {
    const holderIds = new Set(holders.map(h => h.agentId))
    return Object.entries(STRAT).map(([key, meta]) => {
      const group = holders
        .filter(h => {
          const a = agents.find(ag => ag.id === h.agentId)
          return a?.strategy === key
        })
        .map(h => ({
          ...h,
          agent: agents.find(a => a.id === h.agentId),
        }))
      const count = group.length
      const totalValue = group.reduce((s, h) => s + (h.holdingValueUsd || 0), 0)
      const totalPnl = group.reduce((s, h) => s + (h.realizedPnl || 0) + (h.unrealizedPnl || 0), 0)
      const avgPnl = count > 0 ? totalPnl / count : 0
      return { key, ...meta, count, totalValue, totalPnl, avgPnl }
    }).filter(s => s.count > 0)
      .sort((a, b) => b.totalPnl - a.totalPnl)
  }, [holders, agents])

  return (
    <div className="lt-lb">
      {/* Header */}
      <div className="lt-lb-header">
        <div className="lt-lb-title">
          <span className="lt-lb-trophy">🏆</span>
          <span>{indexSymbol || 'Index'} Leaderboard</span>
        </div>
        <span className="lt-lb-count">Top {enriched.length}</span>
      </div>

      {/* Per-index Strategy Breakdown */}
      {stratBreakdown.length > 0 && (
        <div className="lt-lb-strats">
          <div className="lt-lb-strats-title">📡 Strategy Performance · {indexSymbol}</div>
          <div className="lt-lb-strats-grid">
            {stratBreakdown.map(s => (
              <div key={s.key} className="lt-lb-strat-card">
                <div className="lt-lb-strat-top">
                  <span className="lt-lb-strat-icon" style={{ color: s.color }}>{s.icon}</span>
                  <span className="lt-lb-strat-name" style={{ color: s.color }}>{s.short}</span>
                  <span className="lt-lb-strat-count">{s.count}</span>
                </div>
                <div className="lt-lb-strat-row">
                  <span className="lt-lb-strat-label">Avg P&L</span>
                  <span className={`lt-lb-strat-val ${s.avgPnl >= 0 ? 'c-green' : 'c-red'}`}>
                    {s.avgPnl >= 0 ? '+' : ''}{fmt$(s.avgPnl)}
                  </span>
                </div>
                <div className="lt-lb-strat-row">
                  <span className="lt-lb-strat-label">Total Value</span>
                  <span className="lt-lb-strat-val">{fmt$(s.totalValue)}</span>
                </div>
                <div className="lt-lb-strat-row">
                  <span className="lt-lb-strat-label">Total P&L</span>
                  <span className={`lt-lb-strat-val ${s.totalPnl >= 0 ? 'c-green' : 'c-red'}`}>
                    {s.totalPnl >= 0 ? '+' : ''}{fmt$(s.totalPnl)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Leaderboard table */}
      <div className="lt-lb-table-head">
        <span className="lt-lb-col-rank">#</span>
        <span className="lt-lb-col-agent">Agent</span>
        <span className="lt-lb-col-hold">Holdings</span>
        <span className="lt-lb-col-val">Value</span>
        <span className="lt-lb-col-pnl">P&L</span>
      </div>

      <div className="lt-lb-list">
        {loading ? (
          <div className="lt-lb-loading"><div className="lt-spin" /> Loading holders…</div>
        ) : enriched.length === 0 ? (
          <div className="lt-lb-empty">No holders yet for this index</div>
        ) : (
          enriched.map((h, i) => {
            const strat = h.agent ? getLiteAgentStrategyMeta(h.agent) : null
            const totalPnl = (h.realizedPnl || 0) + (h.unrealizedPnl || 0)
            const isUp = totalPnl >= 0
            return (
              <div
                key={h.agentId}
                className={`lt-lb-row${i < 3 ? ' lt-lb-row-top' : ''}`}
                onClick={() => h.agent && onAgentClick(h.agentId)}
                style={h.agent ? { cursor: 'pointer' } : undefined}
              >
                <span className="lt-lb-rank">
                  {i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}
                </span>
                <div className="lt-lb-agent">
                  <span className="lt-lb-agent-icon">{h.agent?.icon || '🤖'}</span>
                  <div className="lt-lb-agent-info">
                    <span className="lt-lb-agent-name">{h.agent?.name || h.agentId.slice(0,8)}</span>
                    {strat && (
                      <span className="lt-lb-agent-strat" style={{ color: strat.color, borderColor: `${strat.color}44`, background: `${strat.color}15` }}>
                        {strat.short}
                      </span>
                    )}
                  </div>
                </div>
                <div className="lt-lb-hold">
                  <span className="lt-lb-hold-qty">{fmtSize(h.balance)}</span>
                  <span className="lt-lb-hold-pct">{h.pctOfSupply.toFixed(1)}%</span>
                </div>
                <span className="lt-lb-val">{fmt$(h.holdingValueUsd)}</span>
                <span className={`lt-lb-pnl ${isUp ? 'c-green' : 'c-red'}`}>
                  {isUp ? '+' : ''}{fmt$(totalPnl)}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ════════════════════════════════════════════════════════════════════════
export default function LitePage() {
  const { session } = useAuthSession()
  const [metrics, setMetrics] = useState(null)
  const [agents, setAgents] = useState([])
  const [trades, setTrades] = useState([])
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [myAgentId, setMyAgentId] = useState(null)
  const [showMyAgent, setShowMyAgent] = useState(false)

  const [liteUi, dispatchLiteUi] = useReducer(liteUiReducer, undefined, createInitialLiteUiState)
  const setLiteUi = useCallback((key, value) => {
    dispatchLiteUi({ type: 'SET', key, value })
  }, [])
  const {
    activeTab,
    indexList,
    indexSnap,
    indexOB,
    indexTrades,
    indexPriceHist,
    indexOracleHist,
    agentSubs,
    subPending,
    showIndexDetail,
    showCreateIndex,
    showMyIndexes,
    centerView,
    pinnedIndexIds,
  } = liteUi

  // ── Index state ──
  const indexPriceCacheRef = useRef(new Map())               // per-index price history cache
  const indexOracleCacheRef = useRef(new Map())              // per-index oracle snapshots cache
  const indexPollCountRef = useRef(0)                        // poll counter for full vs light

  const handlePinIndex = useCallback((indexId) => {
    const prev = pinnedIndexIds || []
    const next = prev.includes(indexId)
      ? prev.filter(id => id !== indexId)
      : [...prev, indexId].slice(-2)
    localStorage.setItem('odrob_pinned_indexes', JSON.stringify(next))
    setLiteUi('pinnedIndexIds', next)
  }, [pinnedIndexIds, setLiteUi])

  const handleUnpinIndex = useCallback((indexId) => {
    const next = (pinnedIndexIds || []).filter(id => id !== indexId)
    localStorage.setItem('odrob_pinned_indexes', JSON.stringify(next))
    setLiteUi('pinnedIndexIds', next)
  }, [pinnedIndexIds, setLiteUi])

  const [tonConnectUI] = useTonConnectUI()
  const wallet = useTonWallet()
  const tonRawAddress = useTonAddress(false)
  const sessionWalletAddress = normalizeWalletAddr(getSessionWalletAddress(session))
  const walletAddress = normalizeWalletAddr(tonRawAddress || wallet?.account?.address || sessionWalletAddress || '')
  const connectChooser = useConnectWalletChooser({ mode: 'lite' })

  // ── Sync wallet address to API client + discover existing agent ──
  useEffect(() => {
    setWalletAddress(walletAddress || null)
    setIndexWalletAddress(walletAddress || null)

    if (!walletAddress) {
      // Wallet disconnected — clear agent state
      setMyAgentId(null)
      setShowMyAgent(false)
      setShowCreateModal(false)
      return
    }

    // Check localStorage first (keyed by wallet)
    const cachedId = localStorage.getItem(`odrob_agent_${walletAddress}`)

    // Always verify with server (agent might have been deleted)
    loginWallet(walletAddress)
      .then(() => fetchAgentByWallet(walletAddress))
      .then(({ agent }) => {
        if (agent) {
          setMyAgentId(agent.id)
          localStorage.setItem(`odrob_agent_${walletAddress}`, agent.id)
        } else {
          // No agent on server — clear stale cache
          setMyAgentId(null)
          localStorage.removeItem(`odrob_agent_${walletAddress}`)
        }
      })
      .catch(() => {
        // Server unreachable — try to find agent in cached agents list by wallet
        if (cachedId) {
          setMyAgentId(cachedId)
        }
      })
  }, [walletAddress])

  // ── Fetch index list on mount, default to first index ──
  useEffect(() => {
    fetchIndexes().then(list => {
      setLiteUi('indexList', list || [])
      if (list?.length > 0) {
        setLiteUi('activeTab', prev => prev || list[0].id)
      }
    }).catch(() => {})
  }, [setLiteUi])

  // ── Load agent's index subscriptions when myAgentId changes ──
  useEffect(() => {
    if (!myAgentId) { setLiteUi('agentSubs', []); return }
    fetchAgentIndexes(myAgentId)
      .then(r => setLiteUi('agentSubs', normalizeAgentSubscriptions(r)))
      .catch(() => {})
  }, [myAgentId])

  // ── Restore cached price history when switching tabs (don't destroy data) ──
  useEffect(() => {
    const cached = indexPriceCacheRef.current.get(activeTab)
    const cachedOracle = indexOracleCacheRef.current.get(activeTab)
    setLiteUi('indexPriceHist', cached || [])
    setLiteUi('indexOracleHist', cachedOracle || [])
    indexPollCountRef.current = 0  // reset so first poll is always full
  }, [activeTab])

  // Always search agent by normalized wallet address
  const myAgent = useMemo(() => {
    if (!walletAddress) return null
    const normalized = normalizeWalletAddr(walletAddress)
    const agent = agents.find(a => a.isUserAgent && normalizeWalletAddr(a.walletAddress) === normalized)
    if (agent && agent.id !== myAgentId) {
      setMyAgentId(agent.id)
    }
    return agent || null
  }, [agents, walletAddress])

  const poll = useCallback(async () => {
    try {
      const [m, a, t] = await Promise.all([
        fetchMetrics(), fetchEngineAgents(),
        fetchRecentTrades(50),
      ])
      setMetrics(m)
      setAgents(a || [])
      setTrades((t || []).sort((a, b) => b.timestamp - a.timestamp))

      if (selectedAgent) {
        const updated = (a || []).find(x => x.id === selectedAgent.id)
        if (updated) setSelectedAgent(updated)
      }

      // ── Index data polling (smart: full every 5th, lightweight otherwise) ──
      if (activeTab) {
        try {
          indexPollCountRef.current++
          const isFullPoll = !indexSnap || indexPollCountRef.current % 5 === 1

          if (isFullPoll) {
            // Step 1: Load priceHistory and oracleHistory for chart
            const [snap, ioracle] = await Promise.all([
              fetchIndex(activeTab),
              fetchIndexOracle(activeTab, ORACLE_HISTORY_LIMIT).catch(() => []),
            ])
            setLiteUi('indexSnap', snap)
            if (Array.isArray(ioracle) && ioracle.length > 1) {
              indexOracleCacheRef.current.set(activeTab, ioracle)
              setLiteUi('indexOracleHist', ioracle)
            }
            if (snap?.oraclePrice) {
              setLiteUi('indexPriceHist', prev => {
                if (prev.length === 0 && snap.priceHistory?.length > 0) {
                  const seeded = snap.priceHistory.slice(-CHART_PTS)
                  indexPriceCacheRef.current.set(activeTab, seeded)
                  return seeded
                }
                const lastPrice = prev[prev.length - 1]
                if (snap.oraclePrice === lastPrice) return prev
                const next = [...prev, snap.oraclePrice]
                const trimmed = next.length > CHART_PTS ? next.slice(-CHART_PTS) : next
                indexPriceCacheRef.current.set(activeTab, trimmed)
                return trimmed
              })
            }
            // Step 2: Load orderbook and trades asynchronously
            fetchIndexOrderBook(activeTab, 12).then(iob => setLiteUi('indexOB', iob))
            fetchIndexTrades(activeTab, FEED_LIMIT).then(itrades => setLiteUi('indexTrades', (itrades || []).sort((a, b) => b.timestamp - a.timestamp)))
          } else {
            // Lightweight poll: price-only (~200 bytes)
            const price = await fetchIndexPrice(activeTab)
            if (price?.oraclePrice) {
              setLiteUi('indexSnap', prev => prev ? {
                ...prev,
                oraclePrice: price.oraclePrice,
                prevOraclePrice: price.prevOraclePrice,
                changePct: price.changePct,
                tickChangePct: price.tickChangePct,
                bandLow: price.bandLow,
                bandHigh: price.bandHigh,
                totalVolume: price.totalVolume,
                totalTrades: price.totalTrades,
              } : prev)
              setLiteUi('indexPriceHist', prev => {
                const lastPrice = prev[prev.length - 1]
                if (price.oraclePrice === lastPrice) return prev
                const next = [...prev, price.oraclePrice]
                const trimmed = next.length > CHART_PTS ? next.slice(-CHART_PTS) : next
                indexPriceCacheRef.current.set(activeTab, trimmed)
                return trimmed
              })
            }
          }
        } catch (e) { console.warn('[Lite] index poll:', e.message) }
      }
    } catch (err) { console.warn('[Lite] poll:', err.message) }
  }, [selectedAgent?.id, activeTab])

  useEffect(() => { poll(); const iv = setInterval(poll, POLL_MS); return () => clearInterval(iv) }, [poll])

  const handleAgentClick = useCallback((id) => {
    if (id === myAgentId) { setShowMyAgent(true); return }
    const a = agents.find(x => x.id === id)
    if (a) setSelectedAgent(a)
  }, [agents, myAgentId])

  const handleAgentCreated = useCallback((newAgent) => {
    setMyAgentId(newAgent.id)
    localStorage.setItem(`odrob_agent_${walletAddress}`, newAgent.id)
    setShowCreateModal(false)
    setShowMyAgent(true)
    poll()
  }, [])

  const handlePause = useCallback(async () => {
    if (!myAgentId) return
    try { await pauseEngineAgent(myAgentId); poll() } catch (e) { console.warn('Pause failed', e) }
  }, [myAgentId])

  const handleResume = useCallback(async () => {
    if (!myAgentId) return
    try { await startEngineAgent(myAgentId); poll() } catch (e) { console.warn('Resume failed', e) }
  }, [myAgentId])

  const handleDelete = useCallback(async () => {
    if (!myAgentId) return
    if (!confirm('Remove your agent from the fleet?')) return
    try {
      await deleteEngineAgent(myAgentId)
      setMyAgentId(null)
      if (walletAddress) localStorage.removeItem(`odrob_agent_${walletAddress}`)
      setShowMyAgent(false)
      poll()
    } catch (e) { console.warn('Delete failed', e) }
  }, [myAgentId, walletAddress])

  const sorted = useMemo(() => [...agents].sort((a, b) => (b.pnlPercent || 0) - (a.pnlPercent || 0)), [agents])
  const indexPriceDir = (() => {
    if (indexPriceHist.length < 2) return 'same'
    const prev = indexPriceHist[indexPriceHist.length - 2]
    const cur = indexPriceHist[indexPriceHist.length - 1]
    return cur > prev ? 'up' : cur < prev ? 'down' : 'same'
  })()

  // Active index metadata (for header display)
  const activeIndex = indexList.find(ix => ix.id === activeTab)

  // Tab labels
  const tabs = useMemo(() => {
    return indexList.map(ix => ({ id: ix.id, label: ix.symbol || ix.name, icon: ix.icon || '📊' }))
  }, [indexList])

  // ── Index subscription handlers ──
  const handleSubscribe = useCallback(async (indexId, pct = 5) => {
    if (!myAgentId || subPending || (myAgent?.subscriptionOwner && myAgent.subscriptionOwner !== 'manual')) return
    setLiteUi('subPending', true)
    try {
      await subscribeToIndex(indexId, myAgentId, pct)
      const r = await fetchAgentIndexes(myAgentId)
      setLiteUi('agentSubs', normalizeAgentSubscriptions(r))
    } catch (e) { console.warn('Subscribe failed', e) }
    setLiteUi('subPending', false)
  }, [myAgentId, myAgent?.subscriptionOwner, subPending, setLiteUi])

  const handleUnsubscribe = useCallback(async (indexId) => {
    if (!myAgentId || subPending || (myAgent?.subscriptionOwner && myAgent.subscriptionOwner !== 'manual')) return
    setLiteUi('subPending', true)
    try {
      await unsubscribeFromIndex(indexId, myAgentId)
      const r = await fetchAgentIndexes(myAgentId)
      setLiteUi('agentSubs', normalizeAgentSubscriptions(r))
    } catch (e) { console.warn('Unsubscribe failed', e) }
    setLiteUi('subPending', false)
  }, [myAgentId, myAgent?.subscriptionOwner, subPending, setLiteUi])

  return (
    <div className="lite-root">
      <Particles />

      {/* ═══ HEADER ═══ */}
      <header className="lt-header">
        <div className="lt-logo">
          <span className="lt-logo-icon">⚡</span>
          <span className="lt-logo-text">ODROB</span>
          <span className="lt-logo-badge">LITE</span>
        </div>
        <div className="lt-price-block">
          <div className="lt-price-top">
            <span className="lt-live-dot" /> {activeIndex?.symbol || activeTab || '...'}
          </div>
          <div className={`lt-price lt-price-${indexPriceDir}`}>
            ${indexSnap?.oraclePrice?.toFixed(4) || '—'}
          </div>
        </div>
        <div className="lt-header-end">
          {myAgent && (
            <>
              <Link className="lt-header-idx-btn" to="/lite/strategies" title="Strategy Marketplace">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.9 7.2 18l.9-5.4L4.2 8.7l5.4-.8L12 3z"/></svg>
              </Link>
              <Link className="lt-header-idx-btn" to="/lite/strategies/publish" title="Publish Strategy">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 4.6L18.5 9 15 12.2l.9 4.8L12 14.8 8.1 17l.9-4.8L5.5 9l4.6-1.4L12 3z"/><path d="M19 19l2 2"/><path d="M17 21l4-4"/></svg>
              </Link>
              <Link className="lt-header-idx-btn" to="/lite/wallet" title="Top up managed wallet">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M3 9h18"/><path d="M16 14h.01"/></svg>
              </Link>
              <button className="lt-header-idx-btn" onClick={() => setLiteUi('showCreateIndex', true)} title="Create Index">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
              </button>
              <button className="lt-header-idx-btn" onClick={() => setLiteUi('showMyIndexes', true)} title="My Indexes">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>
              </button>
              <button className="lt-myagent-quick" onClick={() => setShowMyAgent(true)}>
                <span>{myAgent.icon}</span>
                <span className={`lt-myagent-quick-pnl ${(myAgent.pnl||0) >= 0 ? 'c-green' : 'c-red'}`}>
                  {fmtPct(myAgent.pnlPercent || 0)}
                </span>
              </button>
            </>
          )}
          <WalletButton onCreateAgent={() => setShowCreateModal(true)} hasAgent={!!myAgent} onConnect={connectChooser.openChooser} />
        </div>
      </header>

      <StatsTicker metrics={metrics} />

      {/* ═══ MAIN — 3 Column Exchange Layout ═══ */}
      <main className="lt-main lt-main-3col">
        {/* ── LEFT: Exchange-style index list ── */}
        <aside className="lt-col-market">
          <AgentIndexList
            indexes={indexList}
            onSelect={(id) => setLiteUi('activeTab', id)}
            onPin={handlePinIndex}
            pinnedIds={pinnedIndexIds}
            activeId={activeTab}
            myAgent={myAgent}
            agentSubs={agentSubs}
            walletConnected={!!walletAddress}
            onConnect={connectChooser.openChooser}
          />
        </aside>

        {/* ── CENTER: Dashboard OR Leaderboard ── */}
        <section className="lt-col-center">
          {/* Pinned Agent Index Slots (always visible) */}
          <PinnedAgentSlots
            pinnedIds={pinnedIndexIds}
            indexes={indexList}
            onSelect={(id) => setLiteUi('activeTab', id)}
            onUnpin={handleUnpinIndex}
            activeId={activeTab}
          />

          {/* ── View toggle bar ── */}
          <div className="lt-view-toggle">
            <button
              className={`lt-vt-btn${centerView === 'dashboard' ? ' lt-vt-btn-active' : ''}`}
              onClick={() => setLiteUi('centerView', 'dashboard')}
            >
              📈 Market
            </button>
            <button
              className={`lt-vt-btn${centerView === 'leaderboard' ? ' lt-vt-btn-active' : ''}`}
              onClick={() => setLiteUi('centerView', 'leaderboard')}
            >
              🏆 Leaderboard
            </button>
            {activeIndex && (
              <div className="lt-vt-index">
                <span className="lt-vt-index-icon">{activeIndex.icon || '📊'}</span>
                <span className="lt-vt-index-sym">{activeIndex.symbol}</span>
                <span className={`lt-vt-index-pct ${(indexSnap?.changePct || 0) >= 0 ? 'c-green' : 'c-red'}`}>
                  {(indexSnap?.changePct || 0) >= 0 ? '+' : ''}{(indexSnap?.changePct || 0).toFixed(2)}%
                </span>
              </div>
            )}
          </div>

          {centerView === 'leaderboard' ? (
            /* ═══ LEADERBOARD VIEW ═══ */
            <IndexLeaderboard
              indexId={activeTab}
              indexSymbol={activeIndex?.symbol}
              agents={agents}
              onBack={() => setLiteUi('centerView', 'dashboard')}
              onAgentClick={handleAgentClick}
            />
          ) : (
            /* ═══ DASHBOARD VIEW ═══ */
            <>
              {/* ── Index Info Card ── */}
              {indexSnap && (
                <div className="lt-chart-card lt-index-info">
                  <div className="lt-chart-head">
                    <span>{activeIndex?.icon} {activeIndex?.name || activeIndex?.symbol}</span>
                    <button className="lt-idx-info-btn" onClick={() => setLiteUi('showIndexDetail', activeIndex)}>
                      <Info className="h-4 w-4 mr-1 -ml-1" strokeWidth={1.7} /> Details
                    </button>
                  </div>
                  <div className="lt-index-stats">
                    <div className="lt-idx-stat">
                      <span className="lt-idx-label">Supply</span>
                      <span className="lt-idx-val">{fmtVol(indexSnap.circulatingSupply || 0)}</span>
                    </div>
                    <div className="lt-idx-stat">
                      <span className="lt-idx-label">Holders</span>
                      <span className="lt-idx-val">{indexSnap.holderCount || 0}</span>
                    </div>
                    <div className="lt-idx-stat">
                      <span className="lt-idx-label">Market Cap</span>
                      <span className="lt-idx-val">${fmtVol((indexSnap.oraclePrice || 0) * (indexSnap.circulatingSupply || 0))}</span>
                    </div>
                    <div className="lt-idx-stat">
                      <span className="lt-idx-label">Band</span>
                      <span className="lt-idx-val">±{(indexSnap.bandWidthPct || 0).toFixed(1)}%</span>
                    </div>
                    <div className="lt-idx-stat">
                      <span className="lt-idx-label">Volume</span>
                      <span className="lt-idx-val">${fmtVol(indexSnap.totalVolume || 0)}</span>
                    </div>
                    <div className="lt-idx-stat">
                      <span className="lt-idx-label">Total Trades</span>
                      <span className="lt-idx-val">{indexSnap.totalTrades || 0}</span>
                    </div>
                  </div>
                  <div className="lt-idx-desc">{activeIndex?.formulaDesc || activeIndex?.description || ''}</div>
                  {myAgent && (
                    <div className="lt-idx-sub">
                      {myAgent.subscriptionOwner && myAgent.subscriptionOwner !== 'manual' ? (
                        <button className="lt-idx-sub-btn lt-idx-unsub" disabled title={getSubscriptionOwnerLockLabel(myAgent.subscriptionOwner)}>
                          🔒 {getSubscriptionOwnerLockLabel(myAgent.subscriptionOwner)}
                        </button>
                      ) : agentSubs.some(s => s.indexId === activeTab) ? (
                        <button className="lt-idx-sub-btn lt-idx-unsub" onClick={() => handleUnsubscribe(activeTab)} disabled={subPending}>
                          {subPending ? '…' : '✕ Unsubscribe Agent'}
                        </button>
                      ) : (
                        <button className="lt-idx-sub-btn lt-idx-dosub" onClick={() => handleSubscribe(activeTab)} disabled={subPending}>
                          {subPending ? '…' : '⚡ Subscribe Agent (5%)'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Price Chart ── */}
              <div className="lt-chart-card">
                <div className="lt-chart-head">
                  <span>📈 {activeIndex?.symbol || ''} Oracle</span>
                  <span className="lt-chart-live"><span className="lt-live-dot" /> LIVE</span>
                </div>
                <div className="lt-chart-body">
                  {indexPriceHist.length > 3 ? (
                    <OracleInteractiveChart
                      series={indexPriceHist}
                      history={indexOracleHist}
                      intervalMs={indexSnap?.oracleIntervalMs || POLL_MS}
                      symbol={activeIndex?.symbol}
                      height={132}
                    />
                  ) : (
                    <div className="lt-chart-empty"><div className="lt-spin" />Waiting for oracle…</div>
                  )}
                </div>
              </div>

              {/* ── Depth / Order Book ── */}
              <div className="lt-chart-card">
                <div className="lt-chart-head">
                  <span>📊 {activeIndex?.symbol || ''} Depth</span>
                  <div className="lt-depth-info">
                    <span className="c-green">{indexOB?.bids?.[0]?.price?.toFixed(4) || '—'}</span>
                    <span className="lt-depth-sep">‹ {(indexOB?.spreadPercent || 0).toFixed(3)}% ›</span>
                    <span className="c-red">{indexOB?.asks?.[0]?.price?.toFixed(4) || '—'}</span>
                  </div>
                </div>
                <div className="lt-chart-body">
                  <DepthChart data={indexOB} />
                </div>
              </div>

            </>
          )}
        </section>

        {/* ── RIGHT: Trade Feed ── */}
        <section className="lt-col-feed">
          <div className="lt-feed-head">
            <span className="lt-feed-title">⚡ {activeIndex?.symbol || ''} Feed</span>
            <div className="lt-feed-tags">
              <span className="lt-feed-tag">
                {Math.min(indexTrades.length, LITE_INDEX_FEED_SIDEBAR_LIMIT)}/{LITE_INDEX_FEED_SIDEBAR_LIMIT}
              </span>
              {indexSnap && (
                <span className="lt-feed-tag lt-feed-tag-dim">${fmtVol(indexSnap.totalVolume || 0)}</span>
              )}
            </div>
          </div>
          <div className="lt-feed">
            {indexTrades.length === 0 ? (
              <div className="lt-feed-empty">
                <div className="lt-spin-lg" />
                <span className="lt-feed-empty-text">Waiting for index trades…</span>
                <span className="lt-feed-empty-sub">Subscribed agents trade here</span>
              </div>
            ) : (
              indexTrades.slice(0, LITE_INDEX_FEED_SIDEBAR_LIMIT).map(t => (
                <IndexTradeCard key={t.id} trade={t} agents={agents} onAgentClick={handleAgentClick} />
              ))
            )}
          </div>
        </section>
      </main>

      <footer className="lt-footer">
        <span>Tick #{metrics?.tickCount || 0}</span>
        <span className="lt-footer-sep">•</span>
        <span>{metrics?.uptime ? `${Math.floor(metrics.uptime/1000)}s uptime` : '—'}</span>
        <span className="lt-footer-sep">•</span>
        <span>Spread {(indexOB?.spreadPercent || 0).toFixed(3)}%</span>
        <span className="lt-footer-sep">•</span>
        <span className="lt-footer-v">v5.0</span>
      </footer>

      {/* MODALS */}
      {selectedAgent && <AgentModal agent={selectedAgent} trades={trades} onClose={() => setSelectedAgent(null)} />}

      {showCreateModal && walletAddress && !myAgent && (
        <LiteCreateAgentModal
          walletAddress={walletAddress}
          onClose={() => setShowCreateModal(false)}
          onCreated={handleAgentCreated}
        />
      )}

      {showMyAgent && myAgent && (
        <MyAgentPanel
          agent={myAgent}
          trades={trades}
          indexes={indexList}
          agentSubs={agentSubs}
          subPending={subPending}
          onClose={() => setShowMyAgent(false)}
          onPause={handlePause}
          onResume={handleResume}
          onDelete={handleDelete}
          onOpenIndex={(indexId) => {
            setShowMyAgent(false)
            setActiveTab(indexId)
          }}
          onUnsubscribe={handleUnsubscribe}
        />
      )}

      {showCreateIndex && myAgentId && (
        <CreateIndexModal
          agentId={myAgentId}
          onClose={() => setLiteUi('showCreateIndex', false)}
          onCreated={(result) => {
            setLiteUi('showCreateIndex', false)
            // Refresh index list
            fetchIndexes().then(list => setLiteUi('indexList', list || [])).catch(() => {})
            // Open the new index dashboard
            setLiteUi('showMyIndexes', true)
          }}
        />
      )}

      {showMyIndexes && myAgentId && (
        <MyIndexDashboard
          agentId={myAgentId}
          onClose={() => setLiteUi('showMyIndexes', false)}
          onViewIndex={(idx) => {
            setLiteUi('showMyIndexes', false)
            const found = indexList.find(i => i.id === idx.indexId)
            if (found) setLiteUi('showIndexDetail', found)
          }}
        />
      )}

      {showIndexDetail && (
        <IndexDetailModal
          index={{ ...showIndexDetail, ...(indexSnap || {}) }}
          trades={indexTrades}
          priceHistory={indexPriceHist}
          onClose={() => setLiteUi('showIndexDetail', null)}
        />
      )}
      <ConnectWalletModal {...connectChooser.modalProps} />
    </div>
  )
}
