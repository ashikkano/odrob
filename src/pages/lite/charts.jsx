// ═══════════════════════════════════════════════════════════════════════
// ARC-002: Extracted chart components from LitePage.jsx
// Wrapped in React.memo() for re-render optimization
// ═══════════════════════════════════════════════════════════════════════

import { memo } from 'react'
import { fmtSize } from './constants'

// ── SVG Sparkline ───────────────────────────────────────────────────
export const Sparkline = memo(function Sparkline({ data, height = 100, color = '#6ee7b7', showArea = true }) {
  if (!data || data.length < 2) return null
  const W = 400, H = height, pad = 6
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (W - pad * 2)
    const y = pad + (1 - (v - min) / range) * (H - pad * 2)
    return [x, y]
  })
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ')
  const area = `${line} L${pts[pts.length-1][0]},${H} L${pts[0][0]},${H} Z`
  const last = pts[pts.length - 1]
  const gid = `sg-${color.replace(/[^a-z0-9]/gi, '')}`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="lt-spark">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {showArea && <path d={area} fill={`url(#${gid})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="4" fill={color} className="lt-dot-pulse" vectorEffect="non-scaling-stroke" />
    </svg>
  )
})

// ── Mini bar chart for agent popup ──────────────────────────────────
export const MiniBarChart = memo(function MiniBarChart({ data, color = '#818cf8' }) {
  if (!data || data.length < 2) return <div className="lt-minibar-empty">No data yet</div>
  const max = Math.max(...data.map(Math.abs)) || 1
  return (
    <div className="lt-minibar">
      {data.slice(-20).map((v, i) => (
        <div key={i} className="lt-minibar-col">
          <div
            className={`lt-minibar-bar ${v >= 0 ? 'lt-minibar-pos' : 'lt-minibar-neg'}`}
            style={{ height: `${Math.abs(v) / max * 100}%`, background: v >= 0 ? '#6ee7b7' : '#fca5a5' }}
          />
        </div>
      ))}
    </div>
  )
})

// ── Metric pill component ───────────────────────────────────────────
export const Metric = memo(function Metric({ label, value, sub, color }) {
  return (
    <div className="lt-metric">
      <div className="lt-metric-label">{label}</div>
      <div className="lt-metric-value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="lt-metric-sub">{sub}</div>}
    </div>
  )
})

// ── Market Depth Chart (SVG) ────────────────────────────────────────
export const DepthChart = memo(function DepthChart({ data }) {
  if (!data?.bids?.length || !data?.asks?.length)
    return <div className="lt-chart-empty"><div className="lt-spin" />Building order book…</div>

  const { bids, asks } = data
  const W = 400, H = 110, pad = 6
  const levels = Math.min(10, Math.max(bids.length, asks.length))
  const bidData = bids.slice(0, levels)
  const askData = asks.slice(0, levels)
  const maxCum = Math.max(
    bidData.length ? bidData[bidData.length - 1].cumVolume : 0,
    askData.length ? askData[askData.length - 1].cumVolume : 0,
  ) || 1

  const midX = W / 2
  const toY = cum => H - pad - (cum / maxCum) * (H - pad * 2)

  const bidPts = [[midX, H - pad]]
  bidData.forEach((b, i) => {
    bidPts.push([midX - ((i + 1) / levels) * (midX - pad), toY(b.cumVolume)])
  })
  const askPts = [[midX, H - pad]]
  askData.forEach((a, i) => {
    askPts.push([midX + ((i + 1) / levels) * (midX - pad), toY(a.cumVolume)])
  })

  const toLine = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const toArea = pts => {
    const line = toLine(pts)
    const last = pts[pts.length - 1]
    return `${line} L${last[0].toFixed(1)},${H - pad} L${pts[0][0].toFixed(1)},${H - pad} Z`
  }

  const bidTotalVol = bidData.reduce((s, b) => s + b.volume, 0)
  const askTotalVol = askData.reduce((s, a) => s + a.volume, 0)
  const ratio = bidTotalVol / (bidTotalVol + askTotalVol || 1)

  return (
    <div className="lt-depth-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="lt-spark">
        <defs>
          <linearGradient id="dBid" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0.03" />
          </linearGradient>
          <linearGradient id="dAsk" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#fca5a5" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#fca5a5" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        <path d={toArea(bidPts)} fill="url(#dBid)" />
        <path d={toLine(bidPts)} fill="none" stroke="#6ee7b7" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d={toArea(askPts)} fill="url(#dAsk)" />
        <path d={toLine(askPts)} fill="none" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <line x1={midX} y1={pad} x2={midX} y2={H - pad} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="3,3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="lt-depth-pressure">
        <div className="lt-depth-pbar">
          <div className="lt-depth-pbar-bid" style={{ width: `${ratio * 100}%` }} />
        </div>
        <div className="lt-depth-pvals">
          <span className="c-green">{fmtSize(bidTotalVol)} bids</span>
          <span className="c-red">{fmtSize(askTotalVol)} asks</span>
        </div>
      </div>
    </div>
  )
})
