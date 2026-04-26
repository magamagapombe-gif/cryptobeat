// src/lib/api.ts
import { NextResponse } from 'next/server'
import { getSessionFromHeader } from './auth'
import type { ApiOk, ApiErr } from '@/types'

export function ok<T>(data: T, status = 200): NextResponse<ApiOk<T>> {
  return NextResponse.json({ ok: true, data }, { status })
}

export function err(message: string, status = 400, code?: string): NextResponse<ApiErr> {
  return NextResponse.json({ ok: false, error: message, code }, { status })
}

// Require authenticated session — returns user payload or short-circuits
export async function requireAuth(req: Request) {
  const session = await getSessionFromHeader(req)
  if (!session) {
    return { session: null, response: err('Unauthorized', 401, 'UNAUTHORIZED') }
  }
  return { session, response: null }
}
