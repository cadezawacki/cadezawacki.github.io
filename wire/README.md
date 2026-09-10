# The Wire — Cloudflare Worker

The live push sender for `ppc.html`. Runs the same pass as `tools/fit-push.mjs`
(shared code in `tools/fit-push-core.mjs`) but on Cloudflare's free plan:

- **every minute** via a cron trigger (GitHub's schedule was firing every 4–5 h)
- **instantly** when the app POSTs `/poke` after a chat message or feed post

Payload encryption (RFC 8291) and VAPID signing (RFC 8292) are implemented on
WebCrypto in `src/webpush.mjs` — the `web-push` npm package can't run in
Workers. `node test/webpush.test.mjs` checks it against the RFC test vector.

## Deploy from the Cloudflare dashboard (no terminal)

**Option A — connect the GitHub repo (recommended: redeploys itself on every merge)**

1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Workers** tab →
   **Import a repository** (a.k.a. Workers Builds). Connect GitHub, pick
   `cadezawacki.github.io`.
2. Build settings: project name `ppc-wire`, **root directory** `wire`, build
   command empty, **deploy command** `npx wrangler deploy`. Create.
3. Once the first build is green: the worker's **Settings** → **Variables and
   Secrets** → add `VAPID_PRIVATE_KEY` (type *Secret*) and `POKE_TOKEN`
   (type *Secret*). The plain vars and the every-minute cron come from
   `wrangler.toml`, so they're already there — check **Settings → Triggers**
   shows `* * * * *`.
4. **Deployments** → **Retry / Redeploy** so the secrets are baked in.

**Option B — paste the single-file build into the online editor**

1. **Workers & Pages** → **Create** → **Create Worker** → name it `ppc-wire`
   → **Deploy** (the hello-world placeholder).
2. **Edit code**. Delete the placeholder, paste the whole of
   [`wire/dist/worker.js`](dist/worker.js) (open the file on GitHub → **Raw** →
   select all → copy). **Deploy**.
3. **Settings → Variables and Secrets**: add
   - `VAPID_PUBLIC_KEY` (Text) — the `VAPID_PUB` value from `ppc.html`
   - `VAPID_SUBJECT` (Text) — `mailto:you@example.com`
   - `VAPID_PRIVATE_KEY` (Secret)
   - `POKE_TOKEN` (Secret) — any long random string
4. **Settings → Triggers → Cron Triggers → Add** → `* * * * *` (every minute).
5. **Settings → Domains & Routes**: make sure the `workers.dev` route is
   enabled; that URL is what goes into the app.

Whenever the push logic changes on `master`, run `node wire/build.mjs`,
commit `wire/dist/worker.js`, and paste it again (Option A doesn't need this —
it builds from the source files).

## Deploy with wrangler (terminal)

Prerequisites: a free Cloudflare account, Node ≥ 20.

```sh
cd wire
npm install                       # installs wrangler
npx wrangler login                # opens the browser, authorizes the CLI
npx wrangler secret put VAPID_PRIVATE_KEY   # paste the private key (same pair as VAPID_PUB in ppc.html)
npx wrangler secret put POKE_TOKEN          # any long random string, e.g. `openssl rand -hex 24`
npx wrangler deploy
```

`deploy` prints the URL, e.g. `https://ppc-wire.<your-subdomain>.workers.dev`.

## After any of the above

Check it: open that URL — `{"ok":true,"wire":"up","keys":true}`. `keys:false`
means the secret didn't take.

Then in the app: 🎰 Arcade → The Wire → paste the **Worker URL** and the
**poke token** → Save for both. From that moment a chat message or feed post
pokes the Worker and the partner's phone gets the push within seconds.

## Watch it work

```sh
npx wrangler tail --format pretty
```

Every pass logs one JSON line: `reason` (`cron` / `poke`), `sent`, and the
per-device `lines` (`sent …`, `skip …: in the app right now`, `send fail …: 410`).

## Change something

- Push copy / rules: edit `tools/fit-push-core.mjs`, then `npx wrangler deploy`.
- Rotate the VAPID pair: `node tools/vapid-keygen.mjs`, put the public key in
  `ppc.html` **and** `wrangler.toml`, `wrangler secret put VAPID_PRIVATE_KEY`,
  deploy, then re-enable push on each phone.
- Pause sends without undeploying: set `DRY_RUN = "1"` under `[vars]` and deploy.

## Cost

Free plan: 100k requests/day and cron triggers are included. 1,440 cron passes +
pokes per day is ~2% of that.
