# Decode My Plan — setup (about 15 minutes)

1. Merge this branch so Cloudflare deploys it (the Worker is named `plandecoder`).
2. Set the secrets (Cloudflare dashboard → Workers → plandecoder → Settings → Variables, as *Secrets*):
   - `ANTHROPIC_API_KEY`: your Claude API key
   - `UNLOCK_SECRET`: any long random string (40+ characters)
   - `STRIPE_SECRET_KEY`: Stripe secret key, used only to check a payment went through
   - `UNLOCK_CODES`: comma-separated member codes for Core/Pro users, e.g. `CORE2026,PRO2026`
3. In Stripe, create a Payment Link for "Plan breakdown — 1 credit" at $5.
   After payment → redirect to `https://<your-domain>/decode.html?session_id={CHECKOUT_SESSION_ID}`
   Put that link in `PAYMENT_LINK_URL` in `wrangler.jsonc`.
4. Add a custom domain such as `decode.plandecoder.com`, then link the live app's "My plan" page to it with a "Decode my plan" button.
5. Test with the DUMMY Jordan Sample PDF.

Privacy: the PDF is read in the browser; only its text (or page images for scanned plans) is sent to Claude; nothing is stored or logged by the Worker; the breakdown is saved only in the user's browser.
Tests: `node worker.test.mjs`
