import { useState } from 'react'
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { registerOnboarding } from '@/services/onboardingApi'
import { cn } from '@/lib/utils'

export default function AdminManagedRegistrationCard({ className, onRegistered }) {
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  async function handleSubmit() {
    setLoading(true)
    setError('')
    try {
      const data = await registerOnboarding({
        displayName: displayName.trim(),
        username: username.trim() || undefined,
        autoProvisionManagedWallet: true,
        managedWalletLabel: `${displayName.trim() || 'User'} custody`,
      })
      setResult(data)
      try {
        window.dispatchEvent(new CustomEvent('odrob:onboarding-session-changed', { detail: data }))
      } catch {}
      onRegistered?.(data)
    } catch (err) {
      setError(err.message || 'Unable to register and provision managed wallet')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={cn('rounded-2xl border border-sky-500/20 bg-sky-500/5 p-5 space-y-4', className)}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-300">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div>
          <div className="font-medium">Register with admin-managed custody</div>
          <div className="text-sm mt-1 text-muted-foreground">Create your profile and let the platform provision a separate managed wallet for trading custody.</div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Display name</span>
          <input className="w-full rounded-xl border bg-background px-3 py-2" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Username</span>
          <input className="w-full rounded-xl border bg-background px-3 py-2" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="optional" />
        </label>
      </div>

      {error ? <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div> : null}

      {result?.managedWallet ? (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm space-y-2">
          <div className="flex items-center gap-2 text-emerald-300 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            Registration complete
          </div>
          <div className="text-muted-foreground break-all">Managed wallet: {result.managedWallet.walletAddress}</div>
          {result.recoveryPhrase ? <div className="rounded-lg border border-dashed border-emerald-500/20 bg-background/60 p-3 text-foreground">Recovery phrase: {result.recoveryPhrase}</div> : null}
        </div>
      ) : null}

      <Button onClick={handleSubmit} disabled={loading || displayName.trim().length < 2}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        Register and provision wallet
      </Button>
    </div>
  )
}