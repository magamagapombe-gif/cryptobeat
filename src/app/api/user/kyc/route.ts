// src/app/api/user/kyc/route.ts
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabase/server'
import { requireAuth, ok, err } from '@/lib/api'

const schema = z.object({
  national_id_number: z.string().min(6).max(30),
  date_of_birth:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  full_legal_name:    z.string().min(3).max(100),
  id_front:           z.string().min(100),
  id_back:            z.string().min(100),
})

function base64ToBuffer(dataUrl: string): { buffer: Buffer; contentType: string } {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!matches) throw new Error('Invalid image format')
  return { buffer: Buffer.from(matches[2], 'base64'), contentType: matches[1] }
}

export async function POST(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  let body: unknown
  try { body = await req.json() } catch { return err('Invalid JSON') }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return err(parsed.error.errors[0].message, 422)

  const { national_id_number, date_of_birth, full_legal_name, id_front, id_back } = parsed.data

  // Age check
  const dob = new Date(date_of_birth)
  const today = new Date()
  const age = today.getFullYear() - dob.getFullYear() -
    (today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0)
  if (age < 18) return err('You must be 18 or older.', 403, 'UNDERAGE')

  // Duplicate NIN check
  const { data: existing } = await supabaseAdmin
    .from('users').select('id')
    .eq('national_id_number', national_id_number.toUpperCase())
    .neq('id', session.sub).single()
  if (existing) return err('This National ID is already registered.', 409, 'DUPLICATE_NID')

  // Already approved check
  const { data: user } = await supabaseAdmin
    .from('users').select('national_id_status, is_activated').eq('id', session.sub).single()
  if (user?.is_activated && user?.national_id_status === 'APPROVED')
    return err('Your account is already activated.', 409, 'ALREADY_ACTIVATED')

  // Upload photos
  const bucket = 'kyc-documents'
  const ts = Date.now()
  const frontPath = `${session.sub}/front_${ts}.jpg`
  const backPath  = `${session.sub}/back_${ts}.jpg`

  try {
    const f = base64ToBuffer(id_front)
    const { error: fe } = await supabaseAdmin.storage.from(bucket)
      .upload(frontPath, f.buffer, { contentType: f.contentType, upsert: true })
    if (fe) throw new Error(fe.message)

    const b = base64ToBuffer(id_back)
    const { error: be } = await supabaseAdmin.storage.from(bucket)
      .upload(backPath, b.buffer, { contentType: b.contentType, upsert: true })
    if (be) throw new Error(be.message)
  } catch (e: unknown) {
    return err(`Photo upload failed: ${e instanceof Error ? e.message : 'Unknown'}`, 500)
  }

  const { error } = await supabaseAdmin.from('users').update({
    national_id_number: national_id_number.toUpperCase(),
    date_of_birth,
    full_legal_name,
    national_id_status: 'PENDING',
    id_front_url: frontPath,
    id_back_url:  backPath,
    updated_at: new Date().toISOString(),
  }).eq('id', session.sub)

  if (error) return err(`Submission failed: ${error.message}`, 500)

  return ok({ message: 'National ID submitted. Review takes 1–24 hours.', status: 'PENDING' })
}

export async function GET(req: NextRequest) {
  const { session, response } = await requireAuth(req)
  if (!session) return response!

  const { data: user } = await supabaseAdmin
    .from('users').select('is_activated, national_id_status, date_of_birth, national_id_number')
    .eq('id', session.sub).single()

  if (!user) return err('User not found', 404)

  return ok({
    is_activated:       user.is_activated,
    national_id_status: user.national_id_status ?? 'NONE',
    has_national_id:    !!user.national_id_number,
    date_of_birth:      user.date_of_birth,
  })
}
