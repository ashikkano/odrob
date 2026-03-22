import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Copy, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthSession } from '@/contexts/AuthContext'
import { fetchManagedWalletRuntime } from '@/services/onboardingApi'

function shortenAddress(address) {
  if (!address) return ''
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

const VARIANTS = {
  default: {
    trigger: 'inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-mono transition-colors hover:border-primary/30 hover:bg-accent',
    panel: 'absolute right-0 top-[calc(100%+0.5rem)] z-50 pointer-events-auto min-w-[220px] rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-2xl',
    label: 'text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground',
    address: 'mt-1 font-mono text-xs text-foreground break-all',
    item: 'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent',
    badge: 'rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary',
    iconButton: 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border/80 bg-background/70 text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground',
    actionButton: 'inline-flex flex-1 items-center justify-center rounded-xl border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors',
    actionButtonPrimary: 'border-primary/20 bg-primary/10 text-primary hover:bg-primary/15',
    actionButtonDisabled: 'cursor-not-allowed border-border/70 bg-muted/30 text-muted-foreground opacity-60',
    balanceValue: 'text-sm font-semibold text-foreground',
  },
  lite: {
    trigger: 'lt-wallet-addr inline-flex items-center gap-1.5',
    panel: 'absolute right-0 top-[calc(100%+0.5rem)] z-50 pointer-events-auto min-w-[220px] rounded-2xl border border-white/10 bg-[#0d1220] p-2 text-white shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl',
    label: 'text-[10px] font-semibold uppercase tracking-[0.2em] text-white/45',
    address: 'mt-1 font-mono text-xs text-white/90 break-all',
    item: 'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-white/85 transition-colors hover:bg-white/10',
    badge: 'rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200',
    iconButton: 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/65 transition-colors hover:bg-white/10 hover:text-white',
    actionButton: 'inline-flex flex-1 items-center justify-center rounded-xl border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors',
    actionButtonPrimary: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/15',
    actionButtonDisabled: 'cursor-not-allowed border-white/10 bg-white/5 text-white/35 opacity-70',
    balanceValue: 'text-sm font-semibold text-white',
  },
}

function formatBalance(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return `${amount.toFixed(4)} TON`
}

export default function ConnectedWalletMenu({
  address,
  label = 'WDK wallet',
  badgeText = 'WDK',
  linkedWalletEntries = [],
  onLogout,
  onTopUp,
  variant = 'default',
  icon = '✨',
  className,
  balanceText,
}) {
  const theme = VARIANTS[variant] || VARIANTS.default
  const { session } = useAuthSession()
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [copiedKey, setCopiedKey] = useState('')
  const [panelStyle, setPanelStyle] = useState(null)
  const [runtimeBalance, setRuntimeBalance] = useState(null)
  const [balanceLoading, setBalanceLoading] = useState(false)

  const hasManagedWallet = Boolean(session?.managedWallet?.walletAddress || badgeText === 'WDK')
  const resolvedBalanceText = useMemo(() => {
    if (typeof balanceText === 'string' && balanceText.trim()) return balanceText
    return formatBalance(runtimeBalance)
  }, [balanceText, runtimeBalance])

  const handleTopUp = useCallback(() => {
    setOpen(false)
    if (typeof onTopUp === 'function') {
      onTopUp()
      return
    }
    if (typeof window !== 'undefined') {
      window.location.assign('/lite/wallet')
    }
  }, [onTopUp])

  const handleCopy = useCallback(async (value, key = 'primary') => {
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(value)
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey((current) => (current === key ? '' : current)), 1400)
  }, [])

  useEffect(() => {
    if (!open) return undefined

    const updatePanelPosition = () => {
      if (!triggerRef.current) return
      const rect = triggerRef.current.getBoundingClientRect()
      setPanelStyle({
        position: 'fixed',
        top: rect.bottom + 8,
        left: Math.max(12, rect.right - 220),
        minWidth: 220,
        maxWidth: 'min(calc(100vw - 24px), 320px)',
        zIndex: 2000,
      })
    }

    updatePanelPosition()

    const handlePointerDown = (event) => {
      const target = event.target
      const clickedTrigger = rootRef.current?.contains(target)
      const clickedPanel = panelRef.current?.contains(target)
      if (!clickedTrigger && !clickedPanel) {
        setOpen(false)
      }
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    const handleViewportChange = () => updatePanelPosition()

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || !hasManagedWallet || typeof balanceText === 'string') return undefined

    let cancelled = false
    setBalanceLoading(true)

    fetchManagedWalletRuntime()
      .then((data) => {
        if (cancelled) return
        setRuntimeBalance(data?.runtime?.balance ?? null)
      })
      .catch(() => {
        if (cancelled) return
        setRuntimeBalance(null)
      })
      .finally(() => {
        if (!cancelled) setBalanceLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [balanceText, hasManagedWallet, open])

  return (
    <div ref={rootRef} className={cn('relative', open && 'z-[1200]', className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(theme.trigger, 'max-w-[220px]')}
        onClick={() => setOpen((value) => !value)}
        title={address}
      >
        <span className="shrink-0 text-sm leading-none">{icon}</span>
        <span className="truncate">{shortenAddress(address)}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && panelStyle && typeof document !== 'undefined' ? createPortal(
        <div ref={panelRef} className={theme.panel} style={panelStyle}>
          <div className="px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className={theme.label}>{label}</div>
              <span className={theme.badge}>{badgeText}</span>
            </div>
            <div className="mt-1 flex items-start justify-between gap-2">
              <div className={cn(theme.address, 'mt-0 flex-1')}>{address}</div>
              <button
                type="button"
                className={theme.iconButton}
                onClick={() => handleCopy(address, 'primary')}
                title={copiedKey === 'primary' ? 'Copied' : 'Copy address'}
              >
                {copiedKey === 'primary' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <div className="mt-3 rounded-xl border border-border/70 bg-background/40 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className={theme.label}>Balance</span>
                <span className={theme.balanceValue}>{balanceLoading ? 'Loading…' : resolvedBalanceText}</span>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className={cn(theme.actionButton, theme.actionButtonPrimary)}
                  onClick={handleTopUp}
                >
                  TOP-UP
                </button>
                <button
                  type="button"
                  className={cn(theme.actionButton, theme.actionButtonDisabled)}
                  disabled
                >
                  WITHDRAW
                </button>
              </div>
            </div>
          </div>
          {linkedWalletEntries.length ? (
            <>
              <div className="mt-1 h-px bg-border/70 opacity-60" />
              <div className="px-3 py-2">
                <div className={theme.label}>Privy wallets</div>
                <div className="mt-2 space-y-2">
                  {linkedWalletEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={cn(theme.item, 'justify-between text-left')}
                      onClick={() => handleCopy(entry.address, entry.id)}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium">{entry.label}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] opacity-80">{entry.address}</div>
                      </div>
                      <div className="ml-3 flex items-center gap-2">
                        <span className={theme.badge}>{entry.badgeText}</span>
                        {copiedKey === entry.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}
          <div className="mt-1 h-px bg-border/70 opacity-60" />
          <div className="mt-1 space-y-1">
            <button
              type="button"
              className={cn(theme.item, variant === 'lite' ? 'text-rose-200 hover:bg-rose-400/10' : 'text-red-500 hover:bg-red-500/10')}
              onClick={async () => {
                setOpen(false)
                await onLogout?.()
              }}
            >
              <LogOut className="h-4 w-4" />
              <span>Logout</span>
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}