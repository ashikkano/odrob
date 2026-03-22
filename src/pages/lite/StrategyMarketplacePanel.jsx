import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Bot, CheckCircle2, Download, RefreshCw, ShieldCheck, Sparkles, TrendingUp, Users, Zap } from 'lucide-react'

import {
  fetchStrategyMarketplace,
  fetchStrategyTemplateMetrics,
  installMarketplaceStrategy,
  setStrategyMarketplaceWalletAddress,
} from '@/services/strategyMarketplaceApi'

function formatCompact(value) {
  const number = Number(value) || 0
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`
  return `${Math.round(number)}`
}

function formatPercent(value) {
  const number = Number(value) || 0
  return `${number >= 0 ? '+' : ''}${number.toFixed(1)}%`
}

function formatCurrency(value) {
  const number = Number(value) || 0
  const abs = Math.abs(number)
  if (abs >= 1000) return `$${(number / 1000).toFixed(1)}k`
  return `$${number.toFixed(2)}`
}

const LITE_MARKETPLACE_PAGE_SIZE = 12

function normalizeMarketplaceResponse(payload) {
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : []

  return {
    items,
    total: Array.isArray(payload) ? items.length : payload?.total ?? items.length,
    hasMore: Array.isArray(payload) ? false : Boolean(payload?.hasMore),
  }
}

function getExplainabilityTone(score) {
  if (score >= 80) return { label: 'Easy to follow', tone: 'good' }
  if (score >= 55) return { label: 'Balanced', tone: 'neutral' }
  return { label: 'Advanced', tone: 'warn' }
}

function getComplexityTone(score) {
  if (score <= 30) return { label: 'Simple setup', tone: 'good' }
  if (score <= 65) return { label: 'Some tuning', tone: 'neutral' }
  return { label: 'Advanced setup', tone: 'warn' }
}

function getPrimaryActionLabel({ walletAddress, myAgent, isInstalled, installing }) {
  if (installing) return 'Installing…'
  if (!walletAddress) return 'Connect wallet'
  if (!myAgent) return 'Create my agent'
  if (isInstalled) return 'Installed on my agent'
  return 'Install on my agent'
}

function StrategyMetric({ label, value, tone = 'neutral' }) {
  return (
    <div className={`lt-strategy-metric lt-strategy-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function StrategyDetailStat({ label, value, hint = '', tone = 'neutral' }) {
  return (
    <div className={`lt-strategy-detail-stat lt-strategy-detail-stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  )
}

function StrategyCard({ listing, liveMetrics, badgeLabel, isInstalled, walletAddress, myAgent, onOpen, onPrimaryAction, installing }) {
  const template = listing?.template || {}
  const explainability = getExplainabilityTone(template.explainabilityScore || 0)
  const complexity = getComplexityTone(template.complexityScore || 0)
  const primaryLabel = getPrimaryActionLabel({ walletAddress, myAgent, isInstalled, installing })
  const totalPnl = Number(liveMetrics?.totalPnl || 0)
  const totalPnlClass = totalPnl >= 0 ? 'lt-strategy-pnl-positive' : 'lt-strategy-pnl-negative'
  const avgPnl = Number(liveMetrics?.avgPnlPercent || 0)
  const winRate = Number(liveMetrics?.avgWinRate || 0)
  const liveAgents = Number(liveMetrics?.connectedAgents || listing?.activeInstallCount || 0)
  const rankingScore = Math.round(Number(listing?.rankingScore || 0))

  return (
    <article className={`lt-strategy-card${isInstalled ? ' lt-strategy-card-installed' : ''}`}>
      <div className="lt-strategy-card-head">
        <div className="lt-strategy-card-identity">
          <div className="lt-strategy-card-badges">
            <span className="lt-strategy-pill lt-strategy-pill-blue">{template.category || 'custom'}</span>
            {listing?.verifiedBadge ? <span className="lt-strategy-pill lt-strategy-pill-green">Verified</span> : null}
            {badgeLabel ? <span className="lt-strategy-pill lt-strategy-pill-purple">{badgeLabel}</span> : null}
            {isInstalled ? <span className="lt-strategy-pill lt-strategy-pill-amber">My strategy</span> : null}
          </div>
          <div className="lt-strategy-card-title-row">
            <h3>{template.name || 'Strategy'}</h3>
            <span className="lt-strategy-card-score">Score {rankingScore}</span>
          </div>
        </div>
        <button className="lt-strategy-open" onClick={() => onOpen(listing)} aria-label={`Open ${template.name || 'strategy'}`}>
          <ArrowRight size={16} />
        </button>
      </div>

      <div className="lt-strategy-card-premium">
        <div className={`lt-strategy-pnl ${totalPnlClass}`}>
          <span>Total P&amp;L</span>
          <strong>{formatCurrency(totalPnl)}</strong>
          <small>
            {liveMetrics
              ? `${formatCompact(liveAgents)} live agents connected`
              : 'Loading live performance…'}
          </small>
        </div>

        <div className="lt-strategy-card-rail">
          <StrategyMetric label="Avg P&L" value={liveMetrics ? formatPercent(avgPnl) : '—'} tone={avgPnl >= 0 ? 'good' : 'warn'} />
          <StrategyMetric label="Win rate" value={liveMetrics ? `${winRate.toFixed(0)}%` : '—'} tone={winRate >= 50 ? 'good' : 'neutral'} />
          <StrategyMetric label="Live now" value={formatCompact(listing?.activeInstallCount || 0)} tone="good" />
          <StrategyMetric label="Installs" value={formatCompact(listing?.installCount || 0)} />
        </div>
      </div>

      <div className="lt-strategy-fit-row">
        <span className={`lt-strategy-fit lt-strategy-fit-${explainability.tone}`}>{explainability.label}</span>
        <span className={`lt-strategy-fit lt-strategy-fit-${complexity.tone}`}>{complexity.label}</span>
        <span className="lt-strategy-fit lt-strategy-fit-neutral">{template.type || 'custom'}</span>
      </div>

      <div className="lt-strategy-card-note">
        <span className="lt-strategy-card-note-label">Why it stands out</span>
        <span className="lt-strategy-card-note-value">
          {explainability.label} execution with {complexity.label.toLowerCase()} and institutional-style visibility.
        </span>
      </div>

      <div className="lt-strategy-card-actions">
        <button className="lt-strategy-ghost" onClick={() => onOpen(listing)}>
          Open
        </button>
        <button
          className={`lt-strategy-primary${isInstalled ? ' lt-strategy-primary-installed' : ''}`}
          onClick={() => onPrimaryAction(listing)}
          disabled={installing || isInstalled}
        >
          {isInstalled ? <CheckCircle2 size={14} /> : <Download size={14} />}
          <span>{primaryLabel}</span>
        </button>
      </div>
    </article>
  )
}

function StrategyDetailModal({
  listing,
  metrics,
  metricsLoading,
  walletAddress,
  myAgent,
  isInstalled,
  installing,
  installMessage,
  onClose,
  onPrimaryAction,
  onOpenMyAgent,
}) {
  if (!listing) return null

  const template = listing.template || {}
  const live = metrics?.live || {}
  const structure = metrics?.structure || {}
  const connectedAgents = Array.isArray(metrics?.agents) ? metrics.agents : []
  const primaryLabel = getPrimaryActionLabel({ walletAddress, myAgent, isInstalled, installing })
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    setTab('overview')
  }, [listing?.strategyTemplateId])

  const detailTabs = [
    { id: 'overview', label: 'Overview', icon: '✨' },
    { id: 'performance', label: 'Performance', icon: '📈' },
    { id: 'fit', label: 'Fit', icon: '🛡️' },
    { id: 'agents', label: 'Connected agents', icon: '🤖', count: connectedAgents.length },
  ]
  const explainability = getExplainabilityTone(template.explainabilityScore || 0)
  const complexity = getComplexityTone(template.complexityScore || 0)

  return (
    <div className="lt-modal-overlay" onClick={onClose}>
      <div className="lt-modal lt-strategy-modal" onClick={(event) => event.stopPropagation()}>
        <button className="lt-modal-close" onClick={onClose}>✕</button>

        <div className="lt-modal-header">
          <div className="lt-strategy-modal-icon">
            <Sparkles size={22} />
          </div>
          <div className="lt-modal-hinfo">
            <div className="lt-modal-name">
              <span>{template.name || 'Strategy'}</span>
              {listing?.verifiedBadge ? <span className="lt-strategy-pill lt-strategy-pill-green">Verified</span> : null}
              {isInstalled ? <span className="lt-strategy-pill lt-strategy-pill-amber">Connected</span> : null}
            </div>
            <div className="lt-modal-since">{template.category || 'custom'} · {template.type || 'custom'} · score {Math.round(listing?.rankingScore || 0)}</div>
          </div>
        </div>

        <div className="lt-modal-bio">
          {template.shortDescription || 'Use this strategy to connect a ready-made trading logic to your user agent in one tap.'}
        </div>

        <div className="lt-strategy-hero">
          <div className="lt-strategy-hero-item">
            <span><Users size={14} /> Live agents</span>
            <strong>{formatCompact(live.connectedAgents || listing?.activeInstallCount || 0)}</strong>
          </div>
          <div className="lt-strategy-hero-item">
            <span><TrendingUp size={14} /> Avg PnL</span>
            <strong className={(live.avgPnlPercent || 0) >= 0 ? 'c-green' : 'c-red'}>{formatPercent(live.avgPnlPercent || 0)}</strong>
          </div>
          <div className="lt-strategy-hero-item">
            <span><ShieldCheck size={14} /> Win rate</span>
            <strong>{`${Number(live.avgWinRate || 0).toFixed(0)}%`}</strong>
          </div>
          <div className="lt-strategy-hero-item">
            <span><Zap size={14} /> Trades</span>
            <strong>{formatCompact(live.totalTrades || 0)}</strong>
          </div>
        </div>

        <div className="lt-modal-tabs">
          {detailTabs.map((item) => (
            <button
              key={item.id}
              className={`lt-tab ${tab === item.id ? 'lt-tab-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <span className="lt-tab-icon">{item.icon}</span>
              {item.label}
              {item.count != null ? <span className="lt-tab-count">{item.count}</span> : null}
            </button>
          ))}
        </div>

        <div className="lt-modal-body" key={tab}>
          {tab === 'overview' ? (
            <div className="lt-strategy-overview-stack">
              <div className="lt-strategy-thesis-card">
                <span>Investment thesis</span>
                <strong>{template.name || 'Strategy'} is built for clean deployment in Lite.</strong>
                <p>
                  It packages a market-ready ruleset, transparent operating profile, and one-step install flow so
                  the strategy reads more like a product mandate than a raw algorithm.
                </p>
              </div>
              <div className="lt-strategy-detail-grid">
                <div className="lt-strategy-detail-card">
                  <span>Why it fits Lite</span>
                  <strong>{explainability.label}</strong>
                  <p>Clear goal, readable metrics, and a simple installation path for business-facing users.</p>
                </div>
                <div className="lt-strategy-detail-card">
                  <span>Setup effort</span>
                  <strong>{complexity.label}</strong>
                  <p>Defaults are applied automatically when you connect this strategy to your agent.</p>
                </div>
                <div className="lt-strategy-detail-card">
                  <span>Versions</span>
                  <strong>{structure.versionCount || 1}</strong>
                  <p>{structure.ruleCount || 0} rules · {structure.requiredChannelCount || 0} required channels</p>
                </div>
                <div className="lt-strategy-detail-card">
                  <span>Connected capital</span>
                  <strong>{formatCurrency(live.totalEquity || 0)}</strong>
                  <p>{formatCompact(live.activeAgents || 0)} active agents · {formatCurrency(live.totalVolume || 0)} volume</p>
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'performance' ? (
            <div className="lt-strategy-detail-stats-grid">
              <StrategyDetailStat label="Total P&L" value={formatCurrency(live.totalPnl || 0)} hint="Across connected agents" tone={(live.totalPnl || 0) >= 0 ? 'good' : 'warn'} />
              <StrategyDetailStat label="Average P&L" value={formatPercent(live.avgPnlPercent || 0)} hint="Per connected agent" tone={(live.avgPnlPercent || 0) >= 0 ? 'good' : 'warn'} />
              <StrategyDetailStat label="Win rate" value={`${Number(live.avgWinRate || 0).toFixed(0)}%`} hint="Average realized success rate" tone={Number(live.avgWinRate || 0) >= 50 ? 'good' : 'neutral'} />
              <StrategyDetailStat label="Total trades" value={formatCompact(live.totalTrades || 0)} hint="Executed under this template" />
              <StrategyDetailStat label="Active agents" value={formatCompact(live.activeAgents || 0)} hint="Currently running it" />
              <StrategyDetailStat label="Connected capital" value={formatCurrency(live.totalEquity || 0)} hint={`${formatCurrency(live.totalVolume || 0)} total volume`} tone="blue" />
            </div>
          ) : null}

          {tab === 'fit' ? (
            <div className="lt-strategy-fit-panel">
              <div className="lt-strategy-fit-summary">
                <span className={`lt-strategy-fit lt-strategy-fit-${explainability.tone}`}>{explainability.label}</span>
                <span className={`lt-strategy-fit lt-strategy-fit-${complexity.tone}`}>{complexity.label}</span>
                <span className="lt-strategy-fit lt-strategy-fit-neutral">{template.category || 'custom'}</span>
                <span className="lt-strategy-fit lt-strategy-fit-neutral">{template.type || 'custom'}</span>
              </div>
              <div className="lt-strategy-detail-grid">
                <div className="lt-strategy-detail-card">
                  <span>Ranking score</span>
                  <strong>{Math.round(listing?.rankingScore || 0)}</strong>
                  <p>Marketplace ranking blends quality, traction, and live performance.</p>
                </div>
                <div className="lt-strategy-detail-card">
                  <span>Install base</span>
                  <strong>{formatCompact(listing?.installCount || 0)}</strong>
                  <p>{formatCompact(listing?.activeInstallCount || 0)} live installs right now.</p>
                </div>
                <div className="lt-strategy-detail-card">
                  <span>Explainability</span>
                  <strong>{explainability.label}</strong>
                  <p>Designed to be easier to evaluate, present, and trust before installation.</p>
                </div>
                <div className="lt-strategy-detail-card">
                  <span>Operational fit</span>
                  <strong>{complexity.label}</strong>
                  <p>Indicates how much tuning or oversight is expected after the initial install.</p>
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'agents' ? (
            <div className="lt-strategy-detail-section">
              <div className="lt-strategy-detail-head">
                <span>Top connected agents</span>
                {metricsLoading ? <span className="lt-section-badge">Loading…</span> : <span className="lt-section-badge">{connectedAgents.length}</span>}
              </div>
              {metricsLoading ? (
                <div className="lt-strategy-empty">Loading live metrics…</div>
              ) : connectedAgents.length === 0 ? (
                <div className="lt-strategy-empty">No public agent snapshots yet. You can still install and be first.</div>
              ) : (
                <div className="lt-strategy-agent-list">
                  {connectedAgents.slice(0, 6).map((agent) => (
                    <div key={agent.id} className="lt-strategy-agent-chip">
                      <div className="lt-strategy-agent-main">
                        <span className="lt-strategy-agent-icon">{agent.icon || '🤖'}</span>
                        <div>
                          <strong>{agent.name || 'Agent'}</strong>
                          <small>{agent.mode || 'direct'} · {agent.totalTrades || 0} trades</small>
                        </div>
                      </div>
                      <div className="lt-strategy-agent-side">
                        <span className={(agent.pnlPercent || 0) >= 0 ? 'c-green' : 'c-red'}>{formatPercent(agent.pnlPercent || 0)}</span>
                        <small>{`${Number(agent.winRate || 0).toFixed(0)}% win`}</small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {installMessage ? (
          <div className={`lt-strategy-message lt-strategy-message-${installMessage.type}`}>
            {installMessage.text}
          </div>
        ) : null}

        <div className="lt-strategy-modal-actions">
          {myAgent ? (
            <button className="lt-myagent-subs-btn lt-myagent-subs-btn-open" onClick={onOpenMyAgent}>
              <Bot size={14} />
              <span>Open my agent</span>
            </button>
          ) : null}
          <button
            className={`lt-strategy-primary lt-strategy-primary-wide${isInstalled ? ' lt-strategy-primary-installed' : ''}`}
            onClick={() => onPrimaryAction(listing)}
            disabled={installing || isInstalled}
          >
            {isInstalled ? <CheckCircle2 size={15} /> : <Download size={15} />}
            <span>{primaryLabel}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default function StrategyMarketplacePanel({
  walletAddress,
  myAgent,
  onConnectWallet,
  onCreateAgent,
  onOpenMyAgent,
  onInstallComplete,
}) {
  const [listings, setListings] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMoreListings, setHasMoreListings] = useState(false)
  const [totalListings, setTotalListings] = useState(0)
  const [error, setError] = useState(null)
  const [selectedListing, setSelectedListing] = useState(null)
  const [selectedMetrics, setSelectedMetrics] = useState(null)
  const [cardMetricsByTemplate, setCardMetricsByTemplate] = useState({})
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [installingTemplateId, setInstallingTemplateId] = useState(null)
  const [installMessage, setInstallMessage] = useState(null)
  const [sortMode, setSortMode] = useState('pnl')
  const loadMoreRef = useRef(null)
  const requestRef = useRef(0)

  useEffect(() => {
    setStrategyMarketplaceWalletAddress(walletAddress || null)
  }, [walletAddress])

  const loadMarketplace = useCallback(async ({ append = false, offset = 0 } = {}) => {
    const requestId = append ? requestRef.current : requestRef.current + 1
    if (!append) requestRef.current = requestId

    if (append) {
      setLoadingMore(true)
    } else {
      setLoading(true)
      setError(null)
    }

    try {
      const payload = await fetchStrategyMarketplace({
        limit: LITE_MARKETPLACE_PAGE_SIZE,
        offset,
        sort: 'ranking',
        includeMeta: true,
      })
      if (!append && requestId !== requestRef.current) return

      const { items, total, hasMore } = normalizeMarketplaceResponse(payload)
      setTotalListings(total)
      setHasMoreListings(hasMore)
      setListings((prev) => {
        if (!append) return items
        const known = new Set(prev.map((item) => item.strategyTemplateId))
        return [...prev, ...items.filter((item) => !known.has(item.strategyTemplateId))]
      })
      if (!append) {
        setSelectedListing((prev) => {
          if (prev) {
            return items.find((item) => item.strategyTemplateId === prev.strategyTemplateId) || null
          }
          return null
        })
      }
    } catch (err) {
      if (!append || requestId === requestRef.current) {
        setError(err?.message || 'Could not load strategy marketplace')
      }
    } finally {
      if (append) {
        setLoadingMore(false)
      } else if (requestId === requestRef.current) {
        setLoading(false)
      }
    }
  }, [])

  const loadNextPage = useCallback(() => {
    if (loading || loadingMore || !hasMoreListings) return
    loadMarketplace({ append: true, offset: listings.length })
  }, [hasMoreListings, listings.length, loadMarketplace, loading, loadingMore])

  useEffect(() => {
    loadMarketplace()
  }, [loadMarketplace])

  useEffect(() => {
    if (loading || loadingMore || !hasMoreListings) return
    const node = loadMoreRef.current
    if (!node) return

    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        loadNextPage()
      }
    }, { rootMargin: '280px 0px' })

    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMoreListings, loadNextPage, loading, loadingMore])

  useEffect(() => {
    if (!selectedListing?.strategyTemplateId) {
      setSelectedMetrics(null)
      return undefined
    }

    let cancelled = false
    setMetricsLoading(true)
    fetchStrategyTemplateMetrics(selectedListing.strategyTemplateId)
      .then((data) => {
        if (!cancelled) setSelectedMetrics(data || null)
      })
      .catch(() => {
        if (!cancelled) setSelectedMetrics(null)
      })
      .finally(() => {
        if (!cancelled) setMetricsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedListing])

  const totalInstalls = useMemo(
    () => listings.reduce((sum, listing) => sum + (Number(listing?.installCount) || 0), 0),
    [listings]
  )
  const activeInstalls = useMemo(
    () => listings.reduce((sum, listing) => sum + (Number(listing?.activeInstallCount) || 0), 0),
    [listings]
  )
  const displayListings = useMemo(() => {
    const sorted = [...listings]
      .sort((left, right) => {
        if (sortMode === 'installs') {
          const installDelta = (right.installCount || 0) - (left.installCount || 0)
          if (installDelta !== 0) return installDelta
          const activeDelta = (right.activeInstallCount || 0) - (left.activeInstallCount || 0)
          if (activeDelta !== 0) return activeDelta
        }

        if (sortMode === 'new') {
          const rightTs = Number(right.template?.createdAt || right.template?.updatedAt || right.createdAt || 0)
          const leftTs = Number(left.template?.createdAt || left.template?.updatedAt || left.createdAt || 0)
          if (rightTs !== leftTs) return rightTs - leftTs
        }

        const leftPnl = Number(cardMetricsByTemplate[left.strategyTemplateId]?.totalPnl)
        const rightPnl = Number(cardMetricsByTemplate[right.strategyTemplateId]?.totalPnl)
        const leftHasPnl = Number.isFinite(leftPnl)
        const rightHasPnl = Number.isFinite(rightPnl)
        if ((sortMode === 'pnl' || (!sortMode && leftHasPnl && rightHasPnl)) && leftHasPnl && rightHasPnl && rightPnl !== leftPnl) return rightPnl - leftPnl
        if (sortMode === 'pnl' && rightHasPnl && !leftHasPnl) return 1
        if (sortMode === 'pnl' && leftHasPnl && !rightHasPnl) return -1

        return (right.rankingScore || 0) - (left.rankingScore || 0)
      })
    return sorted
  }, [cardMetricsByTemplate, listings, sortMode])

  useEffect(() => {
    const targets = listings
      .map((listing) => listing?.strategyTemplateId)
      .filter((id) => id && !cardMetricsByTemplate[id])

    if (targets.length === 0) return undefined

    let cancelled = false

    Promise.all(
      targets.map((id) => fetchStrategyTemplateMetrics(id).then((data) => [id, data]).catch(() => [id, null]))
    ).then((results) => {
      if (cancelled) return
      setCardMetricsByTemplate((prev) => {
        const next = { ...prev }
        for (const [id, data] of results) next[id] = data?.live || null
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [cardMetricsByTemplate, listings])

  const handlePrimaryAction = useCallback(async (listing) => {
    if (!walletAddress) {
      onConnectWallet?.()
      return
    }
    if (!myAgent) {
      onCreateAgent?.()
      return
    }
    if (!listing?.strategyTemplateId) return

    setInstallingTemplateId(listing.strategyTemplateId)
    setInstallMessage({ type: 'pending', text: `Installing ${listing.template?.name || 'strategy'} on ${myAgent.name || 'your agent'}…` })

    try {
      await installMarketplaceStrategy({
        agentId: myAgent.id,
        templateId: listing.strategyTemplateId,
      })
      await Promise.resolve(onInstallComplete?.())
      await loadMarketplace()
      setInstallMessage({ type: 'success', text: `${listing.template?.name || 'Strategy'} is now connected to ${myAgent.name || 'your agent'}.` })
    } catch (err) {
      setInstallMessage({ type: 'error', text: err?.message || 'Install failed. Please try again.' })
    } finally {
      setInstallingTemplateId(null)
    }
  }, [loadMarketplace, myAgent, onConnectWallet, onCreateAgent, onInstallComplete, walletAddress])

  useEffect(() => {
    if (!installMessage || installMessage.type === 'pending') return undefined
    const timeoutId = window.setTimeout(() => setInstallMessage(null), 4000)
    return () => window.clearTimeout(timeoutId)
  }, [installMessage])

  const sortOptions = [
    { id: 'pnl', label: 'Best P&L' },
    { id: 'installs', label: 'Most installs' },
    { id: 'new', label: 'New' },
  ]

  const getBadgeLabel = useCallback((index, listing) => {
    if (sortMode === 'installs') {
      if (index === 0) return 'Most installs'
      if (index < 3) return `Popular ${index + 1}`
      return null
    }
    if (sortMode === 'new') {
      return index === 0 ? 'Newest' : null
    }
    const totalPnl = Number(cardMetricsByTemplate[listing.strategyTemplateId]?.totalPnl)
    if (!Number.isFinite(totalPnl)) return null
    if (index === 0) return 'Best P&L'
    if (index < 3) return `Top ${index + 1}`
    return null
  }, [cardMetricsByTemplate, sortMode])

  return (
    <>
      <div className="lt-strategy-shell">
        <div className="lt-strategy-toolbar">
          <div className="lt-strategy-sort-tabs" role="tablist" aria-label="Sort strategies">
            {sortOptions.map((option) => (
              <button
                key={option.id}
                className={`lt-strategy-sort-btn${sortMode === option.id ? ' lt-strategy-sort-btn-active' : ''}`}
                onClick={() => setSortMode(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="lt-strategy-toolbar-actions">
            {!walletAddress ? (
              <button className="lt-strategy-primary" onClick={onConnectWallet}>
                <ShieldCheck size={14} />
                <span>Connect wallet</span>
              </button>
            ) : !myAgent ? (
              <button className="lt-strategy-primary" onClick={onCreateAgent}>
                <Bot size={14} />
                <span>Create my agent</span>
              </button>
            ) : (
              <button className="lt-myagent-subs-btn lt-myagent-subs-btn-open" onClick={onOpenMyAgent}>
                <Bot size={14} />
                <span>Open my agent</span>
              </button>
            )}
            <button className="lt-strategy-ghost" onClick={loadMarketplace}>
              <RefreshCw size={14} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <div className="lt-strategy-summary-row">
          <StrategyMetric label="Published" value={formatCompact(totalListings || listings.length)} tone="blue" />
          <StrategyMetric label="Total installs" value={formatCompact(totalInstalls)} />
          <StrategyMetric label="Active now" value={formatCompact(activeInstalls)} tone="good" />
          <StrategyMetric label="My status" value={myAgent ? 'Ready to install' : walletAddress ? 'Create agent first' : 'Connect wallet'} tone="neutral" />
        </div>

        {!loading && listings.length > 0 ? (
          <div className="lt-strategy-message">
            Showing {displayListings.length} of {totalListings || displayListings.length} strategies
            {loadingMore ? ' · Loading more…' : ''}
          </div>
        ) : null}

        {error ? <div className="lt-strategy-message lt-strategy-message-error">{error}</div> : null}
        {installMessage && !selectedListing ? <div className={`lt-strategy-message lt-strategy-message-${installMessage.type}`}>{installMessage.text}</div> : null}

        {loading ? (
          <div className="lt-strategy-loading">Loading strategy catalog…</div>
        ) : displayListings.length === 0 ? (
          <div className="lt-strategy-empty">Marketplace is still empty. New strategies will appear here.</div>
        ) : (
          <>
            <div className="lt-strategy-list">
              {displayListings.map((listing, index) => {
                const isInstalled = Boolean(myAgent?.activeStrategyTemplateId && myAgent.activeStrategyTemplateId === listing.strategyTemplateId)
                const isInstalling = installingTemplateId === listing.strategyTemplateId
                const badgeLabel = getBadgeLabel(index, listing)
                return (
                  <StrategyCard
                    key={listing.strategyTemplateId}
                    listing={listing}
                    liveMetrics={cardMetricsByTemplate[listing.strategyTemplateId] || null}
                    badgeLabel={badgeLabel}
                    isInstalled={isInstalled}
                    walletAddress={walletAddress}
                    myAgent={myAgent}
                    onOpen={setSelectedListing}
                    onPrimaryAction={handlePrimaryAction}
                    installing={isInstalling}
                  />
                )
              })}
            </div>
            <div ref={loadMoreRef} className="lt-strategy-empty">
              {hasMoreListings
                ? (loadingMore ? 'Loading more strategies…' : 'Scroll down to load more strategies automatically.')
                : 'All available strategies are loaded.'}
            </div>
          </>
        )}
      </div>

      <StrategyDetailModal
        listing={selectedListing}
        metrics={selectedMetrics}
        metricsLoading={metricsLoading}
        walletAddress={walletAddress}
        myAgent={myAgent}
        isInstalled={Boolean(myAgent?.activeStrategyTemplateId && selectedListing?.strategyTemplateId === myAgent.activeStrategyTemplateId)}
        installing={installingTemplateId === selectedListing?.strategyTemplateId}
        installMessage={installMessage}
        onClose={() => setSelectedListing(null)}
        onPrimaryAction={handlePrimaryAction}
        onOpenMyAgent={onOpenMyAgent}
      />
    </>
  )
}
