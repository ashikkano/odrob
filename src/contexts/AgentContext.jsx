// ═══════════════════════════════════════════════════════════════════════
// ODROB Agent Context — Server-backed, wallet-gated
//
// - Watches TonConnect wallet state
// - On connect: POST /api/auth → GET /api/agents → populate state
// - On disconnect: clear state (agents hidden)
// - All mutations go to server first, then update local state
// - Decision engine / simulation remain client-side (ephemeral)
// ═══════════════════════════════════════════════════════════════════════

import {
  createContext, useContext, useReducer, useCallback,
  useRef, useEffect, useState,
} from 'react'
import { lazy, Suspense } from 'react'
import { useTonAddress, useIsConnectionRestored } from '@tonconnect/ui-react'
import { AGENT_STATUS, AGENT_PRESETS } from '../agents/agentTypes'
import { makeDecision, buildMarketContext, analyzePerformance } from '../agents/decisionEngine'
import * as api from '../services/agentApi'
import { setWalletAddress as setEngineWalletAddress } from '../services/engineApi'
import {
  createEngineAgent,
  deleteEngineAgent,
  fetchAgentByWallet,
  fetchEngineAgent,
  pauseEngineAgent,
  startEngineAgent,
  stopEngineAgent,
  updateEngineAgent,
} from '../services/engineApi'
import { setIndexWalletAddress } from '../services/indexApi'
import { setStrategyMarketplaceWalletAddress } from '../services/strategyMarketplaceApi'
import { fetchOnboardingBootstrap } from '../services/onboardingApi'
import { notifyAuthSessionRefresh } from './AuthContext'

const AgentContext = createContext(null)

// ─── Enrich server agent with client-side defaults ───────────────────

function enrichAgent(serverAgent) {
  return {
    // Client-side defaults (not stored on server)
    pnl: 0,
    pnlPercent: 0,
    winRate: 0,
    totalTrades: 0,
    openPositions: 0,
    drawdown: 0,
    maxDrawdown: 0,
    trades: [],
    decisionHistory: [],
    equityHistory: [],
    lastTradeTime: null,
    // Server data overwrites defaults
    ...serverAgent,
  }
}

function normalizeLegacyAgent(agent) {
  return {
    ...agent,
    backendSource: 'legacy',
    isUserAgent: true,
    supportsMarketplaceStrategies: false,
  }
}

function normalizeEngineWalletAgent(agent) {
  if (!agent) return null
  return {
    ...agent,
    backendSource: 'engine',
    isUserAgent: true,
    supportsMarketplaceStrategies: true,
    balance: Number.isFinite(Number(agent.virtualBalance)) ? Number(agent.virtualBalance) : Number(agent.balance || 0),
    initialBalance: Number.isFinite(Number(agent.initialBalance)) ? Number(agent.initialBalance) : Number(agent.virtualBalance || 0),
    deposits: agent.deposits || [],
  }
}

async function loadWalletAgents(walletAddress) {
  const [legacyResult, engineResult] = await Promise.allSettled([
    api.fetchAgents(walletAddress),
    fetchAgentByWallet(walletAddress),
  ])

  const legacyAgents = legacyResult.status === 'fulfilled'
    ? (legacyResult.value || []).map(normalizeLegacyAgent)
    : []
  const engineAgent = engineResult.status === 'fulfilled'
    ? normalizeEngineWalletAgent(engineResult.value?.agent || null)
    : null

  const merged = [...legacyAgents]
  if (engineAgent && !merged.some((agent) => agent.id === engineAgent.id)) {
    merged.unshift(engineAgent)
  }

  return merged
}

// ─── Reducer ─────────────────────────────────────────────────────────

const ACTIONS = {
  SET_AGENTS:      'SET_AGENTS',
  CLEAR:           'CLEAR',
  ADD_AGENT:       'ADD_AGENT',
  UPDATE_AGENT:    'UPDATE_AGENT',
  REMOVE_AGENT:    'REMOVE_AGENT',
  SELECT_AGENT:    'SELECT_AGENT',
  SET_SIMULATION:  'SET_SIMULATION',
  RECORD_DECISION: 'RECORD_DECISION',
  EXECUTE_TRADE:   'EXECUTE_TRADE',
}

const initialState = {
  agents: {},
  agentOrder: [],
  selectedId: null,
  simulationRunning: false,
}

function agentReducer(state, action) {
  switch (action.type) {
    case ACTIONS.SET_AGENTS: {
      const agents = {}
      const agentOrder = []
      for (const a of action.payload) {
        agents[a.id] = enrichAgent(a)
        agentOrder.push(a.id)
      }
      return { ...state, agents, agentOrder }
    }

    case ACTIONS.CLEAR:
      return { ...initialState }

    case ACTIONS.ADD_AGENT: {
      const agent = enrichAgent(action.payload)
      return {
        ...state,
        agents: { ...state.agents, [agent.id]: agent },
        agentOrder: [...state.agentOrder, agent.id],
        selectedId: agent.id,
      }
    }

    case ACTIONS.UPDATE_AGENT: {
      const { id, data } = action.payload
      const existing = state.agents[id]
      if (!existing) return state
      // Merge: server fields update, client-side simulation fields preserved
      return {
        ...state,
        agents: { ...state.agents, [id]: { ...existing, ...data } },
      }
    }

    case ACTIONS.REMOVE_AGENT: {
      const id = action.payload
      const { [id]: _, ...rest } = state.agents
      return {
        ...state,
        agents: rest,
        agentOrder: state.agentOrder.filter(aid => aid !== id),
        selectedId: state.selectedId === id ? null : state.selectedId,
      }
    }

    case ACTIONS.SELECT_AGENT:
      return { ...state, selectedId: action.payload }

    case ACTIONS.SET_SIMULATION:
      return { ...state, simulationRunning: action.payload }

    // ── Client-side only: simulation results ──

    case ACTIONS.RECORD_DECISION: {
      const { id, record } = action.payload
      const a = state.agents[id]
      if (!a) return state
      const history = [record, ...(a.decisionHistory || [])].slice(0, 200)
      return {
        ...state,
        agents: { ...state.agents, [id]: { ...a, decisionHistory: history } },
      }
    }

    case ACTIONS.EXECUTE_TRADE: {
      const { id, trade } = action.payload
      const a = state.agents[id]
      if (!a) return state

      const trades = [trade, ...(a.trades || [])].slice(0, 500)
      const pnlDelta = trade.pnl || 0
      const newPnl = (a.pnl || 0) + pnlDelta
      const newBalance = (a.balance || 0) + pnlDelta
      const newEquityHistory = [...(a.equityHistory || []), newBalance]
      const peak = Math.max(...newEquityHistory, a.initialBalance || newBalance)
      const drawdown = peak > 0 ? ((peak - newBalance) / peak) * 100 : 0
      const wins = trades.filter(t => (t.pnl || 0) > 0).length

      return {
        ...state,
        agents: {
          ...state.agents,
          [id]: {
            ...a,
            trades,
            pnl: newPnl,
            pnlPercent: a.initialBalance ? (newPnl / a.initialBalance) * 100 : 0,
            balance: newBalance,
            equityHistory: newEquityHistory.slice(-100),
            drawdown,
            maxDrawdown: Math.max(a.maxDrawdown || 0, drawdown),
            winRate: trades.length > 0 ? wins / trades.length : 0,
            totalTrades: trades.length,
            openPositions: Math.max(0, (a.openPositions || 0) + (trade.opensPosition ? 1 : -1)),
            lastTradeTime: Date.now(),
          },
        },
      }
    }

    default:
      return state
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════

export function AgentProvider({ children }) {
  const walletAddress = useTonAddress(false) // false = raw format (0:hex) for cross-device consistency
  const connectionRestored = useIsConnectionRestored()

  const [state, dispatch] = useReducer(agentReducer, initialState)
  const [isLoading, setIsLoading] = useState(true) // true until we know connection state
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [sessionWalletAddress, setSessionWalletAddress] = useState(null)
  const simulationRef = useRef(null)
  const prevAddressRef = useRef(null)
  const effectiveWalletAddress = walletAddress || sessionWalletAddress || null

  const refreshSessionPrincipal = useCallback(async (candidateAddress) => {
    try {
      const data = await fetchOnboardingBootstrap(candidateAddress || undefined)
      setSessionWalletAddress(data?.session?.address || null)
      return data
    } catch {
      setSessionWalletAddress(null)
      return null
    }
  }, [])

  // ── Clean up old localStorage data from previous version ──
  useEffect(() => {
    try { localStorage.removeItem('odrob_agents') } catch {}
  }, [])

  // ── Sync wallet into all API clients like Lite does ─────────────────
  useEffect(() => {
    const nextWallet = effectiveWalletAddress || null
    setEngineWalletAddress(nextWallet)
    setIndexWalletAddress(nextWallet)
    setStrategyMarketplaceWalletAddress(nextWallet)
  }, [effectiveWalletAddress])

  useEffect(() => {
    if (!connectionRestored) return
    refreshSessionPrincipal(walletAddress)
  }, [connectionRestored, walletAddress, refreshSessionPrincipal])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const handleSessionChanged = () => {
      refreshSessionPrincipal(walletAddress)
    }
    window.addEventListener('odrob:onboarding-session-changed', handleSessionChanged)
    return () => window.removeEventListener('odrob:onboarding-session-changed', handleSessionChanged)
  }, [refreshSessionPrincipal, walletAddress])

  // ── Watch wallet connect / disconnect ──────────────────────────────

  useEffect(() => {
    // Wait for TonConnect to finish restoring
    if (!connectionRestored) return

    if (walletAddress && walletAddress !== prevAddressRef.current) {
      // Wallet connected (or changed) → login + fetch agents
      prevAddressRef.current = walletAddress
      setIsLoading(true)

      api.login(walletAddress)
        .then(async () => {
          notifyAuthSessionRefresh()
          await refreshSessionPrincipal(walletAddress)
          return loadWalletAgents(walletAddress)
        })
        .then((agents) => {
          dispatch({ type: ACTIONS.SET_AGENTS, payload: agents })
          setIsAuthenticated(true)
        })
        .catch((err) => {
          console.error('Auth/fetch failed:', err)
          setIsAuthenticated(false)
        })
        .finally(() => setIsLoading(false))

    } else if (!walletAddress && sessionWalletAddress && sessionWalletAddress !== prevAddressRef.current) {
      prevAddressRef.current = sessionWalletAddress
      setIsLoading(true)

      loadWalletAgents(sessionWalletAddress)
        .then((agents) => {
          dispatch({ type: ACTIONS.SET_AGENTS, payload: agents })
          setIsAuthenticated(true)
        })
        .catch((err) => {
          console.error('Session fetch failed:', err)
          setIsAuthenticated(false)
        })
        .finally(() => setIsLoading(false))

    } else if (!walletAddress && !sessionWalletAddress && prevAddressRef.current) {
      // Wallet disconnected → clear everything
      const prevAddress = prevAddressRef.current
      prevAddressRef.current = null
      dispatch({ type: ACTIONS.CLEAR })
      setIsAuthenticated(false)
      setIsLoading(false)

      api.logout(prevAddress)
        .catch(() => {})
        .finally(() => {
          notifyAuthSessionRefresh()
        })

      if (simulationRef.current) {
        clearInterval(simulationRef.current)
        simulationRef.current = null
      }

    } else if (!effectiveWalletAddress) {
      // Connection restored but no wallet ever connected
      setIsLoading(false)
    }
  }, [connectionRestored, walletAddress, sessionWalletAddress, effectiveWalletAddress])

  const reloadAgents = useCallback(async () => {
    if (!effectiveWalletAddress) {
      dispatch({ type: ACTIONS.CLEAR })
      setIsAuthenticated(false)
      return []
    }

    const agents = await loadWalletAgents(effectiveWalletAddress)
    dispatch({ type: ACTIONS.SET_AGENTS, payload: agents })
    setIsAuthenticated(true)
    return agents
  }, [effectiveWalletAddress])

  // ── Create agent (server creates wallet) ───────────────────────────

  const createAgent = useCallback(async (params) => {
    if (!effectiveWalletAddress) throw new Error('Wallet not connected or session not established')

    const preset = AGENT_PRESETS[params.preset]
    const payload = {
      name: params.name || 'Agent',
      preset: params.preset,
      strategy: preset?.strategy || 'mean_reversion',
      index: params.index || 'FLOOR',
      icon: preset?.icon || '🤖',
      config: { ...preset?.config, ...params.config },
      riskParams: { ...preset?.risk, ...params.riskParams },
    }

    if (!isAuthenticated && walletAddress) {
      await api.login(walletAddress)
      setIsAuthenticated(true)
    }

    let agent
    try {
      agent = await api.createAgent(effectiveWalletAddress, payload)
    } catch (err) {
      if (err?.status !== 401 || !walletAddress) throw err
      await api.login(walletAddress)
      setIsAuthenticated(true)
      agent = await api.createAgent(effectiveWalletAddress, payload)
    }

    try {
      const existingEngineAgent = await fetchAgentByWallet(effectiveWalletAddress)
      if (!existingEngineAgent?.agent) {
        await createEngineAgent({
          name: payload.name,
          strategy: payload.strategy,
          icon: payload.icon,
          isUserAgent: true,
          walletAddress: effectiveWalletAddress,
          riskLevel: payload.riskParams?.riskLevel || 'medium',
          config: payload.config || {},
          bio: `${payload.name} engine companion for marketplace strategy installs.`,
        })
      }
    } catch (err) {
      console.error('Engine companion sync failed:', err)
    }

    const agents = await loadWalletAgents(effectiveWalletAddress)
    dispatch({ type: ACTIONS.SET_AGENTS, payload: agents })
    return agent
  }, [effectiveWalletAddress, walletAddress, isAuthenticated])

  // ── Update agent ───────────────────────────────────────────────────

  const updateAgent = useCallback(async (id, updates) => {
    if (!effectiveWalletAddress) return
    const target = state.agents[id]
    if (!target) return
    try {
      const data = target.backendSource === 'engine'
        ? await updateEngineAgent(id, updates)
        : await api.updateAgent(effectiveWalletAddress, id, updates)
      dispatch({ type: ACTIONS.UPDATE_AGENT, payload: { id, data } })
    } catch (err) {
      console.error('Update agent failed:', err)
    }
  }, [effectiveWalletAddress, state.agents])

  // ── Remove agent ───────────────────────────────────────────────────

  const removeAgent = useCallback(async (id) => {
    if (!effectiveWalletAddress) return
    const target = state.agents[id]
    if (!target) return
    try {
      if (target.backendSource === 'engine') await deleteEngineAgent(id)
      else await api.deleteAgent(effectiveWalletAddress, id)
      dispatch({ type: ACTIONS.REMOVE_AGENT, payload: id })
    } catch (err) {
      console.error('Delete agent failed:', err)
    }
  }, [effectiveWalletAddress, state.agents])

  // ── Start / Pause / Stop ───────────────────────────────────────────

  const startAgent = useCallback(async (id) => {
    if (!effectiveWalletAddress) return
    const target = state.agents[id]
    if (!target) return
    try {
      const data = target.backendSource === 'engine'
        ? await startEngineAgent(id)
        : await api.startAgent(effectiveWalletAddress, id)
      dispatch({ type: ACTIONS.UPDATE_AGENT, payload: { id, data } })
    } catch (err) { console.error('Start agent failed:', err) }
  }, [effectiveWalletAddress, state.agents])

  const pauseAgent = useCallback(async (id) => {
    if (!effectiveWalletAddress) return
    const target = state.agents[id]
    if (!target) return
    try {
      const data = target.backendSource === 'engine'
        ? await pauseEngineAgent(id)
        : await api.pauseAgent(effectiveWalletAddress, id)
      dispatch({ type: ACTIONS.UPDATE_AGENT, payload: { id, data } })
    } catch (err) { console.error('Pause agent failed:', err) }
  }, [effectiveWalletAddress, state.agents])

  const stopAgent = useCallback(async (id) => {
    if (!effectiveWalletAddress) return
    const target = state.agents[id]
    if (!target) return
    try {
      const data = target.backendSource === 'engine'
        ? await stopEngineAgent(id)
        : await api.stopAgent(effectiveWalletAddress, id)
      dispatch({ type: ACTIONS.UPDATE_AGENT, payload: { id, data } })
    } catch (err) { console.error('Stop agent failed:', err) }
  }, [effectiveWalletAddress, state.agents])

  // ── Balance ────────────────────────────────────────────────────────

  const refreshBalance = useCallback(async (agentId) => {
    if (!effectiveWalletAddress) return null
    const target = state.agents[agentId]
    if (!target) return null
    try {
      if (target.backendSource === 'engine') {
        const agent = await fetchEngineAgent(agentId)
        dispatch({ type: ACTIONS.UPDATE_AGENT, payload: { id: agentId, data: normalizeEngineWalletAgent(agent) } })
        return agent?.virtualBalance ?? agent?.equity ?? null
      }

      const { balance, agent } = await api.refreshBalance(effectiveWalletAddress, agentId)
      dispatch({ type: ACTIONS.UPDATE_AGENT, payload: { id: agentId, data: normalizeLegacyAgent(agent) } })
      return balance
    } catch (err) {
      console.error('Balance refresh failed:', err)
      return null
    }
  }, [effectiveWalletAddress, state.agents])

  // ── Record deposit ─────────────────────────────────────────────────

  const recordDeposit = useCallback(async (agentId, amount, txHash) => {
    if (!effectiveWalletAddress) return
    const target = state.agents[agentId]
    if (!target) return
    try {
      if (target.backendSource === 'engine') {
        await reloadAgents()
        return
      }
      const agent = await api.recordDeposit(effectiveWalletAddress, agentId, amount, txHash)
      dispatch({ type: ACTIONS.UPDATE_AGENT, payload: { id: agentId, data: normalizeLegacyAgent(agent) } })
    } catch (err) {
      console.error('Record deposit failed:', err)
    }
  }, [effectiveWalletAddress, state.agents, reloadAgents])

  // ── Select ─────────────────────────────────────────────────────────

  const selectAgent = useCallback((id) => {
    dispatch({ type: ACTIONS.SELECT_AGENT, payload: id })
  }, [])

  // ── Decision cycle (client-side simulation) ────────────────────────

  const runDecisionCycle = useCallback((agentId) => {
    const agent = state.agents[agentId]
    if (!agent || agent.status !== AGENT_STATUS.ACTIVE) return null

    const context = buildMarketContext(agent.index)
    const result = makeDecision(agent, context)

    dispatch({ type: ACTIONS.RECORD_DECISION, payload: { id: agentId, record: result } })

    if (result.executed) {
      const dec = result.decision
      const pnl = (Math.random() - 0.45) * (dec.size || 1) * 0.1
      const trade = {
        id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        side: dec.type === 'buy' ? 'buy' : 'sell',
        price: dec.price || context.marketPrice,
        size: dec.size || 0,
        pnl,
        reasoning: dec.reasoning,
        confidence: dec.confidence,
        timestamp: Date.now(),
        opensPosition: Math.random() > 0.5,
      }
      dispatch({ type: ACTIONS.EXECUTE_TRADE, payload: { id: agentId, trade } })
      return { ...result, trade }
    }

    return result
  }, [state.agents])

  // ── Simulation loop ────────────────────────────────────────────────

  const startSimulation = useCallback(() => {
    dispatch({ type: ACTIONS.SET_SIMULATION, payload: true })
  }, [])

  const stopSimulation = useCallback(() => {
    dispatch({ type: ACTIONS.SET_SIMULATION, payload: false })
    if (simulationRef.current) {
      clearInterval(simulationRef.current)
      simulationRef.current = null
    }
  }, [])

  useEffect(() => {
    if (state.simulationRunning) {
      simulationRef.current = setInterval(() => {
        const activeAgents = Object.values(state.agents).filter(a => a.status === AGENT_STATUS.ACTIVE)
        for (const agent of activeAgents) {
          runDecisionCycle(agent.id)
        }
      }, 5000)
    } else if (simulationRef.current) {
      clearInterval(simulationRef.current)
      simulationRef.current = null
    }
    return () => { if (simulationRef.current) clearInterval(simulationRef.current) }
  }, [state.simulationRunning, state.agents, runDecisionCycle])

  // ── Performance ────────────────────────────────────────────────────

  const getPerformance = useCallback((agentId) => {
    const agent = state.agents[agentId]
    if (!agent) return null
    return analyzePerformance(agent)
  }, [state.agents])

  // ── Context value ──────────────────────────────────────────────────

  const value = {
    // State
    agents: state.agents,
    agentOrder: state.agentOrder,
    agentList: state.agentOrder.map(id => state.agents[id]).filter(Boolean),
    selectedAgent: state.selectedId ? state.agents[state.selectedId] : null,
    selectedId: state.selectedId,
    simulationRunning: state.simulationRunning,

    // Auth state
    isLoading,
    isAuthenticated,
    walletAddress: effectiveWalletAddress,
    externalWalletAddress: walletAddress,
    sessionWalletAddress,

    // Actions (all async, go to server)
    createAgent,
    updateAgent,
    removeAgent,
    startAgent,
    pauseAgent,
    stopAgent,
    selectAgent,
    refreshBalance,
    recordDeposit,
    reloadAgents,

    // Client-side only
    runDecisionCycle,
    startSimulation,
    stopSimulation,
    getPerformance,
  }

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgents() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgents must be used within AgentProvider')
  return ctx
}

export default AgentContext
