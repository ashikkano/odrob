import { Fragment, useMemo, useState } from 'react'
import { createEngineAgent } from '@/services/engineApi'
import {
  STRAT,
  LLM_PROVIDERS,
  LLM_MODELS,
  RISK_LEVELS,
  LITE_RISK_TO_ENGINE_RISK,
  buildLiteStrategyConfig,
} from '@/components/agents/liteAgentWizardShared'
import '@/styles/lite.css'

export default function LiteCreateAgentModal({ walletAddress, onClose, onCreated }) {
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [strategy, setStrategy] = useState(null)
  const [risk, setRisk] = useState('medium')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const [llmProvider, setLlmProvider] = useState('odrob')
  const [llmModel, setLlmModel] = useState('google/gemini-2.0-flash-001')
  const [llmApiKey, setLlmApiKey] = useState('')

  const selectedRisk = useMemo(() => RISK_LEVELS.find((item) => item.id === risk), [risk])
  const selectedStrat = strategy ? STRAT[strategy] : null
  const isLLM = selectedStrat?.isLLM
  const llmProviderMeta = useMemo(() => LLM_PROVIDERS.find((item) => item.id === llmProvider), [llmProvider])
  const llmNeedsKey = llmProviderMeta?.needsKey
  const llmModels = LLM_MODELS[llmProvider] || []
  const aiStrats = useMemo(() => Object.entries(STRAT).filter(([, item]) => item.isLLM), [])
  const classicStrats = useMemo(() => Object.entries(STRAT).filter(([, item]) => !item.isLLM), [])

  const accentColor = selectedStrat?.color || '#818cf8'
  const agentSteps = [
    { num: 1, label: 'Name' },
    { num: 2, label: 'Strategy' },
    { num: 3, label: isLLM ? 'AI Config' : 'Risk' },
    { num: 4, label: 'Launch' },
  ]

  const canGoStep2 = name.trim().length >= 2
  const canGoStep3 = !!strategy
  const canGoStep4 = isLLM ? (!llmNeedsKey || llmApiKey.trim()) : true

  const handleProviderChange = (providerId) => {
    setLlmProvider(providerId)
    const firstModel = LLM_MODELS[providerId]?.[0]
    if (firstModel) setLlmModel(firstModel.id)
    setLlmApiKey('')
  }

  const handleCreate = async () => {
    if (!walletAddress || !strategy) return

    setCreating(true)
    setError(null)
    try {
      const created = await createEngineAgent({
        name: name.trim(),
        strategy,
        icon: selectedStrat?.icon || '🤖',
        virtualBalance: isLLM ? 3000 : 1000,
        isUserAgent: true,
        walletAddress,
        riskLevel: isLLM ? 'medium' : (LITE_RISK_TO_ENGINE_RISK[risk] || 'medium'),
        config: buildLiteStrategyConfig(
          strategy,
          risk,
          isLLM ? { provider: llmProvider, model: llmModel, apiKey: llmNeedsKey ? llmApiKey.trim() : '' } : null,
        ),
        bio: isLLM
          ? `LLM agent (${llmProvider}/${llmModel}) via ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
          : `User agent via ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}. ${selectedStrat?.label} / ${selectedRisk?.label} risk.`,
      })

      if (created?.error) {
        const details = Array.isArray(created.details) && created.details.length > 0
          ? `\n${created.details.map((item) => `• ${item.field}: ${item.message}`).join('\n')}`
          : ''
        setError(`${created.error}${details}`)
        setCreating(false)
        return
      }

      await onCreated?.(created)
    } catch (err) {
      const details = Array.isArray(err?.details) && err.details.length > 0
        ? `\n${err.details.map((item) => `• ${item.field}: ${item.message}`).join('\n')}`
        : ''
      setError(`${err.message || 'Failed to create agent'}${details}`)
      setCreating(false)
      return
    }

    setCreating(false)
  }

  return (
    <div className="lt-modal-overlay" onClick={onClose}>
      <div className="lt-modal lt-ca-modal" onClick={(event) => event.stopPropagation()}>
        <button className="lt-modal-close" onClick={onClose}>✕</button>

        <div className="lt-ca-header">
          <div className="lt-ca-header-glow" style={{ background: `radial-gradient(ellipse at center, ${accentColor}12 0%, transparent 70%)` }} />
          <div className="lt-ca-header-icon">🤖</div>
          <h3 className="lt-ca-title">Create Trading Agent</h3>
          <p className="lt-ca-subtitle">Build and deploy your own AI-powered trader</p>
        </div>

        <div className="lt-ca-stepper">
          {agentSteps.map((item, index) => (
            <Fragment key={item.num}>
              {index > 0 ? <div className={`lt-ca-stepper-line${step > item.num - 1 ? ' lt-ca-stepper-line-done' : ''}`} /> : null}
              <button
                className={`lt-ca-step-pill${step === item.num ? ' lt-ca-step-active' : ''}${step > item.num ? ' lt-ca-step-done' : ''}`}
                onClick={() => { if (step > item.num) setStep(item.num) }}
                disabled={step < item.num}
                style={step === item.num ? { '--lt-ca-accent': accentColor, borderColor: accentColor } : undefined}
              >
                <span className="lt-ca-step-num">{step > item.num ? '✓' : item.num}</span>
                <span className="lt-ca-step-label">{item.label}</span>
              </button>
            </Fragment>
          ))}
        </div>

        {step === 1 && (
          <div className="lt-ca-step lt-ca-step-enter">
            <div className="lt-ca-name-preview">
              <div className="lt-ca-name-avatar">
                <span>{selectedStrat?.icon || '🤖'}</span>
              </div>
              <div className="lt-ca-name-info">
                <span className="lt-ca-name-val">{name || 'Your Agent Name'}</span>
                <span className="lt-ca-name-wallet">{walletAddress?.slice(0, 6)}…{walletAddress?.slice(-4)}</span>
              </div>
              <div className="lt-ca-name-badge">NEW</div>
            </div>

            <div className="lt-ca-field">
              <label className="lt-ca-field-label">Agent Name</label>
              <input
                className="lt-ca-input"
                type="text"
                placeholder="e.g. AlphaBot, NightTrader…"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={20}
                autoFocus
              />
              <div className="lt-ca-field-footer">
                <span className="lt-ca-field-hint">Unique name visible to all traders</span>
                <span className="lt-ca-field-count">{name.length}/20</span>
              </div>
            </div>

            <div className="lt-ca-nav">
              <div />
              <button className="lt-ca-btn-next" disabled={!canGoStep2} onClick={() => setStep(2)}>
                Continue <span className="lt-ca-btn-arrow">→</span>
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="lt-ca-step lt-ca-step-enter">
            <div className="lt-ca-strat-section">
              <div className="lt-ca-strat-section-head">
                <span className="lt-ca-strat-section-icon">🧠</span>
                <span className="lt-ca-strat-section-title">AI-Powered</span>
                <span className="lt-ca-strat-section-tag">NEW</span>
              </div>
              <div className="lt-ca-strat-grid lt-ca-strat-grid-ai">
                {aiStrats.map(([key, item]) => {
                  const selected = strategy === key
                  return (
                    <div
                      key={key}
                      className={`lt-ca-strat-card${selected ? ' lt-ca-strat-card-on' : ''} lt-ca-strat-card-ai`}
                      onClick={() => setStrategy(key)}
                      style={selected ? { borderColor: item.color, '--strat-glow': item.color } : { '--strat-glow': item.color }}
                    >
                      <div className="lt-ca-strat-card-top">
                        <span className="lt-ca-strat-card-icon">{item.icon}</span>
                        {selected && <span className="lt-ca-strat-check" style={{ color: item.color }}>✓</span>}
                      </div>
                      <div className="lt-ca-strat-card-name" style={selected ? { color: item.color } : undefined}>{item.label}</div>
                      <div className="lt-ca-strat-card-desc">{item.desc}</div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="lt-ca-strat-section">
              <div className="lt-ca-strat-section-head">
                <span className="lt-ca-strat-section-icon">⚙️</span>
                <span className="lt-ca-strat-section-title">Classic Algorithms</span>
                <span className="lt-ca-strat-section-count">{classicStrats.length}</span>
              </div>
              <div className="lt-ca-strat-grid">
                {classicStrats.map(([key, item]) => {
                  const selected = strategy === key
                  return (
                    <div
                      key={key}
                      className={`lt-ca-strat-card${selected ? ' lt-ca-strat-card-on' : ''}`}
                      onClick={() => setStrategy(key)}
                      style={selected ? { borderColor: item.color, '--strat-glow': item.color } : { '--strat-glow': item.color }}
                    >
                      <div className="lt-ca-strat-card-top">
                        <span className="lt-ca-strat-card-icon">{item.icon}</span>
                        {selected && <span className="lt-ca-strat-check" style={{ color: item.color }}>✓</span>}
                      </div>
                      <div className="lt-ca-strat-card-name" style={selected ? { color: item.color } : undefined}>{item.label}</div>
                      <div className="lt-ca-strat-card-desc">{item.desc}</div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="lt-ca-nav">
              <button className="lt-ca-btn-back" onClick={() => setStep(1)}>← Back</button>
              <button className="lt-ca-btn-next" disabled={!canGoStep3} onClick={() => setStep(3)}>
                Continue <span className="lt-ca-btn-arrow">→</span>
              </button>
            </div>
          </div>
        )}

        {step === 3 && isLLM && (
          <div className="lt-ca-step lt-ca-step-enter">
            <div className="lt-ca-step-header">
              <h4 className="lt-ca-step-title">🧠 AI Model Configuration</h4>
              <p className="lt-ca-step-desc">Choose the brain powering your agent</p>
            </div>

            <div className="lt-ca-field">
              <label className="lt-ca-field-label">Provider</label>
              <div className="lt-ca-llm-providers">
                {LLM_PROVIDERS.map((provider) => (
                  <button
                    key={provider.id}
                    className={`lt-ca-llm-prov${llmProvider === provider.id ? ' lt-ca-llm-prov-on' : ''}`}
                    onClick={() => handleProviderChange(provider.id)}
                  >
                    {provider.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="lt-ca-field">
              <label className="lt-ca-field-label">Model</label>
              <div className="lt-ca-llm-models">
                {llmModels.map((model) => (
                  <button
                    key={model.id}
                    className={`lt-ca-llm-model${llmModel === model.id ? ' lt-ca-llm-model-on' : ''}`}
                    onClick={() => setLlmModel(model.id)}
                  >
                    {model.label}
                  </button>
                ))}
              </div>
            </div>

            {llmNeedsKey && (
              <div className="lt-ca-field">
                <label className="lt-ca-field-label">API Key</label>
                <input
                  className="lt-ca-input"
                  type="password"
                  placeholder={llmProvider === 'openai' ? 'sk-...' : llmProvider === 'anthropic' ? 'sk-ant-...' : 'sk-or-...'}
                  value={llmApiKey}
                  onChange={(event) => setLlmApiKey(event.target.value)}
                />
                <div className="lt-ca-field-footer">
                  <span className="lt-ca-field-hint">🔒 Encrypted, never shared with third parties</span>
                </div>
              </div>
            )}

            <div className={`lt-ca-llm-banner${llmProvider === 'odrob' ? ' lt-ca-llm-banner-free' : ''}`}>
              {llmProvider === 'odrob' && <><span className="lt-ca-llm-banner-dot" style={{ background: '#6ee7b7' }} />Free — powered by ODROB infrastructure</>}
              {llmProvider === 'openai' && <><span className="lt-ca-llm-banner-dot" style={{ background: '#f59e0b' }} />Requires your OpenAI API key</>}
              {llmProvider === 'anthropic' && <><span className="lt-ca-llm-banner-dot" style={{ background: '#f59e0b' }} />Requires your Anthropic API key</>}
              {llmProvider === 'openrouter' && <><span className="lt-ca-llm-banner-dot" style={{ background: '#f59e0b' }} />Requires your OpenRouter API key</>}
              {llmProvider === 'ollama' && <><span className="lt-ca-llm-banner-dot" style={{ background: '#60a5fa' }} />Requires Ollama running locally</>}
            </div>

            <div className="lt-ca-nav">
              <button className="lt-ca-btn-back" onClick={() => setStep(2)}>← Back</button>
              <button className="lt-ca-btn-next" disabled={!canGoStep4} onClick={() => setStep(4)}>
                Continue <span className="lt-ca-btn-arrow">→</span>
              </button>
            </div>
          </div>
        )}

        {step === 3 && !isLLM && (
          <div className="lt-ca-step lt-ca-step-enter">
            <div className="lt-ca-step-header">
              <h4 className="lt-ca-step-title">Risk Appetite</h4>
              <p className="lt-ca-step-desc">How aggressively should your agent trade?</p>
            </div>

            <div className="lt-ca-risk-grid">
              {RISK_LEVELS.map((item) => {
                const selected = risk === item.id
                return (
                  <div
                    key={item.id}
                    className={`lt-ca-risk-card${selected ? ' lt-ca-risk-card-on' : ''}`}
                    onClick={() => setRisk(item.id)}
                    style={selected ? { borderColor: item.color, '--risk-glow': item.color } : undefined}
                  >
                    <span className="lt-ca-risk-icon">{item.icon}</span>
                    <span className="lt-ca-risk-name" style={selected ? { color: item.color } : undefined}>{item.label}</span>
                    <span className="lt-ca-risk-mult" style={selected ? { color: item.color } : undefined}>{item.mult}×</span>
                    <span className="lt-ca-risk-desc">{item.desc}</span>
                    <div className="lt-ca-risk-bar">
                      <div className="lt-ca-risk-bar-fill" style={{ width: `${(item.mult / 3) * 100}%`, background: item.color }} />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="lt-ca-nav">
              <button className="lt-ca-btn-back" onClick={() => setStep(2)}>← Back</button>
              <button className="lt-ca-btn-next" onClick={() => setStep(4)}>
                Continue <span className="lt-ca-btn-arrow">→</span>
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="lt-ca-step lt-ca-step-enter">
            <div className="lt-ca-step-header">
              <h4 className="lt-ca-step-title">🚀 Ready to Deploy</h4>
              <p className="lt-ca-step-desc">Review your agent and launch to the fleet</p>
            </div>

            <div className="lt-ca-launch-card" style={{ borderColor: `${accentColor}35` }}>
              <div className="lt-ca-launch-glow" style={{ background: `radial-gradient(ellipse, ${accentColor}10, transparent 70%)` }} />
              <div className="lt-ca-launch-top">
                <div className="lt-ca-launch-avatar">
                  <span>{selectedStrat?.icon || '🤖'}</span>
                </div>
                <div className="lt-ca-launch-identity">
                  <div className="lt-ca-launch-name">{name}</div>
                  <div className="lt-ca-launch-strat" style={{ color: accentColor }}>{selectedStrat?.label}</div>
                </div>
                <div className="lt-ca-launch-status">READY</div>
              </div>

              <div className="lt-ca-launch-grid">
                {isLLM ? (
                  <>
                    <div className="lt-ca-launch-item">
                      <span className="lt-ca-launch-label">Provider</span>
                      <span className="lt-ca-launch-val">{llmProviderMeta?.label}</span>
                    </div>
                    <div className="lt-ca-launch-item">
                      <span className="lt-ca-launch-label">Model</span>
                      <span className="lt-ca-launch-val lt-ca-launch-mono">{llmModels.find((item) => item.id === llmModel)?.label || llmModel}</span>
                    </div>
                    <div className="lt-ca-launch-item">
                      <span className="lt-ca-launch-label">Balance</span>
                      <span className="lt-ca-launch-val">$3,000</span>
                    </div>
                    <div className="lt-ca-launch-item">
                      <span className="lt-ca-launch-label">Type</span>
                      <span className="lt-ca-launch-val" style={{ color: '#a78bfa' }}>🧠 AI Agent</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="lt-ca-launch-item">
                      <span className="lt-ca-launch-label">Strategy</span>
                      <span className="lt-ca-launch-val" style={{ color: accentColor }}>{selectedStrat?.icon} {selectedStrat?.short}</span>
                    </div>
                    <div className="lt-ca-launch-item">
                      <span className="lt-ca-launch-label">Risk</span>
                      <span className="lt-ca-launch-val" style={{ color: selectedRisk?.color }}>{selectedRisk?.icon} {selectedRisk?.label}</span>
                    </div>
                    <div className="lt-ca-launch-item">
                      <span className="lt-ca-launch-label">Balance</span>
                      <span className="lt-ca-launch-val">$1,000</span>
                    </div>
                    <div className="lt-ca-launch-item">
                      <span className="lt-ca-launch-label">Multiplier</span>
                      <span className="lt-ca-launch-val">{selectedRisk?.mult}×</span>
                    </div>
                  </>
                )}
              </div>

              <div className="lt-ca-launch-wallet">
                <span className="lt-ca-launch-wallet-icon">💎</span>
                <span className="lt-ca-launch-wallet-addr">{walletAddress?.slice(0, 8)}…{walletAddress?.slice(-6)}</span>
              </div>
            </div>

            {error && <div className="lt-ca-error">⚠️ {error}</div>}

            <div className="lt-ca-nav">
              <button className="lt-ca-btn-back" onClick={() => setStep(3)}>← Back</button>
              <button
                className="lt-ca-btn-launch"
                disabled={creating}
                onClick={handleCreate}
                style={{ background: `linear-gradient(135deg, ${accentColor}, ${accentColor}bb)` }}
              >
                {creating ? <><span className="lt-ca-btn-spinner" /> Deploying…</> : <>{isLLM ? '🧠' : '🚀'} {isLLM ? 'Deploy AI Agent' : 'Deploy Agent'}</>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}