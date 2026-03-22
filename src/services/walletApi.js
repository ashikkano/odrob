// ═══════════════════════════════════════════════════════════════════════
// Wallet Utilities
// TonConnect transaction builder for wallet funding / top-up flows.
// Wallet CRUD is handled by the backend (agentApi.js).
// ═══════════════════════════════════════════════════════════════════════

import { beginCell, Address, toNano } from '@ton/core'
import { CHAIN, toUserFriendlyAddress } from '@tonconnect/sdk'
import { Buffer } from 'buffer'

function isTestnetNetwork(network) {
  return String(network || '') === CHAIN.TESTNET
}

function resolveTonConnectNetwork(network) {
  return network || CHAIN.MAINNET
}

function normalizeTonConnectAddress(toAddress, network) {
  const resolvedNetwork = resolveTonConnectNetwork(network)
  try {
    const parsed = Address.parse(toAddress)
    return toUserFriendlyAddress(parsed.toRawString(), isTestnetNetwork(resolvedNetwork))
  } catch (error) {
    console.warn('buildFundTransaction: could not parse address, using as-is', error)
    return toAddress
  }
}

function encodeCellToBase64(cell) {
  return Buffer.from(cell.toBoc()).toString('base64')
}

/**
 * Build a TonConnect transaction object for sending TON
 * to a TON wallet address.
 *
 * Uses the same BOC encoding pattern as GiftIndex:
 * - address: user-friendly format (EQ/UQ, 48 chars)
 * - amount: nanoTON as string via toNano()
 * - payload: base64-encoded BOC with op=0 (text comment)
 *
 * @param {string} toAddress - TON wallet address (non-bounceable)
 * @param {number} amountTon - Amount in TON (e.g. 1.5)
 * @param {string} [comment] - Optional transfer comment
 * @param {{ network?: string, from?: string }} [options] - TonConnect network metadata
 * @returns Transaction object for tonConnectUI.sendTransaction()
 */
export function buildFundTransaction(toAddress, amountTon, comment, options = {}) {
  const { network, from } = options
  const resolvedNetwork = resolveTonConnectNetwork(network)
  const address = normalizeTonConnectAddress(toAddress, resolvedNetwork)

  const message = {
    address,
    amount: toNano(amountTon.toString()).toString(),
  }

  // Encode comment as BOC payload (op=0 means text comment, same as GiftIndex)
  if (comment) {
    const body = beginCell()
      .storeUint(0, 32)            // op=0 → text comment
      .storeStringTail(comment)     // UTF-8 comment text
      .endCell()

    message.payload = encodeCellToBase64(body)
  }

  return {
    validUntil: Math.floor(Date.now() / 1000) + 5 * 60, // 5 minutes
    network: resolvedNetwork,
    ...(from ? { from } : {}),
    messages: [message],
  }
}

export function buildManagedWalletTopUpTransaction(toAddress, amountTon, comment, options) {
  return buildFundTransaction(toAddress, amountTon, comment, options)
}

export function buildTonConnectWalletRedirectLink(wallet, sessionId, traceId) {
  const universalLink = wallet?.universalLink
  if (!universalLink) return null

  try {
    const url = new URL(universalLink)
    if (sessionId && !url.searchParams.has('id')) {
      url.searchParams.set('id', sessionId)
    }
    if (traceId && !url.searchParams.has('trace_id')) {
      url.searchParams.set('trace_id', traceId)
    }
    return url.toString()
  } catch (error) {
    console.warn('buildTonConnectWalletRedirectLink: could not build redirect link', error)
    return universalLink
  }
}
