// ═══════════════════════════════════════════════════════════════════════
// Memory Store — High-level memory API for LLM agents
//
// Wraps db.js prepared statements with agent-scoped operations.
// Used by llmStrategy.js to load/save memory context.
// ═══════════════════════════════════════════════════════════════════════

import {
  saveLLMDecision,
  getRecentLLMDecisions,
  getUnevaluatedLLMDecisions,
  getEvaluatedLLMDecisions,
  updateLLMOutcome,
  saveLLMInsight,
  getLLMInsights,
  decayLLMInsights,
  pruneLLMDecisions,
  saveLLMPattern,
  getLLMPatterns,
  updateLLMPattern,
  clearLLMMemory,
} from '../../db.js'

import { LLM_CONFIG } from './config.js'

export class MemoryStore {
  constructor() {
    // In-memory cache of recent decision counts per agent
    this._decisionCounts = new Map()
  }

  // ─── Decisions ─────────────────────────────────────────────────

  /**
   * Save a new LLM decision.
   * @param {string} agentId
   * @param {object} decision - { tick, timestamp, contextSummary, rawResponse, action, instrument, price, size, confidence, reasoning, thinking }
   */
  saveDecision(agentId, decision) {
    saveLLMDecision({ agentId, ...decision })

    // Track count for reflection triggers
    const count = (this._decisionCounts.get(agentId) || 0) + 1
    this._decisionCounts.set(agentId, count)
  }

  /**
   * Get recent decisions for memory context.
   * @param {string} agentId
   * @param {number} limit
   * @returns {object[]}
   */
  getRecentMemory(agentId, limit = LLM_CONFIG.memoryLimit) {
    return getRecentLLMDecisions(agentId, limit)
  }

  /**
   * Get decisions with outcomes for reflection.
   * @param {string} agentId
   * @param {number} limit
   * @returns {object[]}
   */
  getEvaluatedDecisions(agentId, limit = 20) {
    return getEvaluatedLLMDecisions(agentId, limit)
  }

  /**
   * Get decisions pending outcome evaluation.
   * @param {string} agentId
   * @returns {object[]}
   */
  getUnevaluatedDecisions(agentId) {
    return getUnevaluatedLLMDecisions(agentId)
  }

  /**
   * Record the outcome of a past decision.
   * @param {number} decisionId
   * @param {number} pnl
   * @param {string} tag - 'win' | 'loss' | 'neutral' | 'no_fill'
   */
  updateOutcome(decisionId, pnl, tag) {
    updateLLMOutcome(decisionId, pnl, tag)
  }

  // ─── Insights ──────────────────────────────────────────────────

  /**
   * Save a reflection insight.
   * @param {string} agentId
   * @param {object} insight - { type, content, relevanceScore }
   */
  saveInsight(agentId, insight) {
    saveLLMInsight({ agentId, ...insight })
  }

  /**
   * Get top insights by relevance.
   * @param {string} agentId
   * @param {number} limit
   * @returns {object[]}
   */
  getInsights(agentId, limit = 5) {
    return getLLMInsights(agentId, limit)
  }

  /**
   * Decay all insight relevance scores (aging).
   * @param {string} agentId
   * @param {number} factor
   */
  decayInsights(agentId, factor = LLM_CONFIG.insightDecayFactor) {
    decayLLMInsights(agentId, factor)
  }

  // ─── Patterns ──────────────────────────────────────────────────

  /**
   * Save a learned pattern.
   * @param {string} agentId
   * @param {object} pattern - { patternType, description, conditions, successRate, sampleSize }
   */
  savePattern(agentId, pattern) {
    saveLLMPattern({ agentId, ...pattern })
  }

  /**
   * Get top patterns by success rate.
   * @param {string} agentId
   * @param {number} limit
   * @returns {object[]}
   */
  getPatterns(agentId, limit = 10) {
    return getLLMPatterns(agentId, limit)
  }

  /**
   * Update pattern stats.
   * @param {number} patternId
   * @param {number} successRate
   * @param {number} sampleSize
   */
  updatePattern(patternId, successRate, sampleSize) {
    updateLLMPattern(patternId, successRate, sampleSize)
  }

  // ─── Maintenance ───────────────────────────────────────────────

  /**
   * Prune old decisions, keeping only the last N.
   * @param {string} agentId
   * @param {number} keepLast
   */
  prune(agentId, keepLast = LLM_CONFIG.pruneKeepLast) {
    pruneLLMDecisions(agentId, keepLast)
  }

  /**
   * Clear all memory for an agent.
   * @param {string} agentId
   */
  clearAll(agentId) {
    clearLLMMemory(agentId)
    this._decisionCounts.delete(agentId)
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /**
   * Get full memory context for prompt injection.
   * Returns { decisions, insights } ready for prePrompter.
   */
  getMemoryForPrompt(agentId) {
    const decisions = this.getRecentMemory(agentId, 5) // last 5 for prompt
    const insights  = this.getInsights(agentId, 3)     // top 3 insights

    if (decisions.length === 0 && insights.length === 0) return null

    return { decisions, insights }
  }

  /**
   * Check if it's time for reflection.
   * @param {string} agentId
   * @returns {boolean}
   */
  shouldReflect(agentId) {
    const count = this._decisionCounts.get(agentId) || 0
    return count > 0 && count % LLM_CONFIG.reflectionInterval === 0
  }

  /**
   * Get stats for an agent's LLM memory.
   */
  getStats(agentId) {
    const recent = this.getRecentMemory(agentId, 100)
    const insights = this.getInsights(agentId, 10)
    const patterns = this.getPatterns(agentId, 10)

    const wins   = recent.filter(d => d.outcomeTag === 'win').length
    const losses = recent.filter(d => d.outcomeTag === 'loss').length
    const pending = recent.filter(d => !d.outcomeTag).length

    return {
      totalDecisions: recent.length,
      wins,
      losses,
      pending,
      winRate: (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) + '%' : 'N/A',
      totalInsights: insights.length,
      totalPatterns: patterns.length,
      decisionsSinceReflection: (this._decisionCounts.get(agentId) || 0) % LLM_CONFIG.reflectionInterval,
    }
  }
}

// Singleton
let _instance = null
export function getMemoryStore() {
  if (!_instance) _instance = new MemoryStore()
  return _instance
}

export default MemoryStore
