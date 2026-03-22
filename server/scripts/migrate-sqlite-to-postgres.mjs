import {
  migrateSqliteToPostgres,
  parseCliArgs,
  printMigrationHelp,
} from './lib/sqlitePostgresMigration.mjs'

async function main() {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    printMigrationHelp('node server/scripts/migrate-sqlite-to-postgres.mjs')
    return
  }

  const result = await migrateSqliteToPostgres(args)
  console.log(`Done: ${result.tableCount} tables, ${result.totalRows} rows discovered`)
}

main().catch((error) => {
  console.error('SQLite -> Postgres migration failed')
  console.error(error)
  process.exit(1)
})