import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from 'recharts'

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="text-muted-foreground text-[10px]">
        {new Date(d.time).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
      </p>
      <p className="font-mono font-semibold mt-0.5">${d.equity.toLocaleString()}</p>
    </div>
  )
}

export default function EquitySparkline({ data, height = 180 }) {
  if (!data?.length) return null

  const isPositive = data[data.length - 1].equity >= data[0].equity
  const color = isPositive ? 'oklch(0.72 0.19 155)' : 'oklch(0.65 0.22 25)'

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
        <defs>
          <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="time" hide />
        <Tooltip content={<CustomTooltip />} />
        <Area
          type="monotone"
          dataKey="equity"
          stroke={color}
          strokeWidth={2}
          fill="url(#equityGrad)"
          dot={false}
          activeDot={{ r: 3, fill: color, stroke: 'oklch(0.13 0.005 260)', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
