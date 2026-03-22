import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTonAddress, useTonConnectUI, useTonWallet } from '@tonconnect/ui-react'
import { ArrowLeft, House, Sparkles, Wand2 } from 'lucide-react'

import StrategyCreateWizard from '@/components/marketplace/StrategyCreateWizard'
import { fetchMyStrategyRevenue, fetchMyStrategyTemplates, setStrategyMarketplaceWalletAddress } from '@/services/strategyMarketplaceApi'
import ConnectWalletModal from '@/components/wallet/ConnectWalletModal'
import ConnectedWalletMenu from '@/components/wallet/ConnectedWalletMenu'
import { getPrivyLinkedWalletEntries, getSessionWalletAddress, hasPrivyWalletSession, useConnectWalletChooser } from '@/components/wallet/useConnectWalletChooser'
import { useAuthSession } from '@/contexts/AuthContext'
import { normalizeWalletAddr } from './lite/constants'
import '@/styles/lite.css'

function LiteWalletButton({ onConnect }) {
  const [tonConnectUI] = useTonConnectUI()
  const navigate = useNavigate()
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
  )
}

function formatCurrency(value) {
  const amount = Number(value) || 0
  if (Math.abs(amount) >= 1000) return `$${(amount / 1000).toFixed(1)}k`
  return `$${amount.toFixed(2)}`
}

function StrategyRevenueSummary({ walletAddress }) {
  const [loading, setLoading] = useState(Boolean(walletAddress))
  const [payload, setPayload] = useState(null)

  useEffect(() => {
    let cancelled = false

    if (!walletAddress) {
      setPayload(null)
      setLoading(false)
      return undefined
    }

    setLoading(true)
    Promise.allSettled([
      fetchMyStrategyRevenue({ limit: 5 }),
      fetchMyStrategyTemplates(),
    ]).then((results) => {
      if (cancelled) return
      const revenue = results[0]?.status === 'fulfilled' ? results[0].value : null
      const templates = results[1]?.status === 'fulfilled' ? results[1].value : []
      setPayload({ revenue, templates: Array.isArray(templates) ? templates : [] })
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [walletAddress])

  const summary = payload?.revenue?.summary || null
  const events = Array.isArray(payload?.revenue?.recentEvents) ? payload.revenue.recentEvents : []
  const templates = payload?.templates || []

  return (
    <section className="lt-author-revenue-grid">
      <article className="lt-author-revenue-card">
        <div className="lt-author-revenue-head">
          <div>
            <span className="lt-page-kicker">CREATOR REVENUE</span>
            <h2>Your strategy income</h2>
          </div>
          <span className="lt-author-revenue-badge">Royalty ledger</span>
        </div>
        {!walletAddress ? (
          <div className="lt-author-revenue-empty">Connect wallet to publish strategies and track royalty income.</div>
        ) : loading ? (
          <div className="lt-author-revenue-empty">Loading your strategy revenue…</div>
        ) : (
          <>
            <div className="lt-author-revenue-stats">
              <div className="lt-author-revenue-stat">
                <span>Total earned</span>
                <strong>{formatCurrency(summary?.totalRevenue || 0)}</strong>
              </div>
              <div className="lt-author-revenue-stat">
                <span>Published templates</span>
                <strong>{templates.filter((item) => item.visibility === 'public').length}</strong>
              </div>
              <div className="lt-author-revenue-stat">
                <span>Paying agents</span>
                <strong>{summary?.agentCount || 0}</strong>
              </div>
              <div className="lt-author-revenue-stat">
                <span>Payout events</span>
                <strong>{summary?.eventCount || 0}</strong>
              </div>
            </div>
            <div className="lt-author-revenue-note">
              Royalties are attributed to the connected wallet as the strategy owner, tracked in the royalty ledger, and currently come from up to 25% of the platform-side protocol trade fee when other agents use your public strategy.
            </div>
          </>
        )}
      </article>

      <article className="lt-author-revenue-card">
        <div className="lt-author-revenue-head">
          <div>
            <span className="lt-page-kicker">RECENT EVENTS</span>
            <h2>Latest royalty flow</h2>
          </div>
        </div>
        {!walletAddress ? (
          <div className="lt-author-revenue-empty">After connecting wallet, recent royalty events appear here.</div>
        ) : loading ? (
          <div className="lt-author-revenue-empty">Loading royalty events…</div>
        ) : events.length === 0 ? (
          <div className="lt-author-revenue-empty">No royalty events yet. Publish a strategy and let another agent connect to it.</div>
        ) : (
          <div className="lt-author-revenue-list">
            {events.map((event) => (
              <div key={event.id} className="lt-author-revenue-event">
                <div>
                  <strong>{event.templateName || 'Custom strategy'}</strong>
                  <small>{event.agentId || 'agent'} · {event.sourceIndexId || 'index'} · {new Date(event.createdAt || Date.now()).toLocaleString()}</small>
                </div>
                <span className="c-green">+{formatCurrency(event.royaltyAmount || 0)}</span>
              </div>
            ))}
          </div>
        )}
      </article>
    </section>
  )
}

export default function LiteStrategyPublishPage() {
  const navigate = useNavigate()
  const connectChooser = useConnectWalletChooser({ mode: 'lite' })
  const { session } = useAuthSession()
  const wallet = useTonWallet()
  const tonRawAddress = useTonAddress(false)
  const sessionWalletAddress = normalizeWalletAddr(getSessionWalletAddress(session))
  const walletAddress = useMemo(
    () => normalizeWalletAddr(tonRawAddress || wallet?.account?.address || sessionWalletAddress || ''),
    [sessionWalletAddress, tonRawAddress, wallet?.account?.address]
  )

  useEffect(() => {
    setStrategyMarketplaceWalletAddress(walletAddress || null)
  }, [walletAddress])

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
            <span className="lt-live-dot" /> STRATEGY STUDIO
          </div>
          <div className="lt-price lt-price-same">Publish custom logic</div>
        </div>
        <div className="lt-header-end">
          <Link className="lt-header-idx-btn" to="/lite/strategies" title="Back to marketplace">
            <ArrowLeft size={15} />
          </Link>
          <Link className="lt-header-idx-btn" to="/lite" title="Back to Lite market">
            <House size={15} />
          </Link>
          <LiteWalletButton onConnect={connectChooser.openChooser} />
        </div>
      </header>

      <main className="lt-page-shell">
        <div className="lt-page-content">
          <div className="lt-page-head">
            <div>
              <div className="lt-page-kicker">LITE PAGE</div>
              <h1><Wand2 size={18} /> Publish Strategy</h1>
              <p>Create a custom or LLM-ready strategy template, publish it to the marketplace, and start collecting royalty income when other agents connect to it.</p>
            </div>
            <div className="lt-page-links">
              <Link className="lt-strategy-ghost" to="/lite/strategies">
                <Sparkles size={14} />
                <span>Marketplace</span>
              </Link>
            </div>
          </div>

          <StrategyRevenueSummary walletAddress={walletAddress} />
        </div>
      </main>

      <StrategyCreateWizard
        walletAddress={walletAddress}
        open
        onClose={() => navigate('/lite/strategies')}
        onCreated={() => navigate('/lite/strategies')}
        onConnectWallet={connectChooser.openChooser}
      />
      <ConnectWalletModal {...connectChooser.modalProps} />
    </div>
  )
}