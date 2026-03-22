#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// ODROB Dev Runner — robust process manager for local development
// Manages backend (Express) + frontend (Vite) with:
//   • Auto-restart on crash (with backoff)
//   • Health checks
//   • Proper signal forwarding / graceful shutdown
//   • Port cleanup on start
//   • Color-coded prefixed logs
// ═══════════════════════════════════════════════════════════════════════

import { spawn, execSync } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import { loadLocalEnv } from './loadLocalEnv.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LOCAL_ENV = loadLocalEnv({ overrideProcessEnv: true })

// ─── Config ────────────────────────────────────────────────────────────

const BACKEND_PORT = Number(process.env.PORT || process.env.APP_BACKEND_PORT || 3001)
const VITE_PORT = Number(process.env.VITE_PORT || process.env.APP_FRONTEND_PORT || 3000)
const FRESH_DB = process.argv.includes('--fresh')
const NO_VITE = process.argv.includes('--backend-only')
const NO_BACKEND = process.argv.includes('--frontend-only')
const SQLITE_PATH = process.env.SQLITE_PATH || path.join('server', 'data', 'odrob.db')

const MAX_RESTARTS = 5           // max restarts within window
const RESTART_WINDOW_MS = 60000  // 1 minute window
const RESTART_DELAY_BASE = 1000  // initial delay
const RESTART_DELAY_MAX = 15000  // max delay (exponential backoff)
const HEALTH_INTERVAL = 10000    // health check every 10s

// ─── Colors ────────────────────────────────────────────────────────────

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const MAGENTA = '\x1b[35m'
const CYAN = '\x1b[36m'

function log(prefix, color, msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
  console.log(`${DIM}${ts}${RESET} ${color}${BOLD}[${prefix}]${RESET} ${msg}`)
}

const logBackend = (msg) => log('API', BLUE, msg)
const logVite = (msg) => log(' UI', GREEN, msg)
const logSystem = (msg) => log('SYS', MAGENTA, msg)
const logError = (msg) => log('ERR', RED, msg)
const logWarn = (msg) => log('WRN', YELLOW, msg)

// ─── Port cleanup ──────────────────────────────────────────────────────

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf8' }).trim()
    if (pids) {
      execSync(`kill -9 ${pids.split('\n').join(' ')} 2>/dev/null`)
      logSystem(`Killed stale process(es) on port ${port}`)
      return true
    }
  } catch { /* no processes */ }
  return false
}

// ─── Health check ──────────────────────────────────────────────────────

function healthCheck(port, path = '/') {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}${path}`, { timeout: 3000 }, (res) => {
      resolve(res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// ─── Process Manager ───────────────────────────────────────────────────

class ManagedProcess {
  constructor({ name, command, args, cwd, port, color, logFn, healthPath, env }) {
    this.name = name
    this.command = command
    this.args = args
    this.cwd = cwd
    this.port = port
    this.color = color
    this.log = logFn
    this.healthPath = healthPath || '/'
    this.env = { ...LOCAL_ENV, ...process.env, ...env }

    this.proc = null
    this.restartTimestamps = []
    this.restartCount = 0
    this.stopping = false
    this.started = false
    this.healthy = false
  }

  start() {
    if (this.stopping) return

    // Kill anything on our port first
    killPort(this.port)

    this.log(`Starting ${this.name}...`)
    
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.started = true

    // Prefix stdout
    this.proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim())
      for (const line of lines) {
        this.log(line)
      }
    })

    // Prefix stderr 
    this.proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim())
      for (const line of lines) {
        // Vite prints normal info to stderr, don't make it look like error
        if (this.name.includes('Vite')) {
          this.log(line)
        } else {
          logError(`${this.name}: ${line}`)
        }
      }
    })

    // Handle exit
    this.proc.on('exit', (code, signal) => {
      this.proc = null
      this.healthy = false

      if (this.stopping) {
        this.log(`${this.name} stopped.`)
        return
      }

      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
        this.log(`${this.name} exited cleanly (code=${code}, signal=${signal})`)
        return
      }

      logWarn(`${this.name} crashed (code=${code}, signal=${signal})`)
      this._scheduleRestart()
    })

    this.proc.on('error', (err) => {
      logError(`${this.name} spawn error: ${err.message}`)
      this.proc = null
      if (!this.stopping) this._scheduleRestart()
    })
  }

  _scheduleRestart() {
    const now = Date.now()
    // Clean old timestamps outside window
    this.restartTimestamps = this.restartTimestamps.filter(t => now - t < RESTART_WINDOW_MS)
    
    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      logError(`${this.name} crashed ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 1000}s — giving up.`)
      logError(`Fix the error above and restart manually.`)
      return
    }

    this.restartTimestamps.push(now)
    this.restartCount++

    // Exponential backoff
    const delay = Math.min(RESTART_DELAY_BASE * Math.pow(2, this.restartCount - 1), RESTART_DELAY_MAX)
    logWarn(`Restarting ${this.name} in ${(delay / 1000).toFixed(1)}s (attempt ${this.restartCount})...`)
    
    setTimeout(() => {
      if (!this.stopping) this.start()
    }, delay)
  }

  async stop() {
    this.stopping = true
    if (!this.proc) return

    this.log(`Stopping ${this.name} (SIGTERM)...`)

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.proc) {
          logWarn(`${this.name} didn't exit in 5s, sending SIGKILL`)
          this.proc.kill('SIGKILL')
        }
        resolve()
      }, 5000)

      this.proc.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      this.proc.kill('SIGTERM')
    })
  }

  async checkHealth() {
    if (!this.proc || this.stopping) return
    const ok = await healthCheck(this.port, this.healthPath)
    const wasHealthy = this.healthy
    this.healthy = ok
    if (!wasHealthy && ok) {
      this.log(`✅ ${this.name} is healthy on port ${this.port}`)
    }
    if (wasHealthy && !ok) {
      logWarn(`${this.name} health check failed on port ${this.port}`)
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('')
  logSystem(`${'═'.repeat(56)}`)
  logSystem(`  ODROB Dev Runner`)
  logSystem(`  Backend: :${BACKEND_PORT}  |  Vite: :${VITE_PORT}`)
  logSystem(`  Fresh DB: ${FRESH_DB ? 'YES' : 'no'}  |  Auto-restart: ON`)
  logSystem(`${'═'.repeat(56)}`)
  console.log('')

  // Clean DB if --fresh
  if (FRESH_DB) {
    if (SQLITE_PATH === ':memory:') {
      logSystem('Skipping SQLite cleanup because SQLITE_PATH=:memory:')
    }

    const dbPath = path.isAbsolute(SQLITE_PATH)
      ? SQLITE_PATH
      : path.join(ROOT, SQLITE_PATH)
    const walPath = dbPath + '-wal'
    const shmPath = dbPath + '-shm'
    if (SQLITE_PATH !== ':memory:') {
      for (const f of [dbPath, walPath, shmPath]) {
        if (existsSync(f)) {
          unlinkSync(f)
          logSystem(`Deleted ${path.basename(f)}`)
        }
      }
    }
  }

  const processes = []

  // ── Backend ──
  if (!NO_BACKEND) {
    const backend = new ManagedProcess({
      name: 'Express API',
      command: 'node',
      args: ['--watch', 'server/index.js'],
      cwd: ROOT,
      port: BACKEND_PORT,
      color: BLUE,
      logFn: logBackend,
      healthPath: '/api/engine/metrics',
      env: {
        NODE_ENV: 'development',
        ...(process.env.ALLOW_DEV_ADMIN_LOCAL_ONLY ? { ALLOW_DEV_ADMIN_LOCAL_ONLY: process.env.ALLOW_DEV_ADMIN_LOCAL_ONLY } : {}),
      },
    })
    processes.push(backend)
  }

  // ── Vite ──
  if (!NO_VITE) {
    const vite = new ManagedProcess({
      name: 'Vite Dev',
      command: path.join(ROOT, 'node_modules', '.bin', 'vite'),
      args: ['--port', String(VITE_PORT), '--host', '--clearScreen', 'false'],
      cwd: ROOT,
      port: VITE_PORT,
      color: GREEN,
      logFn: logVite,
      healthPath: '/',
      env: { FORCE_COLOR: '1' },
    })
    processes.push(vite)
  }

  if (processes.length === 0) {
    logError('Nothing to start (both --backend-only and --frontend-only?)')
    process.exit(1)
  }

  // Start all
  for (const p of processes) {
    p.start()
  }

  // Periodic health checks
  const healthTimer = setInterval(async () => {
    for (const p of processes) {
      await p.checkHealth()
    }
  }, HEALTH_INTERVAL)

  // ── Graceful shutdown ──
  let shuttingDown = false
  async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true

    console.log('')
    logSystem(`Received ${signal}, shutting down...`)
    clearInterval(healthTimer)

    // Stop in reverse order (vite first, then backend to allow graceful save)
    for (const p of [...processes].reverse()) {
      await p.stop()
    }

    logSystem('All processes stopped. Goodbye! 👋')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Don't crash on unhandled promise rejections in the runner
  process.on('unhandledRejection', (err) => {
    logError(`Unhandled rejection in dev runner: ${err}`)
  })
}

main().catch((err) => {
  logError(`Fatal: ${err.message}`)
  process.exit(1)
})
