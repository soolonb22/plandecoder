/**
 * Plan Decoder — "Decode my plan" Worker
 *
 * Routes:
 *   POST /api/decode   { text?, images?[], token? }  -> preview or full breakdown
 *   POST /api/unlock   { session_id }                 -> signed unlock token (after Stripe payment)
 *   everything else    -> static assets (decode.html, index.html, ...)
 *
 * Privacy: plan text/images are passed straight to Claude and never stored or logged.
 *
 * Secrets (wrangler secret put ...):
 *   ANTHROPIC_API_KEY   - Claude API key
 *   UNLOCK_SECRET       - long random string used to sign unlock tokens
 *   STRIPE_SECRET_KEY   - (optional) to verify paid Checkout Sessions for 1-credit unlocks
 *   UNLOCK_CODES        - (optional) comma-separated codes for Core/Pro members, e.g. "KYLIE2026,COREMEMBER"
 * Vars (wrangler.jsonc "vars"):
 *   CLAUDE_MODEL        - model id, e.g. "claude-sonnet-4-5"
 *   PAYMENT_LINK_URL    - Stripe Payment Link for 1 credit ($5)
 */

const MAX_TEXT = 120_000;     // chars of extracted plan text
const MAX_IMAGES = 12;        // scanned-page fallback
const TOKEN_TTL = 7 * 24 * 3600; // unlock token lifetime (seconds)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/decode" && request.method === "POST") return await decode(request, env);
      if (url.pathname === "/api/unlock" && request.method === "POST") return await unlock(request, env);
      if (url.pathname === "/api/config") return json({ paymentLink: env.PAYMENT_LINK_URL || null });
    } catch (err) {
      // Never log request bodies (participant data). Log the error type only.
      console.error("api_error", err && err.name, err && err.message && err.message.slice(0, 200));
      return json({ error: "Something went wrong reading your plan. Please try again." }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------------- decode ---------------- */

async function decode(request, env) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : "";
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (text.trim().length < 200 && images.length === 0) {
    return json({ error: "We couldn't find enough text in that file. Is it your NDIS plan PDF?" }, 400);
  }

  const unlocked = await verifyToken(body.token, env);

  const content = [];
  for (const dataUrl of images) {
    const m = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(dataUrl || "");
    if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  content.push({
    type: "text",
    text: text
      ? `Here is the text of the NDIS plan, extracted from the PDF:\n\n<plan>\n${text}\n</plan>\n\nCall plan_breakdown.`
      : "The NDIS plan pages are attached as images. Read them carefully and call plan_breakdown.",
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-4-5",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: [BREAKDOWN_TOOL],
      tool_choice: { type: "tool", name: "plan_breakdown" },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    console.error("anthropic_status", res.status);
    return json({ error: "The decoder is busy right now. Please try again in a minute." }, 502);
  }
  const out = await res.json();
  const tool = (out.content || []).find((c) => c.type === "tool_use");
  if (!tool) return json({ error: "We couldn't read that plan. Try a clearer PDF." }, 422);
  const b = tool.input;

  if (b.is_ndis_plan === false) {
    return json({ error: "This doesn't look like an NDIS plan. Please upload the plan PDF from the my NDIS app or portal." }, 422);
  }

  return json(unlocked ? { tier: "full", breakdown: b } : { tier: "preview", breakdown: toPreview(b) });
}

// Free tier: the shape of the plan, plus a teaser of what's locked.
function toPreview(b) {
  return {
    plan_start: b.plan_start, plan_end: b.plan_end, reassessment_date: b.reassessment_date,
    total_budget: b.total_budget,
    summary_plain: b.summary_plain,
    pots: (b.pots || []).map(({ name, total }) => ({ name, total })),
    management_summary: b.management_summary,
    locked: {
      line_items: (b.line_items || []).length,
      red_flags: (b.red_flags || []).length,
      high_flags: (b.red_flags || []).filter((f) => f.severity === "high").length,
      key_dates: (b.key_dates || []).length,
      questions: (b.questions_to_ask || []).length,
    },
  };
}

/* ---------------- unlock (1 credit via Stripe, or member code) ---------------- */

async function unlock(request, env) {
  const { session_id, code } = await request.json().catch(() => ({}));

  if (code) {
    const codes = (env.UNLOCK_CODES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!codes.includes(String(code).trim().toUpperCase())) return json({ error: "That code didn't work." }, 403);
    return json({ token: await signToken({ src: "code" }, env) });
  }

  if (!session_id || !/^cs_(live|test)_[A-Za-z0-9]+$/.test(session_id)) return json({ error: "Missing payment reference." }, 400);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments are not set up yet." }, 501);

  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session_id}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!r.ok) return json({ error: "We couldn't confirm that payment." }, 402);
  const s = await r.json();
  if (s.payment_status !== "paid") return json({ error: "That payment isn't complete yet." }, 402);
  return json({ token: await signToken({ src: "stripe", sid: session_id }, env) });
}

/* ---------------- HMAC tokens (no database needed) ---------------- */

async function hmac(data, env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.UNLOCK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}
async function signToken(claims, env) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL })));
  return `${payload}.${await hmac(payload, env)}`;
}
async function verifyToken(token, env) {
  if (!token || !env.UNLOCK_SECRET || typeof token !== "string") return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || (await hmac(payload, env)) !== sig) return false;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return c.exp > Date.now() / 1000;
  } catch { return false; }
}
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/* ---------------- Claude prompt + output schema ---------------- */

const SYSTEM_PROMPT = `You are Plan Decoder, a plain-language explainer for Australian NDIS plans. You read a participant's plan and explain it to them, their family or carer.

Who is reading: NDIS participants, parents and carers. Many are stressed, tired, neurodivergent or have low literacy. Write at a Grade 6–8 reading level. Short sentences. No jargon without a plain explanation. Warm, calm, respectful. Trauma-informed: never alarming, never blaming. Speak to "you" (the participant or their carer).

Accuracy rules (most important):
- Only use facts that are in the plan. Copy dollar amounts and dates exactly. Never invent a number, date, provider or rule.
- If something is not in the plan, say so in not_found. Do not guess.
- Explain general NDIS rules only when they help the reader understand a line in THIS plan, and keep them general (e.g. "Stated supports must be used for exactly what is written").
- NDIS budgets: Core (daily living, community participation, consumables, transport in older plans), Capacity Building (therapy, support coordination, skills, employment, plan management), Capital (assistive technology, home modifications, SDA), and Recurring (e.g. transport periodic payments) on current plans. Money cannot be moved between Core, Capacity Building, Capital and Recurring.
- Stated = only that exact support. Flexible = choice within that budget. Management: NDIA-managed (registered providers only), plan-managed (plan manager pays any provider at or below price limits), self-managed (participant pays and keeps receipts).
- Newer plans release money in funding periods (often every 3 months). Unspent money usually rolls forward but cannot be pulled forward early.
- Red flags are things the reader should act on or check: expiring documents (e.g. interim behaviour support plans), funds held until a quote, registered-provider-only lines, low hours vs stated needs, upcoming reassessment dates, items marked not funded, unclear wording. Rate severity honestly.
- You are not the NDIA and not giving legal or financial advice. Do not tell them their plan is wrong; tell them what to check and who to ask.
- If the document is not an NDIS plan, set is_ndis_plan to false and leave other fields minimal.

Always respond by calling the plan_breakdown tool.`;

const BREAKDOWN_TOOL = {
  name: "plan_breakdown",
  description: "Structured plain-language breakdown of an NDIS plan.",
  input_schema: {
    type: "object",
    required: ["is_ndis_plan", "summary_plain", "total_budget", "pots", "line_items", "red_flags", "questions_to_ask", "not_found"],
    properties: {
      is_ndis_plan: { type: "boolean" },
      participant_first_name: { type: "string", description: "First name only. Never include NDIS number, DOB or address." },
      plan_start: { type: "string" },
      plan_end: { type: "string" },
      reassessment_date: { type: "string" },
      total_budget: { type: "number" },
      summary_plain: { type: "string", description: "3–5 short sentences: what this plan is for and the big picture." },
      goals: { type: "array", items: { type: "string" } },
      pots: {
        type: "array",
        items: {
          type: "object", required: ["name", "total", "plain_explanation"],
          properties: {
            name: { type: "string", enum: ["Core", "Capacity Building", "Capital", "Recurring"] },
            total: { type: "number" },
            plain_explanation: { type: "string" },
          },
        },
      },
      management_summary: {
        type: "array",
        items: {
          type: "object", required: ["type", "amount", "what_it_means"],
          properties: {
            type: { type: "string" }, amount: { type: "number" }, what_it_means: { type: "string" },
          },
        },
      },
      line_items: {
        type: "array",
        items: {
          type: "object", required: ["pot", "name", "amount", "stated", "plain_explanation"],
          properties: {
            pot: { type: "string" },
            name: { type: "string", description: "Support name as written in the plan" },
            amount: { type: "number" },
            management: { type: "string" },
            stated: { type: "boolean" },
            plain_explanation: { type: "string", description: "What this money is for, in plain words, and what it can be used for." },
            rules: { type: "string", description: "Conditions from the plan (quote needed, registered provider only, ratios, caps). Empty if none." },
          },
        },
      },
      funding_periods: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, dates: { type: "string" }, amount: { type: "number" } } },
      },
      funding_periods_explainer: { type: "string" },
      key_dates: {
        type: "array",
        items: {
          type: "object", required: ["date", "what"],
          properties: { date: { type: "string" }, what: { type: "string" }, why_it_matters: { type: "string" } },
        },
      },
      red_flags: {
        type: "array",
        items: {
          type: "object", required: ["severity", "title", "explanation", "what_to_do"],
          properties: {
            severity: { type: "string", enum: ["high", "medium", "low"] },
            title: { type: "string" }, explanation: { type: "string" }, what_to_do: { type: "string" },
          },
        },
      },
      questions_to_ask: {
        type: "array",
        items: {
          type: "object", required: ["who", "question"],
          properties: { who: { type: "string", description: "e.g. Support coordinator, Plan manager, NDIA planner, Provider" }, question: { type: "string" } },
        },
      },
      not_found: { type: "array", items: { type: "string" }, description: "Useful things the plan does not say." },
    },
  },
};
