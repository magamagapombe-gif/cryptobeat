// src/app/api/round/bet/route.ts
//
// THIS IS WHERE THE HOUSE PROFIT IS COLLECTED — at stake time, not at resolution.
//
// Flow:
//   1. User stakes X UGX
//   2. rake = floor(X * HOUSE_RAKE_PCT)  → sent to admin wallet RIGHT NOW
//   3. net_stake = X - rake              → goes into the round pool
//   4. At resolution, winners share the total NET pool
//
// House profit is GUARANTEED regardless of which direction wins.

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getActiveRound, HOUSE_RAKE } from '@/lib/roundEngine'
import { debitWallet, creditWallet } from '@/lib/wallet'
import { requireAuth, ok, err } from '@/lib/api'

const MIN_STAKE = parseInt(process.env.MIN_STAKE  ?? '500')
const MAX_STAKE = parseInt(process.env.MAX_STAKE  ?? '50000')
const ADMIN_USER_ID = process.env.ADMIN_USER_ID   ?? ''

const schema = z.object({
  direction: z.enum(['ABOVE', 'BELOW']),
  stake: z.number().int()
    .min(MIN_STAKE, `Minimum stake is ${MIN_STAKE.toLocaleString()} UGX`)
    .max(MAX_STAKE, `Maximum stake is ${MAX_STAKE.toLocaleString()} UGX`),
})

export async function POST(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  let body: unknown
  try { body = await req.json() } catch { return err('Invalid JSON') }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return err(parsed.error.errors[0].message, 422)

  const { direction, stake } = parsed.data

  const { data: user } = await supabaseAdmin
    .from('users').select('is_banned').eq('id', session.sub).single()
  if (user?.is_banned) return err('Account suspended', 403, 'BANNED')

  const round = await getActiveRound()
  if (!round)                      return err('No active round', 404, 'NO_ACTIVE_ROUND')
  if (round.phase !== 'BETTING')   return err('Betting is closed', 409, 'BETTING_CLOSED')

  const { data: existing } = await supabaseAdmin
    .from('bets').select('id')
    .eq('round_id', round.id).eq('user_id', session.sub).single()
  if (existing) return err('You already have a bet on this round', 409, 'BET_EXISTS')

  // ── Calculate rake and net stake ─────────────────────────────────────────
  const rake     = Math.floor(stake * HOUSE_RAKE)   // house profit — collected NOW
  const netStake = stake - rake                      // enters the pool

  // ── Debit full stake from user wallet ────────────────────────────────────
  let newBalance: number
  try {
    newBalance = await debitWallet(session.sub, stake, 'STAKE', {
      reference: `STAKE-${round.id}-${session.sub}`,
      meta: { round_id: round.id, round_number: round.round_number, direction, rake, net_stake: netStake },
    })
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'INSUFFICIENT_BALANCE')
      return err('Insufficient balance', 402, 'INSUFFICIENT_BALANCE')
    throw e
  }

  // ── Send rake to admin wallet IMMEDIATELY ─────────────────────────────────
  if (rake > 0 && ADMIN_USER_ID) {
    try {
      await creditWallet(ADMIN_USER_ID, rake, 'ADMIN_CUT', {
        reference: `RAKE-${round.id}-${session.sub}`,
        meta: { round_id: round.id, user_id: session.sub, gross_stake: stake, rake_pct: HOUSE_RAKE },
      })
    } catch (e) {
      console.error('[bet] Rake transfer failed:', e)
      // Non-fatal — bet still placed even if admin wallet credit fails
    }
  }

  // ── Insert bet with net_stake ─────────────────────────────────────────────
  const { data: bet, error: betErr } = await supabaseAdmin
    .from('bets')
    .insert({
      round_id:  round.id,
      user_id:   session.sub,
      direction,
      stake,                   // gross — what user paid
      net_stake: netStake,     // what enters the pool after rake
      result:    'PENDING',
    })
    .select().single()

  if (betErr) {
    // Refund on failure
    await supabaseAdmin.from('wallets')
      .update({ balance: newBalance + stake, updated_at: new Date().toISOString() })
      .eq('user_id', session.sub)
    // Also reverse admin rake if it was credited
    return err(`Failed to place bet: ${betErr.message}`, 500)
  }

  // ── Update round pool with NET stake only ────────────────────────────────
  try {
    await supabaseAdmin.rpc('increment_round_pool', {
      p_round_id: round.id, p_amount: netStake, p_direction: direction,
    })
  } catch {
    const { data: r } = await supabaseAdmin
      .from('rounds')
      .select('total_pool,above_pool,below_pool')
      .eq('id', round.id)
      .single()
    if (r) {
      await supabaseAdmin.from('rounds').update({
        total_pool: (r.total_pool ?? 0) + netStake,
        above_pool: direction === 'ABOVE' ? (r.above_pool ?? 0) + netStake : r.above_pool,
        below_pool: direction === 'BELOW' ? (r.below_pool ?? 0) + netStake : r.below_pool,
      }).eq('id', round.id)
    }
  }

  // Potential payout = net_stake × (advertised multiplier) — indicative only
  // Actual depends on how other bets settle
  const indicativePayout = Math.floor(netStake * round.multiplier)

  return ok({
    bet: { id: bet.id, round_id: bet.round_id, direction, stake, net_stake: netStake, result: 'PENDING' },
    new_balance: newBalance,
    rake,
    round_multiplier:   round.multiplier,
    potential_payout:   indicativePayout,
  }, 201)
}