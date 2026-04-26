// src/app/api/cron/tick/route.ts
//
// GET /api/cron/tick
// Called every 5 seconds by Vercel Cron (vercel.json) to advance the game loop.
// Also callable externally (protected by CRON_SECRET header).
//
// Vercel Cron config (add to vercel.json):
// {
//   "crons": [{ "path": "/api/cron/tick", "schedule": "*/1 * * * *" }]
// }
// Note: Vercel free tier minimum is 1 minute. For 5s resolution,
// use an external cron service (cron-job.org, Upstash QStash, etc.)
// pointing at: POST https://your-domain.vercel.app/api/cron/tick
// with header: Authorization: Bearer <CRON_SECRET>

import { NextRequest, NextResponse } from 'next/server'
import { advanceRound } from '@/lib/roundEngine'

const CRON_SECRET = process.env.CRON_SECRET

export async function GET(req: NextRequest) {
  // ── Auth: accept Vercel's built-in cron header OR our secret ──
  const authHeader = req.headers.get('authorization')
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'

  if (!isVercelCron) {
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
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

// Also support POST (for external cron services like cron-job.org)
export const POST = GET
