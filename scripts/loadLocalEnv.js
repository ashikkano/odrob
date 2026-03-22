import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseEnvValue(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) return ''

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  return value
}

function parseEnvFile(filePath) {
  const parsed = {}
  const content = readFileSync(filePath, 'utf8')

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    if (!key) continue

    const rawValue = trimmed.slice(separatorIndex + 1)
    parsed[key] = parseEnvValue(rawValue)
  }

  return parsed
}

export function loadLocalEnv({ overrideProcessEnv = false } = {}) {
  const files = [
    path.join(ROOT, '.env'),
    path.join(ROOT, '.env.local'),
  ]

  const merged = {}
  for (const filePath of files) {
    if (!existsSync(filePath)) continue
    Object.assign(merged, parseEnvFile(filePath))
  }

  if (overrideProcessEnv) {
    for (const [key, value] of Object.entries(merged)) {
      if (!(key in process.env)) {
        process.env[key] = value
      }
    }
  }

  return merged
}

export function getWorkspaceRoot() {
  return ROOT
}