import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTonConnectUI } from '@tonconnect/ui-react'
import { useAuthSession } from '@/contexts/AuthContext'

export function getSessionWalletAddress(session) {
  return session?.activeWalletAddress
    || session?.managedWallet?.walletAddress
    || session?.linkedWallets?.[0]?.walletAddress
    || ''
}

export function hasPrivyWalletSession(session) {
  return Boolean(
    session?.authenticated
    && (
      session?.authSource === 'privy'
      || session?.privyUserId
      || session?.privy?.userId
      || (Array.isArray(session?.privy?.wallets) && session.privy.wallets.length > 0)
    )
  )
}

export function getPrivyLinkedWalletEntries(user, primaryAddress = '', session = null) {
  const normalizedPrimary = String(primaryAddress || '').toLowerCase()
  const linkedAccounts = Array.isArray(user?.linkedAccounts) ? user.linkedAccounts : []
  const sessionWallets = Array.isArray(session?.privy?.wallets) ? session.privy.wallets : []

  return [
    ...linkedAccounts
      .filter((account) => (account?.type === 'wallet' || account?.type === 'smart_wallet') && account?.address)
      .map((account, index) => {
        const chain = account?.chainType || account?.chain_type || (account?.type === 'smart_wallet' ? 'smart' : 'wallet')
        const chainLabel = chain === 'ethereum'
          ? 'ETH'
          : chain === 'solana'
            ? 'SOL'
            : 'SMART'

        return {
          id: `${account.type}:${account.address}:${index}`,
          address: account.address,
          label: account.type === 'smart_wallet' ? 'Privy smart wallet' : 'Privy wallet',
          badgeText: chainLabel,
        }
      }),
    ...sessionWallets.map((wallet, index) => {
      const chain = wallet?.chainType || wallet?.chain_type || wallet?.walletClientType || 'wallet'
      const chainLabel = chain === 'ethereum'
        ? 'ETH'
        : chain === 'solana'
          ? 'SOL'
          : 'SMART'

      return {
        id: wallet?.id || `session-privy-wallet:${wallet?.address || 'unknown'}:${index}`,
        address: wallet?.address || '',
        label: chain === 'smart' || chain === 'smart_wallet' ? 'Privy smart wallet' : 'Privy wallet',
        badgeText: chainLabel,
      }
    }),
  ]
    .filter((entry) => Boolean(entry?.address))
    .filter((entry, index, items) => {
      const normalizedAddress = String(entry.address || '').toLowerCase()
      if (!normalizedAddress || normalizedAddress === normalizedPrimary) return false
      return items.findIndex((candidate) => String(candidate.address || '').toLowerCase() === normalizedAddress) === index
    })
}

export function useConnectWalletChooser({ mode = 'default' } = {}) {
  const [open, setOpen] = useState(false)
  const [tonConnectUI] = useTonConnectUI()
  const { privyEnabled, loginWithPrivy, loginWithGoogle, loginWithPhone } = useAuthSession()

  const closeChooser = useCallback(() => setOpen(false), [])
  const openChooser = useCallback(() => setOpen(true), [])

  useEffect(() => {
    if (!tonConnectUI?.onStatusChange) return undefined

    return tonConnectUI.onStatusChange((wallet) => {
      if (!wallet) return
      closeChooser()
      tonConnectUI.closeModal?.()
    })
  }, [closeChooser, tonConnectUI])

  const selectTon = useCallback(() => {
    tonConnectUI.openModal()
    closeChooser()
  }, [closeChooser, tonConnectUI])

  const selectWallets = useCallback(() => {
    if (!privyEnabled) {
      tonConnectUI.openModal()
      closeChooser()
      return
    }
    const request = loginWithPrivy({ loginMethods: ['wallet'] })
    closeChooser()
    request.catch(() => {})
  }, [closeChooser, loginWithPrivy, privyEnabled, tonConnectUI])

  const selectGoogle = useCallback(() => {
    if (!privyEnabled) return
    const request = loginWithGoogle()
    closeChooser()
    request.catch(() => {})
  }, [closeChooser, loginWithGoogle, privyEnabled])

  const selectPhone = useCallback(() => {
    if (!privyEnabled) return
    const request = loginWithPhone()
    closeChooser()
    request.catch(() => {})
  }, [closeChooser, loginWithPhone, privyEnabled])

  return useMemo(() => ({
    open,
    openChooser,
    closeChooser,
    modalProps: {
      open,
      onClose: closeChooser,
      onSelectTon: selectTon,
      onSelectWallets: selectWallets,
      onSelectGoogle: selectGoogle,
      onSelectPhone: selectPhone,
      privyEnabled,
      mode,
    },
  }), [closeChooser, mode, open, openChooser, privyEnabled, selectGoogle, selectPhone, selectTon, selectWallets])
}