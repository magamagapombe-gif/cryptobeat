// src/app/api/wallet/withdraw/route.ts
//
// Withdrawal rules:
//  1. Account must be ACTIVATED (is_activated = true) — set by admin after KYC review
//  2. National ID must be submitted and approved
//  3. User must be 18+ (dob stored at registration)
//  4. Min withdrawal: 1,000 UGX, Max: 10,000,000 UGX
//  5. One phone number per person enforced at registration level

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabase/server'
import { livePaySend } from '@/lib/livepay'
import { debitWallet } from '@/lib/wallet'
import { requireAuth, ok, err } from '@/lib/api'

const schema = z.object({
  amount:  z.number().int().min(1000).max(10_000_000),
  phone:   z.string().min(9),
  network: z.enum(['MTN', 'AIRTEL']),
})

function normalizePhone(phone: string): string {
  let p = phone.replace(/\D/g, '')
  if (p.startsWith('0')) p = '256' + p.slice(1)
  else if (!p.startsWith('256')) p = '256' + p
  return p
}

export async function POST(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  let body: unknown
  try { body = await req.json() } catch { return err('Invalid JSON') }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return err(parsed.error.errors[0].message, 422)

  // ── Fetch full user record to check activation + KYC ──
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, is_activated, national_id_status, date_of_birth, is_banned')
    .eq('id', session.sub)
    .single()

  if (!user) return err('User not found', 404)
  if (user.is_banned) return err('Account suspended', 403, 'BANNED')

  // ── Activation check — can play and win, but not withdraw until activated ──
  if (!user.is_activated) {
    return err(
      'Your account needs to be activated before you can withdraw. Submit your National ID to activate.',
      403,
      'NOT_ACTIVATED'
    )
  }

  // ── National ID check ──
  if (user.national_id_status !== 'APPROVED') {
    const statusMsg: Record<string, string> = {
      PENDING: 'Your National ID is under review. Withdrawals will be enabled once approved.',
      REJECTED: 'Your National ID verification was rejected. Please resubmit.',
      NONE: 'Please submit your National ID to enable withdrawals.',
    }
    return err(
      statusMsg[user.national_id_status ?? 'NONE'] ?? 'National ID verification required.',
      403,
      'KYC_REQUIRED'
    )
  }

  // ── Age check (18+) ──
  if (user.date_of_birth) {
    const dob = new Date(user.date_of_birth)
    const today = new Date()
    const age = today.getFullYear() - dob.getFullYear() -
      (today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0)

    if (age < 18) {
      return err('You must be 18 or older to withdraw funds.', 403, 'UNDERAGE')
    }
  }

  const { amount, phone, network } = parsed.data
  const normalizedPhone = normalizePhone(phone)
  const ref = `WIT${Date.now().toString(36).toUpperCase()}${session.sub.slice(0, 6)}`

  // ── Debit wallet FIRST ──
  let newBalance: number
  try {
    newBalance = await debitWallet(session.sub, amount, 'WITHDRAWAL', {
      reference: ref,
      status: 'PENDING',
      meta: { phone: normalizedPhone, network },
    })
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'INSUFFICIENT_BALANCE') {
      return err('Insufficient balance', 402, 'INSUFFICIENT_BALANCE')
    }
    throw e
  }

  // ── Send via LivePay ──
  const livepayRes = await livePaySend({
    phone: normalizedPhone,
    network,
    amount,
    internalRef: ref,
    description: 'CryptoBeat Withdrawal',
  })

  if (!livepayRes.success) {
    // Reverse debit
    await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance + amount, updated_at: new Date().toISOString() })
      .eq('user_id', session.sub)

    await supabaseAdmin
      .from('transactions')
      .update({ status: 'FAILED', meta: { error: livepayRes.error ?? livepayRes.message } })
      .eq('reference', ref)

    return err(`Withdrawal failed: ${livepayRes.message ?? livepayRes.error}`, 402, 'LIVEPAY_SEND_FAILED')
  }

  await supabaseAdmin
    .from('transactions')
    .update({ status: 'SUCCESS', livepay_ref: livepayRes.internal_reference, balance_after: newBalance })
    .eq('reference', ref)

  return ok({
    message: `UGX ${amount.toLocaleString()} sent to ${phone}`,
    new_balance: newBalance,
    reference: ref,
  })
}
