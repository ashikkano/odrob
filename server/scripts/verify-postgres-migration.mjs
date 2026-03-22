import {
  parseCliArgs,
  printMigrationHelp,
  verifySqliteToPostgres,
} from './lib/sqlitePostgresMigration.mjs'

async function main() {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    printMigrationHelp('node server/scripts/verify-postgres-migration.mjs')
    return
  }

  const report = await verifySqliteToPostgres(args)
  let hasMismatch = false

  for (const entry of report) {
    const parts = [
      `${entry.table}`,
      `sqlite=${entry.sqliteCount}`,
      `postgres=${entry.postgresCount}`,
      entry.countsMatch ? 'count=ok' : 'count=mismatch',
    ]

    if (entry.exactMatch === true) parts.push('hash=ok')
    if (entry.exactMatch === false) parts.push('hash=mismatch')
    if (!entry.countsMatch || entry.exactMatch === false) hasMismatch = true

    console.log(parts.join(' | '))
  }

  if (hasMismatch) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('Postgres verification failed')
  console.error(error)
  process.exit(1)
})