import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export function PageShell({ children, width = 'wide', className }) {
  return (
    <div
      className={cn(
        'od-page-shell',
        width === 'narrow' && 'od-page-shell-narrow',
        width === 'wide' && 'od-page-shell-wide',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function PageHero({ icon: Icon, title, description, meta = [], actions, className, children, tone = 'default' }) {
  return (
    <section className={cn('od-page-hero', className)}>
      <div className="od-page-hero-main">
        <div className="od-page-hero-copy">
          <div className="od-page-hero-title-row">
            {Icon ? (
              <div className={cn('od-page-hero-icon', `od-page-hero-icon-${tone}`)}>
                <Icon className="h-5 w-5" />
              </div>
            ) : null}
            <div>
              <h1 className="od-page-hero-title">{title}</h1>
              {description ? <p className="od-page-hero-description">{description}</p> : null}
            </div>
          </div>

          {meta.length > 0 ? (
            <div className="od-page-hero-meta">
              {meta.map((item, index) => (
                <Badge key={index} variant="outline" className="od-page-hero-chip">
                  {item}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        {actions ? <div className="od-page-hero-actions">{actions}</div> : null}
      </div>

      {children ? <div className="od-page-hero-body">{children}</div> : null}
    </section>
  )
}