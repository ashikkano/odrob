// ═══════════════════════════════════════════════════════════════════════
// Order Model — Extended order with types, TIF, STP, trigger support
// ═══════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto'

/* ─── Enums ───────────────────────────────────────────────────────── */

export const OrderType = {
  LIMIT:         'limit',
  MARKET:        'market',
  STOP:          'stop',
  STOP_LIMIT:    'stop_limit',
  TRAILING_STOP: 'trailing_stop',
}

export const TimeInForce = {
  GTC: 'GTC',   // Good Till Cancel (default)
  IOC: 'IOC',   // Immediate Or Cancel
  FOK: 'FOK',   // Fill Or Kill
  GTD: 'GTD',   // Good Till Date
}

export const STPMode = {
  NONE:           'none',
  CANCEL_NEWEST:  'cancel_newest',
  CANCEL_OLDEST:  'cancel_oldest',
  CANCEL_BOTH:    'cancel_both',
}

export const OrderStatus = {
  OPEN:      'open',
  PARTIAL:   'partial',
  FILLED:    'filled',
  CANCELLED: 'cancelled',
  REJECTED:  'rejected',
  TRIGGERED: 'triggered',
}

/* ─── Factory ─────────────────────────────────────────────────────── */

export function createOrder(params) {
  return {
    id:           params.id || randomUUID(),
    agentId:      params.agentId,
    side:         params.side,                                // 'buy' | 'sell'
    type:         params.type         || OrderType.LIMIT,
    price:        params.price        ?? 0,
    size:         params.size,
    filled:       0,
    remaining:    params.size,
    status:       OrderStatus.OPEN,
    timestamp:    params.timestamp     || Date.now(),
    reasoning:    params.reasoning     || '',
    timeInForce:  params.timeInForce   || TimeInForce.GTC,
    triggerPrice: params.triggerPrice   ?? null,
    trailAmount:  params.trailAmount   ?? null,
    trailPercent: params.trailPercent   ?? null,
    expireAt:     params.expireAt       ?? null,
    stpMode:      params.stpMode       || STPMode.CANCEL_NEWEST,
    maxSlippage:  params.maxSlippage    ?? null,
    // Doubly-linked list pointers (managed by PriceLevel)
    prev: null,
    next: null,
  }
}
