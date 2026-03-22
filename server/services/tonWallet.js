import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto'
import { WalletContractV4 } from '@ton/ton'
import { randomUUID } from 'crypto'

export function createTonWalletService({ insertWallet, getWallet, deleteWallet, isTestnet, tonApiBase }) {
  async function createTonWallet() {
    const mnemonic = await mnemonicNew()
    const keyPair = await mnemonicToPrivateKey(mnemonic)
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
    const address = wallet.address.toString({ bounceable: false, testOnly: isTestnet })
    const addressBounceable = wallet.address.toString({ bounceable: true, testOnly: isTestnet })
    const id = randomUUID()

    await insertWallet({
      id,
      address,
      address_bounce: addressBounceable,
      address_raw: wallet.address.toRawString(),
      mnemonic: mnemonic.join(' '),
      public_key: Buffer.from(keyPair.publicKey).toString('hex'),
      secret_key: Buffer.from(keyPair.secretKey).toString('hex'),
      created_at: Date.now(),
    })

    return {
      id,
      address,
      addressBounceable,
      publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    }
  }

  async function getTonBalance(walletId) {
    const wallet = await getWallet(walletId)
    if (!wallet) return { balance: 0, balanceNano: '0' }

    try {
      const res = await fetch(`${tonApiBase}/getAddressBalance?address=${encodeURIComponent(wallet.address)}`)
      const data = await res.json()
      if (data.ok) {
        const balanceNano = data.result
        return {
          balance: Number(BigInt(balanceNano)) / 1e9,
          balanceNano: balanceNano.toString(),
        }
      }
    } catch (err) {
      console.error('Balance check failed:', err.message)
    }

    return { balance: 0, balanceNano: '0' }
  }

  async function deleteTonWalletById(walletId) {
    await deleteWallet(walletId)
  }

  return { createTonWallet, getTonBalance, deleteTonWalletById }
}
