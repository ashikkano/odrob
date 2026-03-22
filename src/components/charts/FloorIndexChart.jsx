import { useState, useEffect, useCallback, useRef } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Loader2, RefreshCw, TrendingUp, TrendingDown, AlertCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { getFloorIndexData } from '@/services/giftIndexApi'

const TIMEFRAMES = ['1D', '7D', '1M', '3M', 'ALL']
const REFRESH_INTERVAL = 5 * 60 * 1000 // 5 min

function FloorTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload

  const change = d.open !== undefined
    ? ((d.close - d.open) / d.open * 100)
    : null

  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="text-muted-foreground text-[10px]">
        {d.dt ? new Date(d.dt).toLocaleString('ru-RU', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }) : ''}
      </p>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="font-mono font-semibold">${d.price?.toFixed(3)}</span>
        {change !== null && (
          <span className={cn('font-mono text-[10px]', change >= 0 ? 'text-profit' : 'text-loss')}>
            {change >= 0 ? '+' : ''}{change.toFixed(2)}%
          </span>
        )}
      </div>
    </div>
  )
}

export default function FloorIndexChart({ height = 320, compact = false }) {
  const [timeframe, setTimeframe] = useState('7D')
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const intervalRef = useRef(null)

  const fetchData = useCallback(async (tf) => {
    try {
      setError(null)
      const points = await getFloorIndexData(tf)
      setData(points)
      setLastUpdated(new Date())
    } catch (err) {
      console.error('FloorIndex fetch error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchData(timeframe)

    // Auto-refresh
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(() => fetchData(timeframe), REFRESH_INTERVAL)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [timeframe, fetchData])

  const handleRefresh = () => {
    setLoading(true)
    fetchData(timeframe)
  }

  // Stats
  const currentPrice = data.length > 0 ? data[data.length - 1].price : null
  const firstPrice = data.length > 0 ? (data[0].open ?? data[0].price) : null
  const priceChange = currentPrice && firstPrice ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0
  const isPositive = priceChange >= 0

  // Price domain
  const prices = data.map((d) => [d.price, d.high, d.low]).flat().filter(Boolean)
  const minY = prices.length ? Math.min(...prices) * 0.995 : 0
  const maxY = prices.length ? Math.max(...prices) * 1.005 : 1

  const gradientId = `floorGrad-${compact ? 'c' : 'f'}`

  if (error && data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-loss/60" />
        <p className="text-sm">Ошибка загрузки данных</p>
        <p className="text-xs">{error}</p>
        <button
          onClick={handleRefresh}
          className="mt-2 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Повторить
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Header: price info + timeframe selector */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {currentPrice !== null && (
            <>
              <span className="font-mono text-xl font-bold">${currentPrice.toFixed(3)}</span>
              <div className="flex items-center gap-1">
                {isPositive ? (
                  <TrendingUp className="h-3.5 w-3.5 text-profit" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5 text-loss" />
                )}
                <span className={cn('font-mono text-sm font-semibold', isPositive ? 'text-profit' : 'text-loss')}>
                  {isPositive ? '+' : ''}{priceChange.toFixed(2)}%
                </span>
              </div>
              <Badge variant="outline" className="text-[10px] font-mono">
                LIVE
              </Badge>
            </>
          )}
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>

        <div className="flex items-center gap-2">
          {!compact && lastUpdated && (
            <span className="text-[10px] text-muted-foreground mr-2">
              {lastUpdated.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={handleRefresh}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-muted transition-colors"
            title="Обновить"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          </button>
          <div className="flex items-center rounded-lg border border-border bg-muted/50 p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-all cursor-pointer',
                  timeframe === tf
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart */}
      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={isPositive ? 'oklch(0.72 0.19 155)' : 'oklch(0.65 0.22 25)'}
                  stopOpacity={0.3}
                />
                <stop
                  offset="100%"
                  stopColor={isPositive ? 'oklch(0.72 0.19 155)' : 'oklch(0.65 0.22 25)'}
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.26 0.015 260)" opacity={0.5} />

            <XAxis
              dataKey="time"
              tickFormatter={(t) => {
                const d = new Date(t)
                if (timeframe === '1D') {
                  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
                }
                if (timeframe === '7D') {
                  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
                }
                return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
              }}
              tick={{ fontSize: 10, fill: 'oklch(0.55 0.02 260)' }}
              axisLine={{ stroke: 'oklch(0.26 0.015 260)' }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={40}
            />
            <YAxis
              domain={[minY, maxY]}
              tickFormatter={(v) => `$${v.toFixed(2)}`}
              tick={{ fontSize: 10, fill: 'oklch(0.55 0.02 260)' }}
              axisLine={false}
              tickLine={false}
              width={55}
            />

            <Tooltip content={<FloorTooltip />} />

            <Area
              type="monotone"
              dataKey="price"
              stroke={isPositive ? 'oklch(0.72 0.19 155)' : 'oklch(0.65 0.22 25)'}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{
                r: 4,
                fill: isPositive ? 'oklch(0.72 0.19 155)' : 'oklch(0.65 0.22 25)',
                stroke: 'oklch(0.13 0.005 260)',
                strokeWidth: 2,
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex items-center justify-center" style={{ height }}>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Bottom stats */}
      {!compact && data.length > 0 && (
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span>Точек: {data.length}</span>
          <span>Мин: ${Math.min(...prices).toFixed(3)}</span>
          <span>Макс: ${Math.max(...prices).toFixed(3)}</span>
          {data[data.length - 1]?.tonRate && (
            <span>TON: ${data[data.length - 1].tonRate.toFixed(2)}</span>
          )}
          {data[data.length - 1]?.mcap && (
            <span>MCap: {(data[data.length - 1].mcap / 1_000_000).toFixed(1)}M</span>
          )}
        </div>
      )}
    </div>
  )
}
