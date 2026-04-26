// src/types/index.ts
export type Network = 'MTN' | 'AIRTEL'
export type RoundPhase = 'WAITING' | 'BETTING' | 'LIVE' | 'RESOLVING' | 'COMPLETE'
export type Direction = 'ABOVE' | 'BELOW'
export type BetResult = 'WIN' | 'LOSS' | 'PENDING'
export type TxType = 'DEPOSIT' | 'WITHDRAWAL' | 'STAKE' | 'PAYOUT' | 'REFERRAL_BONUS' | 'REGISTRATION_FEE' | 'ADMIN_CUT'
export type TxStatus = 'PENDING' | 'SUCCESS' | 'FAILED'

export interface User {
  id: string
  phone: string
  name: string
  network: Network
  referral_code: string
  referred_by?: string
  is_verified: boolean
  is_banned: boolean
  created_at: string
}

export interface Wallet {
  id: string
  user_id: string
  balance: number  // UGX
  updated_at: string
}

export interface Transaction {
  id: string
  user_id: string
  type: TxType
  amount: number
  balance_before: number
  balance_after: number
  reference?: string
  livepay_ref?: string
  status: TxStatus
  meta: Record<string, unknown>
  created_at: string
}

export interface Round {
  id: string
  round_number: number
  phase: RoundPhase
  betting_starts: string
  betting_ends: string
  live_ends: string
  locked_price: number | null   // BTC/UGX × 100
  final_price: number | null
  result: Direction | null
  multiplier: number
  total_pool: number
  above_pool: number
  below_pool: number
  winner_count: number
  created_at: string
  completed_at: string | null
}

export interface Bet {
  id: string
  round_id: string
  user_id: string
  direction: Direction
  stake: number
  locked_price: number | null
  multiplier: number | null
  payout: number
  result: BetResult
  created_at: string
  // joined
  user?: Pick<User, 'name' | 'phone'>
}

export interface Referral {
  id: string
  referrer_id: string
  referred_id: string
  bonus_amount: number
  paid: boolean
  created_at: string
}

// API response shapes
export interface ApiOk<T = unknown> {
  ok: true
  data: T
}
export interface ApiErr {
  ok: false
  error: string
  code?: string
}
export type ApiResult<T = unknown> = ApiOk<T> | ApiErr

// LivePay API shapes
export interface LivePayCollectBody {
  accountNumber: string
  phoneNumber: string
  amount: number
  currency: 'UGX'
  reference: string
  description: string
  network: Network
}

export interface LivePayCollectResponse {
  success: boolean
  message: string
  network?: string
  internal_reference?: string
  error?: string
}

export interface LivePaySendBody {
  accountNumber: string
  phoneNumber: string
  amount: number
  currency: 'UGX'
  reference: string
  description: string
  network: Network
}

export interface LivePaySendResponse {
  success: boolean
  message: string
  internal_reference?: string
  error?: string
}

// Auth token payload
export interface JwtPayload {
  sub: string     // user id
  phone: string
  iat: number
  exp: number
}
