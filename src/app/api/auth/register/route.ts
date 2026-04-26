// src/app/api/auth/register/route.ts
//
// Free registration — no upfront payment required.
// Users can play and win immediately.
// Withdrawals are locked until:
//   1. National ID submitted and approved (national_id_status = 'APPROVED')
//   2. Admin sets is_activated = true
//   3. User is 18+ (date_of_birth validated here and in KYC route)

import { NextRequest } from 'next/server'
import { hash } from 'bcryptjs'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabase/server'
import { signToken, setSessionCookie } from '@/lib/auth'
import { ok, err } from '@/lib/api'

const schema = z.object({
  name:          z.string().min(2).max(80),
  phone:         z.string().min(9).max(13),
  network:       z.enum(['MTN', 'AIRTEL']),
  password:      z.string().min(6).max(100),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DOB must be YYYY-MM-DD'),
  referralCode:  z.string().optional(),
})

function generateReferralCode(): string {
  return 'CB-' + Math.random().toString(36).slice(2, 8).toUpperCase()
}

function normalizePhone(phone: string): string {
  let p = phone.replace(/\D/g, '')
  if (p.startsWith('0')) p = '256' + p.slice(1)
  else if (!p.startsWith('256')) p = '256' + p
  return p
}

export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() } catch { return err('Invalid JSON', 400) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return err(parsed.error.errors[0].message, 422)

  const { name, phone, network, password, date_of_birth, referralCode } = parsed.data
  const normalizedPhone = normalizePhone(phone)

  // ── Age check (18+) ──
  const dob = new Date(date_of_birth)
  const today = new Date()
  const age = today.getFullYear() - dob.getFullYear() -
    (today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0)

  if (age < 18) {
    return err('You must be 18 or older to use CryptoBeat.', 403, 'UNDERAGE')
  }

  // ── One phone per person ──
  const { data: existing } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('phone', normalizedPhone)
    .single()

  if (existing) return err('Phone number already registered', 409, 'PHONE_TAKEN')

  // ── Resolve referrer ──
  let referrerId: string | null = null
  if (referralCode) {
    const { data: referrer } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('referral_code', referralCode.toUpperCase())
      .single()
    if (referrer) referrerId = referrer.id
  }

  const passwordHash = await hash(password, 12)

  // ── Create user (free — no payment) ──
  const { data: user, error: userErr } = await supabaseAdmin
    .from('users')
    .insert({
      phone: normalizedPhone,
      name,
      password_hash: passwordHash,
      network,
      referral_code: generateReferralCode(),
      referred_by: referrerId,
      date_of_birth,
      is_verified: true,
      is_activated: false,          // locked until KYC approved
      national_id_status: 'NONE',
    })
    .select()
    .single()

  if (userErr) return err(`Account creation failed: ${userErr.message}`, 500)

  // ── Create wallet (starts at 0) ──
  await supabaseAdmin.from('wallets').insert({ user_id: user.id, balance: 0 })

  // ── Referral bonus (paid to referrer) ──
  if (referrerId) {
    const REFERRAL_BONUS = parseInt(process.env.REFERRAL_BONUS ?? '4000')
    const { data: refWallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', referrerId)
      .single()

    if (refWallet) {
      const newBal = refWallet.balance + REFERRAL_BONUS
      await supabaseAdmin
        .from('wallets')
        .update({ balance: newBal, updated_at: new Date().toISOString() })
        .eq('user_id', referrerId)

      await supabaseAdmin.from('transactions').insert({
        user_id: referrerId,
        type: 'REFERRAL_BONUS',
        amount: REFERRAL_BONUS,
        balance_before: refWallet.balance,
        balance_after: newBal,
        reference: `REFBONUS-${user.id}`,
        status: 'SUCCESS',
        meta: { referred_user_id: user.id, referred_phone: normalizedPhone },
      })

      await supabaseAdmin.from('referrals').insert({
        referrer_id: referrerId,
        referred_id: user.id,
        bonus_amount: REFERRAL_BONUS,
        paid: true,
      })
    }
  }

  // ── Sign JWT ──
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
      is_activated: false,
    },
  }, 201)

  response.cookies.set(cookieOpts)
  return response
}
