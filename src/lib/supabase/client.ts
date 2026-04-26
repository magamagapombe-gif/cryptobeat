// src/lib/supabase/client.ts
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Singleton for browser
let _client: ReturnType<typeof createClient> | null = null

export function getSupabaseBrowser() {
  if (!_client) {
    _client = createClient(supabaseUrl, anonKey)
  }
  return _client
}
