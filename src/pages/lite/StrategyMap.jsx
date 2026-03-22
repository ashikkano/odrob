// ═══════════════════════════════════════════════════════════════════════
// ARC-002: Extracted StrategyMap from LitePage.jsx
// ═══════════════════════════════════════════════════════════════════════

import { memo, useMemo } from 'react'
import { STRAT, fmtPct } from './constants'

export const StrategyMap = memo(function StrategyMap({ agents }) {
  const strats = useMemo(() => {
    return Object.entries(STRAT).map(([key, meta]) => {
      const group = agents.filter(a => a.strategy === key)
      const count = group.length
      const avgPnl = count > 0 ? group.reduce((s, a) => s + (a.pnlPercent || 0), 0) / count : 0
      const trades = group.reduce((s, a) => s + (a.totalTrades || 0), 0)
      return { key, ...meta, count, avgPnl, trades }
    })
  }, [agents])

  return (
    <div className="lt-stratmap">
      {strats.map((s, i) => (
        <div
          key={s.key}
          className={`lt-stratmap-cell lt-card-slide ${s.avgPnl >= 0 ? 'lt-sm-up' : 'lt-sm-down'}`}
          style={{ animationDelay: `${i * 0.07}s` }}
        >
          <div className="lt-stratmap-dot" style={{ background: s.color }} />
          <div className="lt-stratmap-body">
            <span className="lt-stratmap-name" style={{ color: s.color }}>{s.short}</span>
            <span className={`lt-stratmap-pnl ${s.avgPnl >= 0 ? 'c-green' : 'c-red'}`}>{fmtPct(s.avgPnl)}</span>
          </div>
          <span className="lt-stratmap-trades">{s.trades}</span>
        </div>
      ))}
    </div>
  )
})
