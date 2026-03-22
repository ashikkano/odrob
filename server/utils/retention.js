// ═══════════════════════════════════════════════════════════════════════
// DB Retention — Periodic cleanup of old records to prevent unbounded growth
// ═══════════════════════════════════════════════════════════════════════

/**
 * Set up periodic cleanup of stale DB records.
 * Returns a cleanup function to stop the timer.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=3_600_000] — how often to run cleanup (default: 1h)
 * @param {number} [opts.maxAgeDays=30] — max age for trade/decision records
 * @param {number} [opts.maxOracleAgeDays=14] — max age for oracle snapshots
 * @param {number} [opts.maxFeedAgeDays=7] — max age for feed events
 * @returns {{ stop: () => void, runNow: () => object }}
 */
export function setupRetentionPolicy(db, opts = {}) {
  const {
    intervalMs = 3_600_000,     // every hour
    maxAgeDays = 30,
    maxOracleAgeDays = 14,
    maxFeedAgeDays = 7,
  } = opts

  // Prepared statements for cleanup
  const cleanupStatements = {
    trades: db.prepare(`DELETE FROM index_trades WHERE timestamp < ?`),
    oracleSnapshots: db.prepare(`DELETE FROM index_oracle_snapshots WHERE timestamp < ?`),
    feedEvents: db.prepare(`DELETE FROM index_feed WHERE timestamp < ?`),
    agentTrades: db.prepare(`DELETE FROM agent_trades WHERE timestamp < ?`),
    agentDecisions: db.prepare(`DELETE FROM agent_decisions WHERE timestamp < ?`),
    llmDecisions: db.prepare(`DELETE FROM llm_decisions WHERE timestamp < ?`),
  }

  function runCleanup() {
    const now = Date.now()
    const tradesCutoff = now - maxAgeDays * 86_400_000
    const oracleCutoff = now - maxOracleAgeDays * 86_400_000
    const feedCutoff = now - maxFeedAgeDays * 86_400_000

    const results = {}

    try {
      results.trades = cleanupStatements.trades.run(tradesCutoff).changes
      results.oracleSnapshots = cleanupStatements.oracleSnapshots.run(oracleCutoff).changes
      results.feedEvents = cleanupStatements.feedEvents.run(feedCutoff).changes
      results.agentTrades = cleanupStatements.agentTrades.run(tradesCutoff).changes
      results.agentDecisions = cleanupStatements.agentDecisions.run(tradesCutoff).changes
      results.llmDecisions = cleanupStatements.llmDecisions.run(tradesCutoff).changes

      const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0)
      if (totalDeleted > 0) {
        console.log(`🧹 DB retention: cleaned ${totalDeleted} old records`, results)
      }
    } catch (err) {
      console.error('❌ DB retention cleanup error:', err.message)
    }

    return results
  }

  // Run immediately on startup (non-blocking via setImmediate)
  setImmediate(runCleanup)

  // Then periodically
  const timer = setInterval(runCleanup, intervalMs)
  timer.unref() // don't prevent process exit

  return {
    stop: () => clearInterval(timer),
    runNow: runCleanup,
  }
}
