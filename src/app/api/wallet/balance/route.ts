// src/app/api/wallet/balance/route.ts
import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { requireAuth, ok, err } from '@/lib/api'

export async function GET(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('balance, updated_at')
    .eq('user_id', session.sub)
    .single()

  if (!wallet) return err('Wallet not found', 404)
  return ok({ balance: wallet.balance, updated_at: wallet.updated_at })
}
