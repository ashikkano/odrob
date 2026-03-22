import { validateMnemonic } from 'bip39'
import { randomUUID } from 'crypto'
import { normalizeAddr } from '../utils/tonAddress.js'

async function loadWdkModule() {
  return import('@tetherto/wdk-wallet-ton')
}

function normalizeMnemonicInput(mnemonic) {
  const phrase = Array.isArray(mnemonic)
    ? mnemonic.map((word) => String(word || '').trim()).filter(Boolean).join(' ')
    : String(mnemonic || '')
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .join(' ')

  return phrase.trim()
}

function buildProviderConfig({ isTestnet, tonApiBase }) {
  const tonClientUrl = String(tonApiBase || '').replace('/api/v2', '/api/v3')
  return {
    tonClient: {
      url: tonClientUrl,
    },
    transferMaxFee: isTestnet ? 1_000_000_000n : 2_000_000_000n,
  }
}

async function createWalletManager(WalletManagerTon, seedPhrase, config) {
  try {
    return new WalletManagerTon(seedPhrase, config)
  } catch (primaryError) {
    try {
      return new WalletManagerTon(seedPhrase)
    } catch {
      throw primaryError
    }
  }
}

function buildAccountPathCandidates(derivationPath) {
  const rawPath = typeof derivationPath === 'string' ? derivationPath.trim() : ''
  if (!rawPath) return []

  return [rawPath]
}

function extractAccountIndexFromDerivationPath(derivationPath) {
  const rawPath = typeof derivationPath === 'string' ? derivationPath.trim() : ''
  const match = /^m\/44'\/607'\/(\d+)'$/i.exec(rawPath)
  if (!match) return null

  const accountIndex = Number.parseInt(match[1], 10)
  return Number.isInteger(accountIndex) ? accountIndex : null
}

async function loadManagedAccount(manager, { derivationPath = null, accountIndex = null }) {
  const pathAccountIndex = extractAccountIndexFromDerivationPath(derivationPath)
  if (Number.isInteger(pathAccountIndex)) {
    return manager.getAccount(pathAccountIndex)
  }

  const pathCandidates = buildAccountPathCandidates(derivationPath)
  let pathError = null

  if (pathCandidates.length > 0 && typeof manager.getAccountByPath === 'function') {
    for (const candidatePath of pathCandidates) {
      try {
        return await manager.getAccountByPath(candidatePath)
      } catch (err) {
        pathError = err
      }
    }
  }

  const resolvedAccountIndex = Number.isInteger(accountIndex) ? accountIndex : 0
  try {
    return await manager.getAccount(resolvedAccountIndex)
  } catch (indexError) {
    if (pathError) {
      throw pathError
    }
    throw indexError
  }
}

function resolveManagedWalletSeed({ mnemonic, mode, masterSeed }) {
  if (mode === 'import') {
    const importedPhrase = normalizeMnemonicInput(mnemonic)
    if (!importedPhrase) {
      throw new Error('Mnemonic is required for managed wallet import')
    }
    if (!validateMnemonic(importedPhrase)) {
      throw new Error('Managed wallet seed phrase must be a valid BIP-39 mnemonic')
    }
    return {
      seedPhrase: importedPhrase,
      custodyModel: 'imported-mnemonic',
      recoveryPhrase: null,
    }
  }

  const configuredMasterSeed = normalizeMnemonicInput(masterSeed)
  if (!configuredMasterSeed) {
    throw new Error('WDK master seed is required for managed wallet creation. Set WDK_MASTER_SEED.')
  }
  if (!validateMnemonic(configuredMasterSeed)) {
    throw new Error('WDK master seed must be a valid BIP-39 mnemonic')
  }

  return {
    seedPhrase: configuredMasterSeed,
    custodyModel: 'master-seed-derived',
    recoveryPhrase: null,
  }
}

function resolveStoredWalletSeed({ walletRecord, masterSeed }) {
  const storedMnemonic = normalizeMnemonicInput(walletRecord?.mnemonic)
  if (!storedMnemonic) {
    throw new Error('Managed wallet seed data is missing from storage')
  }

  if (storedMnemonic === '__wdk_master_seed__') {
    const configuredMasterSeed = normalizeMnemonicInput(masterSeed)
    if (!configuredMasterSeed) {
      throw new Error('WDK master seed is required to load managed wallet account runtime')
    }
    if (!validateMnemonic(configuredMasterSeed)) {
      throw new Error('WDK master seed must be a valid BIP-39 mnemonic')
    }
    return {
      seedPhrase: configuredMasterSeed,
      custodyModel: 'master-seed-derived',
    }
  }

  if (!validateMnemonic(storedMnemonic)) {
    throw new Error('Stored managed wallet mnemonic is invalid')
  }

  return {
    seedPhrase: storedMnemonic,
    custodyModel: 'imported-mnemonic',
  }
}

async function fetchTonBalance(tonApiBase, address) {
  try {
    const res = await fetch(`${tonApiBase}/getAddressBalance?address=${encodeURIComponent(address)}`)
    const data = await res.json()
    if (data?.ok) {
      const balanceNano = data.result?.toString?.() || '0'
      return {
        balance: Number(BigInt(balanceNano)) / 1e9,
        balanceNano,
      }
    }
  } catch (err) {
    console.error('Managed wallet balance check failed:', err.message)
  }

  return { balance: 0, balanceNano: '0' }
}

function areEquivalentTonAddresses(left, right) {
  if (!left || !right) return false
  return normalizeAddr(String(left)) === normalizeAddr(String(right))
}

export function createWdkWalletService({ insertWallet, getWallet, deleteWallet, getNextManagedWalletAccountIndex, isTestnet, tonApiBase, masterSeed }) {
  async function createManagedWallet({ mnemonic, mode = 'create', label = null, accountIndex = null, derivationPath = null, ownerAddress = null }) {
    const seedSpec = resolveManagedWalletSeed({ mnemonic, mode, masterSeed })
    const module = await loadWdkModule()
    const WalletManagerTon = module.default
    if (!WalletManagerTon) {
      throw new Error('WDK WalletManagerTon export not found')
    }
    const manager = await createWalletManager(
      WalletManagerTon,
      seedSpec.seedPhrase,
      buildProviderConfig({ isTestnet, tonApiBase }),
    )

    const resolvedAccountIndex = derivationPath
      ? undefined
      : Number.isInteger(accountIndex)
        ? accountIndex
        : getNextManagedWalletAccountIndex('wdk-ton')

    const account = await loadManagedAccount(manager, {
      derivationPath,
      accountIndex: resolvedAccountIndex,
    })

    const address = await account.getAddress()
    const keyPair = account.keyPair
    const walletId = randomUUID()
    const publicKeyHex = Buffer.from(keyPair.publicKey).toString('hex')
    const secretKeyHex = Buffer.from(keyPair.privateKey).toString('hex')
    const resolvedDerivationPath = account.path || derivationPath || null
    const storedMnemonic = seedSpec.custodyModel === 'master-seed-derived'
      ? '__wdk_master_seed__'
      : seedSpec.seedPhrase
    const storedSecretKey = seedSpec.custodyModel === 'master-seed-derived'
      ? '__derived_from_wdk_master_seed__'
      : secretKeyHex

    await insertWallet({
      id: walletId,
      address,
      address_bounce: address,
      address_raw: address,
      mnemonic: storedMnemonic,
      public_key: publicKeyHex,
      secret_key: storedSecretKey,
      created_at: Date.now(),
    })

    manager.dispose?.()

    return {
      providerId: 'wdk-ton',
      ownerAddress,
      mode,
      wallet: {
        id: walletId,
        address,
        addressBounceable: address,
        publicKey: publicKeyHex,
      },
      managedWallet: {
        label,
        accountIndex: account.index,
        derivationPath: resolvedDerivationPath,
        metadata: {
          network: isTestnet ? 'testnet' : 'mainnet',
          accountIndex: account.index,
          derivationPath: resolvedDerivationPath,
          custodyModel: seedSpec.custodyModel,
          usesMasterSeed: seedSpec.custodyModel === 'master-seed-derived',
        },
      },
      recoveryPhrase: seedSpec.recoveryPhrase,
    }
  }

  async function deleteManagedWalletById(walletId) {
    await deleteWallet(walletId)
  }

  async function getManagedWalletRuntime(managedWallet) {
    if (!managedWallet?.walletId) {
      throw new Error('Managed wallet record is missing walletId')
    }

    const walletRecord = await getWallet(managedWallet.walletId)
    if (!walletRecord) {
      throw new Error('Managed wallet backing record not found')
    }

    const seedSpec = resolveStoredWalletSeed({ walletRecord, masterSeed })
    const module = await loadWdkModule()
    const WalletManagerTon = module.default
    if (!WalletManagerTon) {
      throw new Error('WDK WalletManagerTon export not found')
    }

    const manager = await createWalletManager(
      WalletManagerTon,
      seedSpec.seedPhrase,
      buildProviderConfig({ isTestnet, tonApiBase }),
    )

    try {
      const account = await loadManagedAccount(manager, {
        derivationPath: managedWallet.derivationPath,
        accountIndex: managedWallet.accountIndex,
      })

      const derivedAddress = await account.getAddress()
      const addressMatches = areEquivalentTonAddresses(derivedAddress, managedWallet.walletAddress)
        || areEquivalentTonAddresses(derivedAddress, walletRecord.address)
      if (!addressMatches) {
        throw new Error('Derived managed wallet address does not match stored record')
      }

      const { balance, balanceNano } = await fetchTonBalance(tonApiBase, derivedAddress)
      const displayAddress = managedWallet.walletAddress || walletRecord.address || derivedAddress

      return {
        providerId: 'wdk-ton',
        walletId: managedWallet.walletId,
        address: displayAddress,
        balance,
        balanceNano,
        accountIndex: account.index,
        derivationPath: account.path || managedWallet.derivationPath || null,
        custodyModel: seedSpec.custodyModel,
        usesMasterSeed: seedSpec.custodyModel === 'master-seed-derived',
        network: isTestnet ? 'testnet' : 'mainnet',
        addressVerified: true,
      }
    } finally {
      manager.dispose?.()
    }
  }

  function getProviderMeta() {
    return {
      id: 'wdk-ton',
      label: 'WDK Managed TON Wallet',
      kind: 'managed',
      capabilities: ['create', 'import', 'derive-account'],
    }
  }

  return {
    createManagedWallet,
    deleteManagedWalletById,
    getManagedWalletRuntime,
    getProviderMeta,
  }
}