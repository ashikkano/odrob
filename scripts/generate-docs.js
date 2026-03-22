import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const SRC_DIR = path.join(ROOT, 'src')
const SERVER_DIR = path.join(ROOT, 'server')
const OUT_FILE = path.join(ROOT, 'docs', 'COMPONENT_CATALOG.md')
const OUT_PUBLIC_FILE = path.join(ROOT, 'public', 'docs', 'COMPONENT_CATALOG.md')
const LLM_DOC_SOURCE = path.join(ROOT, 'docs', 'LLM_AGENT_ARCHITECTURE.md')
const LLM_DOC_PUBLIC = path.join(ROOT, 'public', 'docs', 'LLM_AGENT_ARCHITECTURE.md')

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build'])

function walk(dir, base = dir, acc = []) {
  const list = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of list) {
    if (IGNORE.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(abs, base, acc)
    } else {
      acc.push(path.relative(base, abs).replace(/\\/g, '/'))
    }
  }
  return acc
}

function byPrefix(files, prefix) {
  return files.filter(f => f.startsWith(prefix))
}

function toMdList(files) {
  if (!files.length) return '- _empty_\n'
  return files.map(f => `- ${f}`).join('\n') + '\n'
}

function parseReactRoutes(appSource) {
  const routes = []
  const routeRegex = /<Route[^>]*path=\"([^\"]+)\"[^>]*>/g
  for (const m of appSource.matchAll(routeRegex)) routes.push(m[1])
  if (appSource.includes('<Route index element=')) routes.unshift('/')
  return Array.from(new Set(routes))
}

function parseExpressRoutes(routeFileSource) {
  const endpoints = []
  const rgx = /router\.(get|post|put|patch|delete)\(\s*['\"`]([^'\"`]+)['\"`]/g
  for (const m of routeFileSource.matchAll(rgx)) {
    endpoints.push(`${m[1].toUpperCase()} ${m[2]}`)
  }
  return endpoints
}

function renderSection(title, body) {
  return `## ${title}\n\n${body}\n`
}

function generate() {
  const srcFiles = walk(SRC_DIR)
  const serverFiles = walk(SERVER_DIR)

  const appFile = path.join(SRC_DIR, 'App.jsx')
  const appSource = fs.existsSync(appFile) ? fs.readFileSync(appFile, 'utf8') : ''
  const reactRoutes = parseReactRoutes(appSource)

  const routeDir = path.join(SERVER_DIR, 'routes')
  const routeFiles = fs.existsSync(routeDir)
    ? fs.readdirSync(routeDir).filter(f => f.endsWith('.js')).sort()
    : []

  const routeMap = routeFiles.map((file) => {
    const abs = path.join(routeDir, file)
    const src = fs.readFileSync(abs, 'utf8')
    return {
      file,
      endpoints: parseExpressRoutes(src),
    }
  })

  const ts = new Date().toISOString()

  let md = ''
  md += '# ODROB Component Catalog\n\n'
  md += `Generated: ${ts}\n\n`
  md += '> Автосгенерированный каталог компонентов (frontend + backend + маршруты).\n\n'

  md += renderSection('Frontend Routes (React)', toMdList(reactRoutes.map(r => `/${r}`.replace('//', '/'))))

  md += renderSection('Frontend: Pages', toMdList(byPrefix(srcFiles, 'pages/')))
  md += renderSection('Frontend: Components', toMdList(byPrefix(srcFiles, 'components/')))
  md += renderSection('Frontend: Services', toMdList(byPrefix(srcFiles, 'services/')))
  md += renderSection('Frontend: Contexts', toMdList(byPrefix(srcFiles, 'contexts/')))
  md += renderSection('Frontend: Styles', toMdList(byPrefix(srcFiles, 'styles/')))

  md += renderSection('Backend: Routes', toMdList(byPrefix(serverFiles, 'routes/')))
  md += renderSection('Backend: Engine', toMdList(byPrefix(serverFiles, 'engine/')))
  md += renderSection('Backend: Middleware', toMdList(byPrefix(serverFiles, 'middleware/')))
  md += renderSection('Backend: Workers', toMdList(byPrefix(serverFiles, 'workers/')))
  md += renderSection('Backend: Utils', toMdList(byPrefix(serverFiles, 'utils/')))
  md += renderSection('Backend: Validation', toMdList(byPrefix(serverFiles, 'validation/')))

  md += '## Express Endpoints by Route Module\n\n'
  for (const row of routeMap) {
    md += `### routes/${row.file}\n\n`
    md += toMdList(row.endpoints)
    md += '\n'
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.mkdirSync(path.dirname(OUT_PUBLIC_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, md, 'utf8')
  fs.writeFileSync(OUT_PUBLIC_FILE, md, 'utf8')

  if (fs.existsSync(LLM_DOC_SOURCE)) {
    fs.copyFileSync(LLM_DOC_SOURCE, LLM_DOC_PUBLIC)
  }

  console.log(`[docs] generated: ${path.relative(ROOT, OUT_FILE)}`)
  console.log(`[docs] generated: ${path.relative(ROOT, OUT_PUBLIC_FILE)}`)
  if (fs.existsSync(LLM_DOC_PUBLIC)) {
    console.log(`[docs] copied: ${path.relative(ROOT, LLM_DOC_PUBLIC)}`)
  }
}

generate()
