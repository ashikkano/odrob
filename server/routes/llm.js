// ═══════════════════════════════════════════════════════════════════════
// LLM Agent Routes — Intelligence monitoring & management
// ═══════════════════════════════════════════════════════════════════════

import { Router } from 'express'
import { getLLMAgentState, resetLLMAgent, getMemoryStore, getProvider, buildContext, buildPrompts } from '../engine/llm/index.js'
import { adminAuth } from '../middleware/index.js'
import { ok, fail, notFound } from '../validation/index.js'

/**
 * @param {{ engine }} deps
 */
export default function llmRoutes({ engine }) {
  const router = Router()

  function getLlmRuntimeMeta(agent) {
    const sanitized = engine._sanitizeAgent(agent)
    const customState = typeof engine._getCustomStrategyState === 'function'
      ? engine._getCustomStrategyState(agent)
      : null
    return {
      sanitized,
      isLlmRuntime: agent?.strategy === 'llm_trader' || sanitized?.activeStrategyRuntime === 'llm_trader',
      memoryKey: customState?.llmSharedMemoryKey || customState?.llmSharedStateKey || agent?.config?.llmSharedMemoryKey || agent?.id,
    }
  }
  // Get all LLM agents and their states
  router.get('/agents', (req, res) => {
    const memStore = getMemoryStore()
    const result = Array.from(engine.agents?.values?.() || [])
      .map((agent) => {
        const meta = getLlmRuntimeMeta(agent)
        if (!meta.isLlmRuntime) return null
        const state = getLLMAgentState(meta.memoryKey) || getLLMAgentState(`${meta.memoryKey}::default`) || null
        const stats = memStore.getStats(meta.memoryKey)
        return {
          ...meta.sanitized,
          llmState: state,
          llmStats: stats,
          latencyMs: meta.sanitized.llmLatencyMs || null,
          provider: meta.sanitized.llmProvider || null,
          model: meta.sanitized.llmModel || null,
        }
      })
      .filter(Boolean)

    ok(res, result)
  })

  // Get detailed LLM state for a single agent
  router.get('/agents/:id', (req, res) => {
    const agent = engine.getAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')

    const meta = getLlmRuntimeMeta(agent)
    if (!meta.isLlmRuntime) return fail(res, 'Agent is not an LLM agent')

    const sanitized = meta.sanitized
    sanitized.decisions = (agent.decisions || []).slice(0, 50)
    sanitized.trades = (agent.trades || []).slice(0, 50)
    sanitized.equityCurve = (agent.equityCurve || []).slice(-100)

    const memStore = getMemoryStore()
    const state = getLLMAgentState(meta.memoryKey) || null
    const stats = memStore.getStats(meta.memoryKey)
    const recentDecisions = memStore.getRecentMemory(meta.memoryKey, 20)
    const insights = memStore.getInsights(meta.memoryKey, 10)
    const patterns = memStore.getPatterns(meta.memoryKey, 10)

    ok(res, {
      agent: sanitized,
      llmState: state,
      llmStats: stats,
      recentDecisions,
      insights,
      patterns,
    })
  })

  // LLM provider metrics
  router.get('/metrics', (req, res) => {
    try {
      const provider = getProvider()
      ok(res, {
        provider: provider.metrics,
        agents: (() => {
          const llmAgents = Array.from(engine.agents?.values?.() || []).filter((agent) => getLlmRuntimeMeta(agent).isLlmRuntime)
          return {
            total: llmAgents.length,
            active: llmAgents.filter(a => {
              const meta = getLlmRuntimeMeta(a)
              const s = getLLMAgentState(meta.memoryKey)
              return s && !s.fallbackActive
            }).length,
            fallback: llmAgents.filter(a => {
              const meta = getLlmRuntimeMeta(a)
              const s = getLLMAgentState(meta.memoryKey)
              return s && s.fallbackActive
            }).length,
          }
        })(),
      })
    } catch (err) {
      fail(res, err.message, 500)
    }
  })

  // Reset LLM agent error state (admin only)
  router.post('/agents/:id/reset', adminAuth, (req, res) => {
    const agent = engine.getAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')

    resetLLMAgent(agent.id)
    ok(res, { message: `LLM state reset for ${agent.name}` })
  })

  // Clear LLM memory (admin only)
  router.delete('/agents/:id/memory', adminAuth, (req, res) => {
    const agent = engine.getAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')

    const memStore = getMemoryStore()
    memStore.clearAll(agent.id)
    ok(res, { message: `Memory cleared for ${agent.name}` })
  })

  // Recent decisions for an agent
  router.get('/agents/:id/decisions', (req, res) => {
    const agent = engine.getAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')

    const limit = parseInt(req.query.limit) || 50
    const memStore = getMemoryStore()
    const meta = getLlmRuntimeMeta(agent)
    ok(res, memStore.getRecentMemory(meta.memoryKey, Math.min(limit, 200)))
  })

  // Insights for an agent
  router.get('/agents/:id/insights', (req, res) => {
    const agent = engine.getAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')

    const memStore = getMemoryStore()
    const meta = getLlmRuntimeMeta(agent)
    ok(res, memStore.getInsights(meta.memoryKey, 20))
  })

  // Debug: view exact prompts from real engine context
  router.get('/agents/:id/prompts', (req, res) => {
    const agent = engine.getAgent(req.params.id)
    if (!agent) return notFound(res, 'Agent')
    if (agent.strategy !== 'llm_trader') return fail(res, 'Not an LLM agent')

    const cached = {
      tick: agent._llmLastTick || null,
      systemPrompt: agent._llmLastSystemPrompt || null,
      userPrompt: agent._llmLastUserPrompt || null,
      contextSummary: agent._llmLastContextSummary || null,
    }

    const ctx = engine.getEngineContext()
    const memStore = getMemoryStore()
    const meta = getLlmRuntimeMeta(agent)
    const memory = memStore.getRecentMemory(meta.memoryKey, 10)
    const context = buildContext(agent, ctx)
    const { systemPrompt, userPrompt } = buildPrompts(agent, context, memory.length > 0 ? memory : null)

    ok(res, {
      agent: { id: agent.id, name: agent.name, strategy: agent.strategy },
      live: {
        systemPrompt,
        userPrompt,
        systemPromptLength: systemPrompt.length,
        userPromptLength: userPrompt.length,
        contextSummary: context.summary,
        contextKeys: Object.keys(context),
        indexCount: context.indexes?.length || 0,
        indexContextCount: Object.keys(context.indexes || {}).length,
        technicals: context.technicals || {},
      },
      lastCall: cached,
    })
  })

  return router
}
