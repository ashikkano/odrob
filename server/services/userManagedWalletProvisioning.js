import { randomUUID } from 'crypto'

export function createUserManagedWalletProvisioningService({
  walletProviderRegistry,
  upsertUser,
  upsertWalletConnection,
  insertManagedWalletRecord,
  upsertUserWallet,
  listUserWalletsByUserId,
  getAppUser,
  updateAppUserPrimaryWallet,
}) {
  async function ensureManagedWalletForUser({ userId, ownerAddress = null, source = 'system', label = null }) {
    const appUser = await getAppUser(userId)
    if (!appUser) throw new Error('App user not found for managed wallet provisioning')

    const existingManaged = (await listUserWalletsByUserId(userId))
      .find((wallet) => wallet.walletKind === 'managed' && wallet.walletProvider === 'wdk-ton' && wallet.isActive)

    if (existingManaged) {
      if (!appUser.primaryWalletAddress) await updateAppUserPrimaryWallet(userId, existingManaged.walletAddress)
      await upsertUser(existingManaged.walletAddress)
      return {
        created: false,
        appUser: await getAppUser(userId),
        managedWallet: existingManaged,
      }
    }

    const created = await walletProviderRegistry.createManagedWallet({
      providerId: 'wdk-ton',
      ownerAddress,
      mode: 'create',
      label: label || 'Privy managed wallet',
    })

    const compatibilityOwnerAddress = ownerAddress || created.wallet.address
    await upsertUser(created.wallet.address)

    const managedWalletRecord = await insertManagedWalletRecord({
      id: randomUUID(),
      ownerAddress: compatibilityOwnerAddress,
      walletId: created.wallet.id,
      walletAddress: created.wallet.address,
      provider: created.providerId,
      mode: created.mode,
      label: label || 'Privy managed wallet',
      accountIndex: created.managedWallet.accountIndex || 0,
      derivationPath: created.managedWallet.derivationPath || null,
      status: 'active',
      metadata: {
        ...created.managedWallet.metadata,
        source,
        autoProvisioned: true,
      },
    })

    const linkedWallet = await upsertWalletConnection({
      id: randomUUID(),
      ownerAddress: compatibilityOwnerAddress,
      walletAddress: created.wallet.address,
      walletKind: 'managed',
      walletProvider: created.providerId,
      walletRef: created.wallet.id,
      label: label || 'Privy managed wallet',
      isPrimary: true,
      metadata: {
        managedWalletId: managedWalletRecord.id,
        source,
        autoProvisioned: true,
        accountIndex: created.managedWallet.accountIndex || 0,
        derivationPath: created.managedWallet.derivationPath || null,
      },
    })

    const userWallet = await upsertUserWallet({
      id: randomUUID(),
      userId,
      walletAddress: created.wallet.address,
      walletKind: 'managed',
      walletProvider: created.providerId,
      walletRef: created.wallet.id,
      label: label || 'Privy managed wallet',
      isPrimary: true,
      isActive: true,
      metadata: {
        source,
        autoProvisioned: true,
        managedWalletId: managedWalletRecord.id,
      },
    })

    const nextAppUser = appUser.primaryWalletAddress
      ? appUser
      : await updateAppUserPrimaryWallet(userId, created.wallet.address)

    return {
      created: true,
      appUser: nextAppUser,
      managedWallet: userWallet,
      compatibility: {
        managedWalletRecord,
        linkedWallet,
      },
    }
  }

  return { ensureManagedWalletForUser }
}