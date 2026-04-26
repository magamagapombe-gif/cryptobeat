// src/lib/btcPrice.ts

const UGX_PER_USD = 3700  // fallback rate — production: pull from an FX API

let cachedPrice: number = 0
let cacheTime: number = 0
const CACHE_TTL_MS = 4000  // 4 seconds — tight enough for 5s frontend polling

export async function getBTCPriceUGX(): Promise<number> {
  const now = Date.now()
  if (cachedPrice && now - cacheTime < CACHE_TTL_MS) return cachedPrice

  try {
    // Primary: Binance (no key required, very reliable)
    const res = await fetch(
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      { cache: 'no-store', signal: AbortSignal.timeout(3000) }
    )
    const data = await res.json()
    const usd = parseFloat(data.price)
    cachedPrice = Math.round(usd * UGX_PER_USD)
    cacheTime = now
    return cachedPrice
  } catch {
    // Fallback: CoinGecko (free tier, rate-limited)
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=ugx',
        { cache: 'no-store', signal: AbortSignal.timeout(4000) }
      )
      const data = await res.json()
      cachedPrice = Math.round(data.bitcoin.ugx)
      cacheTime = now
      return cachedPrice
    } catch {
      // Return last known price rather than crashing
      if (cachedPrice) return cachedPrice
      throw new Error('BTC price unavailable')
    }
  }
}
