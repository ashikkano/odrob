// ═══════════════════════════════════════════════════════════════════════
// Response Parser — Parse and validate LLM JSON response into Signal[]
//
// Handles:
//   - JSON extraction from markdown wrappers
//   - Field validation & sanitization
//   - Size clamping by balance/position
//   - Confidence threshold enforcement
//   - Graceful fallback on parse errors
// ═══════════════════════════════════════════════════════════════════════

import { LLM_CONFIG } from './config.js'

/**
 * Parse raw LLM response text into engine Signal[].
 *
 * @param {string} rawResponse - Raw text from LLM
 * @param {object} agent       - Agent state (balance, position)
 * @param {object} ctx         - Market context (mid, bandLow, bandHigh)
 * @returns {{ signals: Signal[], metadata: object }}
 */
export function parse(rawResponse, agent, ctx) {
  let parsed
  try {
    parsed = extractJSON(rawResponse)
  } catch (err) {
    return {
      signals: [{ action: 'hold', price: 0, size: 0, reasoning: `Parse error: ${err.message}`, confidence: 0 }],
      metadata: { thinking: null, risk_note: null, parseError: err.message, raw: rawResponse?.substring(0, 200) },
    }
  }

  // Validate and sanitize
  const action     = validateAction(parsed.action)
  const orderType  = validateOrderType(parsed.orderType)
  const confidence = clamp(parseFloat(parsed.confidence) || 0.5, 0, 1)
  const thinking   = String(parsed.thinking || '').substring(0, 500)
  const reasoning  = String(parsed.reasoning || 'No reasoning provided').substring(0, 300)
  const risk_note  = String(parsed.risk_note || '').substring(0, 200)
  const instrument = String(parsed.instrument || 'INDEX')

  const metadata = { thinking, risk_note, rawAction: parsed.action, rawConfidence: parsed.confidence, orderType }

  // Confidence gate
  if (confidence < (LLM_CONFIG.confidenceThreshold || 0.4) && action !== 'hold' && action !== 'cancel_all') {
    return {
      signals: [{ action: 'hold', price: 0, size: 0, reasoning: `Confidence ${confidence} < threshold — holding`, confidence }],
      metadata: { ...metadata, gated: true },
    }
  }

  // Hold / cancel_all — no further processing
  if (action === 'hold' || action === 'cancel_all') {
    return {
      signals: [{ action, price: 0, size: 0, reasoning, confidence }],
      metadata,
    }
  }

  // Price sanitization
  let price = parseFloat(parsed.price)
  const mid = ctx.mid || ctx.currentPrice || 0
  if (!price || isNaN(price) || price <= 0) {
    price = mid
  }
  // Band clamp
  if (ctx.bandLow && ctx.bandHigh) {
    price = clamp(price, ctx.bandLow, ctx.bandHigh)
  }

  // Size sanitization
  let size = parseFloat(parsed.size)
  if (!size || isNaN(size) || size <= 0) {
    // Default: orderSizePct of balance for buy, 50% of position for sell
    if (action === 'buy' && agent.virtualBalance > 0 && price > 0) {
      size = (agent.virtualBalance * (LLM_CONFIG.defaultOrderSizePct || 0.05)) / price
    } else if (action === 'sell' && agent.position > 0) {
      size = agent.position * 0.5
    } else {
      size = 0
    }
  }

  // Apply confidence scaling: size × confidence
  size = size * confidence

  // Clamp by actual limits
  if (action === 'buy') {
    const maxBuySize = price > 0 ? (agent.virtualBalance * 0.9) / price : 0
    size = Math.min(size, maxBuySize)
  } else if (action === 'sell') {
    size = Math.min(size, agent.position || 0)
  }

  // Final check: zero size = hold
  if (size <= 0) {
    return {
      signals: [{ action: 'hold', price: 0, size: 0, reasoning: `Computed size=0 for ${action} — holding`, confidence }],
      metadata: { ...metadata, sizeZero: true },
    }
  }

  // Round size to 2 decimals
  size = Math.round(size * 100) / 100

  return {
    signals: [{ action, price, size, reasoning, confidence, orderType }],
    metadata,
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Extract JSON object from potentially markdown-wrapped response.
 * Handles: ```json blocks, <thinking> tags, raw JSON, partial wrapping.
 */
function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Empty or non-string response')
  }

  let text = raw.trim()

  // Strip <thinking>...</thinking> or <thought>...</thought> tags (some models use these)
  text = text.replace(/<(?:thinking|thought)>[\s\S]*?<\/(?:thinking|thought)>/gi, '').trim()

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (jsonBlockMatch) {
    text = jsonBlockMatch[1].trim()
  }

  // Try to find JSON object boundaries
  const firstBrace = text.indexOf('{')
  const lastBrace  = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.substring(firstBrace, lastBrace + 1)
  }

  try {
    return JSON.parse(text)
  } catch (e) {
    // Attempt to fix common JSON issues: trailing commas, single quotes
    let fixed = text
      .replace(/,\s*}/g, '}')      // trailing comma before }
      .replace(/,\s*]/g, ']')      // trailing comma before ]
      .replace(/'/g, '"')           // single quotes → double quotes
      .replace(/(\w+)\s*:/g, '"$1":') // unquoted keys (risky but helpful)

    try {
      return JSON.parse(fixed)
    } catch {
      // Last resort: try to find action keyword
      const actionMatch = text.match(/["']?action["']?\s*[:=]\s*["']?(buy|sell|hold|cancel_all)["']?/i)
      if (actionMatch) {
        return {
          action: actionMatch[1].toLowerCase(),
          confidence: 0.3,
          thinking: 'Extracted from malformed JSON',
          reasoning: 'LLM returned malformed JSON, extracted action only',
        }
      }
      throw new Error(`Invalid JSON: ${e.message}. First 200 chars: ${text.substring(0, 200)}`)
    }
  }
}

function validateAction(action) {
  const valid = ['buy', 'sell', 'hold', 'cancel_all']
  const a = String(action || '').toLowerCase().trim()
  return valid.includes(a) ? a : 'hold'
}

function validateOrderType(orderType) {
  const valid = ['limit', 'market', 'ioc', 'fok']
  const o = String(orderType || '').toLowerCase().trim()
  return valid.includes(o) ? o : 'limit'
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

export default { parse }
