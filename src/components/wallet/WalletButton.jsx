import { useTonAddress, useTonConnectUI } from '@tonconnect/ui-react'
import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ConnectWalletModal from '@/components/wallet/ConnectWalletModal'
import ConnectedWalletMenu from '@/components/wallet/ConnectedWalletMenu'
import { getPrivyLinkedWalletEntries, getSessionWalletAddress, hasPrivyWalletSession, useConnectWalletChooser } from '@/components/wallet/useConnectWalletChooser'
import { useAuthSession } from '@/contexts/AuthContext'
import { useAgents } from '@/contexts/AgentContext'

export default function WalletButton() {
  const tonAddress = useTonAddress(false)
  const [tonConnectUI] = useTonConnectUI()
  const navigate = useNavigate()
  const { agentList, walletAddress, externalWalletAddress } = useAgents()
  const { logout, session, user } = useAuthSession()
  const connectChooser = useConnectWalletChooser()

  const sessionWalletAddress = getSessionWalletAddress(session)
  const address = sessionWalletAddress || walletAddress || tonAddress || null
  const hasExternalWallet = Boolean(externalWalletAddress || tonAddress)
  const isManagedSession = Boolean(sessionWalletAddress)
  const privyWalletEntries = hasPrivyWalletSession(session)
    ? getPrivyLinkedWalletEntries(user, address, session)
    : []

  const hasUserAgent = agentList.some((agent) => agent?.isUserAgent)

  const handleConnect = useCallback(() => {
    connectChooser.openChooser()
  }, [connectChooser])

  const handleLogout = useCallback(async () => {
    await logout()
    if (hasExternalWallet) {
      await tonConnectUI.disconnect().catch(() => {})
    }
  }, [hasExternalWallet, logout, tonConnectUI])

  const handleCreateAgent = useCallback(() => {
    navigate('/agents/new')
  }, [navigate])

  if (!address) {
    return (
      <>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-primary/25 bg-primary/10 px-3 text-sm font-medium text-primary transition-colors hover:bg-primary/15"
          onClick={handleConnect}
        >
          <span className="text-base leading-none">💎</span>
          <span className="hidden sm:inline">Connect Wallet</span>
          <span className="sm:hidden">Connect</span>
        </button>
        <ConnectWalletModal {...connectChooser.modalProps} />
      </>
    )
  }

  return (
    <>
      <div className="flex items-center gap-2">
        {!hasUserAgent ? (
          <Button size="sm" variant="outline" className="hidden md:inline-flex gap-1.5" onClick={handleCreateAgent}>
            <Plus className="h-3.5 w-3.5" />
            Create agent
          </Button>
        ) : null}
        <ConnectedWalletMenu
          address={address}
          label={isManagedSession ? 'WDK wallet' : 'Wallet'}
          badgeText={isManagedSession ? 'WDK' : 'TON'}
          linkedWalletEntries={privyWalletEntries}
          icon={isManagedSession ? '✨' : '💎'}
          onTopUp={() => navigate('/lite/wallet')}
          onLogout={handleLogout}
        />
      </div>
      <ConnectWalletModal {...connectChooser.modalProps} />
    </>
  )
}
