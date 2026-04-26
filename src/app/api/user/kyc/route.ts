// src/app/api/user/kyc/route.ts
//
// POST /api/user/kyc
// Submits National ID details for account activation.
// Admin reviews in Supabase dashboard and flips is_activated = true.
//
// Fields collected:
//  - national_id_number (Uganda National ID format: CM900XXXXX or similar)
//  - date_of_birth (YYYY-MM-DD)
//  - full_legal_name
//
// Flow:
//  User submits → national_id_status = 'PENDING'
//  Admin approves in dashboard → national_id_status = 'APPROVED', is_activated = true

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabase/server'
import { requireAuth, ok, err } from '@/lib/api'

const schema = z.object({
  national_id_number: z.string().min(6).max(30),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  full_legal_name: z.string().min(3).max(100),
})

export async function POST(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  let body: unknown
  try { body = await req.json() } catch { return err('Invalid JSON') }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return err(parsed.error.errors[0].message, 422)

  const { national_id_number, date_of_birth, full_legal_name } = parsed.data

  // ── Age check — must be 18+ ──
  const dob = new Date(date_of_birth)
  const today = new Date()
  const age = today.getFullYear() - dob.getFullYear() -
    (today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0)

  if (age < 18) {
    return err('You must be 18 or older to use CryptoBeat.', 403, 'UNDERAGE')
  }

  // ── Check for duplicate National ID ──
  const { data: existing } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('national_id_number', national_id_number.toUpperCase())
    .neq('id', session.sub) // exclude self
    .single()

  if (existing) {
    return err('This National ID is already registered to another account.', 409, 'DUPLICATE_NID')
  }

  // ── Check current status — don't allow resubmit if already approved ──
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('national_id_status, is_activated')
    .eq('id', session.sub)
    .single()

  if (user?.is_activated && user?.national_id_status === 'APPROVED') {
    return err('Your account is already activated.', 409, 'ALREADY_ACTIVATED')
  }

  // ── Submit KYC ──
  const { error } = await supabaseAdmin
    .from('users')
    .update({
      national_id_number: national_id_number.toUpperCase(),
      date_of_birth,
      full_legal_name,
      national_id_status: 'PENDING',
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.sub)

  if (error) return err(`Submission failed: ${error.message}`, 500)

  return ok({
    message: 'National ID submitted for review. Activation typically takes 1–24 hours.',
    status: 'PENDING',
  })
}

// GET — check current KYC status
export async function GET(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('is_activated, national_id_status, date_of_birth, national_id_number')
    .eq('id', session.sub)
    .single()

  if (!user) return err('User not found', 404)

  return ok({
    is_activated: user.is_activated,
    national_id_status: user.national_id_status ?? 'NONE',
    has_national_id: !!user.national_id_number,
    date_of_birth: user.date_of_birth,
  })
}
