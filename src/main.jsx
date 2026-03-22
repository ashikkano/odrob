import { createRoot } from 'react-dom/client'
import { lazy, Suspense } from 'react'
import { PrivyProvider } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
const TonConnectUIProvider = lazy(() => import('@tonconnect/ui-react').then(mod => ({
  default: mod.TonConnectUIProvider
})))
const THEME = lazy(() => import('@tonconnect/ui-react').then(mod => ({
  default: mod.THEME
})))
import ErrorBoundary from './components/ErrorBoundary'
import { AuthProvider } from './contexts/AuthContext'
import App from './App'
import { isTonConnectDebugEnabled, tonConnectDebugLog } from './lib/tonConnectDebug'
import './index.css'

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID || ''
const privyClientId = import.meta.env.VITE_PRIVY_CLIENT_ID || undefined
const privyEnabled = Boolean(privyAppId)

const privyConfig = {
  loginMethods: ['wallet', 'google', 'sms'],
  appearance: {
    theme: 'dark',
    accentColor: '#6d5efc',
    walletChainType: 'ethereum-and-solana',
    walletList: [
      'metamask',
      'phantom',
      'solflare',
      'coinbase_wallet',
      'rainbow',
      'detected_ethereum_wallets',
      'detected_solana_wallets',
      'wallet_connect',
    ],
  },
  externalWallets: {
    solana: {
      connectors: toSolanaWalletConnectors(),
    },
  },
  intl: {
    defaultCountry: 'US',
  },
}

function OptionalPrivyProvider({ children }) {
  if (!privyEnabled) return children

  return (
    <PrivyProvider appId={privyAppId} clientId={privyClientId} config={privyConfig}>
      {children}
    </PrivyProvider>
  )
}

console.log('[ODROB] main.jsx loaded, rendering...')

if (typeof window !== 'undefined' && isTonConnectDebugEnabled() && !window.__ODROB_TONCONNECT_DIAGNOSTICS__) {
  window.__ODROB_TONCONNECT_DIAGNOSTICS__ = true

  const tonConnectEvents = [
    'ton-connect-connection-completed',
    'ton-connect-connection-error',
    'ton-connect-transaction-sent-for-signature',
    'ton-connect-transaction-signed',
    'ton-connect-transaction-signing-failed',
  ]

  tonConnectEvents.forEach((eventName) => {
    window.addEventListener(eventName, (event) => {
      tonConnectDebugLog(`[TonConnect event] ${eventName}`, event.detail)
    })
  })
}

// Signal that the app mounted (used by index.html timeout diagnostics)
const origMounted = () => { window.__ODROB_MOUNTED = true }

try {
  const root = createRoot(document.getElementById('root'))
  root.render(
    <ErrorBoundary onMount={origMounted}>
      <Suspense fallback={<div style={{padding:40,textAlign:'center'}}>Loading TON wallet…</div>}>
        <OptionalPrivyProvider>
          <AuthProvider privyEnabled={privyEnabled}>
            <TonConnectUIProvider
              manifestUrl='https://dev.giftindex.io/tonconnect-manifest.json'
              analytics={{ mode: 'off' }}
              actionsConfiguration={{
                twaReturnUrl: 'https://t.me/odrob_bot/app',
                skipRedirectToWallet: 'never',
                returnStrategy: 'back',
              }}
              uiPreferences={{
                theme: THEME.DARK,
              }}
            >
              <App />
            </TonConnectUIProvider>
          </AuthProvider>
        </OptionalPrivyProvider>
      </Suspense>
    </ErrorBoundary>
  )
  // Mark mounted after short delay (React render is async)
  setTimeout(origMounted, 500)
  console.log('[ODROB] render() called successfully')
} catch (err) {
  console.error('[ODROB] Fatal render error:', err)
  window.__ODROB_ERRORS = window.__ODROB_ERRORS || []
  window.__ODROB_ERRORS.push({ msg: err.message, stack: err.stack })
  document.getElementById('root').innerHTML =
    '<div style="padding:40px;background:#0d0d14;color:#ff6b6b;min-height:100vh;font-family:monospace">' +
    '<h1 style="color:#fff">⚠ Render Error</h1><pre style="white-space:pre-wrap">' + err.message + '</pre><pre style="color:#888;white-space:pre-wrap">' + err.stack + '</pre>' +
    '<button onclick="localStorage.clear();location.reload()" style="margin-top:20px;padding:8px 20px;background:#4a6cf7;color:#fff;border:none;border-radius:6px;cursor:pointer">Reload</button></div>'
}

