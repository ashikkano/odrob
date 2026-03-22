import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts'

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="text-muted-foreground text-[10px]">
        {new Date(d.time).toLocaleString('ru-RU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </p>
      <p className="font-mono font-semibold mt-0.5">${d.price?.toFixed(4)}</p>
    </div>
  )
}

export default function CorridorChart({ data, height = 300 }) {
  if (!data?.length) return null

  const prices = data.map((d) => [d.price, d.upperBound, d.lowerBound]).flat()
  const minY = Math.min(...prices) * 0.998
  const maxY = Math.max(...prices) * 1.002

  // Current oracle price for reference line
  const currentOracle = data[data.length - 1]?.oraclePrice

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
        <defs>
          <linearGradient id="corridorGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.65 0.18 250)" stopOpacity={0.12} />
            <stop offset="100%" stopColor="oklch(0.65 0.18 250)" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.72 0.19 155)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="oklch(0.72 0.19 155)" stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.26 0.015 260)" opacity={0.5} />

        <XAxis
          dataKey="time"
          tickFormatter={(t) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
          tick={{ fontSize: 10, fill: 'oklch(0.55 0.02 260)' }}
          axisLine={{ stroke: 'oklch(0.26 0.015 260)' }}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[minY, maxY]}
          tickFormatter={(v) => `$${v.toFixed(4)}`}
          tick={{ fontSize: 10, fill: 'oklch(0.55 0.02 260)' }}
          axisLine={false}
          tickLine={false}
          width={65}
        />

        <Tooltip content={<CustomTooltip />} />

        {/* Corridor band */}
        <Area
          type="monotone"
          dataKey="upperBound"
          stroke="oklch(0.65 0.18 250 / 0.3)"
          strokeWidth={1}
          strokeDasharray="4 2"
          fill="none"
          dot={false}
        />
        <Area
          type="monotone"
          dataKey="lowerBound"
          stroke="oklch(0.65 0.18 250 / 0.3)"
          strokeWidth={1}
          strokeDasharray="4 2"
          fill="url(#corridorGrad)"
          dot={false}
        />

        {/* Oracle price - dashed */}
        <Area
          type="monotone"
          dataKey="oraclePrice"
          stroke="oklch(0.65 0.18 250)"
          strokeWidth={1.5}
          strokeDasharray="6 3"
          fill="none"
          dot={false}
        />

        {/* Market price */}
        <Area
          type="monotone"
          dataKey="price"
          stroke="oklch(0.72 0.19 155)"
          strokeWidth={2}
          fill="url(#priceGrad)"
          dot={false}
          activeDot={{ r: 4, fill: 'oklch(0.72 0.19 155)', stroke: 'oklch(0.13 0.005 260)', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
