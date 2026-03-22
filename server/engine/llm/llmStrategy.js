// ═══════════════════════════════════════════════════════════════════════
// LLM Strategy — Entry point for AI-driven trading decisions
//
// This module wires the full pipeline:
//   contextAssembler → prePrompter → llmProvider → responseParser → Signal[]
//
// Registered in STRATEGIES as 'llm_trader'.
// ═══════════════════════════════════════════════════════════════════════

import { LLM_CONFIG } from './config.js'
import { buildContext } from './contextAssembler.js'
import { buildPrompts } from './prePrompter.js'
import { parse } from './responseParser.js'
import { getProvider } from './llmProvider.js'
import { getMemoryStore } from './memoryStore.js'
import { evaluateOutcomes, runReflection } from './learningModule.js'

// Per-agent error counters  Map<agentId, { consecutiveErrors, currentInterval }>
const _agentState = new Map()

function resolveRuntimeScope(agent) {
  const config = agent?.config || {}
  const sharedExecution = Boolean(config.llmSharedExecution && (config.llmSharedMemoryKey || config.llmSharedStateKey))
  const memoryKey = sharedExecution ? (config.llmSharedMemoryKey || config.llmSharedStateKey) : agent.id
  const stateKey = sharedExecution ? (config.llmSharedStateKey || config.llmSharedMemoryKey || memoryKey) : agent.id
  const providerAgentId = sharedExecution ? (config.llmSharedCreatorAgentId || agent._llmExecutionOwnerAgentId || agent.id) : agent.id

  return {
    sharedExecution,
    executionMode: config.llmSharedExecutionMode || null,
    scopeId: config.llmSharedScopeId || null,
    scopeKey: config.llmSharedScopeKey || memoryKey,
    memoryKey,
    stateKey,
    providerAgentId,
    creatorAgentId: config.llmSharedCreatorAgentId || agent._llmExecutionOwnerAgentId || null,
    creatorAgentName: config.llmSharedCreatorAgentName || agent._llmExecutionOwnerAgentName || null,
    templateId: config.llmSharedTemplateId || null,
    templateName: config.llmSharedTemplateName || null,
  }
}

function annotateAgentFromLlmPayload(agent, payload, runtime, signals, metadata, tick) {
  agent._llmLastThinking = metadata.thinking
  agent._llmLastReasoning = signals[0]?.reasoning
  agent._llmLastConfidence = signals[0]?.confidence
  agent._llmLastAction = signals[0]?.action
  agent._llmLatencyMs = payload.latencyMs
  agent._llmProvider = payload.provider
  agent._llmModel = payload.model
  agent._llmLastSystemPrompt = payload.systemPrompt
  agent._llmLastUserPrompt = payload.userPrompt
  agent._llmLastContextSummary = payload.contextSummary
  agent._llmLastTick = tick

  if (runtime.sharedExecution) {
    agent._llmSharedExecution = true
    agent._llmSharedExecutionMode = runtime.executionMode || 'strategy_scope'
    agent._llmSharedTemplateId = runtime.templateId || null
    agent._llmSharedScopeId = runtime.scopeId || null
    agent._llmSharedScopeKey = runtime.scopeKey || runtime.memoryKey || null
    agent._llmExecutionOwnerAgentId = runtime.creatorAgentId
    agent._llmExecutionOwnerAgentName = runtime.creatorAgentName
  }

  if (metadata.thinking && signals[0]) {
    signals[0].thinking = metadata.thinking
  }
}

function materializeSignalsFromPayload(agent, ctx, payload, runtime, tick) {
  const { signals, metadata } = parse(payload.rawResponse, agent, ctx)
  annotateAgentFromLlmPayload(agent, payload, runtime, signals, metadata, tick)
  return { signals, metadata }
}

function getAgentLLMState(agentId) {
  let s = _agentState.get(agentId)
  if (!s) {
    s = {
      consecutiveErrors: 0,
      currentInterval: LLM_CONFIG.tickInterval,
      lastCallTick: -Infinity,
      totalCalls: 0,
      fallbackActive: false,
    }
    _agentState.set(agentId, s)
  }
  return s
}

/**
 * LLM Strategy function — same signature as all strategies.
 *
 * @param {object} agent - Engine agent state
 * @param {object} ctx   - Engine market context
 * @returns {Signal[]}   - Array of { action, price, size, reasoning, confidence }
 */
export async function llmTrader(agent, ctx) {
  const runtime = resolveRuntimeScope(agent)

  // Use per-agent-per-index state to allow trading multiple indexes
  const indexId = ctx.indexId || 'default'
  const stateKey = `${runtime.stateKey}::${indexId}`
  const state = getAgentLLMState(stateKey)
  const tick = ctx.tickCount || 0

  if (runtime.sharedExecution && state.inflight?.tick === tick && state.inflight?.promise) {
    const payload = await state.inflight.promise
    const { signals } = materializeSignalsFromPayload(agent, ctx, payload, runtime, tick)
    return signals
  }

  // ── Tick interval gate ─────────────────────────────────────────
  if (tick - state.lastCallTick < state.currentInterval) {
    return [{ action: 'hold', price: 0, size: 0, reasoning: `LLM cooldown (next call in ${state.currentInterval - (tick - state.lastCallTick)} ticks)`, confidence: 0 }]
  }

  // ── Fallback mode ──────────────────────────────────────────────
  if (state.fallbackActive) {
    return [{ action: 'hold', price: 0, size: 0, reasoning: 'LLM fallback active — too many errors, holding', confidence: 0 }]
  }

  state.lastCallTick = tick
  state.totalCalls++

  const requestPayload = async () => {
    const context = buildContext(agent, ctx)
    const memory = loadMemory(runtime.memoryKey)
    const { systemPrompt, userPrompt } = buildPrompts(agent, context, memory)
    const provider = getProvider()
    const response = await provider.chat({
      systemPrompt,
      userPrompt,
      agentId: runtime.providerAgentId,
      temperature: agent.config?.llmTemperature ?? LLM_CONFIG.temperature,
      model:       agent.config?.llmModel       ?? LLM_CONFIG.defaultModel,
      provider:    agent.config?.llmProvider     ?? LLM_CONFIG.defaultProvider,
      apiKey:      agent.config?.llmApiKey       || undefined,
    })

    return {
      rawResponse: response.text,
      latencyMs: response.latencyMs,
      provider: response.provider,
      model: response.model,
      systemPrompt,
      userPrompt,
      contextSummary: context.summary,
    }
  }

  try {
    let payload

    if (runtime.sharedExecution) {
      const promise = requestPayload()
      state.inflight = { tick, promise }
      try {
        payload = await promise
      } finally {
        if (state.inflight?.tick === tick) delete state.inflight
      }
    } else {
      payload = await requestPayload()
    }

    const { signals, metadata } = materializeSignalsFromPayload(agent, ctx, payload, runtime, tick)

    saveDecision(runtime.memoryKey, {
      tick,
      timestamp: Date.now(),
      contextSummary: payload.contextSummary,
      rawResponse: payload.rawResponse,
      action: signals[0]?.action || 'hold',
      orderType: signals[0]?.orderType || 'limit',
      instrument: ctx.indexSymbol || ctx.indexId || 'INDEX',
      price: signals[0]?.price || 0,
      size: signals[0]?.size || 0,
      confidence: signals[0]?.confidence || 0,
      reasoning: signals[0]?.reasoning || '',
      thinking: metadata.thinking || '',
    })

    state.consecutiveErrors = 0
    state.currentInterval = LLM_CONFIG.tickInterval

    console.log(`[LLM] ${agent.name} tick=${tick} → ${signals[0]?.action} conf=${signals[0]?.confidence} (${payload.latencyMs}ms ${payload.provider}/${payload.model})`)

    try {
      const evalResult = evaluateOutcomes(runtime.memoryKey, agent, ctx)
      if (evalResult.evaluated > 0) {
        console.log(`[LLM] ${agent.name} evaluated ${evalResult.evaluated} outcomes: ${evalResult.wins}W/${evalResult.losses}L`)
      }
    } catch (err) {
      console.warn(`[LLM] ${agent.name} outcome eval error: ${err.message}`)
    }

    const store = getMemoryStore()
    if (store.shouldReflect(runtime.memoryKey)) {
      const reflectionAgent = runtime.sharedExecution
        ? { ...agent, id: runtime.memoryKey, name: runtime.templateName || agent.name }
        : agent
      runReflection(runtime.memoryKey, reflectionAgent).then(result => {
        if (result.success) {
          console.log(`[LLM] ${agent.name} reflection insight: "${result.insight}"`)
        }
      }).catch(err => {
        console.warn(`[LLM] ${agent.name} reflection error: ${err.message}`)
      })
    }

    return signals
  } catch (err) {
    state.consecutiveErrors++
    console.error(`[LLM] ${agent.name} ERROR #${state.consecutiveErrors}: ${err.message}`)

    if (state.consecutiveErrors >= 3) {
      state.currentInterval = Math.min(
        state.currentInterval * LLM_CONFIG.errorBackoffMultiplier,
        LLM_CONFIG.tickInterval * 10
      )
      console.warn(`[LLM] ${agent.name} backoff → interval=${state.currentInterval}`)
    }

    if (state.consecutiveErrors >= LLM_CONFIG.maxConsecutiveErrors) {
      state.fallbackActive = true
      console.error(`[LLM] ${agent.name} FALLBACK ACTIVATED after ${state.consecutiveErrors} errors`)
    }

    return [{ action: 'hold', price: 0, size: 0, reasoning: `LLM error: ${err.message.substring(0, 80)}`, confidence: 0 }]
  }
}

// ─── Memory operations ─────────────────────────────────────────────

function loadMemory(agentId) {
  try {
    return getMemoryStore().getMemoryForPrompt(agentId)
  } catch (err) {
    console.warn(`[LLM] ${agentId} loadMemory error: ${err.message}`)
    return null
  }
}

function saveDecision(agentId, decision) {
  try {
    getMemoryStore().saveDecision(agentId, decision)
  } catch (err) {
    console.warn(`[LLM] ${agentId} saveDecision error: ${err.message}`)
  }
}

// ─── Exports ───────────────────────────────────────────────────────

/** Get LLM state for an agent (for API/UI) */
export function getLLMAgentState(agentId) {
  if (_agentState.has(agentId)) return _agentState.get(agentId) || null

  const matches = Array.from(_agentState.entries())
    .filter(([key]) => key === agentId || key.startsWith(`${agentId}::`))
    .map(([, value]) => value)

  if (matches.length === 0) return null

  return matches.reduce((latest, current) => {
    if (!latest) return current
    return (current?.lastCallTick || -Infinity) > (latest?.lastCallTick || -Infinity) ? current : latest
  }, null)
}

/** Reset error state (for admin API) */
export function resetLLMAgent(agentId) {
  for (const key of Array.from(_agentState.keys())) {
    if (key === agentId || key.startsWith(`${agentId}::`)) {
      _agentState.delete(key)
    }
  }
}

/** Default config for llm_trader agents */
export const LLM_DEFAULT_CONFIG = {
  llmProvider:     LLM_CONFIG.defaultProvider,
  llmModel:        LLM_CONFIG.defaultModel,
  llmTemperature:  LLM_CONFIG.temperature,
  llmTickInterval: LLM_CONFIG.tickInterval,
  orderSizePct:    LLM_CONFIG.defaultOrderSizePct,
}

export default llmTrader
