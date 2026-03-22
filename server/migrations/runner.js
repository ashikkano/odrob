// ═══════════════════════════════════════════════════════════════════════
// DB-002 — Lightweight SQL Migration Runner
// Reads numbered .sql files from this directory, runs them in order,
// tracks applied versions in schema_version table.
// ═══════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Run all pending migrations on a better-sqlite3 Database instance.
 * Migration files must be named: 001_description.sql, 002_description.sql, etc.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations(db) {
  // 1. Ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version   INTEGER PRIMARY KEY,
      filename  TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      checksum  TEXT
    );
  `)

  // 2. Read already-applied versions
  const appliedRows = db.prepare('SELECT version FROM schema_version ORDER BY version').all()
  const appliedSet = new Set(appliedRows.map(r => r.version))

  // 3. Read migration files sorted by number prefix
  const files = readdirSync(__dirname)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort()

  const applied = []
  const skipped = []

  const insertVersion = db.prepare(
    'INSERT INTO schema_version (version, filename, applied_at, checksum) VALUES (?, ?, ?, ?)'
  )

  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10)
    if (appliedSet.has(version)) {
      skipped.push(file)
      continue
    }

    const sql = readFileSync(join(__dirname, file), 'utf-8')
    const checksum = simpleHash(sql)

    // Run migration inside a transaction
    const runMigration = db.transaction(() => {
      // Split on semicolons to handle multi-statement SQL files
      // (better-sqlite3's exec handles multi-statement, but we want error clarity)
      db.exec(sql)
      insertVersion.run(version, file, Date.now(), checksum)
    })

    try {
      runMigration()
      applied.push(file)
      console.log(`  📦 Migration ${file} — applied`)
    } catch (err) {
      console.error(`  ❌ Migration ${file} FAILED:`, err.message)
      throw err // Stop on first failure — don't leave DB in partial state
    }
  }

  if (applied.length > 0) {
    console.log(`✅ Migrations: ${applied.length} applied, ${skipped.length} skipped`)
  } else if (skipped.length > 0) {
    console.log(`✅ Migrations: all ${skipped.length} already applied`)
  }

  return { applied, skipped }
}

/** Simple string hash for checksum tracking */
function simpleHash(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + c
    hash |= 0 // Convert to 32-bit integer
  }
  return hash.toString(16)
}
