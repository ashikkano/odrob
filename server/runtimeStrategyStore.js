// Strategy persistence facade.
//
// Today it re-exports the compatibility implementation from db.js.
// This indirection allows incremental migration to Postgres without
// touching every strategy route/service call site again.

export {
  createAgentStrategyInstance,
  createStrategyExecutionEvent,
  createStrategyRevenueEvent,
  createStrategyTemplate,
  createStrategyVersion,
  ensureLlmSharedStrategyScope,
  getActiveStrategyInstanceForAgent,
  getLatestStrategyVersionForTemplate,
  getLlmSharedStrategyScope,
  getStrategyMarketplaceListing,
  getStrategyRevenueSummaryByOwner,
  getStrategyTemplate,
  getStrategyVersion,
  incrementStrategyInstallCounts,
  listAgentStrategyInstances,
  listLlmSharedStrategyScopes,
  listStrategyTemplates,
  listStrategyExecutionEventsByAgent,
  listStrategyExecutionEventsByTemplate,
  listStrategyMarketplaceListings,
  listStrategyMarketplaceListingsPage,
  listStrategyRevenueEventsByOwner,
  listStrategyVersions,
  loadSystemState,
  markStrategyVersionPublished,
  registerSignalChannel,
  saveSystemState,
  updateLlmSharedStrategyScopePlan,
  updateStrategyTemplateLifecycle,
  upsertAgentChannelSubscription,
  upsertAgentRotationPolicy,
  upsertStrategyMarketplaceListing,
} from './db.js'
