// src/app/api/admin/kyc/route.ts
// Admin-only endpoint — list pending KYC submissions and approve/reject them
// Protected by ADMIN_SECRET env var

import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { ok, err } from '@/lib/api'

const ADMIN_SECRET = process.env.ADMIN_SECRET

function isAdmin(req: NextRequest): boolean {
  const auth = req.headers.get('authorization')
  return !!ADMIN_SECRET && auth === `Bearer ${ADMIN_SECRET}`
}

// GET — list all pending KYC submissions with signed photo URLs
export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return err('Unauthorized', 401)

  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? 'PENDING'

  const { data: users, error } = await supabaseAdmin
    .from('users')
    .select('id, name, phone, national_id_number, full_legal_name, date_of_birth, national_id_status, id_front_url, id_back_url, created_at, kyc_reviewed_at')
    .eq('national_id_status', status)
    .order('created_at', { ascending: false })

  if (error) return err(error.message, 500)

  // Generate signed URLs for photos (valid 1 hour)
  const usersWithPhotos = await Promise.all((users ?? []).map(async (u) => {
    let frontUrl = null
    let backUrl  = null

    if (u.id_front_url) {
      const { data } = await supabaseAdmin.storage
        .from('kyc-documents')
        .createSignedUrl(u.id_front_url, 3600)
      frontUrl = data?.signedUrl ?? null
    }
    if (u.id_back_url) {
      const { data } = await supabaseAdmin.storage
        .from('kyc-documents')
        .createSignedUrl(u.id_back_url, 3600)
      backUrl = data?.signedUrl ?? null
    }

    return { ...u, front_photo_url: frontUrl, back_photo_url: backUrl }
  }))

  return ok({ users: usersWithPhotos, total: usersWithPhotos.length })
}

// POST — approve or reject a user
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return err('Unauthorized', 401)

  let body: { user_id: string; action: 'APPROVE' | 'REJECT'; note?: string }
  try { body = await req.json() } catch { return err('Invalid JSON') }

  const { user_id, action, note } = body
  if (!user_id || !action) return err('user_id and action required')
  if (!['APPROVE', 'REJECT'].includes(action)) return err('action must be APPROVE or REJECT')

  const { error } = await supabaseAdmin.from('users').update({
    national_id_status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    is_activated:       action === 'APPROVE' ? true : false,
    kyc_reviewed_at:    new Date().toISOString(),
    kyc_reviewed_by:    note ?? 'admin',
    updated_at:         new Date().toISOString(),
  }).eq('id', user_id)

  if (error) return err(error.message, 500)

  return ok({
    message: `User ${action === 'APPROVE' ? 'approved' : 'rejected'} successfully`,
    user_id,
    action,
  })
}
