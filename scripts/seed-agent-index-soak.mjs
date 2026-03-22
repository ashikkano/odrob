#!/usr/bin/env node

const DEFAULTS = {
  baseUrl: process.env.SOAK_BASE_URL || 'http://localhost:3001',
  adminKey: process.env.SOAK_ADMIN_KEY || process.env.ADMIN_API_KEY || '',
  walletAddress: process.env.SOAK_WALLET_ADDRESS || '0:feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
  durationMinutes: 240,
  intervalMinutes: 2,
  agentsPerCycle: 10,
  virtualBalance: 1000,
  tuneSystem: true,
  restoreSystem: true,
  requestTimeoutMs: 60000,
  summaryFile: '',
  maxIndexesPerAgent: 2,
  minTrades: 0,
}

const NON_LLM_STRATEGIES = [
  'market_maker',
  'trend_follower',
  'mean_reversion',
  'momentum',
  'grid_trader',
  'scalper',
  'contrarian',
  'vwap',
]

const RISK_LEVELS = ['low', 'medium', 'high']

function parseArgs(argv) {
  const options = { ...DEFAULTS }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    const takeValue = () => {
      if (next == null || next.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      index += 1
      return next
    }

    switch (arg) {
      case '--base-url': options.baseUrl = takeValue(); break
      case '--admin-key': options.adminKey = takeValue(); break
      case '--wallet-address': options.walletAddress = takeValue(); break
      case '--duration-minutes': options.durationMinutes = Number(takeValue()); break
      case '--interval-minutes': options.intervalMinutes = Number(takeValue()); break
      case '--agents-per-cycle': options.agentsPerCycle = Number(takeValue()); break
      case '--cycles': options.cycles = Number(takeValue()); break
      case '--virtual-balance': options.virtualBalance = Number(takeValue()); break
      case '--request-timeout-ms': options.requestTimeoutMs = Number(takeValue()); break
      case '--summary-file': options.summaryFile = takeValue(); break
      case '--max-total-indexes': options.maxTotalIndexes = Number(takeValue()); break
      case '--max-indexes-per-agent': options.maxIndexesPerAgent = Number(takeValue()); break
      case '--min-trades': options.minTrades = Number(takeValue()); break
      case '--no-tune-system': options.tuneSystem = false; break
      case '--no-restore-system': options.restoreSystem = false; break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!Number.isFinite(options.agentsPerCycle) || options.agentsPerCycle <= 0) {
    throw new Error('--agents-per-cycle must be > 0')
  }
  if (!Number.isFinite(options.intervalMinutes) || options.intervalMinutes <= 0) {
    throw new Error('--interval-minutes must be > 0')
  }
  if (options.cycles != null && (!Number.isFinite(options.cycles) || options.cycles <= 0)) {
    throw new Error('--cycles must be > 0')
  }
  if (!Number.isFinite(options.durationMinutes) || options.durationMinutes <= 0) {
    throw new Error('--duration-minutes must be > 0')
  }
  if (options.tuneSystem && !options.adminKey) {
    throw new Error('SOAK_ADMIN_KEY or ADMIN_API_KEY is required unless --no-tune-system is used')
  }

  options.totalCycles = options.cycles != null
    ? Math.floor(options.cycles)
    : Math.max(1, Math.round(options.durationMinutes / options.intervalMinutes))
  options.intervalMs = Math.round(options.intervalMinutes * 60_000)
  options.plannedIndexes = options.totalCycles * options.agentsPerCycle
  options.maxTotalIndexes = Math.max(
    Number.isFinite(options.maxTotalIndexes) ? options.maxTotalIndexes : 0,
    options.plannedIndexes + 25,
  )

  return options
}

function printHelp() {
  console.log(`Usage: node scripts/seed-agent-index-soak.mjs [options]

Defaults: 4 hours, every 2 minutes, create 10 agents + 10 indexes.

Options:
  --base-url URL              API base URL (default: ${DEFAULTS.baseUrl})
  --admin-key KEY             Admin API key for system tuning
  --wallet-address ADDR       Wallet used to create authenticated session
  --duration-minutes N        Total soak duration in minutes (default: 240)
  --interval-minutes N        Cycle interval in minutes (default: 2)
  --agents-per-cycle N        Agents created each cycle (default: 10)
  --cycles N                  Override duration/interval and run exactly N cycles
  --virtual-balance N         Starting balance per created agent (default: 1000)
  --max-total-indexes N       Admin cap to set before the test (default: planned + 25)
  --max-indexes-per-agent N   Admin per-agent cap during test (default: 2)
  --min-trades N              Admin minTrades during test (default: 0)
  --request-timeout-ms N      Per-request timeout (default: 20000)
  --summary-file PATH         Optional JSON summary output path
  --no-tune-system            Skip admin tuning step
  --no-restore-system         Do not restore agentIndex config on exit
  --help                      Show this help
`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function nowIso() {
  return new Date().toISOString()
}

function compactError(error) {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error.details?.reasons) return `${error.message || 'Request failed'} (${error.details.reasons.join('; ')})`
  if (error.message) return error.message
  return JSON.stringify(error)
}

function extractEnvelope(body) {
  if (body && typeof body === 'object' && 'success' in body) {
    if (body.success) return body.data
    throw Object.assign(new Error(body.error || 'API request failed'), {
      details: body.details,
      responseBody: body,
    })
  }
  return body
}

class ApiClient {
  constructor({ baseUrl, adminKey, requestTimeoutMs }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.adminKey = adminKey
    this.requestTimeoutMs = requestTimeoutMs
    this.sessionCookie = ''
  }

  async request(path, { method = 'GET', body, headers = {}, admin = false } = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
          ...(admin && this.adminKey ? { 'X-Admin-Key': this.adminKey } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      const setCookie = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()[0]
        : response.headers.get('set-cookie')
      if (setCookie) {
        this.sessionCookie = setCookie.split(';')[0]
      }

      const text = await response.text()
      let parsed = null
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = { success: response.ok, data: text }
        }
      }

      if (!response.ok) {
        const error = parsed && typeof parsed === 'object'
          ? Object.assign(new Error(parsed.error || `HTTP ${response.status}`), { status: response.status, details: parsed.details, responseBody: parsed })
          : Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, responseBody: text })
        throw error
      }

      return extractEnvelope(parsed)
    } finally {
      clearTimeout(timeout)
    }
  }

  async authenticate(walletAddress) {
    const challenge = await this.request('/api/auth/challenge', {
      method: 'POST',
      body: { address: walletAddress },
    })

    await this.request('/api/auth', {
      method: 'POST',
      body: { address: walletAddress, nonce: challenge.nonce },
    })

    return challenge
  }
}

function buildAgentName(sequence, strategy) {
  const suffix = sequence.toString(36).toUpperCase().padStart(4, '0').slice(-4)
  return `Seed ${strategy.slice(0, 3).toUpperCase()} ${suffix}`
}

function buildIndexName(templateName, sequence) {
  const suffix = sequence.toString(36).toUpperCase().padStart(4, '0').slice(-4)
  return `${templateName} ${suffix}`.slice(0, 40)
}

function buildIndexSymbol(sequence) {
  const runToken = Date.now().toString(36).toUpperCase().slice(-3)
  const seqToken = sequence.toString(36).toUpperCase().padStart(2, '0').slice(-2)
  return `X${runToken}${seqToken}`
}

async function tuneSystem(client, options) {
  const systemParams = await client.request('/api/admin/system-params', { admin: true })
  const current = systemParams.agentIndex || {}
  const patch = {
    agentIndex: {
      minTrades: options.minTrades,
      maxIndexesPerAgent: Math.max(current.maxIndexesPerAgent || 0, options.maxIndexesPerAgent),
      maxTotalAgentIndexes: Math.max(current.maxTotalAgentIndexes || 0, options.maxTotalIndexes),
    },
  }

  await client.request('/api/admin/system-params', {
    method: 'PATCH',
    body: patch,
    admin: true,
  })

  return {
    original: {
      minTrades: current.minTrades,
      maxIndexesPerAgent: current.maxIndexesPerAgent,
      maxTotalAgentIndexes: current.maxTotalAgentIndexes,
    },
    applied: patch.agentIndex,
  }
}

async function restoreSystem(client, original) {
  if (!original) return
  await client.request('/api/admin/system-params', {
    method: 'PATCH',
    body: { agentIndex: original },
    admin: true,
  })
}

async function fetchTemplates(client) {
  const templates = await client.request('/api/indexes/templates')
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error('No index templates returned by /api/indexes/templates')
  }
  return templates
}

async function createAgentAndIndex(client, { sequence, cycleNumber, slotNumber, template, strategy, riskLevel, virtualBalance }) {
  const agentPayload = {
    name: buildAgentName(sequence, strategy),
    strategy,
    virtualBalance,
    isUserAgent: false,
    riskLevel,
    bio: `Seed soak cycle ${cycleNumber}, slot ${slotNumber}`,
  }

  const agent = await client.request('/api/engine/agents', {
    method: 'POST',
    body: agentPayload,
  })

  const index = await client.request('/api/indexes/create-by-agent', {
    method: 'POST',
    body: {
      agentId: agent.id,
      templateId: template.id,
      name: buildIndexName(template.name, sequence),
      symbol: buildIndexSymbol(sequence),
    },
  })

  return { agent, index }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const client = new ApiClient(options)
  let interrupted = false
  const summary = {
    startedAt: nowIso(),
    config: {
      baseUrl: options.baseUrl,
      totalCycles: options.totalCycles,
      intervalMinutes: options.intervalMinutes,
      agentsPerCycle: options.agentsPerCycle,
      plannedIndexes: options.plannedIndexes,
    },
    totals: {
      agentsCreated: 0,
      indexesCreated: 0,
      agentFailures: 0,
      indexFailures: 0,
    },
    cycles: [],
  }

  let restoreConfig = null
  let restoreAttempted = false

  const finalize = async (exitCode = 0) => {
    if (restoreAttempted) return
    restoreAttempted = true

    if (options.tuneSystem && options.restoreSystem && restoreConfig) {
      try {
        await restoreSystem(client, restoreConfig)
        console.log(`[${nowIso()}] Restored agentIndex config`) 
      } catch (error) {
        console.error(`[${nowIso()}] Failed to restore agentIndex config: ${compactError(error)}`)
      }
    }

    summary.finishedAt = nowIso()
    if (options.summaryFile) {
      const fs = await import('node:fs/promises')
      await fs.writeFile(options.summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
      console.log(`[${nowIso()}] Wrote summary to ${options.summaryFile}`)
    }

    process.exitCode = exitCode
  }

  const handleSignal = async (signal) => {
    interrupted = true
    console.log(`\n[${nowIso()}] Received ${signal}, shutting down gracefully...`)
    await finalize(1)
    process.exit(1)
  }

  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)

  try {
    console.log(`[${nowIso()}] Authenticating soak runner wallet...`)
    await client.authenticate(options.walletAddress)

    if (options.tuneSystem) {
      console.log(`[${nowIso()}] Raising agent-index limits for soak window...`)
      const tune = await tuneSystem(client, options)
      restoreConfig = tune.original
      console.log(`[${nowIso()}] Applied agentIndex tuning: ${JSON.stringify(tune.applied)}`)
    }

    const templates = await fetchTemplates(client)
    console.log(`[${nowIso()}] Loaded ${templates.length} templates: ${templates.map(t => t.id).join(', ')}`)
    console.log(`[${nowIso()}] Starting soak: ${options.totalCycles} cycles, ${options.agentsPerCycle} agents/cycle, interval ${options.intervalMinutes}m`)

    let globalSequence = 0
    for (let cycleIndex = 0; cycleIndex < options.totalCycles; cycleIndex += 1) {
      if (interrupted) break
      const cycleNumber = cycleIndex + 1
      const cycleStartedAt = Date.now()
      console.log(`\n[${nowIso()}] Cycle ${cycleNumber}/${options.totalCycles} starting...`)

      const tasks = Array.from({ length: options.agentsPerCycle }, (_, slotIndex) => {
        globalSequence += 1
        const template = templates[(cycleIndex * options.agentsPerCycle + slotIndex) % templates.length]
        const strategy = NON_LLM_STRATEGIES[(cycleIndex * options.agentsPerCycle + slotIndex) % NON_LLM_STRATEGIES.length]
        const riskLevel = RISK_LEVELS[(cycleIndex + slotIndex) % RISK_LEVELS.length]

        return createAgentAndIndex(client, {
          sequence: globalSequence,
          cycleNumber,
          slotNumber: slotIndex + 1,
          template,
          strategy,
          riskLevel,
          virtualBalance: options.virtualBalance,
        }).then(result => ({ ok: true, templateId: template.id, strategy, ...result }))
          .catch(error => ({ ok: false, templateId: template.id, strategy, error }))
      })

      const results = await Promise.all(tasks)
      const cycleSummary = {
        cycleNumber,
        startedAt: new Date(cycleStartedAt).toISOString(),
        agentsCreated: 0,
        indexesCreated: 0,
        failures: [],
      }

      for (const result of results) {
        if (result.ok) {
          cycleSummary.agentsCreated += 1
          cycleSummary.indexesCreated += 1
          summary.totals.agentsCreated += 1
          summary.totals.indexesCreated += 1
        } else {
          summary.totals.agentFailures += 1
          summary.totals.indexFailures += 1
          cycleSummary.failures.push({
            templateId: result.templateId,
            strategy: result.strategy,
            error: compactError(result.error),
          })
        }
      }

      cycleSummary.finishedAt = nowIso()
      cycleSummary.durationMs = Date.now() - cycleStartedAt
      summary.cycles.push(cycleSummary)

      console.log(
        `[${nowIso()}] Cycle ${cycleNumber}/${options.totalCycles} done: ` +
        `${cycleSummary.indexesCreated}/${options.agentsPerCycle} indexes created in ${cycleSummary.durationMs}ms`
      )

      if (cycleSummary.failures.length > 0) {
        console.log(`[${nowIso()}] Failures:`)
        for (const failure of cycleSummary.failures.slice(0, 5)) {
          console.log(`  - template=${failure.templateId} strategy=${failure.strategy} → ${failure.error}`)
        }
        if (cycleSummary.failures.length > 5) {
          console.log(`  - ... ${cycleSummary.failures.length - 5} more failure(s)`)
        }
      }

      if (cycleIndex < options.totalCycles - 1) {
        const elapsedMs = Date.now() - cycleStartedAt
        const waitMs = Math.max(0, options.intervalMs - elapsedMs)
        console.log(`[${nowIso()}] Waiting ${(waitMs / 1000).toFixed(1)}s before next cycle...`)
        await sleep(waitMs)
      }
    }

    console.log(`\n[${nowIso()}] Soak completed.`)
    console.log(JSON.stringify(summary.totals, null, 2))
    await finalize(0)
  } catch (error) {
    console.error(`[${nowIso()}] Soak failed: ${compactError(error)}`)
    await finalize(1)
  }
}

main()
