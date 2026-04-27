// supabase/functions/cryptobeat-deposit/index.ts
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
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const auth = req.headers.get("Authorization");
    if (!auth) return j({ error: "Unauthorized" }, 401);

    const { data: { user } } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!user) return j({ error: "Unauthorized" }, 401);

    const { amount, phone, network } = await req.json();
    if (!amount || amount < 1000) return j({ error: "Minimum deposit is UGX 1,000" }, 400);
    if (amount > 10000000) return j({ error: "Maximum deposit is UGX 10,000,000" }, 400);
    if (!phone) return j({ error: "Phone number required" }, 400);
    if (!["MTN", "AIRTEL"].includes(network)) return j({ error: "Network must be MTN or AIRTEL" }, 400);

    // Normalize phone
    let p = String(phone).replace(/\D/g, "");
    if (p.startsWith("0")) p = "256" + p.slice(1);
    else if (!p.startsWith("256")) p = "256" + p;

    const ref = `DEP${user.id.replace(/-/g, "").slice(0, 8)}${Date.now()}`.slice(0, 30);

    // Pre-log transaction
    const { data: wallet } = await sb.from("wallets").select("balance").eq("user_id", user.id).single();
    await sb.from("transactions").insert({
      user_id: user.id,
      type: "DEPOSIT",
      amount,
      balance_before: wallet?.balance ?? 0,
      balance_after: wallet?.balance ?? 0,
      reference: ref,
      status: "PENDING",
      meta: { phone: p, network },
    });

    // Call LivePay from Supabase Edge (not Vercel — avoids Cloudflare block)
    const lp = await fetch("https://livepay.me/api/collect-money", {
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
        description: "CryptoBeat Deposit",
        network,
      }),
    });

    const lpData = await lp.json();

    if (!lp.ok || lpData.success === false) {
      await sb.from("transactions").update({
        status: "FAILED",
        meta: { error: lpData.error || lpData.message },
      }).eq("reference", ref);
      return j({ error: lpData.error || lpData.message || "Deposit failed" }, 400);
    }

    await sb.from("transactions").update({
      livepay_ref: lpData.internal_reference,
    }).eq("reference", ref);

    return j({
      ok: true,
      data: {
        message: "USSD prompt sent. Approve on your phone to complete deposit.",
        reference: ref,
        livepay_ref: lpData.internal_reference,
        amount,
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
