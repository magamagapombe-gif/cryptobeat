// src/app/api/wallet/deposit/route.ts
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabase/server'
import { livePayCollect } from '@/lib/livepay'
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

  const { amount, phone, network } = parsed.data
  const normalizedPhone = normalizePhone(phone)

  // Unique reference for this deposit attempt
  const ref = `DEP${Date.now().toString(36).toUpperCase()}${session.sub.slice(0, 6)}`

  // ── Pre-log as PENDING ──
  const { data: wallet } = await supabaseAdmin
    .from('wallets').select('balance').eq('user_id', session.sub).single()

  await supabaseAdmin.from('transactions').insert({
    user_id: session.sub,
    type: 'DEPOSIT',
    amount,
    balance_before: wallet?.balance ?? 0,
    balance_after: wallet?.balance ?? 0, // updated on webhook confirmation
    reference: ref,
    status: 'PENDING',
    meta: { phone: normalizedPhone, network },
  })

  // ── Trigger USSD prompt ──
  const livepayRes = await livePayCollect({
    phone: normalizedPhone,
    network,
    amount,
    internalRef: ref,
    description: 'CryptoBeat Deposit',
  })

  if (!livepayRes.success) {
    // Update txn to FAILED
    await supabaseAdmin
      .from('transactions')
      .update({ status: 'FAILED', meta: { error: livepayRes.error ?? livepayRes.message } })
      .eq('reference', ref)

    return err(
      `Payment initiation failed: ${livepayRes.message ?? livepayRes.error}`,
      402,
      'LIVEPAY_FAILED'
    )
  }

  // Update livepay_ref
  await supabaseAdmin
    .from('transactions')
    .update({ livepay_ref: livepayRes.internal_reference })
    .eq('reference', ref)

  return ok({
    message: 'USSD prompt sent. Approve on your phone to complete deposit.',
    reference: ref,
    livepay_ref: livepayRes.internal_reference,
    amount,
  })
}
