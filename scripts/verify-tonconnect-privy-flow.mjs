#!/usr/bin/env node

import { loadLocalEnv } from './loadLocalEnv.js'

loadLocalEnv({ overrideProcessEnv: true })

const baseUrl = String(process.env.ODROB_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '')
const address = process.argv[2] || '0:1111111111111111111111111111111111111111111111111111111111111111'

function printSection(title, lines = []) {
  console.log(`\n${title}`)
  for (const line of lines) console.log(line)
}

async function requestJson(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed: ${response.status}`)
    error.status = response.status
    error.payload = payload
    throw error
  }

  const setCookie = typeof response.headers.get === 'function'
    ? response.headers.get('set-cookie')
    : null

  return {
    status: response.status,
    cookie: setCookie ? setCookie.split(';')[0] : '',
    data: payload?.success !== undefined && 'data' in (payload || {}) ? payload.data : payload,
  }
}

function summarizeWalletPolicy(systemParams) {
  const wallets = systemParams?.wallets || {}
  const runtime = systemParams?.walletRuntime || {}
  return [
    `- managedWalletsEnabled: ${Boolean(wallets.managedWalletsEnabled)}`,
    `- managedWalletCreationMode: ${wallets.managedWalletCreationMode || 'unknown'}`,
    `- autoProvisionManagedWalletOnRegistration: ${Boolean(wallets.autoProvisionManagedWalletOnRegistration)}`,
    `- masterSeedConfigured: ${Boolean(runtime.masterSeedConfigured)}`,
    `- adminOnlyReady: ${Boolean(runtime.adminOnlyReady)}`,
  ]
}

function summarizeAuthOutcome(authResponse, authSession) {
  const onboarding = authResponse?.onboarding || {}
  const privy = authResponse?.privy || authSession?.privy || null
  const authMethods = Array.isArray(authSession?.authMethods) ? authSession.authMethods : []
  const linkedWallets = Array.isArray(authSession?.linkedWallets) ? authSession.linkedWallets : []
  const managedWallet = authSession?.managedWallet || null

  return {
    privy,
    authMethods,
    linkedWallets,
    managedWallet,
    checks: {
      privyProvisioned: Boolean(privy?.userId),
      customAuthLinked: authMethods.some((method) => method.provider === 'privy' && method.type === 'custom_auth'),
      managedWalletProvisioned: Boolean(onboarding.managedWalletProvisioned || managedWallet?.walletAddress),
      externalWalletLinked: Boolean(onboarding.externalWalletLinked || linkedWallets.some((wallet) => wallet.walletProvider === 'external-tonconnect')),
    },
  }
}

async function main() {
  console.log(`🔎 Verifying TonConnect → Privy unified flow against ${baseUrl}`)
  console.log(`Using TON address: ${address}`)

  let systemParams = null
  try {
    const response = await requestJson('/api/admin/system-params')
    systemParams = response.data || null
    printSection('Runtime snapshot', summarizeWalletPolicy(systemParams))
  } catch (error) {
    printSection('Runtime snapshot', [`- unavailable: ${error.message}`])
  }

  const challenge = await requestJson('/api/auth/challenge', {
    method: 'POST',
    body: { address },
  })

  const auth = await requestJson('/api/auth', {
    method: 'POST',
    body: { address, nonce: challenge.data?.nonce },
  })

  const session = await requestJson('/api/auth/session', {
    cookie: auth.cookie,
  })

  const summary = summarizeAuthOutcome(auth.data, session.data)

  printSection('Auth response', [
    `- privy user id: ${summary.privy?.userId || 'missing'}`,
    `- auth source: ${session.data?.authSource || 'missing'}`,
    `- auth methods: ${summary.authMethods.map((method) => `${method.provider}:${method.type}`).join(', ') || 'none'}`,
    `- linked wallets: ${summary.linkedWallets.map((wallet) => `${wallet.walletProvider}:${wallet.walletKind}`).join(', ') || 'none'}`,
    `- managed wallet: ${summary.managedWallet?.walletAddress || auth.data?.onboarding?.managedWalletAddress || 'missing'}`,
  ])

  const failures = []
  if (!summary.checks.externalWalletLinked) {
    failures.push('TonConnect wallet was not linked into the unified session state.')
  }
  if (!summary.checks.privyProvisioned) {
    failures.push('Privy user was not provisioned during initial TonConnect auth.')
  }
  if (!summary.checks.customAuthLinked) {
    failures.push('Privy custom_auth identity was not attached to the authenticated app user.')
  }
  if (!summary.checks.managedWalletProvisioned) {
    failures.push('Managed wallet was not provisioned for the unified TonConnect flow.')
  }

  if (failures.length) {
    printSection('Failures', failures.map((message) => `- ${message}`))
    if (systemParams) {
      printSection('Likely runtime blockers', summarizeWalletPolicy(systemParams))
    }
    process.exitCode = 1
    return
  }

  printSection('Result', ['- Unified TonConnect → Privy → wallet provisioning flow is working.'])
}

main().catch((error) => {
  console.error('\nVerification failed:', error.message)
  if (error.payload) {
    console.error(JSON.stringify(error.payload, null, 2))
  }
  process.exitCode = 1
})