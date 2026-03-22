// ═══════════════════════════════════════════════════════════════════════
// Agent Detail Panel — Dashboard with real wallet + TonConnect funding
// ═══════════════════════════════════════════════════════════════════════

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTonAddress, useTonConnectUI, useTonWallet } from '@tonconnect/ui-react'
import { CHAIN } from '@tonconnect/sdk'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/contexts/LanguageContext'
import { useAgents } from '@/contexts/AgentContext'
import { AGENT_PRESETS, AGENT_STATUS } from '@/agents/agentTypes'
import {
  formatRotationIds,
  formatRotationScore,
  formatScoreDelta,
  formatFactorValue,
  getAgentStrategyRuntimeSummary,
  getRotationReasonLabel,
  getStrategySourceLabel,
  summarizeFactorGroups,
} from '@/components/agents/strategyRuntimeSummary'
import EquitySparkline from '@/components/charts/EquitySparkline'
import { formatWinRatePercent, getAgentCurrentState } from '@/lib/agentMetrics'
import { buildFundTransaction, buildTonConnectWalletRedirectLink } from '@/services/walletApi'
import { tonConnectDebugLog } from '@/lib/tonConnectDebug'
import {
  Play, Pause, StopCircle, Trash2, Wallet, ArrowLeft,
  Brain, TrendingUp, TrendingDown, Shield, Zap,
  Activity, BarChart3, AlertTriangle, Check, Copy,
  RefreshCw, Target, ExternalLink, Loader2, Send,
} from 'lucide-react'

const STATUS_STYLES = {
  creating:  { color: 'text-muted-foreground', bg: 'bg-muted-foreground', labelKey: 'agent.status.creating' },
  funding:   { color: 'text-yellow-400', bg: 'bg-yellow-400', labelKey: 'agent.status.funding' },
  idle:      { color: 'text-blue-400', bg: 'bg-blue-400', labelKey: 'agent.status.idle' },
  active:    { color: 'text-agent-active', bg: 'bg-agent-active', labelKey: 'agents.running' },
  paused:    { color: 'text-agent-paused', bg: 'bg-agent-paused', labelKey: 'agents.paused' },
  stopped:   { color: 'text-agent-stopped', bg: 'bg-agent-stopped', labelKey: 'agents.stopped' },
  error:     { color: 'text-red-500', bg: 'bg-red-500', labelKey: 'agent.status.error' },
}

function getFactorTone(total) {
  if (!Number.isFinite(Number(total))) return 'neutral'
  if (Number(total) > 0) return 'positive'
  if (Number(total) < 0) return 'negative'
  return 'neutral'
}

function getFactorChipClasses(total) {
  const tone = getFactorTone(total)
  if (tone === 'positive') return 'border-profit/30 bg-profit/10 text-profit'
  if (tone === 'negative') return 'border-loss/30 bg-loss/10 text-loss'
  return 'border-border/60 bg-background/70 text-foreground'
}

function getFactorCardClasses(total) {
  const tone = getFactorTone(total)
  if (tone === 'positive') return 'border-profit/20 bg-profit/5'
  if (tone === 'negative') return 'border-loss/20 bg-loss/5'
  return 'border-border/60 bg-background/60'
}

function getFactorValueClasses(total) {
  const tone = getFactorTone(total)
  if (tone === 'positive') return 'text-profit'
  if (tone === 'negative') return 'text-loss'
  return 'text-foreground'
}

function buildEquityChartData(agent) {
  if (Array.isArray(agent?.equityCurve) && agent.equityCurve.length > 1) {
    return agent.equityCurve
      .filter((point) => Number.isFinite(Number(point?.equity)))
      .map((point, index) => ({
        time: point.time || Date.now() - ((agent.equityCurve.length - index) * 60000),
        equity: Number(point.equity),
      }))
  }

  if (Array.isArray(agent?.equityHistory) && agent.equityHistory.length > 1) {
    return agent.equityHistory
      .filter((value) => Number.isFinite(Number(value)))
      .map((value, index, arr) => ({
        time: Date.now() - ((arr.length - index) * 60000),
        equity: Number(value),
      }))
  }

  return []
}

function getDecisionQuality(agent, performance, currentState) {
  const metrics = performance?.metrics || {}
  const totalDecisions = Number(metrics.totalDecisions || agent?.decisionHistory?.length || agent?.decisions?.length || 0)
  const executed = Number(metrics.executed || agent?.totalTrades || 0)
  const blocked = Number(metrics.blocked || 0)
  const passive = Math.max(totalDecisions - executed - blocked, 0)
  const avgConfidence = Number(metrics.avgConfidence ?? currentState?.latestDecision?.confidence ?? 0)

  return {
    totalDecisions,
    executed,
    blocked,
    passive,
    avgConfidence,
    score: Number(performance?.score || 0),
  }
}

function getDecisionRecords(agent) {
  if (Array.isArray(agent?.decisionHistory) && agent.decisionHistory.length > 0) return agent.decisionHistory
  if (Array.isArray(agent?.decisions) && agent.decisions.length > 0) {
    return agent.decisions.map((decision) => ({
      id: decision.id,
      timestamp: decision.timestamp,
      executed: ['buy', 'sell', 'cancel', 'cancel_stale'].includes(decision.action),
      decision: {
        type: decision.action,
        action: decision.action,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        price: decision.price,
        size: decision.size,
      },
    }))
  }
  return []
}

function buildActivityFeed(agent) {
  const decisionItems = getDecisionRecords(agent).map((record) => {
    const decision = record.decision || {}
    return {
      id: `decision-${record.id || record.timestamp}`,
      kind: 'decision',
      timestamp: record.timestamp,
      action: decision.type || decision.action || 'hold',
      confidence: decision.confidence ?? null,
      reasoning: decision.reasoning || 'No reasoning provided.',
      executed: Boolean(record.executed),
    }
  })

  const tradeItems = (agent?.trades || []).map((trade) => ({
    id: `trade-${trade.id || trade.timestamp}`,
    kind: 'trade',
    timestamp: trade.timestamp,
    action: trade.side || 'trade',
    pnl: Number(trade.pnl || 0),
    reasoning: trade.reasoning || 'Trade execution recorded.',
    price: trade.price,
    size: trade.size,
    symbol: trade.indexSymbol || trade.symbol || null,
  }))

  return [...decisionItems, ...tradeItems]
    .filter((item) => Number.isFinite(Number(item.timestamp || 0)))
    .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0))
    .slice(0, 8)
}

// ─── Decision log item ───
function DecisionItem({ record }) {
  const decision = record.decision || {}
  const isExecuted = record.executed

  return (
    <div className={cn(
      'p-3 rounded-lg border',
      isExecuted ? 'border-profit/20 bg-profit/5' : 'border-border'
    )}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className={cn(
            'h-6 w-6 rounded-full flex items-center justify-center text-[10px]',
            isExecuted ? 'bg-profit/20 text-profit' : 'bg-muted text-muted-foreground'
          )}>
            {isExecuted ? <Check className="h-3 w-3" /> : '—'}
          </div>
          <span className={cn('text-xs font-medium uppercase',
            decision.type === 'buy' ? 'text-profit' : decision.type === 'sell' ? 'text-loss' : 'text-muted-foreground'
          )}>
            {decision.type}
          </span>
          {decision.confidence != null && (
            <span className="text-[10px] text-muted-foreground">
              {(decision.confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">
          {new Date(record.timestamp).toLocaleTimeString()}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5">{decision.reasoning}</p>
      {record.riskAnalysis?.warnings?.length > 0 && (
        <div className="mt-2 text-[10px] text-yellow-500">
          ⚠ {record.riskAnalysis.warnings.join('; ')}
        </div>
      )}
    </div>
  )
}

// ─── Trade item ───
function TradeItem({ trade }) {
  const isBuy = trade.side === 'buy'
  return (
    <div className="flex items-center gap-3 py-2 px-1 border-b border-border/30 last:border-0">
      <div className={cn('h-6 w-6 rounded flex items-center justify-center', isBuy ? 'bg-bid-muted' : 'bg-ask-muted')}>
        {isBuy ? <TrendingUp className="h-3 w-3 text-profit" /> : <TrendingDown className="h-3 w-3 text-loss" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-medium', isBuy ? 'text-profit' : 'text-loss')}>
            {trade.side.toUpperCase()}
          </span>
          <span className="text-xs font-mono">{trade.price?.toFixed(5)}</span>
        </div>
        <p className="text-[10px] text-muted-foreground truncate">{trade.reasoning}</p>
      </div>
      <div className="text-right">
        <p className={cn('text-xs font-mono font-medium', (trade.pnl || 0) >= 0 ? 'text-profit' : 'text-loss')}>
          {(trade.pnl || 0) >= 0 ? '+' : ''}{(trade.pnl || 0).toFixed(4)}
        </p>
        <p className="text-[10px] text-muted-foreground font-mono">
          {new Date(trade.timestamp).toLocaleTimeString()}
        </p>
      </div>
    </div>
  )
}

function ActivityFeedItem({ item }) {
  const isTrade = item.kind === 'trade'
  const action = String(item.action || 'hold').toUpperCase()

  return (
    <div className="rounded-lg border border-border/60 bg-background/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={isTrade ? 'outline' : item.executed ? 'active' : 'secondary'}>
            {isTrade ? 'Trade' : 'Decision'}
          </Badge>
          <span className={cn('text-xs font-medium', action === 'BUY' ? 'text-profit' : action === 'SELL' ? 'text-loss' : 'text-foreground')}>
            {action}
          </span>
          {item.confidence != null ? <span className="text-[10px] text-muted-foreground">{(Number(item.confidence) * 100).toFixed(0)}%</span> : null}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">{new Date(item.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{item.reasoning}</div>
      {isTrade ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
          {item.symbol ? <span className="text-muted-foreground">{item.symbol}</span> : null}
          {item.price ? <span className="font-mono">@ {Number(item.price).toFixed(4)}</span> : null}
          {item.size ? <span className="font-mono">× {Number(item.size).toFixed(2)}</span> : null}
          <span className={cn('font-mono font-medium', Number(item.pnl || 0) >= 0 ? 'text-profit' : 'text-loss')}>
            {Number(item.pnl || 0) >= 0 ? '+' : ''}{Number(item.pnl || 0).toFixed(4)}
          </span>
        </div>
      ) : null}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

export default function AgentDetailPanel({ agentId, onBack }) {
  const { t } = useTranslation()
  const { agents, startAgent, pauseAgent, stopAgent, removeAgent, runDecisionCycle, getPerformance, refreshBalance, recordDeposit } = useAgents()
  const agent = agents[agentId]

  const address = useTonAddress()
  const tonWallet = useTonWallet()
  const [tonConnectUI] = useTonConnectUI()
  const [fundAmount, setFundAmount] = useState('1')
  const [funding, setFunding] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [walletRedirectReady, setWalletRedirectReady] = useState(false)
  const [walletRedirectLink, setWalletRedirectLink] = useState('')
  const walletRedirectRef = useRef(null)

  const performance = useMemo(() => getPerformance(agentId), [agentId, getPerformance])
  const preset = agent ? AGENT_PRESETS[agent.preset] : null
  const statusStyle = agent ? (STATUS_STYLES[agent.status] || STATUS_STYLES.stopped) : STATUS_STYLES.stopped
  const runtime = useMemo(() => getAgentStrategyRuntimeSummary(agent), [agent])
  const currentState = useMemo(() => getAgentCurrentState(agent), [agent])
  const equityChartData = useMemo(() => buildEquityChartData(agent), [agent])
  const decisionQuality = useMemo(() => getDecisionQuality(agent, performance, currentState), [agent, performance, currentState])
  const decisionRecords = useMemo(() => getDecisionRecords(agent), [agent])
  const activityFeed = useMemo(() => buildActivityFeed(agent), [agent])
  const isEngineBackedAgent = agent?.backendSource === 'engine'

  // Auto-refresh balance on mount
  useEffect(() => {
    if (agent?.walletId) {
      refreshBalance(agentId)
    }
  }, [agentId])

  const handleCopy = useCallback(() => {
    if (agent?.walletAddress) {
      navigator.clipboard.writeText(agent.walletAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [agent])

  const handleRefreshBalance = useCallback(async () => {
    setRefreshing(true)
    await refreshBalance(agentId)
    setRefreshing(false)
  }, [agentId, refreshBalance])

  const handleOpenWalletManually = useCallback(() => {
    if (walletRedirectLink && typeof window !== 'undefined') {
      window.open(walletRedirectLink, '_blank', 'noopener,noreferrer')
      return
    }
    if (typeof walletRedirectRef.current !== 'function') return
    try {
      walletRedirectRef.current()
    } catch (redirectError) {
      console.error('[TonConnect][AgentDetailPanel] manual redirectToWallet failed', redirectError)
    }
  }, [walletRedirectLink])

  // TonConnect fund transfer
  const handleFund = useCallback(async () => {
    setWalletRedirectReady(false)
    setWalletRedirectLink('')
    walletRedirectRef.current = null
    if (!address) {
      tonConnectUI.openModal()
      return
    }
    const amount = parseFloat(fundAmount)
    if (!amount || amount <= 0 || !agent?.walletAddress) return

    setFunding(true)
    try {
      const tx = buildFundTransaction(agent.walletAddress, amount, undefined, {
        network: CHAIN.MAINNET,
        from: tonWallet?.account?.address,
      })
      tonConnectDebugLog('[TonConnect][AgentDetailPanel] source wallet', {
        address: tonWallet?.account?.address || null,
        chain: tonWallet?.account?.chain || null,
        wallet: tonWallet,
      })
      tonConnectDebugLog('[TonConnect][AgentDetailPanel] tx payload', tx)
      const traceId = crypto.randomUUID()
      await tonConnectUI.sendTransaction(tx, {
        modals: ['before', 'success', 'error'],
        notifications: ['before', 'success', 'error'],
        skipRedirectToWallet: 'never',
        returnStrategy: 'back',
        traceId,
        onRequestSent: (redirectToWallet) => {
          tonConnectDebugLog('[TonConnect][AgentDetailPanel] request sent, redirect available', typeof redirectToWallet === 'function')
          if (typeof redirectToWallet === 'function') {
            walletRedirectRef.current = redirectToWallet
            setWalletRedirectReady(true)
            Promise.resolve(tonConnectUI.connector.getSessionId())
              .then((sessionId) => {
                const manualLink = buildTonConnectWalletRedirectLink(tonConnectUI.wallet, sessionId, traceId)
                tonConnectDebugLog('[TonConnect][AgentDetailPanel] manual wallet link', manualLink)
                setWalletRedirectLink(manualLink || '')
              })
              .catch((sessionError) => {
                console.error('[TonConnect][AgentDetailPanel] getSessionId failed', sessionError)
              })
          }
        },
      })
      recordDeposit(agent.id, amount, null)
      setTimeout(() => refreshBalance(agentId), 5000)
      setTimeout(() => refreshBalance(agentId), 15000)
    } catch (err) {
      console.error('[TonConnect][AgentDetailPanel] sendTransaction failed', err)
    } finally {
      setFunding(false)
    }
  }, [address, fundAmount, agent, tonConnectUI, tonWallet, recordDeposit, refreshBalance, agentId])

  if (!agent) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p>{t('agent.notFound')}</p>
        <Button variant="ghost" size="sm" onClick={onBack} className="mt-2 gap-1">
          <ArrowLeft className="h-3 w-3" /> {t('wizard.back')}
        </Button>
      </div>
    )
  }

  const isProfitable = (agent.pnl || 0) >= 0

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="text-2xl">{agent.icon}</span>
          <div>
            <h2 className="text-base font-bold">{agent.name}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              {preset && <Badge variant="outline" className="text-[10px]">{t(preset.nameKey)}</Badge>}
              <Badge variant={agent.status === 'active' ? 'active' : 'outline'} className="text-[10px]">
                <span className={cn('h-1.5 w-1.5 rounded-full mr-1', statusStyle.bg, agent.status === 'active' && 'animate-pulse-live')} />
                {t(statusStyle.labelKey)}
              </Badge>
              <Badge variant="secondary" className="text-[10px] font-mono">{agent.index}</Badge>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {agent.status === AGENT_STATUS.ACTIVE ? (
            <>
              <Button variant="outline" size="sm" onClick={() => pauseAgent(agentId)} className="text-xs gap-1">
                <Pause className="h-3 w-3" /> {t('agents.pause')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => stopAgent(agentId)} className="text-xs text-loss gap-1">
                <StopCircle className="h-3 w-3" /> {t('agents.stop')}
              </Button>
            </>
          ) : (agent.status === AGENT_STATUS.PAUSED || agent.status === AGENT_STATUS.IDLE) ? (
            <Button variant="profit" size="sm" onClick={() => startAgent(agentId)} className="text-xs gap-1">
              <Play className="h-3 w-3" /> {t('agents.start')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => runDecisionCycle(agentId)} className="text-xs gap-1" title="Run one cycle">
            <RefreshCw className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => { removeAgent(agentId); onBack() }} className="h-8 w-8 text-loss">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><CardContent className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase">{t('agents.pnl')}</p>
          <p className={cn('text-lg font-mono font-bold', isProfitable ? 'text-profit' : 'text-loss')}>
            {(agent.pnl || 0).toFixed(4)}
          </p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase">{t('wizard.currentBalance')}</p>
          <p className="text-lg font-mono font-bold">{(agent.balance || 0).toFixed(4)} <span className="text-xs text-muted-foreground">TON</span></p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase">{t('agents.winRate')}</p>
          <p className="text-lg font-mono font-bold">{formatWinRatePercent(agent.winRate)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase">{t('analytics.maxDrawdown')}</p>
          <p className="text-lg font-mono font-bold text-loss">{(agent.maxDrawdown || 0).toFixed(1)}%</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Current state</div>
              <div className="mt-1 text-sm font-semibold">{currentState.healthLabel}</div>
              <div className="mt-1 text-xs text-muted-foreground">{currentState.latestDecision.reasoning || 'No recent decision reasoning yet.'}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {currentState.latestDecision.action ? <Badge variant="outline">{String(currentState.latestDecision.action).toUpperCase()}</Badge> : null}
              {currentState.latestDecision.confidence != null ? <Badge variant="secondary">{(Number(currentState.latestDecision.confidence) * 100).toFixed(0)}% confidence</Badge> : null}
              <Badge variant="outline">{currentState.openPosition ? 'Position open' : 'Flat'}</Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-lg bg-muted/30 p-3">
              <p className="text-[10px] uppercase text-muted-foreground">Position value</p>
              <p className="mt-1 text-base font-mono font-bold">{currentState.positionValue.toFixed(2)}</p>
            </div>
            <div className="rounded-lg bg-muted/30 p-3">
              <p className="text-[10px] uppercase text-muted-foreground">Exposure</p>
              <p className="mt-1 text-base font-mono font-bold">{currentState.exposurePct.toFixed(1)}%</p>
            </div>
            <div className="rounded-lg bg-muted/30 p-3">
              <p className="text-[10px] uppercase text-muted-foreground">Realized</p>
              <p className={cn('mt-1 text-base font-mono font-bold', currentState.realizedPnl >= 0 ? 'text-profit' : 'text-loss')}>{currentState.realizedPnl >= 0 ? '+' : ''}{currentState.realizedPnl.toFixed(2)}</p>
            </div>
            <div className="rounded-lg bg-muted/30 p-3">
              <p className="text-[10px] uppercase text-muted-foreground">Unrealized</p>
              <p className={cn('mt-1 text-base font-mono font-bold', currentState.unrealizedPnl >= 0 ? 'text-profit' : 'text-loss')}>{currentState.unrealizedPnl >= 0 ? '+' : ''}{currentState.unrealizedPnl.toFixed(2)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {(runtime.hasCustomStrategy || runtime.lastRotationAt) ? (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Strategy runtime</div>
                <div className="mt-1 text-sm font-semibold">{runtime.fitLabel}</div>
                <div className="mt-1 text-xs text-muted-foreground">{runtime.rotationHeadline}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {runtime.goalMode ? <Badge variant="secondary" className="capitalize">{runtime.goalMode}</Badge> : null}
                {agent.activeStrategyMode ? <Badge variant="outline">{agent.activeStrategyMode}</Badge> : null}
                {agent.strategySource ? <Badge variant="outline">{getStrategySourceLabel(agent.strategySource)}</Badge> : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Rotated in</p>
                <p className="mt-1 text-base font-mono font-bold text-profit">{runtime.rotatedIn}</p>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Rotated out</p>
                <p className="mt-1 text-base font-mono font-bold text-loss">{runtime.rotatedOut}</p>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Active subscriptions</p>
                <p className="mt-1 text-base font-mono font-bold">{runtime.activeSubscriptions || (agent.indexSubscriptions || []).length}</p>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Last rotation</p>
                <p className="mt-1 text-xs font-medium">{runtime.lastRotationAt ? new Date(runtime.lastRotationAt).toLocaleString() : '—'}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Recent adds</p>
                <p className="mt-1 text-xs font-mono break-all">{formatRotationIds(runtime.rotatedInIds)}</p>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Recent removals</p>
                <p className="mt-1 text-xs font-mono break-all">{formatRotationIds(runtime.rotatedOutIds)}</p>
              </div>
            </div>

            {runtime.skippedReason ? (
              <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-xs text-muted-foreground">
                Rotation note: {runtime.skippedReason === 'churn_budget_reached' ? 'daily churn budget reached, so the runtime paused rotation to avoid over-switching.' : runtime.skippedReason}
              </div>
            ) : null}

            {(agent.recentRotationEvents || []).length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Why these indexes were chosen</div>
                {(agent.recentRotationEvents || []).map((event) => (
                  <div key={event.id} className="rounded-lg border border-border/60 p-3 space-y-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="text-sm font-medium">{getRotationReasonLabel(event.reasonCode)}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {event.rotatedInChannelId ? `Added ${event.rotatedInChannelId}` : 'No added index'}
                          {event.rotatedOutChannelId ? ` · Removed ${event.rotatedOutChannelId}` : ''}
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 text-xs">
                      <div className="rounded-md bg-muted/30 px-2 py-2">
                        <div className="text-muted-foreground">Before score</div>
                        <div className="mt-1 font-semibold">{formatRotationScore(event.beforeScore)}</div>
                      </div>
                      <div className="rounded-md bg-muted/30 px-2 py-2">
                        <div className="text-muted-foreground">After score</div>
                        <div className="mt-1 font-semibold">{formatRotationScore(event.afterScore)}</div>
                      </div>
                      <div className="rounded-md bg-muted/30 px-2 py-2">
                        <div className="text-muted-foreground">Score delta</div>
                        <div className="mt-1 font-semibold">{formatScoreDelta(event.details?.scoreDelta)}</div>
                      </div>
                      <div className="rounded-md bg-muted/30 px-2 py-2">
                        <div className="text-muted-foreground">Profile</div>
                        <div className="mt-1 font-semibold capitalize">{event.details?.profileName || event.details?.goalMode || 'balanced'}</div>
                      </div>
                    </div>

                    {Array.isArray(event.details?.topCandidates) && event.details.topCandidates.length > 0 ? (
                      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs space-y-2">
                        <div className="text-muted-foreground">Top candidates at decision time</div>
                        <div className="mt-1 font-mono">
                          {event.details.topCandidates.map((candidate) => `${candidate.symbol || candidate.indexId} (${formatRotationScore(candidate.score)})`).join(' · ')}
                        </div>
                        <div className="space-y-1">
                          {event.details.topCandidates.map((candidate) => {
                            const groupedFactors = summarizeFactorGroups(candidate.factors, { factorLimit: 1, groupLimit: 3 })
                            return (
                              <div key={candidate.indexId} className="rounded-md bg-background/70 px-2 py-2">
                                <div className="font-medium">{candidate.symbol || candidate.indexId}</div>
                                {groupedFactors.length > 0 ? (
                                  <div className="mt-1 flex flex-wrap gap-1.5">
                                    {groupedFactors.map((group) => (
                                      <span key={`${candidate.indexId}-${group.key}`} className={cn('rounded-full border px-2 py-0.5 text-[10px]', getFactorChipClasses(group.total))}>
                                        {group.label}: {formatFactorValue(group.total)}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : null}

                    {(Array.isArray(event.details?.rotatedInBreakdown) && event.details.rotatedInBreakdown.length > 0) || (Array.isArray(event.details?.rotatedOutBreakdown) && event.details.rotatedOutBreakdown.length > 0) ? (
                      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 text-xs">
                        {Array.isArray(event.details?.rotatedInBreakdown) && event.details.rotatedInBreakdown.length > 0 ? (() => {
                          const groupedFactors = summarizeFactorGroups(event.details.rotatedInBreakdown, { factorLimit: 2, groupLimit: 4 })
                          return (
                            <div className="rounded-md border border-profit/20 bg-profit/5 px-3 py-2">
                              <div className="text-muted-foreground">Why the added index scored well</div>
                              <div className="mt-2 space-y-2">
                                {groupedFactors.map((group) => (
                                  <div key={`in-${event.id}-${group.key}`} className={cn('rounded-md border px-2 py-2', getFactorCardClasses(group.total))}>
                                    <div className="flex items-center justify-between gap-3">
                                      <span className="font-medium">{group.label}</span>
                                      <span className={cn('font-mono font-semibold', getFactorValueClasses(group.total))}>{formatFactorValue(group.total)}</span>
                                    </div>
                                    {group.factors.length > 0 ? (
                                      <div className="mt-1 text-[11px] text-muted-foreground">
                                        {group.factors.map((factor) => `${factor.label} ${formatFactorValue(factor.value)}`).join(' · ')}
                                      </div>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })() : null}
                        {Array.isArray(event.details?.rotatedOutBreakdown) && event.details.rotatedOutBreakdown.length > 0 ? (() => {
                          const groupedFactors = summarizeFactorGroups(event.details.rotatedOutBreakdown, { factorLimit: 2, groupLimit: 4 })
                          return (
                            <div className="rounded-md border border-loss/20 bg-loss/5 px-3 py-2">
                              <div className="text-muted-foreground">Why the removed index lost priority</div>
                              <div className="mt-2 space-y-2">
                                {groupedFactors.map((group) => (
                                  <div key={`out-${event.id}-${group.key}`} className={cn('rounded-md border px-2 py-2', getFactorCardClasses(group.total))}>
                                    <div className="flex items-center justify-between gap-3">
                                      <span className="font-medium">{group.label}</span>
                                      <span className={cn('font-mono font-semibold', getFactorValueClasses(group.total))}>{formatFactorValue(group.total)}</span>
                                    </div>
                                    {group.factors.length > 0 ? (
                                      <div className="mt-1 text-[11px] text-muted-foreground">
                                        {group.factors.map((factor) => `${factor.label} ${formatFactorValue(factor.value)}`).join(' · ')}
                                      </div>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })() : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" className="text-xs gap-1">
            <BarChart3 className="h-3 w-3" /> Overview
          </TabsTrigger>
          <TabsTrigger value="wallet" className="text-xs gap-1">
            <Wallet className="h-3 w-3" /> {t('agent.tab.wallet')}
          </TabsTrigger>
          <TabsTrigger value="decisions" className="text-xs gap-1">
            <Brain className="h-3 w-3" /> {t('agent.tab.decisions')} ({decisionRecords.length})
          </TabsTrigger>
          <TabsTrigger value="trades" className="text-xs gap-1">
            <Activity className="h-3 w-3" /> {t('agent.tab.trades')} ({agent.totalTrades || 0})
          </TabsTrigger>
          <TabsTrigger value="performance" className="text-xs gap-1">
            <BarChart3 className="h-3 w-3" /> {t('agent.tab.performance')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
              <Card>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Equity trend</div>
                      <div className="mt-1 text-sm font-semibold">Live capital curve</div>
                    </div>
                    <Badge variant="outline">{isProfitable ? 'Positive drift' : 'Drawdown phase'}</Badge>
                  </div>
                  {equityChartData.length > 1 ? (
                    <EquitySparkline data={equityChartData} height={180} />
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
                      Equity history is still warming up. Once the agent trades for a few cycles, the curve will appear here.
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-muted-foreground">Balance</div>
                      <div className="mt-1 font-semibold">{(agent.balance || 0).toFixed(2)} TON</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-muted-foreground">Position value</div>
                      <div className="mt-1 font-semibold">{currentState.positionValue.toFixed(2)}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-muted-foreground">Exposure</div>
                      <div className="mt-1 font-semibold">{currentState.exposurePct.toFixed(1)}%</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Decision quality</div>
                    <div className="mt-1 text-sm font-semibold">How cleanly the strategy converts decisions into outcomes</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Quality score</div>
                      <div className="mt-1 text-2xl font-mono font-bold text-primary">{decisionQuality.score || '—'}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Avg confidence</div>
                      <div className="mt-1 text-2xl font-mono font-bold">{(decisionQuality.avgConfidence * 100).toFixed(0)}%</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Executed</div>
                      <div className="mt-1 text-base font-mono font-bold text-profit">{decisionQuality.executed}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Blocked</div>
                      <div className="mt-1 text-base font-mono font-bold text-yellow-500">{decisionQuality.blocked}</div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/50 p-3 text-xs text-muted-foreground">
                    {decisionQuality.totalDecisions > 0
                      ? `${decisionQuality.totalDecisions} total decisions · ${decisionQuality.passive} passive / hold outcomes.`
                      : 'No decision history yet.'}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardContent className="p-4 space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Strategy state</div>
                    <div className="mt-1 text-sm font-semibold">Execution ownership, rotation policy, and live subscription state</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Mode</div>
                      <div className="mt-1 font-semibold capitalize">{agent.activeStrategyMode || 'classic'}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Source</div>
                      <div className="mt-1 font-semibold">{agent.strategySource ? getStrategySourceLabel(agent.strategySource) : 'internal'}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Subscriptions</div>
                      <div className="mt-1 font-semibold">{currentState.activeSubscriptions} / {agent.config?.maxActiveSubscriptions || '—'}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Rotation goal</div>
                      <div className="mt-1 font-semibold capitalize">{runtime.goalMode || agent.config?.rotationGoalMode || 'manual'}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Rotation cadence</div>
                      <div className="mt-1 font-semibold">{agent.config?.intervalTicks ? `Every ${agent.config.intervalTicks} ticks` : 'Not scheduled'}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Last rotation</div>
                      <div className="mt-1 font-semibold text-xs">{runtime.lastRotationAt ? new Date(runtime.lastRotationAt).toLocaleString() : '—'}</div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/50 p-3 text-xs text-muted-foreground">
                    {runtime.skippedReason
                      ? `Rotation is currently constrained: ${runtime.skippedReason.replace(/_/g, ' ')}.`
                      : currentState.latestDecision.reasoning
                        ? `Latest strategy note: ${currentState.latestDecision.reasoning}`
                        : 'No strategy-side status note yet.'}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Risk health</div>
                    <div className="mt-1 text-sm font-semibold">Drawdown, pending exposure, and operational friction</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Max drawdown</div>
                      <div className="mt-1 font-semibold text-loss">{(agent.maxDrawdown || 0).toFixed(1)}%</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Open orders</div>
                      <div className="mt-1 font-semibold">{Number(agent.openOrders || 0)}</div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Realized P&L</div>
                      <div className={cn('mt-1 font-semibold', currentState.realizedPnl >= 0 ? 'text-profit' : 'text-loss')}>
                        {currentState.realizedPnl >= 0 ? '+' : ''}{currentState.realizedPnl.toFixed(2)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-3">
                      <div className="text-[10px] uppercase text-muted-foreground">Unrealized P&L</div>
                      <div className={cn('mt-1 font-semibold', currentState.unrealizedPnl >= 0 ? 'text-profit' : 'text-loss')}>
                        {currentState.unrealizedPnl >= 0 ? '+' : ''}{currentState.unrealizedPnl.toFixed(2)}
                      </div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/50 p-3 text-xs text-muted-foreground">
                    {agent.lastIdleReason
                      ? `Last idle reason: ${agent.lastIdleReason}${agent.lastIdleIndexSymbol ? ` · ${agent.lastIdleIndexSymbol}` : ''}`
                      : currentState.openPosition
                        ? 'Agent is carrying live exposure; monitor unrealized P&L and rotation churn before forcing changes.'
                        : 'Agent is flat, so current risk is primarily operational rather than market exposure.'}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardContent className="p-4 space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">P&L split</div>
                    <div className="mt-1 text-sm font-semibold">Separate closed performance from live exposure</div>
                  </div>
                  {(() => {
                    const realizedAbs = Math.abs(currentState.realizedPnl)
                    const unrealizedAbs = Math.abs(currentState.unrealizedPnl)
                    const maxAbs = Math.max(realizedAbs, unrealizedAbs, 0.001)
                    return (
                      <div className="space-y-3">
                        <div>
                          <div className="mb-1 flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">Realized</span>
                            <span className={cn('font-mono', currentState.realizedPnl >= 0 ? 'text-profit' : 'text-loss')}>
                              {currentState.realizedPnl >= 0 ? '+' : ''}{currentState.realizedPnl.toFixed(2)}
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-muted/70">
                            <div className={cn('h-full rounded-full', currentState.realizedPnl >= 0 ? 'bg-profit' : 'bg-loss')} style={{ width: `${(realizedAbs / maxAbs) * 100}%` }} />
                          </div>
                        </div>
                        <div>
                          <div className="mb-1 flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">Unrealized</span>
                            <span className={cn('font-mono', currentState.unrealizedPnl >= 0 ? 'text-profit' : 'text-loss')}>
                              {currentState.unrealizedPnl >= 0 ? '+' : ''}{currentState.unrealizedPnl.toFixed(2)}
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-muted/70">
                            <div className={cn('h-full rounded-full', currentState.unrealizedPnl >= 0 ? 'bg-profit' : 'bg-loss')} style={{ width: `${(unrealizedAbs / maxAbs) * 100}%` }} />
                          </div>
                        </div>
                        <div className="rounded-lg border border-border/60 bg-background/50 p-3 text-xs text-muted-foreground">
                          {currentState.openPosition
                            ? 'The agent has live market exposure, so unrealized P&L is part of the current risk picture.'
                            : 'The agent is flat, so realized P&L is the cleaner signal of recent quality.'}
                        </div>
                      </div>
                    )
                  })()}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Recent activity</div>
                    <div className="mt-1 text-sm font-semibold">Unified feed of decisions and executions</div>
                  </div>
                  {activityFeed.length > 0 ? (
                    <div className="space-y-2">
                      {activityFeed.map((item) => (
                        <ActivityFeedItem key={item.id} item={item} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
                      No recent activity yet. Decisions and trades will appear here in one timeline.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* Wallet tab */}
        <TabsContent value="wallet">
          <div className="space-y-4">
            {/* Address */}
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">{isEngineBackedAgent ? 'Connected wallet' : t('wizard.agentWallet')}</span>
                </div>
                <Badge variant="outline" className="text-[10px]">{isEngineBackedAgent ? 'Engine runtime' : 'TON Mainnet'}</Badge>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 font-mono text-xs text-muted-foreground break-all bg-background rounded-lg p-2.5 border border-border/50">
                  {agent.walletAddress}
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleCopy}>
                  {copied ? <Check className="h-3.5 w-3.5 text-profit" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>

              <div className="flex items-center justify-between">
                <a
                  href={`https://tonscan.org/address/${agent.walletAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-primary hover:underline flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" /> {t('wizard.viewOnExplorer')}
                </a>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono font-bold">{(agent.balance || 0).toFixed(4)} TON</span>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRefreshBalance}>
                    <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
                  </Button>
                </div>
              </div>
              {isEngineBackedAgent ? (
                <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                  This engine-backed agent is the strategy install target used by the marketplace. Its balance here reflects runtime capital, not a separate custodial wallet created by Full UI.
                </div>
              ) : null}
            </div>

            {/* Fund */}
            {!isEngineBackedAgent ? (
            <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
              <p className="text-sm font-medium flex items-center gap-2">
                <Send className="h-4 w-4 text-primary" /> {t('wizard.fundAgent')}
              </p>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={fundAmount}
                  onChange={(e) => setFundAmount(e.target.value)}
                  min="0.01"
                  step="0.5"
                  className="flex-1 h-9 rounded-lg border border-border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <Button size="sm" className="gap-1.5" onClick={handleFund} disabled={funding}>
                  {funding ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : !address ? (
                    <><Wallet className="h-3.5 w-3.5" /> {t('wallet.connect')}</>
                  ) : (
                    <><Zap className="h-3.5 w-3.5" /> {t('wizard.sendTon', { amount: fundAmount })}</>
                  )}
                </Button>
                {walletRedirectReady ? (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={handleOpenWalletManually}>
                    <Wallet className="h-3.5 w-3.5" /> Open wallet
                  </Button>
                ) : null}
                {walletRedirectLink ? (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => navigator.clipboard?.writeText(walletRedirectLink)}>
                    <Copy className="h-3.5 w-3.5" /> Copy wallet link
                  </Button>
                ) : null}
              </div>
              {walletRedirectReady ? (
                <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                  Request sent to wallet. If MyTonWallet did not open automatically, use <strong>Open wallet</strong>.
                </div>
              ) : null}
              <div className="flex gap-1.5">
                {['0.1', '0.5', '1', '2', '5'].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setFundAmount(amt)}
                    className={cn(
                      'flex-1 h-7 rounded border text-[10px] font-mono cursor-pointer transition-all',
                      fundAmount === amt ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/40'
                    )}
                  >
                    {amt}
                  </button>
                ))}
              </div>
            </div>
            ) : null}

            {/* Deposit history */}
            {(agent.deposits || []).length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">{t('agent.depositHistory')}</p>
                {agent.deposits.map((dep, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
                    <div className="flex items-center gap-2">
                      <Zap className="h-3 w-3 text-profit" />
                      <span className="text-xs font-mono">+{dep.amount.toFixed(2)} TON</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{new Date(dep.timestamp).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Decisions */}
        <TabsContent value="decisions">
          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
            {decisionRecords.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('agent.noDecisions')}</p>
            ) : (
              decisionRecords.map((record) => (
                <DecisionItem key={record.id} record={record} />
              ))
            )}
          </div>
        </TabsContent>

        {/* Trades */}
        <TabsContent value="trades">
          <div className="max-h-[400px] overflow-y-auto">
            {(agent.trades || []).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('agent.noTrades')}</p>
            ) : (
              (agent.trades || []).map((trade) => (
                <TradeItem key={trade.id} trade={trade} />
              ))
            )}
          </div>
        </TabsContent>

        {/* Performance */}
        <TabsContent value="performance">
          <div className="space-y-4">
            {performance?.metrics ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="text-center p-3 rounded-lg bg-muted/30">
                    <p className="text-2xl font-mono font-bold text-primary">{performance.score}</p>
                    <p className="text-[10px] text-muted-foreground">{t('agent.perfScore')}</p>
                  </div>
                  <div className="text-center p-3 rounded-lg bg-muted/30">
                    <p className="text-2xl font-mono font-bold">{(performance.metrics.winRate * 100).toFixed(0)}%</p>
                    <p className="text-[10px] text-muted-foreground">{t('agents.winRate')}</p>
                  </div>
                  <div className="text-center p-3 rounded-lg bg-muted/30">
                    <p className="text-2xl font-mono font-bold">{performance.metrics.executed}</p>
                    <p className="text-[10px] text-muted-foreground">{t('agent.executed')}</p>
                  </div>
                  <div className="text-center p-3 rounded-lg bg-muted/30">
                    <p className="text-2xl font-mono font-bold text-yellow-400">{performance.metrics.blocked}</p>
                    <p className="text-[10px] text-muted-foreground">{t('agent.blocked')}</p>
                  </div>
                </div>
                {performance.suggestions?.length > 0 && (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1.5">
                    <p className="text-xs font-medium flex items-center gap-1.5">
                      <Target className="h-3 w-3 text-primary" /> {t('agent.suggestions')}
                    </p>
                    {performance.suggestions.map((s, i) => (
                      <p key={i} className="text-xs text-muted-foreground">• {s}</p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t('agent.noPerformanceData')}</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
