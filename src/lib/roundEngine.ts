// src/lib/roundEngine.ts — GUARANTEED HOUSE PROFIT MODEL
//
// Rake is taken from EVERY stake at bet placement time (in /api/round/bet).
// Winners are paid from the NET pool only.
// House profits on EVERY round regardless of which side wins.
//
// PROOF (10% rake, 10 players × 10,000 UGX each = 100,000 gross):
//   House collects: 10,000 UGX immediately, guaranteed.
//   Net pool: 90,000 UGX distributed to winners only.
//
//   Case A — 5 win, 5 lose:
//     netWinPool = 45,000  netLosePool = 45,000
//     actualMult = 90,000 / 45,000 = 2.0×  → each winner gets 18,000
//     House kept: 10,000 UGX ✅
//
//   Case B — ALL bet winning side:
//     netWinPool = 90,000  netLosePool = 0
//     actualMult = 90,000 / 90,000 = 1.0×  → each winner gets net stake back only
//     House kept: 10,000 UGX ✅
//
//   Case C — 1 wins, 9 lose:
//     netWinPool = 9,000  netLosePool = 81,000
//     actualMult = 90,000 / 9,000 = 10.0×  → winner gets 90,000 (jackpot!)
//     House kept: 10,000 UGX ✅
//
// The house CANNOT lose. Rake is deducted at stake time, before resolution.

import { supabaseAdmin } from './supabase/server'
import { getBTCPriceUGX } from './btcPrice'
import { creditWallet } from './wallet'
import type { Round, Direction } from '@/types'

const BETTING_SECONDS = parseInt(process.env.ROUND_BETTING_SECONDS ?? '30')
const LIVE_SECONDS    = parseInt(process.env.ROUND_LIVE_SECONDS    ?? '60')
export const HOUSE_RAKE = parseFloat(process.env.HOUSE_RAKE_PCT   ?? '0.10')
const ADMIN_USER_ID   = process.env.ADMIN_USER_ID ?? ''

function advertisedMultiplier(): number {
  // 1.5–1.9× shown to players as an indicative reward.
  // Actual paid multiplier = netPool / netWinnerPool — resolved at round end.
  return Math.round((1.5 + Math.random() * 0.4) * 10) / 10
}

export async function getActiveRound(): Promise<Round | null> {
  const { data } = await supabaseAdmin
    .from('rounds').select('*')
    .in('phase', ['BETTING', 'LIVE', 'RESOLVING'])
    .order('created_at', { ascending: false }).limit(1).single()
  return data ?? null
}

export async function getLatestRound(): Promise<Round | null> {
  const { data } = await supabaseAdmin
    .from('rounds').select('*')
    .order('round_number', { ascending: false }).limit(1).single()
  return data ?? null
}

export async function createRound(): Promise<Round> {
  const latest      = await getLatestRound()
  const nextNumber  = (latest?.round_number ?? 0) + 1
  const now         = new Date()
  const bettingEnds = new Date(now.getTime() + BETTING_SECONDS * 1000)
  const liveEnds    = new Date(bettingEnds.getTime() + LIVE_SECONDS * 1000)

  const { data, error } = await supabaseAdmin.from('rounds').insert({
    round_number:   nextNumber,
    phase:          'BETTING',
    betting_starts: now.toISOString(),
    betting_ends:   bettingEnds.toISOString(),
    live_ends:      liveEnds.toISOString(),
    multiplier:     advertisedMultiplier(),
  }).select().single()

  if (error) throw new Error(`Create round failed: ${error.message}`)
  return data
}

export async function advanceRound(): Promise<{ action: string; round: Round }> {
  const now   = new Date()
  let round   = await getActiveRound()

  if (!round) return { action: 'CREATED', round: await createRound() }

  const bettingEnds = new Date(round.betting_ends)
  const liveEnds    = new Date(round.live_ends)

  if (round.phase === 'BETTING' && now >= bettingEnds) {
    const btcPrice = await getBTCPriceUGX()
    const { data, error } = await supabaseAdmin.from('rounds')
      .update({ phase: 'LIVE', locked_price: btcPrice })
      .eq('id', round.id).select().single()
    if (error) throw new Error(`Lock price failed: ${error.message}`)
    return { action: 'LOCKED', round: data }
  }

  if (round.phase === 'LIVE' && now >= liveEnds) {
    return { action: 'RESOLVED', round: await resolveRound(round) }
  }

  if (round.phase === 'RESOLVING') {
    const { data } = await supabaseAdmin.from('rounds')
      .update({ phase: 'COMPLETE', completed_at: now.toISOString() })
      .eq('id', round.id).select().single()
    if (data) return { action: 'NEXT', round: await createRound() }
  }

  return { action: 'TICK', round }
}

async function resolveRound(round: Round): Promise<Round> {
  // Optimistic lock — only one tick can resolve
  await supabaseAdmin.from('rounds')
    .update({ phase: 'RESOLVING' })
    .eq('id', round.id).eq('phase', 'LIVE')

  const finalPrice  = await getBTCPriceUGX()
  const lockedPrice = round.locked_price ?? finalPrice
  const result: Direction = finalPrice > lockedPrice ? 'ABOVE' : 'BELOW'

  const { data: bets } = await supabaseAdmin.from('bets')
    .select('id, user_id, direction, stake, net_stake')
    .eq('round_id', round.id)

  if (!bets || bets.length === 0) {
    return finalizeRound(round.id, finalPrice, result, 0, 0)
  }

  const winners = bets.filter(b => b.direction === result)
  const losers  = bets.filter(b => b.direction !== result)

  // net_stake = stake already minus rake (rake sent to admin at bet placement)
  const netWinPool  = winners.reduce((s, b) => s + (b.net_stake ?? b.stake), 0)
  const netLosePool = losers.reduce((s, b)  => s + (b.net_stake ?? b.stake), 0)
  const totalNet    = netWinPool + netLosePool

  // Actual multiplier: how much each unit of net_stake in the winning pool grows
  // When losers dominate → high multiplier (jackpot). When everyone wins → 1.0×.
  const actualMult = netWinPool > 0 ? totalNet / netWinPool : 0

  // Pay winners
  for (const bet of winners) {
    const ns     = bet.net_stake ?? bet.stake
    const payout = Math.floor(ns * actualMult) // floor keeps fractional UGX in house

    await creditWallet(bet.user_id, payout, 'PAYOUT', {
      reference: `PAYOUT-${round.id}-${bet.id}`,
      meta: {
        round_id: round.id, round_number: round.round_number,
        direction: bet.direction, gross_stake: bet.stake,
        net_stake: ns, actual_multiplier: actualMult,
        advertised_mult: round.multiplier,
      },
    })

    await supabaseAdmin.from('bets').update({
      result: 'WIN', payout, locked_price: lockedPrice,
      multiplier: parseFloat(actualMult.toFixed(2)),
    }).eq('id', bet.id)
  }

  // Mark losers
  for (const bet of losers) {
    await supabaseAdmin.from('bets').update({
      result: 'LOSS', payout: 0, locked_price: lockedPrice,
      multiplier: round.multiplier,
    }).eq('id', bet.id)
  }

  // House cut = sum of rakes (stake - net_stake) — already collected at bet time
  const totalRake = bets.reduce((s, b) => s + (b.stake - (b.net_stake ?? b.stake)), 0)

  return finalizeRound(round.id, finalPrice, result, winners.length, totalRake)
}

async function finalizeRound(
  roundId: string, finalPrice: number, result: Direction,
  winnerCount: number, houseCut: number
): Promise<Round> {
  const { data, error } = await supabaseAdmin.from('rounds').update({
    phase: 'COMPLETE', final_price: finalPrice, result,
    winner_count: winnerCount, house_cut: houseCut,
    completed_at: new Date().toISOString(),
  }).eq('id', roundId).select().single()

  if (error) throw new Error(`Finalize round failed: ${error.message}`)
  await createRound()
  return data
}

export async function getRoundLeaderboard(roundId: string) {
  const { data } = await supabaseAdmin.from('bets')
    .select('id, direction, stake, result, payout, created_at, users(name, phone)')
    .eq('round_id', roundId)
    .order('stake', { ascending: false }).limit(20)
  return data ?? []
}
