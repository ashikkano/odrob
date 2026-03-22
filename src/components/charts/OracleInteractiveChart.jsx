import { memo, useMemo, useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'

const PERIODS = [
  { key: '15m', label: '15M', ms: 15 * 60 * 1000 },
  { key: '1h', label: '1H', ms: 60 * 60 * 1000 },
  { key: '6h', label: '6H', ms: 6 * 60 * 60 * 1000 },
  { key: '24h', label: '24H', ms: 24 * 60 * 60 * 1000 },
  { key: 'all', label: 'ALL', ms: Infinity },
]

function samplePoints(points, maxPoints = 320) {
  if (!Array.isArray(points) || points.length === 0) return []
  if (points.length <= maxPoints) return points

  const step = Math.ceil(points.length / maxPoints)
  const out = []
  for (let i = 0; i < points.length; i += step) out.push(points[i])
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1])
  return out
}

function normalizeOraclePoints({ series, history, intervalMs = 30000 }) {
  const hist = Array.isArray(history) ? history : []
  if (hist.length > 1) {
    const mapped = hist
      .map((p, i) => ({
        ts: Number(p?.timestamp) || Number(p?.ts) || (Date.now() - (hist.length - i - 1) * intervalMs),
        price: Number(p?.price),
      }))
      .filter(p => Number.isFinite(p.price) && Number.isFinite(p.ts) && p.price > 0)
      .sort((a, b) => a.ts - b.ts)
    if (mapped.length > 1) return mapped
  }

  const src = Array.isArray(series) ? series : []
  if (src.length < 2) return []
  const now = Date.now()
  return src
    .map((v, i) => ({
      ts: now - (src.length - i - 1) * intervalMs,
      price: Number(v),
    }))
    .filter(p => Number.isFinite(p.price) && p.price > 0)
}

function fmtPeriodTime(ts, spanMs) {
  const d = new Date(ts)
  if (spanMs > 24 * 60 * 60 * 1000) {
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function OracleTooltip({ active, payload, label, spanMs }) {
  if (!active || !payload?.length) return null
  const p = payload[0]?.value || 0
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="text-[10px] text-muted-foreground">{fmtPeriodTime(Number(label), spanMs)}</p>
      <p className="font-mono font-semibold mt-0.5">${Number(p).toFixed(4)}</p>
    </div>
  )
}

function OracleInteractiveChartBase({ series = [], history = [], height = 150, symbol = '', intervalMs = 30000 }) {
  const [period, setPeriod] = useState('1h')

  const sampled = useMemo(() => {
    const normalized = normalizeOraclePoints({ series, history, intervalMs })
    return samplePoints(normalized, 320)
  }, [series, history, intervalMs])

  const data = useMemo(() => {
    if (!sampled.length) return []
    const cfg = PERIODS.find(p => p.key === period) || PERIODS[1]
    if (cfg.ms === Infinity) return sampled
    const cutoff = Date.now() - cfg.ms
    const filtered = sampled.filter(p => p.ts >= cutoff)
    return filtered.length >= 2 ? filtered : sampled
  }, [sampled, period])

  const spanMs = useMemo(() => {
    if (data.length < 2) return 0
    return Math.max(0, data[data.length - 1].ts - data[0].ts)
  }, [data])

  const stats = useMemo(() => {
    if (!data.length) return { min: 0, max: 0, first: 0, last: 0, change: 0 }
    const prices = data.map(d => d.price)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const first = prices[0] || 0
    const last = prices[prices.length - 1] || 0
    const change = first > 0 ? ((last - first) / first) * 100 : 0
    return { min, max, first, last, change }
  }, [data])

  const trendUp = stats.change >= 0
  const trendColor = trendUp ? '#6ee7b7' : '#fca5a5'

  if (!data.length) {
    return <div className="lt-chart-empty"><div className="lt-spin" />Waiting for oracle…</div>
  }

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
        <div className="font-mono text-muted-foreground">
          {(symbol || 'INDEX')} · ${stats.last.toFixed(4)}
        </div>
        <div className="flex items-center gap-1">
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-2 py-1 rounded-md border text-[10px] font-semibold transition ${period === p.key ? 'border-white/40 bg-white/10 text-white' : 'border-white/10 bg-transparent text-white/60 hover:text-white/90'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 2" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.5)' }}
              tickFormatter={(v) => fmtPeriodTime(v, spanMs)}
              tickLine={false}
              axisLine={false}
              minTickGap={26}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.55)' }}
              tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
              tickLine={false}
              axisLine={false}
              width={52}
              domain={['dataMin', 'dataMax']}
            />
            <Tooltip content={<OracleTooltip spanMs={spanMs} />} />

            <Line
              type="monotone"
              dataKey="price"
              stroke={trendColor}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: trendColor, stroke: '#111827', strokeWidth: 1.5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-1 text-[11px] font-mono text-white/70">
        <span className={trendUp ? 'text-emerald-400' : 'text-rose-400'}>{trendUp ? '+' : ''}{stats.change.toFixed(2)}%</span>
        <span> · {`$${stats.min.toFixed(4)} — $${stats.max.toFixed(4)}`}</span>
      </div>
    </div>
  )
}

const OracleInteractiveChart = memo(OracleInteractiveChartBase)

export default OracleInteractiveChart
