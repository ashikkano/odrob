import { Shield, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const VARIANTS = {
  default: {
    wrap: 'border-primary/20 bg-primary/5',
    icon: 'bg-primary/10 text-primary',
    title: 'text-foreground',
    desc: 'text-muted-foreground',
  },
  dark: {
    wrap: 'border-white/10 bg-white/[0.04]',
    icon: 'bg-white/10 text-white',
    title: 'text-white',
    desc: 'text-white/65',
  },
}

export default function WalletAuthGate({
  title = 'Connect wallet',
  description = 'Connect your TON wallet to continue.',
  actionLabel = 'Connect Wallet',
  onConnect,
  secondaryActionLabel,
  onSecondaryAction,
  icon: Icon = Shield,
  variant = 'default',
  className,
  compact = false,
  children,
}) {
  const theme = VARIANTS[variant] || VARIANTS.default

  return (
    <div className={cn('rounded-2xl border p-4 space-y-3', theme.wrap, compact && 'p-4', className)}>
      <div className="flex items-start gap-3">
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', theme.icon)}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className={cn('font-medium', theme.title)}>{title}</div>
          <div className={cn('text-sm mt-1', theme.desc)}>{description}</div>
        </div>
      </div>
      <div className={cn('flex gap-2', compact ? 'flex-col' : 'flex-col sm:flex-row')}>
        <Button onClick={onConnect} className={cn('gap-2', compact ? 'w-full' : 'w-full sm:w-auto')}>
          <Wallet className="h-4 w-4" />
          {actionLabel}
        </Button>
        {secondaryActionLabel && onSecondaryAction ? (
          <Button variant="outline" onClick={onSecondaryAction} className={cn('gap-2', compact ? 'w-full' : 'w-full sm:w-auto')}>
            <Shield className="h-4 w-4" />
            {secondaryActionLabel}
          </Button>
        ) : null}
      </div>
      {children}
    </div>
  )
}
