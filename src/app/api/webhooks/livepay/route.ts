// src/app/api/webhooks/livepay/route.ts
//
// POST /api/webhooks/livepay
// Receives payment status callbacks from LivePay after a USSD transaction completes.
//
// SETUP IN LIVEPAY DASHBOARD:
//   Webhook URL → https://your-domain.vercel.app/api/webhooks/livepay
//   Events: collect.success, collect.failed, send.success, send.failed
//
// SECURITY: LivePay sends a signature header. Verify it using your API key.
// Until LivePay docs confirm their exact signature scheme, we use idempotency
// (livepay_webhooks table) to prevent double-processing.
//
// FLOW:
//   Deposit confirmed → credit wallet, update transaction to SUCCESS
//   Deposit failed    → update transaction to FAILED (wallet was never debited)
//   Send confirmed    → update transaction to SUCCESS (wallet was already debited)
//   Send failed       → reverse debit, update transaction to FAILED

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { creditWallet } from '@/lib/wallet'

function respond(ok: boolean, message: string, status = 200) {
  return NextResponse.json({ ok, message }, { status })
}

export async function POST(req: NextRequest) {
  let payload: Record<string, unknown>
  try {
    payload = await req.json()
  } catch {
    return respond(false, 'Invalid JSON', 400)
  }

  // LivePay sends reference as the internal ref we generated
  const reference = (payload.reference ?? payload.internal_reference ?? payload.ref) as string | undefined
  const status = (payload.status ?? payload.event) as string | undefined
  const amount = payload.amount as number | undefined

  if (!reference) {
    console.warn('[webhook/livepay] Missing reference in payload:', payload)
    return respond(false, 'Missing reference', 400)
  }

  // ── Idempotency check — never process the same webhook twice ──
  const { data: existing } = await supabaseAdmin
    .from('livepay_webhooks')
    .select('id, processed')
    .eq('reference', reference)
    .single()

  if (existing?.processed) {
    return respond(true, 'Already processed')
  }

  // ── Log this webhook (upsert) ──
  await supabaseAdmin
    .from('livepay_webhooks')
    .upsert({
      reference,
      payload,
      processed: false,
    }, { onConflict: 'reference' })

  // ── Find the matching transaction ──
  const { data: txn } = await supabaseAdmin
    .from('transactions')
    .select('id, user_id, type, amount, status')
    .eq('reference', reference)
    .single()

  if (!txn) {
    console.warn('[webhook/livepay] No transaction found for reference:', reference)
    // Still mark as processed to avoid retry floods
    await supabaseAdmin
      .from('livepay_webhooks')
      .update({ processed: true })
      .eq('reference', reference)
    return respond(true, 'No matching transaction — ignored')
  }

  // Already processed at transaction level
  if (txn.status === 'SUCCESS' || txn.status === 'FAILED') {
    await supabaseAdmin
      .from('livepay_webhooks')
      .update({ processed: true })
      .eq('reference', reference)
    return respond(true, 'Transaction already settled')
  }

  const isSuccess =
    status === 'SUCCESS' ||
    status === 'SUCCESSFUL' ||
    status === 'collect.success' ||
    status === 'send.success' ||
    status === 'COMPLETED'

  const isFailed =
    status === 'FAILED' ||
    status === 'FAILURE' ||
    status === 'collect.failed' ||
    status === 'send.failed' ||
    status === 'CANCELLED'

  try {
    if (txn.type === 'DEPOSIT' && isSuccess) {
      // ── Credit wallet for confirmed deposit ──
      const txnAmount = amount ?? txn.amount
      await creditWallet(txn.user_id, txnAmount, 'DEPOSIT', {
        reference: `${reference}-CONFIRMED`,
        livepayRef: reference,
        meta: { original_reference: reference, webhook_payload: payload },
      })

      // Update original pending transaction
      await supabaseAdmin
        .from('transactions')
        .update({ status: 'SUCCESS', livepay_ref: reference })
        .eq('reference', reference)

    } else if (txn.type === 'DEPOSIT' && isFailed) {
      // Deposit failed — wallet was never debited, just mark failed
      await supabaseAdmin
        .from('transactions')
        .update({ status: 'FAILED', meta: { error: payload.message ?? 'Payment failed' } })
        .eq('reference', reference)

    } else if (txn.type === 'WITHDRAWAL' && isSuccess) {
      // Withdrawal sent successfully — already debited, just confirm
      await supabaseAdmin
        .from('transactions')
        .update({ status: 'SUCCESS', livepay_ref: payload.internal_reference as string ?? reference })
        .eq('reference', reference)

    } else if (txn.type === 'WITHDRAWAL' && isFailed) {
      // Withdrawal failed — REVERSE the debit (credit back)
      await creditWallet(txn.user_id, txn.amount, 'DEPOSIT', {
        reference: `REFUND-${reference}`,
        livepayRef: reference,
        meta: { reason: 'withdrawal_failed', original_reference: reference },
      })

      await supabaseAdmin
        .from('transactions')
        .update({ status: 'FAILED', meta: { error: payload.message ?? 'Send failed' } })
        .eq('reference', reference)

    } else {
      console.log('[webhook/livepay] Unhandled type/status combo:', txn.type, status)
    }

    // Mark webhook as processed
    await supabaseAdmin
      .from('livepay_webhooks')
      .update({ processed: true })
      .eq('reference', reference)

    return respond(true, 'Processed')
  } catch (e: unknown) {
    console.error('[webhook/livepay] Processing error:', e)
    return respond(false, 'Processing error', 500)
  }
}
