import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'

function OrderRow({ price, volume, cumVolume, maxCumVolume, type }) {
  const barWidth = (cumVolume / maxCumVolume) * 100
  const isAsk = type === 'ask'

  return (
    <div className="relative flex items-center justify-between px-2 py-[3px] text-xs font-mono hover:bg-muted/30 transition-colors group">
      {/* Background bar */}
      <div
        className={cn(
          'absolute inset-y-0 transition-all',
          isAsk ? 'right-0 bg-ask-muted' : 'right-0 bg-bid-muted'
        )}
        style={{ width: `${barWidth}%` }}
      />
      <span className={cn('relative z-10', isAsk ? 'text-ask' : 'text-bid')}>
        {price.toFixed(4)}
      </span>
      <span className="relative z-10 text-muted-foreground">
        {volume >= 1000 ? `${(volume / 1000).toFixed(1)}K` : volume.toFixed(0)}
      </span>
    </div>
  )
}

export default function MiniOrderBook({ orderBook }) {
  if (!orderBook) return null

  const { asks, bids, spread, spreadPercent } = orderBook
  const displayAsks = asks.slice(0, 8).reverse()
  const displayBids = bids.slice(0, 8)

  const maxCum = Math.max(
    ...displayAsks.map((a) => a.cumVolume),
    ...displayBids.map((b) => b.cumVolume)
  )

  return (
    <div className="space-y-0">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <span>Price (USDT)</span>
        <span>Volume</span>
      </div>

      {/* Asks (sells) — top, reversed */}
      <div>
        {displayAsks.map((ask, i) => (
          <OrderRow
            key={`ask-${i}`}
            price={ask.price}
            volume={ask.volume}
            cumVolume={ask.cumVolume}
            maxCumVolume={maxCum}
            type="ask"
          />
        ))}
      </div>

      {/* Spread */}
      <div className="flex items-center justify-center gap-2 py-2 border-y border-border/50">
        <span className="font-mono text-sm font-bold text-foreground">
          ${asks[0] && bids[0] ? ((asks[0].price + bids[0].price) / 2).toFixed(4) : (orderBook.mid || orderBook.lastPrice || 0).toFixed(4)}
        </span>
        <span className="text-[10px] text-muted-foreground">
          spread {(spreadPercent || 0).toFixed(3)}%
        </span>
      </div>

      {/* Bids (buys) — bottom */}
      <div>
        {displayBids.map((bid, i) => (
          <OrderRow
            key={`bid-${i}`}
            price={bid.price}
            volume={bid.volume}
            cumVolume={bid.cumVolume}
            maxCumVolume={maxCum}
            type="bid"
          />
        ))}
      </div>
    </div>
  )
}
