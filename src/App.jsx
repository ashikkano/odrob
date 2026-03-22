// ...existing code...
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { LanguageProvider } from '@/contexts/LanguageContext'
import { useAuthSession } from '@/contexts/AuthContext'
import { AgentProvider } from '@/contexts/AgentContext'
import ErrorBoundary from '@/components/ErrorBoundary'
import { lazy, Suspense } from 'react'
const THEME = lazy(() => import('@tonconnect/ui-react').then(mod => ({ default: mod.THEME })))

// ── Lazy-loaded pages (code-split per route) ──
const LitePage = lazy(() => import('@/pages/LitePage'))
const LiteManagedWalletPage = lazy(() => import('@/pages/LiteManagedWalletPage'))
const LiteStrategyMarketplacePage = lazy(() => import('@/pages/LiteStrategyMarketplacePage'))
const LiteStrategyPublishPage = lazy(() => import('@/pages/LiteStrategyPublishPage'))
const AutonomousAgentsLandingPage = lazy(() => import('@/pages/AutonomousAgentsLandingPage'))

function PageLoader() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', color: 'rgba(255,255,255,0.5)', fontSize: '0.9rem',
    }}>
      Loading...
    </div>
  )
}

const HIDDEN_FULL_UI_ROUTE_PREFIXES = [
  'dashboard',
  'trading',
  'marketplace',
  'analytics',
  'llm-plan',
  'llm',
  'orderbook-plan',
  'orderbook-monitor',
  'settings',
  'admin',
  'admin-v2',
  'manager',
  'audit',
  'docs',
  'guide',
]

function RootEntryRoute({ authenticated }) {
  if (authenticated) {
    return <Navigate to="/lite" replace />
  }

  return <AutonomousAgentsLandingPage />
}

export default function App() {
  const { ready: authReady, privyEnabled, authenticated } = useAuthSession()

  if (privyEnabled && !authReady) {
    return <PageLoader />
  }

  return (
    <ThemeProvider>
      <LanguageProvider>
        <AgentProvider>
          <TooltipProvider>
            <ErrorBoundary>
              <BrowserRouter>
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    <Route path="/" element={<RootEntryRoute authenticated={authenticated} />} />
                    {/* Lite — standalone, no sidebar */}
                    <Route path="lite" element={<LitePage />} />
                    <Route path="lite/wallet" element={<LiteManagedWalletPage />} />
                    <Route path="lite/strategies" element={<LiteStrategyMarketplacePage />} />
                    <Route path="lite/strategies/publish" element={<LiteStrategyPublishPage />} />
                    <Route path="autonomous-agents" element={<Navigate to="/" replace />} />
                    {HIDDEN_FULL_UI_ROUTE_PREFIXES.map((path) => (
                      <Route key={path} path={`${path}/*`} element={<Navigate to="/lite" replace />} />
                    ))}
                    <Route path="agents/*" element={<Navigate to="/lite" replace />} />
                  </Routes>
                </Suspense>
              </BrowserRouter>
            </ErrorBoundary>
          </TooltipProvider>
        </AgentProvider>
      </LanguageProvider>
    </ThemeProvider>
  )
}
