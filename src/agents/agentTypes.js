// ═══════════════════════════════════════════════════════════════════════
// ODROB Agent Types — Simplified Presets
// 4 clear presets, no jargon. Each pre-configures strategy + risk.
// ═══════════════════════════════════════════════════════════════════════

/**
 * AGENT PRESETS — simple cards for the user to choose from
 */
export const AGENT_PRESETS = {
  conservative: {
    id: 'conservative',
    icon: '🛡️',
    nameKey: 'preset.conservative',
    descKey: 'preset.conservative.desc',
    color: 'text-blue-400',
    colorBg: 'bg-blue-400/10',
    colorBorder: 'border-blue-400/30',
    // Internal strategy config
    strategy: 'mean_reversion',
    risk: {
      maxPositionPct: 10,
      maxDrawdownPct: 5,
      dailyLossLimitPct: 3,
      maxOpenPositions: 2,
      stopLossPct: 2,
      takeProfitPct: 3,
      corridorOnly: true,
      cooldownMs: 60000,
    },
    config: {
      deviationThresholdPct: 1.5,
      exitAtOracle: true,
      lookbackPeriods: 12,
    },
  },

  balanced: {
    id: 'balanced',
    icon: '⚖️',
    nameKey: 'preset.balanced',
    descKey: 'preset.balanced.desc',
    color: 'text-yellow-400',
    colorBg: 'bg-yellow-400/10',
    colorBorder: 'border-yellow-400/30',
    strategy: 'corridor_bounce',
    risk: {
      maxPositionPct: 20,
      maxDrawdownPct: 10,
      dailyLossLimitPct: 5,
      maxOpenPositions: 4,
      stopLossPct: 4,
      takeProfitPct: 6,
      corridorOnly: true,
      cooldownMs: 30000,
    },
    config: {
      entryZonePercent: 0.5,
      exitTargetPercent: 50,
      useTrailingStop: true,
      trailingStopPercent: 1.5,
    },
  },

  aggressive: {
    id: 'aggressive',
    icon: '🚀',
    nameKey: 'preset.aggressive',
    descKey: 'preset.aggressive.desc',
    color: 'text-red-400',
    colorBg: 'bg-red-400/10',
    colorBorder: 'border-red-400/30',
    strategy: 'momentum',
    risk: {
      maxPositionPct: 35,
      maxDrawdownPct: 20,
      dailyLossLimitPct: 10,
      maxOpenPositions: 8,
      stopLossPct: 8,
      takeProfitPct: 12,
      corridorOnly: false,
      cooldownMs: 10000,
    },
    config: {
      consecutiveShifts: 2,
      momentumLookback: 6,
      volumeConfirmation: true,
      minMomentumScore: 0.6,
    },
  },

  dca: {
    id: 'dca',
    icon: '📅',
    nameKey: 'preset.dca',
    descKey: 'preset.dca.desc',
    color: 'text-green-400',
    colorBg: 'bg-green-400/10',
    colorBorder: 'border-green-400/30',
    strategy: 'dca',
    risk: {
      maxPositionPct: 100,
      maxDrawdownPct: 50,
      dailyLossLimitPct: 100,
      maxOpenPositions: 1,
      stopLossPct: 0,
      takeProfitPct: 0,
      corridorOnly: false,
      cooldownMs: 300000,
    },
    config: {
      intervalMs: 3600000,
      baseAmountPercent: 5,
      dipMultiplier: 1.5,
      dipThresholdPct: 3,
    },
  },
}

/**
 * AGENT STATUS
 */
export const AGENT_STATUS = {
  CREATING:    'creating',
  FUNDING:     'funding',
  IDLE:        'idle',
  ACTIVE:      'active',
  PAUSED:      'paused',
  STOPPED:     'stopped',
  ERROR:       'error',
}

/**
 * DECISION TYPES — what an agent can decide to do
 */
export const DECISION_TYPES = {
  BUY:            'buy',
  SELL:           'sell',
  HOLD:           'hold',
  CANCEL_ORDER:   'cancel_order',
  REBALANCE:      'rebalance',
  EMERGENCY_EXIT: 'emergency_exit',
}

/**
 * Get preset by ID
 */
export function getPreset(presetId) {
  return AGENT_PRESETS[presetId] || null
}

/**
 * Get all presets as array
 */
export function getPresetsList() {
  return Object.values(AGENT_PRESETS)
}
