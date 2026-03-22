// ═══════════════════════════════════════════════════════════════════════
// Learning Module — Outcome evaluation + self-reflection for LLM agents
//
// Two main functions:
//   1. evaluateOutcomes(agentId, currentCtx) — score past decisions
//   2. runReflection(agentId)              — LLM self-analysis → insights
//
// Called from llmStrategy.js after each successful decision cycle.
// ═══════════════════════════════════════════════════════════════════════

import { getMemoryStore } from './memoryStore.js'
import { buildReflectionPrompts } from './prePrompter.js'
import { getProvider } from './llmProvider.js'
import { LLM_CONFIG } from './config.js'

// Minimum ticks after decision before we evaluate outcome
const EVAL_DELAY_TICKS = 5

// ─── Outcome Evaluation ────────────────────────────────────────────

/**
 * Evaluate pending decisions that are old enough.
 *
 * For each unevaluated decision, we check:
 *   - If the agent's current price moved favorably → win/loss/neutral
 *   - If the order never filled → no_fill
 *
 * @param {string} agentId
 * @param {object} agent   - Current engine agent state
 * @param {object} ctx     - Current engine market context
 * @returns {{ evaluated: number, wins: number, losses: number }}
 */
export function evaluateOutcomes(agentId, agent, ctx) {
  const store = getMemoryStore()
  const pending = store.getUnevaluatedDecisions(agentId)

  const currentTick = ctx.tickCount || 0
  const currentMid  = ctx.mid || ctx.currentPrice || 0

  let evaluated = 0, wins = 0, losses = 0

  for (const decision of pending) {
    // Only evaluate if enough ticks have passed
    if (currentTick - decision.tick < EVAL_DELAY_TICKS) continue

    // hold/cancel_all → always neutral
    if (decision.action === 'hold' || decision.action === 'cancel_all') {
      store.updateOutcome(decision.id, 0, 'neutral')
      evaluated++
      continue
    }

    // Check if decision price is valid
    if (!decision.price || decision.price <= 0) {
      store.updateOutcome(decision.id, 0, 'no_fill')
      evaluated++
      continue
    }

    // Calculate PnL based on current price vs decision price
    let pnl = 0
    let tag = 'neutral'

    if (decision.action === 'buy') {
      // Buy: profit if price went up
      pnl = (currentMid - decision.price) * decision.size
    } else if (decision.action === 'sell') {
      // Sell: profit if price went down
      pnl = (decision.price - currentMid) * decision.size
    }

    // Classify outcome
    const relPnl = decision.price > 0 ? Math.abs(pnl / (decision.price * decision.size)) : 0

    if (relPnl < 0.001) {
      // Less than 0.1% move → neutral (noise)
      tag = 'neutral'
    } else if (pnl > 0) {
      tag = 'win'
      wins++
    } else {
      tag = 'loss'
      losses++
    }

    store.updateOutcome(decision.id, round(pnl), tag)
    evaluated++
  }

  return { evaluated, wins, losses }
}

// ─── Self-Reflection ───────────────────────────────────────────────

/**
 * Run LLM self-reflection on evaluated decisions.
 * Should be called when store.shouldReflect(agentId) returns true.
 *
 * Pipeline:
 *   1. Load evaluated decisions from memory
 *   2. Build reflection prompts
 *   3. Call LLM
 *   4. Parse response → save insights + patterns
 *
 * @param {string} agentId
 * @param {object} agent - Agent object (for name, etc.)
 * @returns {{ success: boolean, insight?: string, error?: string }}
 */
export async function runReflection(agentId, agent) {
  const store = getMemoryStore()

  try {
    // 1. Get evaluated decisions for reflection
    const evaluated = store.getEvaluatedDecisions(agentId, 20)
    if (evaluated.length < 5) {
      return { success: false, error: 'Not enough evaluated decisions for reflection' }
    }

    // Map camelCase to the format buildReflectionPrompts expects
    const mapped = evaluated.map(d => ({
      tick: d.tick,
      action: d.action,
      instrument: d.instrument,
      price: d.price,
      size: d.size,
      confidence: d.confidence,
      reasoning: d.reasoning,
      outcome_tag: d.outcomeTag,
      outcome_pnl: d.outcomePnl,
    }))

    // 2. Build reflection prompts
    const { systemPrompt, userPrompt } = buildReflectionPrompts(agent, mapped)

    // 3. Call LLM
    const provider = getProvider()
    const response = await provider.chat({
      systemPrompt,
      userPrompt,
      agentId,
      temperature: 0.4, // Slightly higher for creative reflection
      maxTokens: 1024,
    })

    // 4. Parse reflection response
    const reflection = parseReflection(response.text)
    if (!reflection) {
      return { success: false, error: 'Failed to parse reflection response' }
    }

    // 5. Save insight from reflection
    if (reflection.one_line_insight) {
      store.saveInsight(agentId, {
        type: 'reflection',
        content: reflection.one_line_insight,
        relevanceScore: 1.0,
      })
    }

    // Save patterns identified
    if (reflection.patterns_identified?.length) {
      for (const pattern of reflection.patterns_identified) {
        store.savePattern(agentId, {
          patternType: 'reflection',
          description: typeof pattern === 'string' ? pattern : JSON.stringify(pattern),
          conditions: {},
          successRate: 0,
          sampleSize: evaluated.length,
        })
      }
    }

    // Save mistakes as insights
    if (reflection.mistakes_to_avoid?.length) {
      store.saveInsight(agentId, {
        type: 'mistake',
        content: reflection.mistakes_to_avoid.join('; '),
        relevanceScore: 0.9,
      })
    }

    // Save strategy insights
    if (reflection.strategies_to_continue?.length) {
      store.saveInsight(agentId, {
        type: 'strategy',
        content: reflection.strategies_to_continue.join('; '),
        relevanceScore: 0.85,
      })
    }

    // Decay older insights (aging)
    store.decayInsights(agentId, LLM_CONFIG.insightDecayFactor)

    // Prune old decisions
    store.prune(agentId, LLM_CONFIG.pruneKeepLast)

    console.log(`[LLM] ${agent.name || agentId} reflection complete: "${reflection.one_line_insight}"`)

    return {
      success: true,
      insight: reflection.one_line_insight,
      patternsFound: reflection.patterns_identified?.length || 0,
      sizingAdj: reflection.sizing_adjustment,
      riskAdj: reflection.risk_adjustment,
    }
  } catch (err) {
    console.error(`[LLM] ${agentId} reflection error: ${err.message}`)
    return { success: false, error: err.message }
  }
}

// ─── Parse Reflection Response ─────────────────────────────────────

/**
 * Extract structured reflection from LLM response.
 * @param {string} raw - Raw LLM text
 * @returns {object|null}
 */
function parseReflection(raw) {
  if (!raw) return null

  try {
    // Try direct JSON parse
    let json
    try {
      json = JSON.parse(raw)
    } catch {
      // Try extracting JSON from markdown code block
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (match) {
        json = JSON.parse(match[1].trim())
      } else {
        // Try finding { ... } in the text
        const braceMatch = raw.match(/\{[\s\S]*\}/)
        if (braceMatch) {
          json = JSON.parse(braceMatch[0])
        }
      }
    }

    if (!json) return null

    return {
      patterns_identified:     Array.isArray(json.patterns_identified) ? json.patterns_identified : [],
      mistakes_to_avoid:       Array.isArray(json.mistakes_to_avoid) ? json.mistakes_to_avoid : [],
      strategies_to_continue:  Array.isArray(json.strategies_to_continue) ? json.strategies_to_continue : [],
      sizing_adjustment:       json.sizing_adjustment || 'keep',
      risk_adjustment:         json.risk_adjustment || 'keep',
      one_line_insight:        json.one_line_insight || '',
    }
  } catch {
    return null
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function round(n, decimals = 4) {
  const m = Math.pow(10, decimals)
  return Math.round(n * m) / m
}

// ─── Exports ───────────────────────────────────────────────────────

export default { evaluateOutcomes, runReflection }
