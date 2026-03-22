import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTonAddress, useTonConnectUI, useTonWallet } from '@tonconnect/ui-react'
import { Coins, House, Sparkles, Wallet, Wand2 } from 'lucide-react'

import StrategyMarketplacePanel from './lite/StrategyMarketplacePanel'
import { POLL_MS, normalizeWalletAddr } from './lite/constants'
import { fetchAgentByWallet, fetchEngineAgents, setWalletAddress } from '@/services/engineApi'
import { login as loginWallet } from '@/services/agentApi'
import { fetchMyStrategyRevenue, fetchMyStrategyTemplates, setStrategyMarketplaceWalletAddress } from '@/services/strategyMarketplaceApi'
import ConnectWalletModal from '@/components/wallet/ConnectWalletModal'
import ConnectedWalletMenu from '@/components/wallet/ConnectedWalletMenu'
import { getPrivyLinkedWalletEntries, getSessionWalletAddress, hasPrivyWalletSession, useConnectWalletChooser } from '@/components/wallet/useConnectWalletChooser'
import { useAuthSession } from '@/contexts/AuthContext'
import '@/styles/lite.css'

function LiteWalletButton({ onCreateAgent, hasAgent, onConnect }) {
  const navigate = useNavigate()
  const [tonConnectUI] = useTonConnectUI()
  const wallet = useTonWallet()
  const { session, logout, user } = useAuthSession()
  const sessionAddress = normalizeWalletAddr(getSessionWalletAddress(session))
  const address = normalizeWalletAddr(wallet?.account?.address || sessionAddress || '')
  const isTonWallet = Boolean(wallet?.account?.address)
  const isManagedSession = Boolean(sessionAddress)
  const privyWalletEntries = hasPrivyWalletSession(session)
    ? getPrivyLinkedWalletEntries(user, address, session)
    : []

  if (!address) {
    return (
      <button className="lt-wallet-btn" onClick={onConnect}>
        <span className="lt-wallet-icon">💎</span>
        Connect Wallet
      </button>
    )
  }

  return (
    <div className="lt-wallet-group">
      {!hasAgent && (
        <button className="lt-wallet-btn lt-wallet-btn-create" onClick={onCreateAgent}>
          🤖 Create Agent
        </button>
      )}
      <ConnectedWalletMenu
        address={address}
        label={isManagedSession ? 'WDK wallet' : 'Wallet'}
        badgeText={isManagedSession ? 'WDK' : 'TON'}
        linkedWalletEntries={privyWalletEntries}
        icon={isManagedSession ? '✨' : '💎'}
        variant="lite"
        onTopUp={() => navigate('/lite/wallet')}
        onLogout={async () => {
          await logout()
          if (isTonWallet) await tonConnectUI.disconnect().catch(() => {})
        }}
      />
    </div>
  )
}

export default function LiteStrategyMarketplacePage() {
  const navigate = useNavigate()
  const connectChooser = useConnectWalletChooser({ mode: 'lite' })
  const { session } = useAuthSession()
  const wallet = useTonWallet()
  const tonRawAddress = useTonAddress(false)
  const sessionWalletAddress = normalizeWalletAddr(getSessionWalletAddress(session))
  const walletAddress = normalizeWalletAddr(tonRawAddress || wallet?.account?.address || sessionWalletAddress || '')

  const [agents, setAgents] = useState([])
  const [myAgentId, setMyAgentId] = useState(null)
  const [creatorRevenue, setCreatorRevenue] = useState({ loading: false, summary: null, recentEvents: [], templateCount: 0 })

  const loadAgents = useCallback(async () => {
    const data = await fetchEngineAgents()
    setAgents(Array.isArray(data) ? data : [])
  }, [])

  const openLiteHome = useCallback(() => {
    navigate('/lite')
  }, [navigate])

  useEffect(() => {
    setWalletAddress(walletAddress || null)
    setStrategyMarketplaceWalletAddress(walletAddress || null)

    if (!walletAddress) {
      setMyAgentId(null)
      setCreatorRevenue({ loading: false, summary: null, recentEvents: [], templateCount: 0 })
      return
    }

    const cachedId = localStorage.getItem(`odrob_agent_${walletAddress}`)

    loginWallet(walletAddress)
      .then(() => fetchAgentByWallet(walletAddress))
      .then(({ agent }) => {
        if (agent) {
          setMyAgentId(agent.id)
          localStorage.setItem(`odrob_agent_${walletAddress}`, agent.id)
        } else {
          setMyAgentId(null)
          localStorage.removeItem(`odrob_agent_${walletAddress}`)
        }
      })
      .catch(() => {
        if (cachedId) setMyAgentId(cachedId)
      })
  }, [walletAddress])

  useEffect(() => {
    let cancelled = false

    if (!walletAddress) return undefined

    setCreatorRevenue((prev) => ({ ...prev, loading: true }))
    Promise.allSettled([
      fetchMyStrategyRevenue({ limit: 4 }),
      fetchMyStrategyTemplates(),
    ]).then((results) => {
      if (cancelled) return
      const revenuePayload = results[0]?.status === 'fulfilled' ? results[0].value : null
      const templates = results[1]?.status === 'fulfilled' && Array.isArray(results[1].value) ? results[1].value : []
      setCreatorRevenue({
        loading: false,
        summary: revenuePayload?.summary || null,
        recentEvents: Array.isArray(revenuePayload?.recentEvents) ? revenuePayload.recentEvents : [],
        templateCount: templates.filter((item) => item.visibility === 'public').length,
      })
    })

    return () => {
      cancelled = true
    }
  }, [walletAddress])

  useEffect(() => {
    let alive = true

    const run = async () => {
      try {
        const data = await fetchEngineAgents()
        if (!alive) return
        setAgents(Array.isArray(data) ? data : [])
      } catch {}
    }

    run()
    const iv = window.setInterval(run, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(iv)
    }
  }, [])

  const myAgent = useMemo(() => {
    if (!walletAddress) return null
    const normalized = normalizeWalletAddr(walletAddress)
    const found = agents.find((agent) => agent.isUserAgent && normalizeWalletAddr(agent.walletAddress) === normalized)
    if (found && found.id !== myAgentId) {
      setMyAgentId(found.id)
    }
    return found || null
  }, [agents, myAgentId, walletAddress])

  const totalCreatorRevenue = Number(creatorRevenue.summary?.totalRevenue || 0)
  const creatorEventCount = Number(creatorRevenue.summary?.eventCount || 0)
  const creatorAgentCount = Number(creatorRevenue.summary?.agentCount || 0)

  return (
    <div className="lite-root">
      <header className="lt-header">
        <div className="lt-logo">
          <span className="lt-logo-icon">⚡</span>
          <span className="lt-logo-text">ODROB</span>
          <span className="lt-logo-badge">LITE</span>
        </div>
        <div className="lt-price-block">
          <div className="lt-price-top">
            <span className="lt-live-dot" /> STRATEGY MARKET
          </div>
          <div className="lt-price lt-price-same">Simple installs</div>
        </div>
        <div className="lt-header-end">
          {myAgent ? (
            <Link className="lt-myagent-quick" to="/lite" title="Open my agent in Lite">
              <span>{myAgent.icon || '🤖'}</span>
              <span className={`lt-myagent-quick-pnl ${(myAgent.pnl || 0) >= 0 ? 'c-green' : 'c-red'}`}>
                {`${(myAgent.pnlPercent || 0) >= 0 ? '+' : ''}${Number(myAgent.pnlPercent || 0).toFixed(2)}%`}
              </span>
            </Link>
          ) : null}
          <Link className="lt-header-idx-btn" to="/lite" title="Back to Lite market">
            <House size={15} />
          </Link>
          <Link className="lt-header-idx-btn" to="/lite/wallet" title="Top up managed wallet">
            <Wallet size={15} />
          </Link>
          <LiteWalletButton onCreateAgent={connectChooser.openChooser} hasAgent={!!myAgent} onConnect={connectChooser.openChooser} />
        </div>
      </header>

      <main className="lt-page-shell">
        <div className="lt-page-content">
          <div className="lt-page-head">
            <div>
              <div className="lt-page-kicker">LITE PAGE</div>
              <h1><Sparkles size={18} /> Strategy Marketplace</h1>
              <p>Compare strategies with simple metrics, switch ranking modes, and connect one to your Lite agent without leaving the Lite flow.</p>
            </div>
            <div className="lt-page-links">
              <Link className="lt-strategy-ghost" to="/lite/strategies/publish">
                <Wand2 size={14} />
                <span>Publish strategy</span>
              </Link>
              <Link className="lt-strategy-ghost" to="/lite">
                <House size={14} />
                <span>Back to Lite</span>
              </Link>
            </div>
          </div>

          <section className="lt-author-revenue-grid">
            <article className="lt-author-revenue-card">
              <div className="lt-author-revenue-head">
                <div>
                  <span className="lt-page-kicker">CREATOR REVENUE</span>
                  <h2>Strategy royalties</h2>
                </div>
                <Link className="lt-author-revenue-link" to="/lite/strategies/publish">
                  <Wand2 size={14} />
                  <span>Open studio</span>
                </Link>
              </div>
              {!walletAddress ? (
                <div className="lt-author-revenue-empty">Connect wallet to publish your own strategy and earn from other agents using it.</div>
              ) : creatorRevenue.loading ? (
                <div className="lt-author-revenue-empty">Loading your creator revenue…</div>
              ) : (
                <div className="lt-author-revenue-stats">
                  <div className="lt-author-revenue-stat">
                    <span>Total earned</span>
                    <strong>${totalCreatorRevenue.toFixed(2)}</strong>
                  </div>
                  <div className="lt-author-revenue-stat">
                    <span>Public templates</span>
                    <strong>{creatorRevenue.templateCount}</strong>
                  </div>
                  <div className="lt-author-revenue-stat">
                    <span>Paying agents</span>
                    <strong>{creatorAgentCount}</strong>
                  </div>
                  <div className="lt-author-revenue-stat">
                    <span>Events</span>
                    <strong>{creatorEventCount}</strong>
                  </div>
                </div>
              )}
            </article>

            <article className="lt-author-revenue-card">
              <div className="lt-author-revenue-head">
                <div>
                  <span className="lt-page-kicker">LATEST FLOW</span>
                  <h2>Recent royalty events</h2>
                </div>
                <span className="lt-author-revenue-badge"><Coins size={14} /> Platform-side share</span>
              </div>
              {!walletAddress ? (
                <div className="lt-author-revenue-empty">Royalty events will show here after you connect and publish.</div>
              ) : creatorRevenue.loading ? (
                <div className="lt-author-revenue-empty">Loading latest royalty events…</div>
              ) : creatorRevenue.recentEvents.length === 0 ? (
                <div className="lt-author-revenue-empty">No royalty events yet. Publish a public strategy and let another agent connect to it.</div>
              ) : (
                <div className="lt-author-revenue-list">
                  {creatorRevenue.recentEvents.map((event) => (
                    <div key={event.id} className="lt-author-revenue-event">
                      <div>
                        <strong>{event.templateName || 'Custom strategy'}</strong>
                        <small>{event.agentId || 'agent'} · {event.sourceIndexId || 'index'}</small>
                      </div>
                      <span className="c-green">+${Number(event.royaltyAmount || 0).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </section>

          <StrategyMarketplacePanel
            walletAddress={walletAddress}
            myAgent={myAgent}
            onConnectWallet={connectChooser.openChooser}
            onCreateAgent={openLiteHome}
            onOpenMyAgent={openLiteHome}
            onInstallComplete={loadAgents}
          />
        </div>
      </main>
      <ConnectWalletModal {...connectChooser.modalProps} />
    </div>
  )
}
