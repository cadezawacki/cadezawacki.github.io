// The Wire — GitHub Actions entry point (see .github/workflows/fit-push.yml).
// Manual dispatch / dry runs only now: the Cloudflare Worker in wire/ is the
// live sender (every minute + instant pokes from the app). Both call the
// same pass in tools/fit-push-core.mjs.
//
// Env: VAPID_PRIVATE_KEY (secret, required unless DRY_RUN=1)
//      PPC_DB (default https://cadetxt-default-rtdb.firebaseio.com)
//      PPC_BASE (default rooms/__ppc)   DRY_RUN=1 → print, don't send
//      NOW_OVERRIDE (ISO instant, tests only)
import { runWire } from './fit-push-core.mjs';

const DRY = process.env.DRY_RUN === '1';
const VAPID_PUB = 'BLDjqScSs7wFz6yfdHv5lZw-8La0X1fBJSrthKp5jguCBgpHVXTf-GXF10C3OpsL4mGWhh56UTr4bYzst2OxTAI';
let send = null;
if (!DRY) {
  const webpush = (await import('web-push')).default;
  if (!process.env.VAPID_PRIVATE_KEY) { console.error('VAPID_PRIVATE_KEY missing'); process.exit(1); }
  webpush.setVapidDetails('mailto:cade.a.zawacki@gmail.com', process.env.VAPID_PUBLIC_KEY || VAPID_PUB, process.env.VAPID_PRIVATE_KEY);
  send = (sub, payload, ttl) => webpush.sendNotification(sub, payload, { TTL: ttl });
}
await runWire({
  db: process.env.PPC_DB, base: process.env.PPC_BASE, dry: DRY,
  now: process.env.NOW_OVERRIDE ? new Date(process.env.NOW_OVERRIDE) : new Date(),
  send,
});
