// ═══════════════════════════════════════════════════════════════════════
// Metrics — Nanosecond-precision performance tracking for OrderBook v2
// ═══════════════════════════════════════════════════════════════════════

export class Metrics {
  constructor() {
    this.insertCount    = 0
    this.insertTotalNs  = 0n
    this.matchCount     = 0
    this.matchTotalNs   = 0n
    this.cancelCount    = 0
    this.cancelTotalNs  = 0n
    this.snapshotCount  = 0
    this.snapshotTotalNs = 0n
    this.triggerCount   = 0
    this.triggerTotalNs = 0n
  }

  recordInsert(durationNs) {
    this.insertCount++
    this.insertTotalNs += durationNs
  }

  recordMatch(durationNs) {
    this.matchCount++
    this.matchTotalNs += durationNs
  }

  recordCancel(durationNs) {
    this.cancelCount++
    this.cancelTotalNs += durationNs
  }

  recordSnapshot(durationNs) {
    this.snapshotCount++
    this.snapshotTotalNs += durationNs
  }

  recordTrigger(durationNs) {
    this.triggerCount++
    this.triggerTotalNs += durationNs
  }

  /** Get summary with average times in microseconds. */
  getSummary() {
    const avgUs = (totalNs, count) =>
      count > 0 ? Number(totalNs / BigInt(count)) / 1000 : 0

    return {
      insert:   { count: this.insertCount,   avgUs: avgUs(this.insertTotalNs, this.insertCount) },
      match:    { count: this.matchCount,     avgUs: avgUs(this.matchTotalNs, this.matchCount) },
      cancel:   { count: this.cancelCount,    avgUs: avgUs(this.cancelTotalNs, this.cancelCount) },
      snapshot: { count: this.snapshotCount,  avgUs: avgUs(this.snapshotTotalNs, this.snapshotCount) },
      trigger:  { count: this.triggerCount,   avgUs: avgUs(this.triggerTotalNs, this.triggerCount) },
    }
  }

  /** Reset all counters. */
  reset() {
    this.insertCount = this.matchCount = this.cancelCount = 0
    this.snapshotCount = this.triggerCount = 0
    this.insertTotalNs = this.matchTotalNs = this.cancelTotalNs = 0n
    this.snapshotTotalNs = this.triggerTotalNs = 0n
  }
}
