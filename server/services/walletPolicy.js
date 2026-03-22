export const DEFAULT_WALLET_POLICY = Object.freeze({
  externalWalletsEnabled: true,
  managedWalletsEnabled: true,
  managedWalletCreationMode: 'admin-only',
  autoProvisionManagedWalletOnRegistration: true,
  requireSessionForManagedWallets: true,
  allowProfileWithoutWallet: true,
  allowReadonlyWalletLinking: true,
})

export function mergeWalletPolicy(overrides = {}) {
  return {
    ...DEFAULT_WALLET_POLICY,
    ...(overrides || {}),
  }
}

export function describeWalletPolicy(policy) {
  const merged = mergeWalletPolicy(policy)
  return {
    ...merged,
    publicManagedWalletCreationAllowed: merged.managedWalletsEnabled && merged.managedWalletCreationMode === 'self-service',
    adminManagedWalletCreationRequired: merged.managedWalletsEnabled && merged.managedWalletCreationMode === 'admin-only',
  }
}