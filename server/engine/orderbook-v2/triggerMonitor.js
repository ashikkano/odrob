// ═══════════════════════════════════════════════════════════════════════
// TriggerMonitor — Watches price events and fires trigger orders
// Subscribes to: trade events, oracle updates
// Sends triggered orders to the MatchingEngine for execution
// ═══════════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events'
import { OrderType, OrderStatus } from './order.js'

export class TriggerMonitor extends EventEmitter {
  /**
   * @param {import('./triggerBook.js').TriggerBook} triggerBook
   * @param {import('./matchingEngine.js').MatchingEngine} matchingEngine
   */
  constructor(triggerBook, matchingEngine) {
    super()
    this.triggerBook     = triggerBook
    this.matchingEngine  = matchingEngine
    this.processing      = false  // Sequential lock
  }

  /**
   * Called on every price-changing event (trade, oracle update).
   * Checks triggers and submits resulting orders to the matching engine.
   * @param {number} currentPrice
   * @returns {{ triggered: number, fills: object[] }}
   */
  onPriceUpdate(currentPrice) {
    if (this.processing) return { triggered: 0, fills: [] }
    this.processing = true

    try {
      // 1. Update trailing stops (move trigger prices closer)
      this.triggerBook.updateTrailingStops(currentPrice)

      // 2. Check which triggers have fired
      const triggered = this.triggerBook.checkTriggers(currentPrice)
      if (triggered.length === 0) return { triggered: 0, fills: [] }

      // 3. Sort by timestamp (oldest first) for fair execution
      triggered.sort((a, b) => a.order.timestamp - b.order.timestamp)

      // 4. Submit each triggered order to the matching engine
      const allFills = []
      for (const t of triggered) {
        const order = t.order
        order.status = OrderStatus.TRIGGERED

        let submitParams
        if (order.type === OrderType.STOP_LIMIT) {
          // Stop-limit → becomes a limit order at the specified price
          submitParams = {
            id:          order.id + '_triggered',
            agentId:     order.agentId,
            side:        order.side,
            type:        'limit',
            price:       order.price,    // The limit price
            size:        order.remaining,
            reasoning:   `stop-limit triggered @ ${t.triggerPrice}`,
            timeInForce: order.timeInForce,
            stpMode:     order.stpMode,
          }
        } else {
          // Stop / trailing-stop → becomes a market order
          submitParams = {
            id:          order.id + '_triggered',
            agentId:     order.agentId,
            side:        order.side,
            type:        'market',
            price:       order.side === 'buy' ? Number.MAX_SAFE_INTEGER : 0,
            size:        order.remaining,
            reasoning:   `${order.type} triggered @ ${t.triggerPrice}`,
            stpMode:     order.stpMode,
          }
        }

        const result = this.matchingEngine.submitOrder(submitParams)
        allFills.push(...result.fills)

        this.emit('trigger:fired', {
          originalOrder: order,
          triggerPrice:  t.triggerPrice,
          resultOrder:   result.order,
          fills:         result.fills,
        })
      }

      return { triggered: triggered.length, fills: allFills }
    } finally {
      this.processing = false
    }
  }
}
