// The Wire on Cloudflare Workers — the live push sender for ppc.html.
//
//   scheduled: every minute (wrangler.toml) → one pass of runWire
//   POST /poke  (Authorization: Bearer <POKE_TOKEN>) → a pass right now; the
//               app calls this the moment a chat message / feed post lands,
//               so the partner's phone buzzes in seconds
//   GET  /      → health
//
// Bindings (wrangler.toml [vars] + `wrangler secret put`):
//   VAPID_PUBLIC_KEY   var     the same key as VAPID_PUB in ppc.html
//   VAPID_SUBJECT      var     mailto:you@example.com
//   PPC_DB, PPC_BASE   vars    optional overrides
//   VAPID_PRIVATE_KEY  secret  private half of the pair
//   POKE_TOKEN         secret  shared with the app (Arcade → The Wire → token)
import { runWire } from '../../tools/fit-push-core.mjs';
import { makeSender } from './webpush.mjs';

let inflight = null;   // coalesce overlapping passes inside one isolate
function pass(env, reason) {
  if (inflight) return inflight;
  const lines = [];
  const send = makeSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'mailto:cade.a.zawacki@gmail.com' });
  inflight = runWire({ db: env.PPC_DB, base: env.PPC_BASE, dry: env.DRY_RUN === '1', send, log: m => lines.push(m), logErr: m => lines.push('! ' + m) })
    .then(r => ({ ok: true, reason, ...r, lines }))
    .catch(e => ({ ok: false, reason, error: String(e && e.message || e), lines }))
    .finally(() => { inflight = null; });
  return inflight;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pass(env, 'cron').then(r => console.log(JSON.stringify(r))));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(JSON.stringify({ ok: true, wire: 'up', keys: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400' } });
    }
    if (req.method === 'POST' && url.pathname === '/poke') {
      const auth = req.headers.get('authorization') || '';
      if (!env.POKE_TOKEN || auth !== 'Bearer ' + env.POKE_TOKEN) return new Response('nope', { status: 401, headers: { 'access-control-allow-origin': '*' } });
      // answer immediately; the pass runs in the background (waitUntil keeps it alive)
      const p = pass(env, 'poke');
      ctx.waitUntil(p.then(r => console.log(JSON.stringify(r))));
      if (url.searchParams.get('wait') === '1') {
        const r = await p;
        return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
      }
      return new Response('ok', { status: 202, headers: { 'access-control-allow-origin': '*' } });
    }
    return new Response('not found', { status: 404 });
  },
};
