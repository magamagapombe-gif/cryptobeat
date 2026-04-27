// supabase/functions/cryptobeat-withdraw/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const auth = req.headers.get("Authorization");
    if (!auth || !auth.startsWith("Bearer ")) return j({ error: "Unauthorized" }, 401);

    const token = auth.replace("Bearer ", "");
    let userId: string;
    try {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("Invalid token");
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      userId = payload.sub;
      if (!userId) throw new Error("No sub");
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return j({ error: "Token expired" }, 401);
      }
    } catch {
      return j({ error: "Invalid token" }, 401);
    }

    // Check activation and KYC
    const { data: userData } = await sb.from("users")
      .select("is_activated, national_id_status, is_banned")
      .eq("id", userId).single();

    if (!userData) return j({ error: "User not found" }, 404);
    if (userData.is_banned) return j({ error: "Account suspended" }, 403);
    if (!userData.is_activated) return j({ error: "Account not activated. Submit National ID to unlock withdrawals.", code: "NOT_ACTIVATED" }, 403);
    if (userData.national_id_status !== "APPROVED") return j({ error: "National ID verification required.", code: "KYC_REQUIRED" }, 403);

    const { amount, phone, network } = await req.json();
    if (!amount || amount < 1000) return j({ error: "Minimum withdrawal is UGX 1,000" }, 400);
    if (!phone) return j({ error: "Phone number required" }, 400);
    if (!["MTN", "AIRTEL"].includes(network)) return j({ error: "Network must be MTN or AIRTEL" }, 400);

    // Normalize phone
    let p = String(phone).replace(/\D/g, "");
    if (p.startsWith("0")) p = "256" + p.slice(1);
    else if (!p.startsWith("256")) p = "256" + p;

    // Check balance
    const { data: wallet } = await sb.from("wallets").select("balance").eq("user_id", userId).single();
    if (!wallet || wallet.balance < amount) return j({ error: "Insufficient balance" }, 402);

    const ref = `WIT${userId.replace(/-/g, "").slice(0, 8)}${Date.now()}`.slice(0, 30);
    const newBalance = wallet.balance - amount;

    // Debit wallet
    await sb.from("wallets").update({ balance: newBalance, updated_at: new Date().toISOString() }).eq("user_id", userId);
    await sb.from("transactions").insert({
      user_id: userId,
      type: "WITHDRAWAL",
      amount,
      balance_before: wallet.balance,
      balance_after: newBalance,
      reference: ref,
      status: "PENDING",
      meta: { phone: p, network },
    });

    // Send via LivePay
    const lp = await fetch("https://livepay.me/api/send-money", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("LIVEPAY_API_KEY")}`,
      },
      body: JSON.stringify({
        accountNumber: Deno.env.get("LIVEPAY_ACCOUNT_NUMBER"),
        phoneNumber: p,
        amount,
        currency: "UGX",
        reference: ref,
        description: "CryptoBeat Withdrawal",
        network,
      }),
    });

    const lpData = await lp.json();

    if (!lp.ok || lpData.success === false) {
      // Reverse debit
      await sb.from("wallets").update({ balance: wallet.balance, updated_at: new Date().toISOString() }).eq("user_id", userId);
      await sb.from("transactions").update({ status: "FAILED", meta: { error: lpData.error || lpData.message } }).eq("reference", ref);
      return j({ error: lpData.error || lpData.message || "Withdrawal failed" }, 400);
    }

    await sb.from("transactions").update({ status: "SUCCESS", livepay_ref: lpData.internal_reference }).eq("reference", ref);

    return j({
      ok: true,
      data: {
        message: `UGX ${amount.toLocaleString()} sent to ${phone}`,
        new_balance: newBalance,
        reference: ref,
      }
    });
  } catch (e) {
    console.error(e);
    return j({ error: "Internal server error" }, 500);
  }
});

function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
