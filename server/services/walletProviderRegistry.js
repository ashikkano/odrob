export function createWalletProviderRegistry({ wdkWalletService }) {
  const providers = [
    {
      id: 'external-tonconnect',
      label: 'External TON Wallet',
      kind: 'external',
      capabilities: ['connect', 'sign-via-client'],
    },
    wdkWalletService.getProviderMeta(),
  ]

  return {
    listProviders() {
      return providers
    },

    async createManagedWallet({ providerId = 'wdk-ton', ...input }) {
      if (providerId !== 'wdk-ton') {
        throw new Error(`Unsupported managed wallet provider: ${providerId}`)
      }
      return wdkWalletService.createManagedWallet(input)
    },

    async getManagedWalletRuntime({ providerId = 'wdk-ton', managedWallet }) {
      if (providerId !== 'wdk-ton') {
        throw new Error(`Unsupported managed wallet provider: ${providerId}`)
      }
      return wdkWalletService.getManagedWalletRuntime(managedWallet)
    },
  }
}