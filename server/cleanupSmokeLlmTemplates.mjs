#!/usr/bin/env node

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dbPath = path.join(__dirname, 'data', 'odrob.db')
const db = new Database(dbPath)

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const templates = db.prepare(`
  SELECT id, slug, name
  FROM strategy_templates
  WHERE slug LIKE 'smoke-llm-%'
  ORDER BY created_at DESC
`).all()

if (templates.length === 0) {
  console.log(JSON.stringify({ removedTemplates: 0, removedIds: [], updatedAgents: [] }, null, 2))
  process.exit(0)
}

const templateIds = templates.map((item) => item.id)
const versions = db.prepare(`
  SELECT id, strategy_template_id AS strategyTemplateId
  FROM strategy_versions
  WHERE strategy_template_id IN (${templateIds.map(() => '?').join(',')})
`).all(...templateIds)
const versionIds = versions.map((item) => item.id)
const instances = db.prepare(`
  SELECT id, agent_id AS agentId, strategy_template_id AS strategyTemplateId, strategy_version_id AS strategyVersionId
  FROM agent_strategy_instances
  WHERE strategy_template_id IN (${templateIds.map(() => '?').join(',')})
`).all(...templateIds)
const instanceIds = instances.map((item) => item.id)

const userAgents = db.prepare(`SELECT id, name, config_json AS configJson FROM user_agents`).all()
const updateUserAgent = db.prepare(`UPDATE user_agents SET config_json = ?, updated_at = ? WHERE id = ?`)
const deleteTemplates = db.prepare(`DELETE FROM strategy_templates WHERE id IN (${templateIds.map(() => '?').join(',')})`)

const cleanup = db.transaction(() => {
  const updatedAgents = []
  const now = Date.now()

  for (const agent of userAgents) {
    const config = parseJson(agent.configJson, {})
    const touchesTemplate = templateIds.includes(config.strategyTemplateId)
    const touchesVersion = versionIds.includes(config.strategyVersionId)
    const touchesInstance = instanceIds.includes(config.activeStrategyInstanceId)

    if (!touchesTemplate && !touchesVersion && !touchesInstance) continue

    delete config.activeStrategyInstanceId
    delete config.strategyTemplateId
    delete config.strategyVersionId
    delete config.strategyMode
    delete config.strategySource
    delete config.enableSubscriptionRotation
    delete config.intervalTicks
    delete config.maxActiveSubscriptions
    delete config.minSubLifetimeTicks
    delete config.maxCandidateIndexes
    delete config.rotationGoalMode
    delete config.rotationProfileName
    delete config.rotationScoreWeights
    delete config.rotationFilters
    delete config.rotationChurnBudgetPerDay

    updateUserAgent.run(JSON.stringify(config), now, agent.id)
    updatedAgents.push({ id: agent.id, name: agent.name })
  }

  deleteTemplates.run(...templateIds)
  return updatedAgents
})

const updatedAgents = cleanup()

console.log(JSON.stringify({
  removedTemplates: templates.length,
  removedIds: templateIds,
  removedSlugs: templates.map((item) => item.slug),
  cleanedInstances: instanceIds.length,
  cleanedVersions: versionIds.length,
  updatedAgents,
}, null, 2))
