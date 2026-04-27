// src/app/api/cron/tick/route.ts
// Accepts secret via URL query param OR Authorization header
// cron-job.org URL: https://cryptobeat14.vercel.app/api/cron/tick?secret=YOUR_CRON_SECRET

import { NextRequest, NextResponse } from 'next/server'
import { advanceRound } from '@/lib/roundEngine'

const CRON_SECRET = process.env.CRON_SECRET

export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const authHeader = req.headers.get('authorization')
  const urlSecret = req.nextUrl.searchParams.get('secret')

  if (!isVercelCron) {
    const validHeader = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`
    const validQuery  = CRON_SECRET && urlSecret === CRON_SECRET
    if (!validHeader && !validQuery) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const result = await advanceRound()
    return NextResponse.json({
      ok: true,
      action: result.action,
      round_id: result.round.id,
      round_number: result.round.round_number,
      phase: result.round.phase,
      ts: new Date().toISOString(),
    })
  } catch (e: unknown) {
    console.error('[cron/tick] error:', e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export const POST = GET
