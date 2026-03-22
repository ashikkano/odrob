import Database from 'better-sqlite3'
import pg from 'pg'
import { createHash } from 'crypto'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const { Client } = pg

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SQLITE_PATH = resolve(__dirname, '../../data/odrob.db')
const SQLITE_INTERNAL_TABLE_PREFIX = 'sqlite_'
const DEFAULT_BATCH_SIZE = 250
const DEFAULT_ROW_HASH_LIMIT = 5000

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

function quoteSqliteIdent(value) {
  return quoteIdent(value)
}

function sanitizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'unnamed'
}

function mapSqliteTypeToPostgres(type = '') {
  const normalized = String(type || '').trim().toUpperCase()
  if (!normalized) return 'TEXT'
  if (normalized.includes('INT')) return 'BIGINT'
  if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) return 'DOUBLE PRECISION'
  if (normalized.includes('BLOB')) return 'BYTEA'
  if (normalized.includes('NUMERIC') || normalized.includes('DECIMAL')) return 'NUMERIC'
  return 'TEXT'
}

function mapSqliteDefaultToPostgres(defaultValue) {
  if (defaultValue == null) return null

  const normalized = String(defaultValue).trim()
  if (!normalized) return null

  if (normalized === "(unixepoch('now') * 1000)" || normalized === "unixepoch('now') * 1000") {
    return "(extract(epoch from now()) * 1000)::bigint"
  }

  if (normalized === 'CURRENT_TIMESTAMP') {
    return 'CURRENT_TIMESTAMP'
  }

  return normalized
}

function normalizeFkAction(value) {
  const action = String(value || 'NO ACTION').toUpperCase()
  if (['CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION'].includes(action)) return action
  return 'NO ACTION'
}

function groupForeignKeys(rows = []) {
  const byId = new Map()
  for (const row of rows) {
    const existing = byId.get(row.id) || {
      id: row.id,
      referencedTable: row.table,
      fromColumns: [],
      toColumns: [],
      onUpdate: normalizeFkAction(row.on_update),
      onDelete: normalizeFkAction(row.on_delete),
    }
    existing.fromColumns.push(row.from)
    existing.toColumns.push(row.to)
    byId.set(row.id, existing)
  }
  return [...byId.values()]
}

function deriveIndexName(tableName, index) {
  if (index.name && !index.name.startsWith('sqlite_autoindex')) return index.name
  const prefix = index.unique ? 'ux' : 'ix'
  const cols = index.columns.map((column) => sanitizeName(column.name)).join('_') || 'all'
  return `${prefix}_${sanitizeName(tableName)}_${cols}`.slice(0, 63)
}

function extractPartialWhere(indexSql = '') {
  const match = String(indexSql || '').match(/\bWHERE\b([\s\S]+)$/i)
  return match ? match[1].trim() : null
}

function buildOrderByClause(columns = []) {
  if (!columns.length) return ''
  return columns.map((column) => quoteIdent(column)).join(', ')
}

function normalizeScalarForHash(value, columnType = '') {
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (value === null || value === undefined) return null

  const type = String(columnType || '').toUpperCase()
  const hasIntegerAffinity = /INT/.test(type)
  const hasNumericAffinity = hasIntegerAffinity || /REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(type)

  if (hasNumericAffinity) return String(value)
  return value
}

function normalizeRowForHash(row, columns) {
  const out = {}
  for (const column of columns) {
    const value = row[column.name]
    out[column.name] = normalizeScalarForHash(value, column.type)
  }
  return JSON.stringify(out)
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {
    sqlitePath: process.env.SQLITE_PATH || DEFAULT_SQLITE_PATH,
    postgresUrl: process.env.DATABASE_URL || '',
    schema: process.env.PGSCHEMA || 'public',
    truncate: false,
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    rowHashLimit: DEFAULT_ROW_HASH_LIMIT,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--sqlite' && argv[index + 1]) {
      args.sqlitePath = resolve(argv[index + 1])
      index += 1
    } else if (value === '--database-url' && argv[index + 1]) {
      args.postgresUrl = argv[index + 1]
      index += 1
    } else if (value === '--schema' && argv[index + 1]) {
      args.schema = argv[index + 1]
      index += 1
    } else if (value === '--batch-size' && argv[index + 1]) {
      args.batchSize = Math.max(1, parseInt(argv[index + 1], 10) || DEFAULT_BATCH_SIZE)
      index += 1
    } else if (value === '--row-hash-limit' && argv[index + 1]) {
      args.rowHashLimit = Math.max(1, parseInt(argv[index + 1], 10) || DEFAULT_ROW_HASH_LIMIT)
      index += 1
    } else if (value === '--truncate') {
      args.truncate = true
    } else if (value === '--dry-run') {
      args.dryRun = true
    } else if (value === '--help' || value === '-h') {
      args.help = true
    }
  }

  return args
}

export function printMigrationHelp(commandName) {
  console.log(`Usage: ${commandName} [options]`)
  console.log('')
  console.log('Options:')
  console.log('  --sqlite <path>          Path to SQLite database file')
  console.log('  --database-url <url>     PostgreSQL connection string')
  console.log('  --schema <name>          PostgreSQL schema name (default: public)')
  console.log('  --batch-size <n>         Batch size for inserts (default: 250)')
  console.log('  --truncate               Truncate target tables before import')
  console.log('  --dry-run                Inspect SQLite schema without writing to Postgres')
  console.log('  --row-hash-limit <n>     Exact checksum limit per table for verify script')
}

export function openSqlite(sqlitePath = DEFAULT_SQLITE_PATH) {
  return new Database(resolve(sqlitePath), { readonly: true })
}

export async function openPostgres(postgresUrl) {
  const client = new Client({ connectionString: postgresUrl })
  await client.connect()
  return client
}

export function introspectSqlite(sqliteDb) {
  const tables = sqliteDb.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE '${SQLITE_INTERNAL_TABLE_PREFIX}%'
    ORDER BY name ASC
  `).all()

  return tables.map((table) => {
    const columns = sqliteDb.prepare(`PRAGMA table_info(${quoteSqliteIdent(table.name)})`).all()
      .map((column) => ({
        name: column.name,
        sqliteType: column.type,
        postgresType: mapSqliteTypeToPostgres(column.type),
        notNull: Boolean(column.notnull),
        defaultValue: mapSqliteDefaultToPostgres(column.dflt_value),
        primaryKeyOrdinal: column.pk,
        autoIncrement: /\bAUTOINCREMENT\b/i.test(table.sql || '') && column.pk === 1,
      }))

    const foreignKeys = groupForeignKeys(sqliteDb.prepare(`PRAGMA foreign_key_list(${quoteSqliteIdent(table.name)})`).all())

    const indexes = sqliteDb.prepare(`PRAGMA index_list(${quoteSqliteIdent(table.name)})`).all()
      .filter((index) => index.origin !== 'pk')
      .map((index) => {
        const columnsForIndex = sqliteDb.prepare(`PRAGMA index_info(${quoteSqliteIdent(index.name)})`).all()
        const sqliteIndex = sqliteDb.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index.name)
        return {
          name: deriveIndexName(table.name, {
            ...index,
            columns: columnsForIndex,
          }),
          unique: Boolean(index.unique),
          columns: columnsForIndex.map((column) => ({ name: column.name })),
          where: extractPartialWhere(sqliteIndex?.sql || ''),
        }
      })

    const rowCount = sqliteDb.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdent(table.name)}`).get().count
    const primaryKey = columns
      .filter((column) => column.primaryKeyOrdinal > 0)
      .sort((left, right) => left.primaryKeyOrdinal - right.primaryKeyOrdinal)
      .map((column) => column.name)

    return {
      name: table.name,
      columns,
      foreignKeys,
      indexes,
      primaryKey,
      rowCount,
    }
  })
}

export function printSchemaSummary(tableSpecs) {
  const totalRows = tableSpecs.reduce((sum, table) => sum + table.rowCount, 0)
  console.log(`SQLite inventory: ${tableSpecs.length} tables, ${totalRows} total rows`)
  for (const table of tableSpecs) {
    console.log(`  - ${table.name}: ${table.rowCount} rows, ${table.columns.length} columns${table.foreignKeys.length ? `, ${table.foreignKeys.length} fk` : ''}`)
  }
}

function buildCreateTableSql(schema, table) {
  const primaryKeyColumns = table.primaryKey
  const lines = table.columns.map((column) => {
    const parts = [quoteIdent(column.name)]
    const isSinglePrimaryKey = primaryKeyColumns.length === 1 && primaryKeyColumns[0] === column.name

    if (column.autoIncrement && isSinglePrimaryKey) {
      parts.push('BIGINT GENERATED BY DEFAULT AS IDENTITY')
    } else {
      parts.push(column.postgresType)
    }

    if (column.defaultValue && !(column.autoIncrement && isSinglePrimaryKey)) {
      parts.push(`DEFAULT ${column.defaultValue}`)
    }

    if (column.notNull || isSinglePrimaryKey) {
      parts.push('NOT NULL')
    }

    if (isSinglePrimaryKey) {
      parts.push('PRIMARY KEY')
    }

    return `  ${parts.join(' ')}`
  })

  if (primaryKeyColumns.length > 1) {
    lines.push(`  PRIMARY KEY (${primaryKeyColumns.map(quoteIdent).join(', ')})`)
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.${quoteIdent(table.name)} (\n${lines.join(',\n')}\n);`
}

async function ensureSchema(client, schema) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`)
}

async function createTables(client, schema, tableSpecs) {
  for (const table of tableSpecs) {
    await client.query(buildCreateTableSql(schema, table))
  }
}

async function truncateTables(client, schema, tableSpecs) {
  if (!tableSpecs.length) return
  const targets = tableSpecs.map((table) => `${quoteIdent(schema)}.${quoteIdent(table.name)}`).join(', ')
  await client.query(`TRUNCATE TABLE ${targets} RESTART IDENTITY CASCADE`)
}

async function insertRows(client, schema, table, rows) {
  if (!rows.length) return 0
  const columnNames = table.columns.map((column) => column.name)
  const values = []
  const tuples = rows.map((row, rowIndex) => {
    const placeholders = columnNames.map((_column, columnIndex) => `$${(rowIndex * columnNames.length) + columnIndex + 1}`)
    for (const columnName of columnNames) {
      const value = row[columnName]
      values.push(value === undefined ? null : value)
    }
    return `(${placeholders.join(', ')})`
  })

  const sql = `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table.name)} (${columnNames.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')}`
  await client.query(sql, values)
  return rows.length
}

async function copyTable(client, sqliteDb, schema, table, batchSize) {
  const statement = sqliteDb.prepare(`SELECT * FROM ${quoteSqliteIdent(table.name)}`)
  let batch = []
  let copied = 0
  for (const row of statement.iterate()) {
    batch.push(row)
    if (batch.length >= batchSize) {
      copied += await insertRows(client, schema, table, batch)
      batch = []
    }
  }
  if (batch.length) copied += await insertRows(client, schema, table, batch)
  return copied
}

async function syncIdentity(client, schema, table) {
  for (const column of table.columns.filter((candidate) => candidate.autoIncrement)) {
    const sequenceResult = await client.query(
      `SELECT pg_get_serial_sequence($1, $2) AS sequence_name`,
      [`${schema}.${table.name}`, column.name],
    )
    const sequenceName = sequenceResult.rows[0]?.sequence_name
    if (!sequenceName) continue

    const maxIdResult = await client.query(
      `SELECT MAX(${quoteIdent(column.name)}) AS max_id FROM ${quoteIdent(schema)}.${quoteIdent(table.name)}`,
    )
    const maxId = maxIdResult.rows[0]?.max_id

    if (maxId === null || maxId === undefined) {
      await client.query(`SELECT setval($1, 1, false)`, [sequenceName])
      continue
    }

    await client.query(`SELECT setval($1, $2::bigint, true)`, [sequenceName, String(maxId)])
  }
}

async function createIndexes(client, schema, tableSpecs) {
  for (const table of tableSpecs) {
    for (const index of table.indexes) {
      const whereClause = index.where ? ` WHERE ${index.where}` : ''
      const unique = index.unique ? 'UNIQUE ' : ''
      const columns = index.columns.map((column) => quoteIdent(column.name)).join(', ')
      await client.query(`CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(schema)}.${quoteIdent(table.name)} (${columns})${whereClause}`)
    }
  }
}

async function constraintExists(client, schema, constraintName) {
  const result = await client.query(
    `SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.conname = $2 LIMIT 1`,
    [schema, constraintName],
  )
  return result.rowCount > 0
}

async function createForeignKeys(client, schema, tableSpecs) {
  for (const table of tableSpecs) {
    for (const foreignKey of table.foreignKeys) {
      const constraintName = `fk_${sanitizeName(table.name)}_${sanitizeName(foreignKey.fromColumns.join('_'))}_${foreignKey.id}`.slice(0, 63)
      if (await constraintExists(client, schema, constraintName)) continue
      await client.query(`
        ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(table.name)}
        ADD CONSTRAINT ${quoteIdent(constraintName)}
        FOREIGN KEY (${foreignKey.fromColumns.map(quoteIdent).join(', ')})
        REFERENCES ${quoteIdent(schema)}.${quoteIdent(foreignKey.referencedTable)} (${foreignKey.toColumns.map(quoteIdent).join(', ')})
        ON UPDATE ${foreignKey.onUpdate}
        ON DELETE ${foreignKey.onDelete}
      `)
    }
  }
}

export async function migrateSqliteToPostgres({ sqlitePath, postgresUrl, schema = 'public', truncate = false, dryRun = false, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const sqliteDb = openSqlite(sqlitePath)
  try {
    const tableSpecs = introspectSqlite(sqliteDb)
    printSchemaSummary(tableSpecs)

    if (dryRun) {
      return {
        tableCount: tableSpecs.length,
        totalRows: tableSpecs.reduce((sum, table) => sum + table.rowCount, 0),
        tableSpecs,
      }
    }

    if (!postgresUrl) {
      throw new Error('DATABASE_URL or --database-url is required unless --dry-run is used')
    }

    const client = await openPostgres(postgresUrl)
    try {
      await ensureSchema(client, schema)
      await createTables(client, schema, tableSpecs)
      if (truncate) await truncateTables(client, schema, tableSpecs)

      for (const table of tableSpecs) {
        const copied = await copyTable(client, sqliteDb, schema, table, batchSize)
        await syncIdentity(client, schema, table)
        console.log(`Copied ${copied} rows -> ${schema}.${table.name}`)
      }

      await createIndexes(client, schema, tableSpecs)
      await createForeignKeys(client, schema, tableSpecs)

      return {
        tableCount: tableSpecs.length,
        totalRows: tableSpecs.reduce((sum, table) => sum + table.rowCount, 0),
        tableSpecs,
      }
    } finally {
      await client.end()
    }
  } finally {
    sqliteDb.close()
  }
}

async function fetchPostgresCount(client, schema, tableName) {
  const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(schema)}.${quoteIdent(tableName)}`)
  return Number(result.rows[0]?.count || 0)
}

function orderColumnsForComparison(table) {
  if (table.primaryKey.length) return table.primaryKey
  return table.columns.map((column) => column.name)
}

function buildSqliteComparisonRows(sqliteDb, table, limit) {
  const columns = table.columns
  const orderColumns = orderColumnsForComparison(table)
  const orderBy = buildOrderByClause(orderColumns)
  const sql = `SELECT * FROM ${quoteSqliteIdent(table.name)}${orderBy ? ` ORDER BY ${orderBy}` : ''}${limit ? ` LIMIT ${limit}` : ''}`
  const rows = sqliteDb.prepare(sql).all()
  return rows.map((row) => normalizeRowForHash(row, columns))
}

async function buildPostgresComparisonRows(client, schema, table, limit) {
  const columns = table.columns
  const orderColumns = orderColumnsForComparison(table)
  const orderBy = buildOrderByClause(orderColumns)
  const sql = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table.name)}${orderBy ? ` ORDER BY ${orderBy}` : ''}${limit ? ` LIMIT ${limit}` : ''}`
  const result = await client.query(sql)
  return result.rows.map((row) => normalizeRowForHash(row, columns))
}

function digestRows(rows) {
  const hash = createHash('sha256')
  for (const row of rows) hash.update(row)
  return hash.digest('hex')
}

export async function verifySqliteToPostgres({ sqlitePath, postgresUrl, schema = 'public', rowHashLimit = DEFAULT_ROW_HASH_LIMIT } = {}) {
  if (!postgresUrl) {
    throw new Error('DATABASE_URL or --database-url is required for verification')
  }

  const sqliteDb = openSqlite(sqlitePath)
  const client = await openPostgres(postgresUrl)
  try {
    const tableSpecs = introspectSqlite(sqliteDb)
    const report = []

    for (const table of tableSpecs) {
      const sqliteCount = table.rowCount
      const postgresCount = await fetchPostgresCount(client, schema, table.name)
      let exactHash = null
      let exactMatch = null

      if (sqliteCount <= rowHashLimit && postgresCount === sqliteCount) {
        const sqliteRows = buildSqliteComparisonRows(sqliteDb, table, rowHashLimit)
        const postgresRows = await buildPostgresComparisonRows(client, schema, table, rowHashLimit)
        exactHash = {
          sqlite: digestRows(sqliteRows),
          postgres: digestRows(postgresRows),
        }
        exactMatch = exactHash.sqlite === exactHash.postgres
      }

      report.push({
        table: table.name,
        sqliteCount,
        postgresCount,
        countsMatch: sqliteCount === postgresCount,
        exactMatch,
      })
    }

    return report
  } finally {
    sqliteDb.close()
    await client.end()
  }
}