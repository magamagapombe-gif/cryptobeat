// src/lib/wallet.ts
import { supabaseAdmin } from './supabase/server'
import type { TxType, TxStatus } from '@/types'

export async function getWallet(userId: string) {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .single()
  if (error) throw new Error(`Wallet fetch failed: ${error.message}`)
  return data
}

export async function creditWallet(
  userId: string,
  amount: number,
  type: TxType,
  opts: {
    reference?: string
    livepayRef?: string
    status?: TxStatus
    meta?: Record<string, unknown>
  } = {}
) {
  // Get current balance
  const wallet = await getWallet(userId)
  const balanceBefore = wallet.balance
  const balanceAfter = balanceBefore + amount

  // Update balance
  const { error: wErr } = await supabaseAdmin
    .from('wallets')
    .update({ balance: balanceAfter, updated_at: new Date().toISOString() })
    .eq('user_id', userId)

  if (wErr) throw new Error(`Credit wallet failed: ${wErr.message}`)

  // Insert transaction
  await supabaseAdmin.from('transactions').insert({
    user_id: userId,
    type,
    amount,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    reference: opts.reference,
    livepay_ref: opts.livepayRef,
    status: opts.status ?? 'SUCCESS',
    meta: opts.meta ?? {},
  })

  return balanceAfter
}

export async function debitWallet(
  userId: string,
  amount: number,
  type: TxType,
  opts: {
    reference?: string
    livepayRef?: string
    status?: TxStatus
    meta?: Record<string, unknown>
  } = {}
) {
  const wallet = await getWallet(userId)
  const balanceBefore = wallet.balance

  if (balanceBefore < amount) {
    throw new Error('INSUFFICIENT_BALANCE')
  }

  const balanceAfter = balanceBefore - amount

  const { error: wErr } = await supabaseAdmin
    .from('wallets')
    .update({ balance: balanceAfter, updated_at: new Date().toISOString() })
    .eq('user_id', userId)

  if (wErr) throw new Error(`Debit wallet failed: ${wErr.message}`)

  await supabaseAdmin.from('transactions').insert({
    user_id: userId,
    type,
    amount,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    reference: opts.reference,
    livepay_ref: opts.livepayRef,
    status: opts.status ?? 'SUCCESS',
    meta: opts.meta ?? {},
  })

  return balanceAfter
}
