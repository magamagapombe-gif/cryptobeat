// src/app/api/auth/login/route.ts
import { NextRequest } from 'next/server'
import { compare } from 'bcryptjs'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabase/server'
import { signToken, setSessionCookie } from '@/lib/auth'
import { ok, err } from '@/lib/api'

const schema = z.object({
  phone:    z.string().min(9),
  password: z.string().min(1),
})

function normalizePhone(phone: string): string {
  let p = phone.replace(/\D/g, '')
  if (p.startsWith('0')) p = '256' + p.slice(1)
  else if (!p.startsWith('256')) p = '256' + p
  return p
}

export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() } catch { return err('Invalid JSON') }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return err(parsed.error.errors[0].message, 422)

  const { phone, password } = parsed.data
  const normalizedPhone = normalizePhone(phone)

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, phone, name, password_hash, network, referral_code, is_banned')
    .eq('phone', normalizedPhone)
    .single()

  if (!user) return err('Invalid phone or password', 401, 'INVALID_CREDENTIALS')
  if (user.is_banned) return err('Account suspended', 403, 'BANNED')

  const valid = await compare(password, user.password_hash)
  if (!valid) return err('Invalid phone or password', 401, 'INVALID_CREDENTIALS')

  const token = await signToken({ sub: user.id, phone: user.phone })
  const cookieOpts = setSessionCookie(token)

  const response = ok({
    token,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      network: user.network,
      referral_code: user.referral_code,
    },
  })

  response.cookies.set(cookieOpts)
  return response
}
