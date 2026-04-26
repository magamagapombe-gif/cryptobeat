// src/app/api/auth/me/route.ts
import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/api'
import { ok, err } from '@/lib/api'

export async function GET(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, name, phone, network, referral_code, created_at')
    .eq('id', session.sub)
    .single()

  if (!user) return err('User not found', 404)

  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('balance')
    .eq('user_id', session.sub)
    .single()

  return ok({ user, balance: wallet?.balance ?? 0 })
}
