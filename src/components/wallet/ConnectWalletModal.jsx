import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Phone, ShieldCheck, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const OPTION_META = {
  ton: { eyebrow: 'Direct TON', accent: 'from-sky-400/20 to-cyan-300/10' },
  wallets: { eyebrow: 'Multi-chain', accent: 'from-violet-400/20 to-indigo-300/10' },
  google: { eyebrow: 'Social login', accent: 'from-amber-400/20 to-orange-300/10' },
  phone: { eyebrow: 'SMS access', accent: 'from-fuchsia-400/20 to-pink-300/10' },
}

function NetworkPill({ label, tone = 'default', compact = false }) {
  const tones = {
    default: 'border-white/10 bg-white/5 text-white/70',
    ton: 'border-sky-400/25 bg-sky-400/10 text-sky-200',
    eth: 'border-violet-400/25 bg-violet-400/10 text-violet-200',
    sol: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
    google: 'border-amber-400/25 bg-amber-400/10 text-amber-100',
    phone: 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-100',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]',
        compact && 'px-2 py-0.5 text-[9px]',
        tones[tone] || tones.default,
      )}
    >
      {label}
    </span>
  )
}

function OptionIcon({ type }) {
  if (type === 'ton') return <span className="text-lg">💎</span>
  if (type === 'wallets') return <span className="text-lg font-semibold text-violet-100">Ξ</span>
  if (type === 'google') return <span className="text-sm font-black text-white">G</span>
  return <Phone className="h-4 w-4 text-white" />
}

function ConnectOptionCard({ title, description, type, badges, onClick, disabled = false }) {
  const meta = OPTION_META[type] || OPTION_META.ton

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group relative overflow-hidden rounded-3xl border p-3.5 text-left transition-all duration-200',
        disabled
          ? 'cursor-not-allowed border-white/5 bg-white/[0.03] opacity-50'
          : 'border-white/10 bg-white/[0.045] hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.08] hover:shadow-[0_14px_40px_rgba(15,23,42,0.35)]'
      )}
    >
      <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br opacity-90', meta.accent)} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(129,140,248,0.12),transparent_35%)] opacity-80" />
      <div className="relative flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-slate-950/50 shadow-inner shadow-black/20">
          <OptionIcon type={type} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-white/45">{meta.eyebrow}</div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">{title}</div>
              <div className="mt-0.5 text-xs leading-5 text-white/65">{description}</div>
            </div>
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-white/35 transition-transform group-hover:translate-x-0.5 group-hover:text-white/70" />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {badges.map((badge) => (
              <NetworkPill key={`${type}-${badge.label}`} label={badge.label} tone={badge.tone} compact />
            ))}
          </div>
        </div>
      </div>
    </button>
  )
}

export default function ConnectWalletModal({
  open,
  onClose,
  onSelectTon,
  onSelectWallets,
  onSelectGoogle,
  onSelectPhone,
  privyEnabled = false,
  mode = 'default',
  title = 'Connect Wallet',
  description = 'Choose a wallet or sign-in method. Privy login auto-provisions a managed WDK wallet for trading.',
}) {
  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null
  if (typeof document === 'undefined') return null

  const isLite = mode === 'lite'

  return createPortal(
    <div className="fixed inset-0 z-[120] overflow-y-auto" aria-modal="true" role="dialog">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-md"
        aria-label="Close connect wallet modal"
        onClick={onClose}
      />
      <div className="relative flex min-h-full items-start justify-center p-3 sm:p-5">
        <div
          className={cn(
            'relative my-0 w-full max-w-3xl overflow-hidden rounded-[26px] border border-white/10 shadow-[0_30px_120px_rgba(15,23,42,0.55)] max-h-[calc(100dvh-1.5rem)] overflow-y-auto sm:my-4 sm:max-h-[calc(100dvh-2.5rem)]',
            isLite ? 'bg-[#090b14]' : 'bg-slate-950'
          )}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(129,140,248,0.18),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(34,197,94,0.12),transparent_28%)]" />
          <div className="relative border-b border-white/10 px-4 py-3.5 sm:px-5 sm:py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="max-w-2xl min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <NetworkPill label="TON" tone="ton" compact />
                  <NetworkPill label="ETH" tone="eth" compact />
                  <NetworkPill label="SOL" tone="sol" compact />
                  {privyEnabled ? <NetworkPill label="Google" tone="google" compact /> : null}
                  {privyEnabled ? <NetworkPill label="Phone" tone="phone" compact /> : null}
                </div>
                <h2 className="mt-2.5 text-lg font-semibold tracking-tight text-white sm:text-xl">{title}</h2>
                <p className="mt-1 text-xs leading-5 text-white/60 sm:text-sm">{description}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 rounded-xl border border-white/10 bg-white/5 text-white/75 hover:bg-white/10 hover:text-white"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="relative grid gap-2.5 px-4 py-3.5 sm:grid-cols-2 sm:px-5 sm:py-4">
            <ConnectOptionCard
              type="ton"
              title="TonConnect"
              description="Direct TON wallet connect."
              badges={[{ label: 'TON', tone: 'ton' }]}
              onClick={onSelectTon}
            />
            <ConnectOptionCard
              type="wallets"
              title="Ethereum & Solana"
              description="EVM or Solana via Privy."
              badges={[{ label: 'ETH', tone: 'eth' }, { label: 'SOL', tone: 'sol' }]}
              onClick={onSelectWallets}
              disabled={!privyEnabled}
            />
            <ConnectOptionCard
              type="google"
              title="Google"
              description="Fast social sign-in."
              badges={[{ label: 'OAuth', tone: 'google' }]}
              onClick={onSelectGoogle}
              disabled={!privyEnabled}
            />
            <ConnectOptionCard
              type="phone"
              title="Phone"
              description="Quick SMS sign-in."
              badges={[{ label: 'SMS', tone: 'phone' }]}
              onClick={onSelectPhone}
              disabled={!privyEnabled}
            />
          </div>

          <div className="relative flex flex-col gap-1.5 border-t border-white/10 px-4 py-2.5 text-[11px] text-white/50 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="flex items-center gap-2 text-white/60">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
              <span>Privy optional.</span>
            </div>
            <div className="flex items-center gap-2 text-white/55">
              <Sparkles className="h-3.5 w-3.5 text-violet-300" />
              <span>WDK wallet auto-created.</span>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}