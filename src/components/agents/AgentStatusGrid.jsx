import { cn, formatUSD, formatPercent } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Activity, Pause, StopCircle, AlertTriangle } from 'lucide-react'

const STATUS_CONFIG = {
  active: { badge: 'active', icon: Activity, label: 'Active', dotColor: 'bg-agent-active' },
  paused: { badge: 'paused', icon: Pause, label: 'Paused', dotColor: 'bg-agent-paused' },
  stopped: { badge: 'stopped', icon: StopCircle, label: 'Stopped', dotColor: 'bg-agent-stopped' },
  error: { badge: 'loss', icon: AlertTriangle, label: 'Error', dotColor: 'bg-agent-error' },
}

function AgentCard({ agent }) {
  const config = STATUS_CONFIG[agent.status] || STATUS_CONFIG.stopped
  const isProfitable = agent.pnl >= 0

  return (
    <div className={cn(
      'rounded-lg border border-border p-3 transition-all hover:border-border/80 hover:bg-muted/20',
      agent.status === 'active' && 'border-agent-active/20'
    )}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{agent.icon}</span>
          <div>
            <p className="text-sm font-medium leading-tight">{agent.name}</p>
            <p className="text-[10px] text-muted-foreground font-mono">{agent.index}</p>
          </div>
        </div>
        <Badge variant={config.badge} className="text-[10px]">
          <span className={cn('h-1.5 w-1.5 rounded-full mr-1', config.dotColor, agent.status === 'active' && 'animate-pulse-live')} />
          {config.label}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <p className="text-muted-foreground text-[10px]">P&L</p>
          <p className={cn('font-mono font-semibold', isProfitable ? 'text-profit' : 'text-loss')}>
            {formatUSD(agent.pnl)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-[10px]">Win Rate</p>
          <p className="font-mono font-medium">{(agent.winRate * 100).toFixed(0)}%</p>
        </div>
        <div>
          <p className="text-muted-foreground text-[10px]">Trades</p>
          <p className="font-mono font-medium">{agent.trades}</p>
        </div>
      </div>

      {/* Allocation bar */}
      <div className="mt-2.5 space-y-1">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">Allocated</span>
          <span className="font-mono">{formatUSD(agent.allocated)}</span>
        </div>
        <Progress
          value={(agent.equity / (agent.allocated * 1.5)) * 100}
          indicatorClassName={isProfitable ? 'bg-profit' : 'bg-loss'}
          className="h-1"
        />
      </div>

      {/* Footer */}
      {agent.status === 'active' && (
        <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>⏱ {agent.uptime}</span>
          <span>Last: {agent.lastTrade}</span>
        </div>
      )}
    </div>
  )
}

export default function AgentStatusGrid({ agents }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  )
}
