import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Import, Loader2, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createManagedWallet } from '@/services/onboardingApi'
import { cn } from '@/lib/utils'

export default function ManagedWalletSetupCard({ ownerAddress = null, onCreated, className }) {
  const [mode, setMode] = useState('create')
  const [label, setLabel] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [accountIndex, setAccountIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const helperText = useMemo(() => {
    if (mode === 'create') return 'Generate a managed TON wallet now and register a profile later.'
    return 'Import an existing recovery phrase into the managed WDK wallet provider.'
  }, [mode])

  async function handleSubmit() {
    setLoading(true)
    setError('')
    try {
      const created = await createManagedWallet({
        providerId: 'wdk-ton',
        ownerAddress: ownerAddress || undefined,
        mode,
        label: label.trim() || undefined,
        mnemonic: mode === 'import' ? mnemonic.trim() : undefined,
        accountIndex: Number(accountIndex) || 0,
      }, ownerAddress || undefined)
      setResult(created)
      if (mode === 'create') setMnemonic(created.recoveryPhrase || '')
      onCreated?.(created)
    } catch (err) {
      setError(err.message || 'Failed to provision managed wallet')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={cn('rounded-2xl border border-primary/20 bg-primary/5 p-5 space-y-4', className)}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Wallet className="h-4 w-4" />
        </div>
        <div>
          <div className="font-medium">Managed wallet via WDK</div>
          <div className="text-sm mt-1 text-muted-foreground">{helperText}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={mode === 'create' ? 'default' : 'outline'} size="sm" onClick={() => setMode('create')}>
          Create new wallet
        </Button>
        <Button variant={mode === 'import' ? 'default' : 'outline'} size="sm" onClick={() => setMode('import')}>
          <Import className="h-3.5 w-3.5" />
          Import phrase
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Label</span>
          <input
            className="w-full rounded-xl border bg-background px-3 py-2"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Treasury wallet, Vault #1..."
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Account index</span>
          <input
            className="w-full rounded-xl border bg-background px-3 py-2"
            type="number"
            min="0"
            value={accountIndex}
            onChange={(event) => setAccountIndex(event.target.value)}
          />
        </label>
      </div>

      {mode === 'import' ? (
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Recovery phrase</span>
          <textarea
            className="min-h-[104px] w-full rounded-xl border bg-background px-3 py-2"
            value={mnemonic}
            onChange={(event) => setMnemonic(event.target.value)}
            placeholder="word1 word2 word3 ..."
          />
        </label>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {result?.wallet ? (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm space-y-2">
          <div className="flex items-center gap-2 text-emerald-300 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            Managed wallet ready
          </div>
          <div className="text-muted-foreground break-all">Address: {result.wallet.address}</div>
          {result.recoveryPhrase ? (
            <div className="rounded-lg border border-dashed border-emerald-500/20 bg-background/60 p-3 text-foreground">
              Save this recovery phrase now: {result.recoveryPhrase}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={handleSubmit} disabled={loading || (mode === 'import' && !mnemonic.trim())}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
          {mode === 'create' ? 'Create managed wallet' : 'Import managed wallet'}
        </Button>
        <span className="text-xs text-muted-foreground">Profile registration remains optional.</span>
      </div>
    </div>
  )
}