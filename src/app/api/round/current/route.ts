// src/app/api/round/current/route.ts
//
// Polled by the frontend every second to drive the UI.
// Returns:
//  - current round state (phase, timer, prices, multiplier)
//  - the caller's bet for this round (if logged in)
//  - live leaderboard (top 20 bets)
//  - current BTC price

import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getActiveRound, getLatestRound, getRoundLeaderboard } from '@/lib/roundEngine'
import { getBTCPriceUGX } from '@/lib/btcPrice'
import { getSessionFromHeader } from '@/lib/auth'
import { ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const [round, btcPrice, session] = await Promise.all([
    getActiveRound().catch(() => null) ?? getLatestRound(),
    getBTCPriceUGX().catch(() => 0),
    getSessionFromHeader(req),
  ])

  if (!round) {
    return ok({
      round: null,
      btc_price: btcPrice,
      my_bet: null,
      leaderboard: [],
      server_time: Date.now(),
    })
  }

  const now = Date.now()
  const bettingEnds = new Date(round.betting_ends).getTime()
  const liveEnds = new Date(round.live_ends).getTime()

  // Compute time remaining on client's behalf (eliminates clock skew)
  let secondsLeft = 0
  if (round.phase === 'BETTING') secondsLeft = Math.max(0, Math.round((bettingEnds - now) / 1000))
  if (round.phase === 'LIVE') secondsLeft = Math.max(0, Math.round((liveEnds - now) / 1000))

  // My bet (only if authenticated)
  let myBet = null
  if (session) {
    const { data: bet } = await supabaseAdmin
      .from('bets')
      .select('direction, stake, result, payout, locked_price, multiplier')
      .eq('round_id', round.id)
      .eq('user_id', session.sub)
      .single()
    myBet = bet ?? null
  }

  // Leaderboard
  const leaderboard = await getRoundLeaderboard(round.id)

  return ok({
    round: {
      id: round.id,
      round_number: round.round_number,
      phase: round.phase,
      seconds_left: secondsLeft,
      locked_price: round.locked_price,
      final_price: round.final_price,
      result: round.result,
      multiplier: round.multiplier,
      total_pool: round.total_pool,
      above_pool: round.above_pool,
      below_pool: round.below_pool,
      winner_count: round.winner_count,
      betting_ends: round.betting_ends,
      live_ends: round.live_ends,
    },
    btc_price: btcPrice,
    my_bet: myBet,
    leaderboard,
    server_time: now,
  })
}
