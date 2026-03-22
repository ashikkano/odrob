import { RingBuffer } from './ringBuffer.js'
import {
  countPersistedAdminAuditEvents as countPersistedAdminAuditEventsRuntime,
  countPersistedAdminAuditEventsFiltered as countPersistedAdminAuditEventsFilteredRuntime,
  listPersistedAdminAuditEvents as listPersistedAdminAuditEventsRuntime,
  listPersistedAdminAuditEventsFiltered as listPersistedAdminAuditEventsFilteredRuntime,
  saveAdminAuditEvent as saveAdminAuditEventRuntime,
} from '../runtimeAuthStore.js'

const AUDIT_BUFFER_CAPACITY = 250
const auditBuffer = new RingBuffer(AUDIT_BUFFER_CAPACITY)

export async function recordAdminAuditEvent(event) {
  const entry = {
    id: `admin_audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...event,
  }

  auditBuffer.push(entry)
  await saveAdminAuditEventRuntime(entry)

  return entry
}

function matchesAuditFilters(event, filters = {}) {
  if (!event) return false
  if (filters.authMode && (event.authMode || 'unknown') !== filters.authMode) return false
  if (filters.action && event.action !== filters.action) return false
  if (filters.actor && event.actor !== filters.actor) return false
  if (filters.targetType && event.targetType !== filters.targetType) return false

  const query = String(filters.query || '').trim().toLowerCase()
  if (!query) return true

  const haystack = [
    event.action,
    event.actor,
    event.authMode,
    event.targetType,
    event.targetId,
    event.details?.summary,
    JSON.stringify(event.details || {}),
  ].filter(Boolean).join(' ').toLowerCase()

  return haystack.includes(query)
}

export async function listAdminAuditEvents(limit = 50, filters = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)
  const persisted = Object.keys(filters || {}).some((key) => filters[key])
    ? await listPersistedAdminAuditEventsFilteredRuntime({ ...filters, limit: safeLimit })
    : await listPersistedAdminAuditEventsRuntime(safeLimit)
  if (persisted.length > 0) return persisted
  return auditBuffer
    .slice(AUDIT_BUFFER_CAPACITY)
    .filter((event) => matchesAuditFilters(event, filters))
    .slice(0, safeLimit)
}

export async function countAdminAuditEvents(filters = {}) {
  const persistedCount = Object.keys(filters || {}).some((key) => filters[key])
    ? await countPersistedAdminAuditEventsFilteredRuntime(filters)
    : await countPersistedAdminAuditEventsRuntime()
  if (persistedCount > 0) return persistedCount

  if (Object.keys(filters || {}).some((key) => filters[key])) {
    return auditBuffer.slice(AUDIT_BUFFER_CAPACITY).filter((event) => matchesAuditFilters(event, filters)).length
  }

  return auditBuffer.length
}
