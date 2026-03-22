import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTonAddress, useTonConnectUI, useTonWallet } from '@tonconnect/ui-react'
import { ArrowUpRight, Coins, House, ShieldCheck, Wallet as WalletIcon } from 'lucide-react'

import ConnectWalletModal from '@/components/wallet/ConnectWalletModal'
import ConnectedWalletMenu from '@/components/wallet/ConnectedWalletMenu'
import { useAuthSession } from '@/contexts/AuthContext'
import { fetchManagedWalletRuntime, fetchOnboardingBootstrap } from '@/services/onboardingApi'
import { getPrivyLinkedWalletEntries, getSessionWalletAddress, hasPrivyWalletSession, useConnectWalletChooser } from '@/components/wallet/useConnectWalletChooser'
import { normalizeWalletAddr } from './lite/constants'
import '@/styles/lite.css'

const PRESET_AMOUNTS = ['10', '25', '50', '100']
const TON_USDT_JETTON_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

function shortAddress(value) {
  const text = String(value || '')
  if (!text) return '—'
  return `${text.slice(0, 6)}…${text.slice(-6)}`
}

function toMicroUsdt(value) {
  const number = Number.parseFloat(String(value || '').replace(',', '.'))
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.round(number * 1_000_000)
}

function buildUsdtDeepLink({ address, amountMicroUsdt, text }) {
  if (!address || !amountMicroUsdt) return ''
  const params = new URLSearchParams({
    jetton: TON_USDT_JETTON_MASTER,
    amount: String(amountMicroUsdt),
    text,
  })
  return `ton://transfer/${address}?${params.toString()}`
}

function buildTonkeeperTransferLink({ address, amountMicroUsdt, text }) {
  if (!address || !amountMicroUsdt) return ''
  const params = new URLSearchParams({
    jetton: TON_USDT_JETTON_MASTER,
    amount: String(amountMicroUsdt),
    text,
  })
  return `https://app.tonkeeper.com/transfer/${address}?${params.toString()}`
}

export default function LiteManagedWalletPage() {
  const [tonConnectUI] = useTonConnectUI()
  const tonWallet = useTonWallet()
  const tonRawAddress = useTonAddress(false)
  const { session, logout, user } = useAuthSession()
  const connectChooser = useConnectWalletChooser({ mode: 'lite' })
  const sessionWalletAddress = normalizeWalletAddr(getSessionWalletAddress(session))
  const privyWalletEntries = hasPrivyWalletSession(session)
    ? getPrivyLinkedWalletEntries(user, sessionWalletAddress, session)
    : []
  const externalWalletAddress = normalizeWalletAddr(tonRawAddress || tonWallet?.account?.address || '')
  const principalWalletAddress = externalWalletAddress || sessionWalletAddress || ''

  const [bootstrap, setBootstrap] = useState(null)
  const [bootstrapLoading, setBootstrapLoading] = useState(true)
  const [runtimePayload, setRuntimePayload] = useState(null)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const [selectedWalletId, setSelectedWalletId] = useState('')
  const [amount, setAmount] = useState('50')
  const [error, setError] = useState('')

  const managedWallets = bootstrap?.managedWallets || []
  const selectedWallet = useMemo(() => {
    if (!managedWallets.length) return null
    return managedWallets.find((item) => item.id === selectedWalletId) || managedWallets[0]
  }, [managedWallets, selectedWalletId])

  const ownerAddress = bootstrap?.ownerAddress || bootstrap?.session?.address || null
  const targetAddress = runtimePayload?.topUp?.targetAddress || runtimePayload?.runtime?.address || selectedWallet?.walletAddress || ''

  const loadBootstrap = useCallback(async () => {
    setBootstrapLoading(true)
    setError('')
    try {
      const data = await fetchOnboardingBootstrap(principalWalletAddress || undefined)
      setBootstrap(data)
    } catch (err) {
      setBootstrap(null)
      setError(err.message || 'Failed to load wallet bootstrap')
    } finally {
      setBootstrapLoading(false)
    }
  }, [principalWalletAddress])

  const loadRuntime = useCallback(async (walletId) => {
    if (!walletId) {
      setRuntimePayload(null)
      return
    }
    setRuntimeLoading(true)
    setError('')
    try {
      const data = await fetchManagedWalletRuntime({
        walletId,
        address: principalWalletAddress || undefined,
      })
      setRuntimePayload(data)
    } catch (err) {
      setRuntimePayload(null)
      setError(err.message || 'Failed to load managed wallet runtime')
    } finally {
      setRuntimeLoading(false)
    }
  }, [principalWalletAddress])

  useEffect(() => {
    loadBootstrap()
  }, [loadBootstrap])

  useEffect(() => {
    if (!managedWallets.length) {
      if (selectedWalletId) setSelectedWalletId('')
      return
    }
    if (!managedWallets.some((item) => item.id === selectedWalletId)) {
      setSelectedWalletId(managedWallets[0].id)
    }
  }, [managedWallets, selectedWalletId])

  useEffect(() => {
    if (selectedWallet?.id) {
      loadRuntime(selectedWallet.id)
    }
  }, [selectedWallet?.id, loadRuntime])

  const connectedSourceAddress = tonWallet?.account?.address || ''
  const hasSessionIdentity = Boolean(sessionWalletAddress)
  const numericAmount = Number(amount)
  const plannedDeposit = Number.isFinite(numericAmount) && numericAmount > 0 ? numericAmount : 0
  const plannedBuyingPower = plannedDeposit * 100
  const liveBalance = Number(runtimePayload?.runtime?.balance || 0)
  const hasManagedWallet = Boolean(ownerAddress && managedWallets.length > 0)
  const plannedDepositMicroUsdt = toMicroUsdt(amount)
  const paymentMemo = `ODROB Lite treasury ${plannedDeposit.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`
  const paymentDeepLink = buildUsdtDeepLink({
    address: targetAddress,
    amountMicroUsdt: plannedDepositMicroUsdt,
    text: paymentMemo,
  })
  const paymentTonkeeperLink = buildTonkeeperTransferLink({
    address: targetAddress,
    amountMicroUsdt: plannedDepositMicroUsdt,
    text: paymentMemo,
  })

  const handleOpenPayment = useCallback(() => {
    if (!paymentDeepLink && !paymentTonkeeperLink) return
    if (typeof window === 'undefined') return
    window.location.assign(paymentDeepLink || paymentTonkeeperLink)
  }, [paymentDeepLink, paymentTonkeeperLink])

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
            <span className="lt-live-dot" /> MANAGED WALLET
          </div>
          <div className="lt-price lt-price-same">USDT treasury</div>
        </div>
        <div className="lt-header-end">
          <Link className="lt-header-idx-btn" to="/lite" title="Back to Lite home">
            <House size={15} />
          </Link>
          <Link className="lt-header-idx-btn" to="/lite/strategies" title="Open marketplace">
            <Coins size={15} />
          </Link>
          {tonWallet ? (
            <button className="lt-wallet-addr" onClick={() => tonConnectUI.disconnect()} title="Disconnect source wallet">
              💎 {shortAddress(connectedSourceAddress)}
            </button>
          ) : hasSessionIdentity ? (
            <div className="lt-wallet-group">
              <ConnectedWalletMenu
                address={sessionWalletAddress}
                label="WDK wallet"
                icon="✨"
                linkedWalletEntries={privyWalletEntries}
                variant="lite"
                balanceText={runtimePayload?.runtime?.balance != null ? `${Number(runtimePayload.runtime.balance).toFixed(4)} TON` : undefined}
                onTopUp={() => {
                  if (typeof window !== 'undefined') window.location.assign('/lite/wallet')
                }}
                onLogout={logout}
              />
              <button className="lt-wallet-btn" onClick={connectChooser.openChooser}>
                <span className="lt-wallet-icon">💎</span>
                Connect source wallet
              </button>
            </div>
          ) : (
            <button className="lt-wallet-btn" onClick={connectChooser.openChooser}>
              <span className="lt-wallet-icon">💎</span>
              Connect / Sign in
            </button>
          )}
        </div>
      </header>

      <main className="lt-page-shell lt-topup-shell">
        <div className="lt-page-content">
          <div className="lt-topup-shell-head">
            <Link className="lt-topup-back" to="/lite">← Back to Lite</Link>
            <div className="lt-topup-shell-agent">
              <span className="lt-topup-shell-kicker">Custody target</span>
              <strong>{selectedWallet?.label || 'Managed wallet'}</strong>
              <small>{ownerAddress ? `Owner ${shortAddress(ownerAddress)}` : 'Session or wallet owner required'}</small>
            </div>
          </div>

          <div className="lt-page-head">
            <div>
                <div className="lt-page-kicker">USDT ONLY · 100X BUYING POWER</div>
                <h1><WalletIcon size={18} /> Fund your Lite treasury</h1>
                <p>Keep the wallet flow simple: send USDT to your managed treasury address and scale trading balance with a clear 100x buying-power model.</p>
            </div>
          </div>

          <section className="lt-topup-mock lt-topup-mock-standalone">
            {bootstrapLoading ? (
              <div className="lt-author-revenue-empty">Loading wallet bootstrap…</div>
            ) : !ownerAddress ? (
              <div className="lt-author-revenue-empty">
                Connect or sign in first, then this page resolves your managed treasury address automatically.
              </div>
            ) : managedWallets.length === 0 ? (
              <div className="lt-author-revenue-empty">
                No managed treasury is linked to this owner yet. Provision one from onboarding or an admin-managed registration first.
              </div>
            ) : (
              <>
                <div className="lt-wallet-premium-hero">
                  <div className="lt-wallet-premium-copy">
                    <span className="lt-wallet-premium-kicker">Treasury funding</span>
                    <h2>Deposit USDT. Trade with 100x balance emphasis.</h2>
                    <p>
                      One clean funding asset, one custody address, and a clear rule for operators: even a small USDT top-up is framed
                      as amplified buying power inside Lite.
                    </p>
                  </div>
                  <div className="lt-wallet-premium-power">
                    <span>100x</span>
                    <small>Buying power model</small>
                  </div>
                </div>

                <div className="lt-wallet-premium-stats">
                  <div className="lt-wallet-premium-stat lt-wallet-premium-stat-accent">
                    <span>Funding asset</span>
                    <strong>USDT only</strong>
                    <small>Use the TON network treasury address below</small>
                  </div>
                  <div className="lt-wallet-premium-stat">
                    <span>Planned buying power</span>
                    <strong>${plannedBuyingPower.toLocaleString('en-US', { maximumFractionDigits: 0 })}</strong>
                    <small>${plannedDeposit.toLocaleString('en-US', { maximumFractionDigits: 2 })} deposit × 100</small>
                  </div>
                  <div className="lt-wallet-premium-stat">
                    <span>Live treasury wallet</span>
                    <strong>{shortAddress(targetAddress)}</strong>
                    <small>{runtimeLoading ? 'Refreshing runtime…' : `${liveBalance.toFixed(4)} wallet balance reported`}</small>
                  </div>
                </div>

                {managedWallets.length > 1 ? (
                  <div className="lt-topup-field" style={{ marginBottom: 12 }}>
                    <span>Managed treasury</span>
                    <select value={selectedWallet?.id || ''} onChange={(event) => setSelectedWalletId(event.target.value)}>
                      {managedWallets.map((wallet) => (
                        <option key={wallet.id} value={wallet.id}>
                          {wallet.label || wallet.walletAddress}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div className="lt-topup-mock-presets">
                  {PRESET_AMOUNTS.map((preset) => (
                    <button
                      key={preset}
                      className={`lt-topup-preset${amount === preset ? ' lt-topup-preset-active' : ''}`}
                      onClick={() => setAmount(preset)}
                    >
                      ${preset}
                    </button>
                  ))}
                </div>

                <div className="lt-topup-mock-grid">
                  <div className="lt-topup-rails">
                    <button className="lt-topup-rail lt-topup-rail-active" type="button">USDT on TON</button>
                    <button className="lt-topup-rail" type="button">1 USDT = 100x model</button>
                    <button className="lt-topup-rail" type="button">Ready wallet deeplink</button>
                  </div>
                  <label className="lt-topup-field">
                    <span>Deposit amount (USDT)</span>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      placeholder="50"
                    />
                  </label>
                </div>

                <div className="lt-wallet-pay-cta">
                  <button
                    className="lt-topup-confirm lt-wallet-pay-btn"
                    onClick={handleOpenPayment}
                    disabled={!paymentDeepLink || !hasManagedWallet || runtimeLoading}
                  >
                    <ArrowUpRight size={14} />
                    {' '}
                    {runtimeLoading
                      ? 'Preparing wallet…'
                      : plannedDeposit > 0
                        ? `Open wallet to pay ${plannedDeposit.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`
                        : 'Enter amount to continue'}
                  </button>
                  <small>
                    Deeplink opens your TON wallet with the treasury address, USDT asset and amount prefilled.
                  </small>
                </div>

                <div className="lt-topup-mock-summary">
                  <div className="lt-topup-sum-item">
                    <span>Treasury address</span>
                    <strong title={targetAddress}>{shortAddress(targetAddress)}</strong>
                  </div>
                  <div className="lt-topup-sum-item">
                    <span>Funding asset</span>
                    <strong title="USDT on TON">USDT on TON</strong>
                  </div>
                  <div className="lt-topup-sum-item">
                    <span>Buying power</span>
                    <strong title={`$${plannedBuyingPower.toFixed(0)}`}>
                      ${plannedBuyingPower.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </strong>
                  </div>
                </div>

                <div className="lt-wallet-usdt-panel">
                  <div className="lt-wallet-usdt-panel-head">
                    <div>
                      <strong>Pay from wallet in one tap</strong>
                      <small>The send screen is prefilled with your managed treasury address, USDT on TON and the exact funding amount.</small>
                    </div>
                    {paymentTonkeeperLink ? (
                      <a className="lt-topup-secondary" href={paymentTonkeeperLink} target="_blank" rel="noreferrer">
                        Open in Tonkeeper web
                      </a>
                    ) : null}
                  </div>

                  <div className="lt-wallet-usdt-address">
                    <span>USDT treasury address</span>
                    <strong title={targetAddress}>{targetAddress || '—'}</strong>
                  </div>

                  <div className="lt-wallet-usdt-steps">
                    <div className="lt-wallet-usdt-step">
                      <span>01</span>
                      <strong>Choose amount</strong>
                      <small>Pick a preset or enter any smaller USDT amount manually.</small>
                    </div>
                    <div className="lt-wallet-usdt-step">
                      <span>02</span>
                      <strong>Open wallet deeplink</strong>
                      <small>Jump directly into your TON wallet with a prefilled USDT transfer instead of copying fields manually.</small>
                    </div>
                    <div className="lt-wallet-usdt-step">
                      <span>03</span>
                      <strong>Trade with 100x emphasis</strong>
                      <small>${plannedDeposit.toLocaleString('en-US', { maximumFractionDigits: 2 })} in USDT is presented as ${plannedBuyingPower.toLocaleString('en-US', { maximumFractionDigits: 0 })} in buying power.</small>
                    </div>
                  </div>
                </div>

                <div className="lt-topup-confirm-card" style={{ marginBottom: 12 }}>
                  <div className="lt-topup-confirm-row">
                    <span>Funding route</span>
                    <strong>USDT treasury only</strong>
                  </div>
                  <div className="lt-topup-confirm-row">
                    <span>Custody model</span>
                    <strong>{runtimePayload?.runtime?.custodyModel || selectedWallet?.metadata?.custodyModel || 'managed'}</strong>
                  </div>
                  <div className="lt-topup-confirm-row">
                    <span>Address verified via WDK</span>
                    <strong>{runtimePayload?.runtime?.addressVerified ? 'Yes' : 'Pending'}</strong>
                  </div>
                </div>

                {error ? (
                  <div className="lt-topup-note" style={{ marginBottom: 12 }}>
                    {error}
                  </div>
                ) : null}

                <div className="lt-topup-mock-actions">
                  <div className="lt-topup-note lt-wallet-funding-note">
                    <ShieldCheck size={14} />
                    <span>Simple rule: fund this treasury in USDT only — the wallet deeplink handles address, asset and amount in one go.</span>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </main>
      <ConnectWalletModal
        {...connectChooser.modalProps}
        title="Connect Wallet"
        description="Sign in with Privy or connect a wallet to resolve your managed treasury. Funding on this screen is designed around USDT treasury deposits."
      />
    </div>
  )
}
