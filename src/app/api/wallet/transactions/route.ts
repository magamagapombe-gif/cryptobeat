// src/app/api/wallet/transactions/route.ts
import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { requireAuth, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  const url = new URL(req.url)
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'))
  const limit = 20
  const from = (page - 1) * limit

  const { data, count } = await supabaseAdmin
    .from('transactions')
    .select('*', { count: 'exact' })
    .eq('user_id', session.sub)
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1)

  return ok({
    transactions: data ?? [],
    total: count ?? 0,
    page,
    pages: Math.ceil((count ?? 0) / limit),
  })
}
