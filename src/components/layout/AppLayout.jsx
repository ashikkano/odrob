import { useState, useEffect, useCallback, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  LineChart,
  Bot,
  Store,
  BarChart3,
  Settings,
  Zap,
  Radio,
  Menu,
  X,
  Sun,
  Moon,
  Languages,
  Brain,
  Server,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import WalletButton from '@/components/wallet/WalletButton'
import { useTheme } from '@/contexts/ThemeContext'
import { useTranslation } from '@/contexts/LanguageContext'
import { fetchIndexes } from '@/services/indexApi'
import { fetchMetrics } from '@/services/engineApi'

const NAV_KEYS = [
  { to: '/dashboard', icon: LayoutDashboard, key: 'nav.dashboard' },
  { to: '/trading', icon: LineChart, key: 'nav.trading' },
  { to: '/agents', icon: Bot, key: 'nav.agents' },
  { to: '/marketplace', icon: Store, key: 'nav.marketplace' },
  { to: '/analytics', icon: BarChart3, key: 'nav.analytics' },
  { to: '/llm-plan', icon: Brain, key: 'nav.llmPlan' },
  { to: '/llm', icon: Zap, key: 'nav.llmDashboard' },
  { to: '/orderbook-plan', icon: BarChart3, key: 'nav.orderbookPlan' },
  { to: '/orderbook-monitor', icon: Server, key: 'nav.orderbookMonitor' },
  { to: '/settings', icon: Settings, key: 'nav.settings' },
]

function SidebarNavItem({ to, icon: Icon, label, onClick }) {
  return (
    <NavLink
      to={to}
      end={to === '/dashboard'}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{label}</span>
    </NavLink>
  )
}

function SidebarContent({ onNavigate, indexes = [], metrics }) {
  const { t } = useTranslation()
  const { language, setLanguage } = useTranslation()
  const { isDark, toggleTheme } = useTheme()

  return (
    <>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15">
          <Zap className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h1 className="text-sm font-bold text-foreground tracking-tight">ODROB</h1>
          <p className="text-[10px] text-muted-foreground">{t('sidebar.platform')}</p>
        </div>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Navigation */}
      <ScrollArea className="flex-1 px-3 py-3">
        <nav className="flex flex-col gap-1">
          {NAV_KEYS.map((item) => (
            <SidebarNavItem key={item.to} to={item.to} icon={item.icon} label={t(item.key)} onClick={onNavigate} />
          ))}
        </nav>
      </ScrollArea>

      <Separator className="bg-sidebar-border" />

      {/* Theme + Language toggles */}
      <div className="px-4 pt-3 flex items-center gap-2">
        <button
          onClick={toggleTheme}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-sidebar-border text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors cursor-pointer"
          title={isDark ? t('theme.light') : t('theme.dark')}
        >
          {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={() => setLanguage(language === 'ru' ? 'en' : 'ru')}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-sidebar-border px-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors cursor-pointer"
          title={t('settings.language')}
        >
          <Languages className="h-3.5 w-3.5" />
          {language === 'ru' ? 'RU' : 'EN'}
        </button>
      </div>

      {/* Status footer */}
      <div className="p-4 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t('sidebar.oracle')}</span>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-profit animate-pulse-live" />
            <span className="text-profit font-medium">{t('sidebar.live')}</span>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t('sidebar.agents')}</span>
          <Badge variant="active" className="text-[10px] px-1.5 py-0">{metrics?.activeAgents || 0}/{metrics?.totalAgents || 0}</Badge>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t('sidebar.network')}</span>
          <span className="font-mono text-muted-foreground">TON</span>
        </div>
        <div className="pt-1 flex items-center gap-3">
          <NavLink
            to="/docs"
            className="text-[11px] text-primary/90 hover:text-primary transition-colors"
          >
            Docs →
          </NavLink>
          <NavLink
            to="/guide"
            className="text-[11px] text-primary/90 hover:text-primary transition-colors"
          >
            Guide →
          </NavLink>
        </div>
      </div>
    </>
  )
}

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [indexes, setIndexes] = useState([])
  const [metrics, setMetrics] = useState(null)
  const location = useLocation()
  const { t } = useTranslation()
  const { isDark, toggleTheme } = useTheme()
  const { language, setLanguage } = useTranslation()
  const mountedRef = useRef(true)

  // Fetch live index prices + engine metrics
  useEffect(() => {
    mountedRef.current = true
    const load = async () => {
      try {
        const [ix, m] = await Promise.all([fetchIndexes(), fetchMetrics()])
        if (!mountedRef.current) return
        setIndexes(ix || [])
        setMetrics(m)
      } catch {}
    }
    load()
    const id = setInterval(load, 5000)
    return () => { mountedRef.current = false; clearInterval(id) }
  }, [])

  // Close drawer on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  // Lock body scroll when drawer open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [mobileOpen])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setMobileOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const closeMobile = useCallback(() => setMobileOpen(false), [])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-[220px] flex-col border-r border-sidebar-border bg-sidebar shrink-0">
        <SidebarContent indexes={indexes} metrics={metrics} />
      </aside>

      {/* Mobile Overlay */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 md:hidden',
          mobileOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        onClick={closeMobile}
        aria-hidden="true"
      />

      {/* Mobile Drawer */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-[260px] flex flex-col border-r border-sidebar-border bg-sidebar shadow-2xl transition-transform duration-300 ease-out md:hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Close button */}
        <button
          onClick={closeMobile}
          className="absolute top-3.5 right-3 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>

        <SidebarContent onNavigate={closeMobile} indexes={indexes} metrics={metrics} />
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="sticky top-0 z-50 flex items-center justify-between border-b border-border/80 px-4 md:px-6 py-3 bg-card/78 backdrop-blur-xl shadow-[0_10px_30px_rgba(0,0,0,0.12)]">
          <div className="flex items-center gap-3">
            {/* Hamburger button — mobile only */}
            <button
              onClick={() => setMobileOpen(true)}
              className="flex md:hidden h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              aria-label="Open menu"
            >
              <Menu className="h-4 w-4" />
            </button>

            {/* Mobile logo */}
            <div className="flex md:hidden items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              <span className="font-bold text-sm">ODROB</span>
            </div>
            
            {/* Live ticker — real index prices */}
            <div className="flex items-center gap-4">
              {indexes.length > 0 && (
                <Radio className="h-3 w-3 text-profit animate-pulse-live shrink-0" />
              )}
              {indexes.map((ix, i) => (
                <div key={ix.id} className={cn('flex items-center gap-1.5', i > 0 && 'hidden sm:flex', i > 1 && 'hidden lg:flex')}>
                  <span className="text-[10px] text-muted-foreground">{ix.symbol}</span>
                  <span className="font-mono text-sm font-semibold text-foreground">
                    ${(ix.oraclePrice || 0).toFixed(ix.oraclePrice >= 1 ? 2 : 4)}
                  </span>
                  <span className={cn('font-mono text-[11px]', (ix.changePct || 0) >= 0 ? 'text-profit' : 'text-loss')}>
                    {(ix.changePct || 0) >= 0 ? '+' : ''}{(ix.changePct || 0).toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs">
              <span className="h-2 w-2 rounded-full bg-profit" />
              <span className="text-muted-foreground">{metrics?.activeAgents || 0} {t('header.active')}</span>
            </div>

            {/* Theme toggle — desktop */}
            <button
              onClick={toggleTheme}
              className="hidden md:flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              title={isDark ? t('theme.light') : t('theme.dark')}
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {/* Language toggle — desktop */}
            <button
              onClick={() => setLanguage(language === 'ru' ? 'en' : 'ru')}
              className="hidden md:flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              title={t('settings.language')}
            >
              <Languages className="h-4 w-4" />
              {language === 'ru' ? 'RU' : 'EN'}
            </button>

            <WalletButton />
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.06),transparent_20%),linear-gradient(180deg,transparent,rgba(255,255,255,0.01))]">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
