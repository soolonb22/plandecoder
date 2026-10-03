// Node test: stubs Claude + Stripe, checks preview gating, tokens, unlock paths.
import worker from "./worker.js";
import assert from "node:assert";
const sample = { is_ndis_plan: true, summary_plain: "s", total_budget: 100, plan_start: "1/10/2026",
  pots: [{ name: "Core", total: 60, plain_explanation: "x" }], management_summary: [],
  line_items: [{ pot: "Core", name: "SIL", amount: 60, stated: true, plain_explanation: "p" }],
  red_flags: [{ severity: "high", title: "t", explanation: "e", what_to_do: "w" }], questions_to_ask: [], not_found: [] };
globalThis.fetch = async (url, init) => {
  if (String(url).includes("anthropic")) return new Response(JSON.stringify({ content: [{ type: "tool_use", input: sample }] }));
  if (String(url).includes("stripe")) return new Response(JSON.stringify({ payment_status: url.includes("unpaid") ? "unpaid" : "paid" }));
};
const env = { ANTHROPIC_API_KEY: "k", UNLOCK_SECRET: "secret123", STRIPE_SECRET_KEY: "sk", UNLOCK_CODES: "KYLIE2026", ASSETS: { fetch: () => new Response("asset") } };
const post = (p, b) => worker.fetch(new Request("https://x" + p, { method: "POST", body: JSON.stringify(b) }), env).then(async r => [r.status, await r.json()]);
const text = "NDIS plan ".repeat(40);

let [s, d] = await post("/api/decode", { text });           assert.equal(d.tier, "preview"); assert.equal(d.breakdown.line_items, undefined); assert.equal(d.breakdown.locked.high_flags, 1);
[s, d] = await post("/api/decode", { text: "short" });       assert.equal(s, 400);
[s, d] = await post("/api/unlock", { code: "nope" });        assert.equal(s, 403);
[s, d] = await post("/api/unlock", { code: "kylie2026" });   assert.ok(d.token);
const tok = d.token;
[s, d] = await post("/api/decode", { text, token: tok });    assert.equal(d.tier, "full"); assert.equal(d.breakdown.line_items.length, 1);
[s, d] = await post("/api/decode", { text, token: tok.slice(0, -2) + "xx" }); assert.equal(d.tier, "preview");
[s, d] = await post("/api/unlock", { session_id: "cs_test_abc" }); assert.ok(d.token);
[s, d] = await post("/api/unlock", { session_id: "cs_test_unpaid" }); assert.equal(s, 402);
[s, d] = await post("/api/unlock", { session_id: "bad/../id" }); assert.equal(s, 400);
const a = await worker.fetch(new Request("https://x/decode.html"), env); assert.equal(await a.text(), "asset");
sample.is_ndis_plan = false; [s, d] = await post("/api/decode", { text }); assert.equal(s, 422);
console.log("all worker tests passed");
