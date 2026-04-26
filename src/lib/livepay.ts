// src/lib/livepay.ts
import type {
  Network,
  LivePayCollectBody,
  LivePayCollectResponse,
  LivePaySendBody,
  LivePaySendResponse,
} from '@/types'

const BASE_URL = process.env.LIVEPAY_BASE_URL ?? 'https://livepay.me/api'
const API_KEY = process.env.LIVEPAY_API_KEY!
const ACCOUNT_NUMBER = process.env.LIVEPAY_ACCOUNT_NUMBER!

function normalizePhone(phone: string): string {
  let p = String(phone).replace(/\D/g, '')
  if (p.startsWith('0')) p = '256' + p.slice(1)
  else if (!p.startsWith('256')) p = '256' + p
  return p
}

function makeRef(prefix: string): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}${ts}${rand}`.slice(0, 30)
}

async function livePayPost<T>(endpoint: string, body: object): Promise<T> {
  const res = await fetch(`${BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    // Next.js: don't cache — financial calls must always be fresh
    cache: 'no-store',
  })

  const text = await res.text()

  let json: T
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`LivePay non-JSON response (${res.status}): ${text.slice(0, 200)}`)
  }

  return json
}

// ── COLLECT (deposit from user) ──────────────────────────────────────────────
export async function livePayCollect(params: {
  phone: string
  network: Network
  amount: number       // UGX
  internalRef?: string
  description?: string
}): Promise<LivePayCollectResponse> {
  const reference = params.internalRef ?? makeRef('DEP')

  const body: LivePayCollectBody = {
    accountNumber: ACCOUNT_NUMBER,
    phoneNumber: normalizePhone(params.phone),
    amount: params.amount,
    currency: 'UGX',
    reference,
    description: params.description ?? 'CryptoBeat Deposit',
    network: params.network,
  }

  const resp = await livePayPost<LivePayCollectResponse>('collect-money', body)
  return { ...resp, internal_reference: resp.internal_reference ?? reference }
}

// ── SEND (payout / withdrawal to user) ───────────────────────────────────────
export async function livePaySend(params: {
  phone: string
  network: Network
  amount: number       // UGX
  internalRef?: string
  description?: string
}): Promise<LivePaySendResponse> {
  const reference = params.internalRef ?? makeRef('PAY')

  const body: LivePaySendBody = {
    accountNumber: ACCOUNT_NUMBER,
    phoneNumber: normalizePhone(params.phone),
    amount: params.amount,
    currency: 'UGX',
    reference,
    description: params.description ?? 'CryptoBeat Payout',
    network: params.network,
  }

  // LivePay send-money endpoint — adjust if your dashboard shows a different slug
  const resp = await livePayPost<LivePaySendResponse>('send-money', body)
  return resp
}
