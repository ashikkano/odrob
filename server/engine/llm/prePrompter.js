// ═══════════════════════════════════════════════════════════════════════
// Pre-Prompter — Builds system + user prompts from templates + context
//
// Templates live in ./prompts/*.md and use {{variable}} placeholders.
// Memory and insights are injected when available.
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = join(__dirname, 'prompts')

// Load templates once at startup
let _systemTpl = null
let _userTpl   = null
let _reflectTpl = null

function loadTemplates() {
  if (!_systemTpl) {
    _systemTpl  = readFileSync(join(PROMPTS_DIR, 'system.md'), 'utf-8')
    _userTpl    = readFileSync(join(PROMPTS_DIR, 'user.md'), 'utf-8')
    _reflectTpl = readFileSync(join(PROMPTS_DIR, 'reflection.md'), 'utf-8')
  }
}

// ─── Main builder ──────────────────────────────────────────────────

/**
 * Build system + user prompts for a trading decision.
 *
 * @param {object} agent   - Engine agent
 * @param {object} context - Output from contextAssembler.buildContext()
 * @param {object} [memory] - { decisions: [], insights: [] }
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildPrompts(agent, context, memory = null) {
  loadTemplates()

  const systemPrompt = renderSystem(agent)
  const userPrompt   = renderUser(context, memory)

  return { systemPrompt, userPrompt }
}

/**
 * Build reflection prompt for self-analysis.
 *
 * @param {object} agent
 * @param {object[]} evaluatedDecisions - Decisions with outcome
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildReflectionPrompts(agent, evaluatedDecisions) {
  loadTemplates()

  const systemPrompt = 'You are a trading performance analyst. Analyze the trading decisions below and provide structured feedback in JSON format.'

  const decisions = evaluatedDecisions.map((d, i) => {
    const outcome = d.outcome_tag || 'pending'
    const pnl = d.outcome_pnl != null ? `$${d.outcome_pnl.toFixed(4)}` : '?'
    return `${i + 1}. Tick ${d.tick}: ${d.action} ${d.instrument || 'MAIN'} @ $${d.price?.toFixed(4) || '?'} × ${d.size?.toFixed(2) || '?'} | confidence=${d.confidence} | result: ${outcome} (${pnl}) | "${d.reasoning || ''}"`
  }).join('\n')

  const wins    = evaluatedDecisions.filter(d => d.outcome_tag === 'win').length
  const losses  = evaluatedDecisions.filter(d => d.outcome_tag === 'loss').length
  const neutral = evaluatedDecisions.filter(d => d.outcome_tag === 'neutral' || d.outcome_tag === 'no_fill').length
  const totalPnl = evaluatedDecisions.reduce((s, d) => s + (d.outcome_pnl || 0), 0)
  const pnls = evaluatedDecisions.filter(d => d.outcome_pnl != null).map(d => d.outcome_pnl)
  const bestPnl  = pnls.length ? Math.max(...pnls).toFixed(4) : '0'
  const worstPnl = pnls.length ? Math.min(...pnls).toFixed(4) : '0'
  const winRate  = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(0) : '0'

  const userPrompt = _reflectTpl
    .replace('{{agentName}}', agent.name || 'Agent')
    .replace('{{decisionCount}}', String(evaluatedDecisions.length))
    .replace('{{decisions}}', decisions)
    .replace('{{totalPnl}}', totalPnl.toFixed(4))
    .replace('{{wins}}', String(wins))
    .replace('{{losses}}', String(losses))
    .replace('{{neutral}}', String(neutral))
    .replace('{{winRate}}', winRate)
    .replace('{{bestPnl}}', bestPnl)
    .replace('{{worstPnl}}', worstPnl)

  return { systemPrompt, userPrompt }
}

// ─── Renderers ─────────────────────────────────────────────────────

function renderSystem(agent) {
  const base = _systemTpl
    .replace(/\{\{agentName\}\}/g, agent.name || 'Agent')
    .replace('{{riskLevel}}', agent.riskLevel || 'medium')
    .replace('{{bio}}', agent.bio || 'A careful AI trader')

  const guidance = agent?.config?.llmTemplateGuidance || null
  const riskDefaults = agent?.config?.llmTemplateRiskDefaults || null
  const templateName = agent?.config?.llmTemplateName || null

  const guidanceLines = []
  if (templateName) guidanceLines.push(`- Active marketplace template: ${templateName}`)
  if (Number.isFinite(Number(guidance?.entryThreshold))) guidanceLines.push(`- Prefer new long entries only when market conviction is at least ${Number(guidance.entryThreshold).toFixed(2)}% oracle move.`)
  if (Number.isFinite(Number(guidance?.exitThreshold))) guidanceLines.push(`- Treat ${Number(guidance.exitThreshold).toFixed(2)}% oracle move or worse as a risk-off / exit zone for open positions.`)
  if (Number.isFinite(Number(guidance?.maxSpreadPct))) guidanceLines.push(`- Avoid opening fresh exposure when spread is above ${Number(guidance.maxSpreadPct).toFixed(2)}%.`)
  if (Number.isFinite(Number(guidance?.buySizePct))) guidanceLines.push(`- Default buy intent should stay near ${Number(guidance.buySizePct).toFixed(0)}% of allocated balance before confidence scaling.`)
  if (Number.isFinite(Number(guidance?.sellSizePct))) guidanceLines.push(`- Default sell / de-risk intent should stay near ${Number(guidance.sellSizePct).toFixed(0)}% of the current position unless urgency is high.`)
  if (Number.isFinite(Number(guidance?.confidence))) guidanceLines.push(`- Target baseline conviction around ${Number(guidance.confidence).toFixed(2)} when conditions align cleanly.`)
  if (Number.isFinite(Number(guidance?.minVolume)) && Number(guidance.minVolume) > 0) guidanceLines.push(`- Prefer setups only when observed market volume is at least ${Number(guidance.minVolume).toFixed(0)}.`)
  if (Number.isFinite(Number(guidance?.highSeverityCount)) && Number(guidance.highSeverityCount) > 0) guidanceLines.push(`- Require roughly ${Number(guidance.highSeverityCount).toFixed(0)} high-severity catalyst events before treating feed context as strongly aligned.`)

  const riskLines = []
  if (Number.isFinite(Number(riskDefaults?.maxPositionPct)) && Number(riskDefaults.maxPositionPct) > 0) riskLines.push(`- Hard guard: max position ${Number(riskDefaults.maxPositionPct).toFixed(0)}% of allocated balance.`)
  if (Number.isFinite(Number(riskDefaults?.stopLossPct)) && Number(riskDefaults.stopLossPct) > 0) riskLines.push(`- Hard guard: stop-loss at ${Number(riskDefaults.stopLossPct).toFixed(1)}% unrealized PnL.`)
  if (Number.isFinite(Number(riskDefaults?.maxDailyTrades)) && Number(riskDefaults.maxDailyTrades) > 0) riskLines.push(`- Hard guard: no more than ${Number(riskDefaults.maxDailyTrades).toFixed(0)} trades in 24h.`)
  if (Number.isFinite(Number(riskDefaults?.maxPositionAgeMs)) && Number(riskDefaults.maxPositionAgeMs) > 0) riskLines.push(`- Hard guard: stale positions are force-exited after about ${Math.max(1, Math.round(Number(riskDefaults.maxPositionAgeMs) / 60000))} minutes.`)

  if (guidanceLines.length === 0 && riskLines.length === 0) return base

  return `${base}\n\n## Active Strategy Template Guidance\n${guidanceLines.concat(riskLines).join('\n')}`
}

function renderUser(ctx, memory) {
  const { agent: a, market: m, orderBook: ob, indexes, technicals: t, meta } = ctx

  // Format candles
  const candleStr = m.candles.length
    ? m.candles.map((c, i) => `  ${i + 1}. O=${c.open} H=${c.high} L=${c.low} C=${c.close}`).join('\n')
    : '  (not enough data yet)'

  // Format agent's recent trades
  const tradesStr = a.recentTrades.length
    ? a.recentTrades.map(t => `  ${(t.side || '?').toUpperCase()} ${t.size} @ $${t.price} → PnL $${t.pnl}`).join('\n')
    : '  (no recent trades)'

  // Format market recent trades
  const marketTradesStr = m.recentTrades?.length
    ? m.recentTrades.map(t => `  ${(t.side || '?').toUpperCase()} ${t.size} @ $${t.price}`).join('\n')
    : '  (no recent fills)'

  // Format order book depth
  const bidsStr = ob?.bids?.length
    ? ob.bids.map(l => `  $${l.price} — ${l.volume} units`).join('\n')
    : '  (no bids)'
  const asksStr = ob?.asks?.length
    ? ob.asks.map(l => `  $${l.price} — ${l.volume} units`).join('\n')
    : '  (no asks)'

  // Format indexes — RICH context with formula, factors, drivers, technicals
  let indexStr = ''
  if (indexes.length) {
    indexStr = indexes.map(ix => {
      const lines = []
      lines.push(`### ${ix.symbol} — ${ix.name}`)

      // Formula explanation
      if (ix.formula?.formulaStr) {
        lines.push(`**Formula**: ${ix.formula.formulaStr}`)
        lines.push(`**Behavior**: ${ix.formula.behavior || 'N/A'}`)
      }

      // Price table
      lines.push('')
      lines.push(`| Metric | Value |`)
      lines.push(`|--------|-------|`)
      lines.push(`| Oracle Price | $${ix.oraclePrice} (${ix.oracleChangePct >= 0 ? '+' : ''}${ix.oracleChangePct}% last tick) |`)
      lines.push(`| Market Mid | $${ix.mid} |`)
      lines.push(`| Price vs Oracle | ${ix.priceVsOracle >= 0 ? '+' : ''}${ix.priceVsOracle}% |`)
      lines.push(`| Trading Band | [$${ix.bandLow}, $${ix.bandHigh}] (±${ix.bandWidthPct}%) |`)
      lines.push(`| Trend | ${ix.trend} | Price Δ(10) | ${ix.priceChange10}% |`)

      // Oracle Factors breakdown
      const factorEntries = Object.entries(ix.factors || {})
      if (factorEntries.length > 0) {
        lines.push('')
        lines.push(`**Oracle Factors** (each >1.0 pushes price UP, <1.0 pushes DOWN):`)
        lines.push(`| Factor | Value |`)
        lines.push(`|--------|-------|`)
        for (const [name, val] of factorEntries) {
          const arrow = val > 1.01 ? '↑' : val < 0.99 ? '↓' : '→'
          lines.push(`| ${name} | ${val} ${arrow} |`)
        }
        if (ix.strongestFactor) {
          lines.push(`| **Strongest** | ${ix.strongestFactor.name} = ${ix.strongestFactor.value} |`)
        }
        if (ix.weakestFactor) {
          lines.push(`| **Weakest** | ${ix.weakestFactor.name} = ${ix.weakestFactor.value} |`)
        }
      }

      // Formula Inputs (what drives the factors)
      const inp = ix.inputs || {}
      const inputLines = []
      if (inp.activeAgents) inputLines.push(`Agents: ${inp.activeAgents}`)
      if (inp.volume24h) inputLines.push(`Vol24h: $${inp.volume24h}`)
      if (inp.trades24h) inputLines.push(`Trades24h: ${inp.trades24h}`)
      if (inp.holderCount) inputLines.push(`Holders: ${inp.holderCount}`)
      if (inp.daysSinceLaunch) inputLines.push(`Days: ${inp.daysSinceLaunch}`)
      if (inp.avgPnlPct != null) inputLines.push(`FleetPnL: ${inp.avgPnlPct}%`)
      if (inp.avgWinRate != null) inputLines.push(`WinRate: ${(inp.avgWinRate * 100).toFixed(1)}%`)
      if (inp.tradingAgentsPct != null) inputLines.push(`TradingPct: ${(inp.tradingAgentsPct * 100).toFixed(1)}%`)
      if (inputLines.length > 0) {
        lines.push(`**Inputs**: ${inputLines.join(' | ')}`)
      }

      // Price Drivers explanation
      if (ix.formula?.drivers?.length) {
        lines.push('')
        lines.push(`**What drives this price:**`)
        for (const d of ix.formula.drivers) {
          const arrow = d.effect === 'up' ? '↑' : d.effect === 'both' ? '↕' : '→'
          lines.push(`- ${arrow} **${d.name}**: ${d.desc}`)
        }
      }

      // Supply & Treasury
      if (ix.supply?.max > 0) {
        lines.push(`**Supply**: ${ix.supply.circulating.toLocaleString()} / ${ix.supply.max.toLocaleString()} (${ix.supply.pct}% minted)`)
      }
      if (ix.treasury?.balance > 0 || ix.treasury?.totalCollected > 0) {
        lines.push(`**Treasury**: balance=$${ix.treasury.balance}, collected=$${ix.treasury.totalCollected}, redistributed=$${ix.treasury.totalRedistributed}`)
      }

      // Per-index technicals
      const t = ix.technicals || {}
      if (t.ema10) {
        lines.push(`**Technicals**: EMA(10)=$${t.ema10} EMA(20)=$${t.ema20} [${t.emaSignal || '?'}] | RSI=${t.rsi14} [${t.rsiSignal || '?'}] | Mom=${t.momentum || 0}%`)
      }

      // Order book & recent trades
      if (ix.orderBook?.bestBid) {
        lines.push(`**Book**: bid=$${ix.orderBook.bestBid} ask=$${ix.orderBook.bestAsk} spread=$${ix.orderBook.spread}`)
      }
      if (ix.recentTrades?.length) {
        lines.push(`**Recent**: ${ix.recentTrades.map(t => `${(t.side || '?').toUpperCase()} ${t.size}@$${t.price}${t.isMint ? ' (MINT)' : ''}`).join(', ')}`)
      }

      lines.push(`**Volume**: $${ix.totalVolume} | **Trades**: ${ix.totalTrades} | **Holders**: ${ix.holderCount}`)

      // Agent's own activity on this index
      const act = ix.agentActivity
      if (act && act.tradeCount > 0) {
        lines.push('')
        lines.push(`**📋 Your ${ix.symbol} Position:**`)
        lines.push(`| Metric | Value |`)
        lines.push(`|--------|-------|`)
        lines.push(`| Holding | ${act.position} units |`)
        lines.push(`| Realized PnL | $${act.realizedPnl} |`)
        lines.push(`| Total Bought | ${act.totalBought} @ avg $${act.avgBuyPrice} |`)
        if (act.totalSold > 0) {
          lines.push(`| Total Sold | ${act.totalSold} @ avg $${act.avgSellPrice} |`)
        }
        lines.push(`| Trades | ${act.tradeCount} |`)
        if (act.recentTrades.length > 0) {
          lines.push(`**Your recent ${ix.symbol} trades:**`)
          for (const t of act.recentTrades) {
            lines.push(`  ${(t.side || '?').toUpperCase()} ${t.size} @ $${t.price} → PnL $${t.pnl}`)
          }
        }
      } else {
        lines.push(`**📋 Your ${ix.symbol} Position:** none (you haven't traded this index yet)`)
      }

      return lines.join('\n')
    }).join('\n\n---\n\n')
  }

  // Format memory
  let memoryStr = ''
  let memoryCount = 0
  if (memory?.decisions?.length) {
    memoryCount = memory.decisions.length
    memoryStr = memory.decisions.map((d, i) => {
      // db.js returns camelCase: outcomeTag / outcomePnl
      const tag = d.outcomeTag || d.outcome_tag
      const pnl = d.outcomePnl ?? d.outcome_pnl ?? 0
      const outcome = tag ? ` → ${tag} ($${Number(pnl).toFixed(4)})` : ''
      return `  ${i + 1}. Tick ${d.tick}: ${d.action} @ $${(d.price || 0).toFixed(4)} × ${(d.size || 0).toFixed(2)} | conf=${d.confidence}${outcome} | "${(d.reasoning || '').substring(0, 60)}"`
    }).join('\n')
  }

  // Format insight
  let insightStr = ''
  if (memory?.insights?.length) {
    const top = memory.insights[0]
    insightStr = typeof top.content === 'string' ? top.content : (top.content?.one_line_insight || JSON.stringify(top.content))
  }

  let result = _userTpl
    // Meta
    .replace('{{tickCount}}',       String(meta.tickCount))
    .replace('{{timestamp}}',       meta.timestamp || '')
    // Market
    .replace('{{mid}}',             String(m.mid))
    .replace('{{bestBid}}',         String(m.bestBid))
    .replace('{{bestAsk}}',         String(m.bestAsk))
    .replace('{{spread}}',          String(m.spread))
    .replace('{{spreadPct}}',       String(m.spreadPct))
    .replace('{{volatility}}',      String(m.volatility))
    .replace('{{bandLow}}',         String(m.bandLow))
    .replace('{{bandHigh}}',        String(m.bandHigh))
    .replace('{{bandWidthPct}}',    String(m.bandWidthPct))
    .replace('{{trend}}',           m.trend)
    .replace('{{high24h}}',         String(m.high24h))
    .replace('{{low24h}}',          String(m.low24h))
    .replace('{{totalVolume}}',     String(m.totalVolume))
    .replace('{{totalTrades}}',     String(m.totalTrades))
    // Technicals
    .replace('{{ema10}}',           String(t?.ema10 || 0))
    .replace('{{ema20}}',           String(t?.ema20 || 0))
    .replace('{{emaSignal}}',       t?.emaSignal || 'neutral')
    .replace('{{rsi14}}',           String(t?.rsi14 || 50))
    .replace('{{rsiSignal}}',       t?.rsiSignal || 'neutral')
    .replace('{{momentum}}',        String(t?.momentum || 0))
    .replace('{{priceChange5}}',    String(t?.priceChange5 || 0))
    .replace('{{priceChange20}}',   String(t?.priceChange20 || 0))
    .replace('{{support}}',         String(t?.support || 0))
    .replace('{{resistance}}',      String(t?.resistance || 0))
    .replace('{{priceVsSupport}}',  String(t?.priceVsSupport || 0))
    .replace('{{priceVsResistance}}', String(t?.priceVsResistance || 0))
    // Order book
    .replace('{{orderBookBids}}',   bidsStr)
    .replace('{{orderBookAsks}}',   asksStr)
    .replace('{{totalBidVol}}',     String(ob?.totalBidVol || 0))
    .replace('{{totalAskVol}}',     String(ob?.totalAskVol || 0))
    .replace('{{obImbalanceRatio}}', String(ob?.imbalanceRatio || 0.5))
    .replace('{{imbalanceSignal}}', m.imbalance.signal)
    .replace('{{imbalanceRatio}}',  String(m.imbalance.ratio))
    .replace('{{candles}}',         candleStr)
    .replace('{{marketTrades}}',    marketTradesStr)
    // Agent portfolio
    .replace('{{balance}}',         String(a.balance))
    .replace('{{position}}',        String(a.position))
    .replace('{{avgEntryPrice}}',   String(a.avgEntryPrice))
    .replace('{{equity}}',          String(a.equity))
    .replace('{{realizedPnl}}',     String(a.realizedPnl))
    .replace('{{unrealizedPnl}}',   String(a.unrealizedPnl))
    .replace('{{maxDrawdown}}',     String(a.maxDrawdown))
    .replace('{{winRate}}',         a.winRate)
    .replace('{{openOrders}}',      String(a.openOrders))
    .replace('{{recentTrades}}',    tradesStr)
    .replace('{{memoryCount}}',     String(memoryCount))

  // Conditional sections
  if (indexStr) {
    result = result.replace('{{#if indexes}}', '').replace('{{/if}}', '').replace('{{indexDetails}}', indexStr)
  } else {
    result = result.replace(/\{\{#if indexes\}\}[\s\S]*?\{\{\/if\}\}/g, '')
  }

  if (memoryStr) {
    result = result.replace('{{#if memory}}', '').replace('{{/if}}', '').replace('{{memory}}', memoryStr)
  } else {
    result = result.replace(/\{\{#if memory\}\}[\s\S]*?\{\{\/if\}\}/g, '')
  }

  if (insightStr) {
    result = result.replace('{{#if insight}}', '').replace('{{/if}}', '').replace('{{insight}}', insightStr)
  } else {
    result = result.replace(/\{\{#if insight\}\}[\s\S]*?\{\{\/if\}\}/g, '')
  }

  return result
}

export default { buildPrompts, buildReflectionPrompts }
