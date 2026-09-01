// The Wire — ppc push sender, run by .github/workflows/fit-push.yml every
// 5 minutes. Reads the RTDB over REST, decides which fitness notification
// window (if any) this run falls into for each partner, relays fresh chat
// messages and feed posts to the other phone, and sends Web Push via the
// VAPID pair (public half in ppc.html, private half in the
// VAPID_PRIVATE_KEY Actions secret).
//
// Design rules:
//  - silence is the reward: a finished day gets NO evening/last-call sends
//  - never send to someone who is in the app right now (fresh presence)
//  - one send per window per day, deduped through push/log
//  - chat/feed relays dedupe per item through push/state/<kind>/<recipient>
//    (the newest relayed ts); a missing state baselines silently so a fresh
//    subscription never gets blasted with history. After a real send attempt
//    state advances even when the send fails or nobody is subscribed — a
//    lost push costs one ping, a non-advancing state would repeat it
//    forever. A fresh-presence recipient consumes only items up to their
//    last heartbeat (later ones defer to the next run). DRY runs never
//    write — they print the state PUTs they would make.
//  - message text goes only inside the encrypted push payload, never into
//    the Actions log: this repo is public and so are its logs
//  - every derived event (wheel/noon/job) ports the page's seeded kernel —
//    keep the two in sync when either changes
//
// Env: VAPID_PRIVATE_KEY (secret, required unless DRY_RUN=1)
//      PPC_DB (default https://cadetxt-default-rtdb.firebaseio.com)
//      PPC_BASE (default rooms/__ppc)   DRY_RUN=1 → print, don't send
//      NOW_OVERRIDE (ISO instant, tests only)

const DB = process.env.PPC_DB || 'https://cadetxt-default-rtdb.firebaseio.com';
const BASE = process.env.PPC_BASE || 'rooms/__ppc';
const DRY = process.env.DRY_RUN === '1';
const NOW = process.env.NOW_OVERRIDE ? new Date(process.env.NOW_OVERRIDE) : new Date();

const USER_NAMES = { C: 'Cade', A: 'Avery' };
const OTHER = u => (u === 'C' ? 'A' : 'C');
const SHARED = ['med', 'str', 'exe'];
const HM = { med: 'Meditation', str: 'Stretch', exe: 'Exercise' };

async function dbGet(path) {
  const r = await fetch(`${DB}/${BASE}/${path}.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
}
async function dbPut(path, val) {
  // a swallowed failed write would green-loop duplicate sends every 5 minutes
  // (push/log and push/state are the only dedupe) — fail the run loudly instead
  const r = await fetch(`${DB}/${BASE}/${path}.json`, { method: 'PUT', body: JSON.stringify(val) });
  if (!r.ok) throw new Error(`PUT ${path}: ${r.status}`);
}

/* ---- seeded kernel (MUST match ppc.html) ---- */
function seedHash(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}
const rand01 = s => seedHash(s) / 4294967296;
const WEDGES = [
  ['vanilla', 40, '🎡 vanilla day'], ['med3', 6, '🧘 Meditation pays 3×'], ['str3', 6, '🙆 Stretch pays 3×'],
  ['exe3', 6, '🏃 Exercise pays 3×'], ['morning2', 8, '🌅 Pre-noon logs pay 2×'], ['sweep15', 8, '💰 Sweep bonus is +15'],
  ['deadeven', 6, '🤝 Dead even — duels OFF'], ['twinday', 6, '⚡ Twin strikes pay double'],
  ['duel2', 7, '⚔️ Duels pay DOUBLE'], ['nudge5', 7, '👉 Assists pay +5'],
];
function wheelFor(k, epoch) {
  if (k < epoch) return WEDGES[0];
  let r = rand01('wheel:' + k) * WEDGES.reduce((a, w) => a + w[1], 0);
  for (const w of WEDGES) { r -= w[1]; if (r < 0) return w; }
  return WEDGES[0];
}
function jobFor(k, epoch) {
  if (k < epoch || rand01('job:' + k) >= 2 / 7) return null;
  const startMin = 17 * 60 + Math.floor(rand01('jobm:' + k) * 150);
  return { startMin, endMin: startMin + 90 };
}
function noonFor(k, epoch) {
  if (k < epoch || jobFor(k, epoch) || rand01('noon:' + k) >= 1.5 / 7) return null;
  const habit = SHARED[Math.floor(rand01('noonh:' + k) * SHARED.length)];
  const startMin = 13 * 60 + Math.floor(rand01('noonm:' + k) * 210);
  return { habit, startMin, endMin: startMin + 90 };
}

/* ---- local time in the couple's timezone ---- */
function localParts(tz, at = NOW) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    min: (+parts.hour % 24) * 60 + +parts.minute,
  };
}
const addDaysKey = (k, n) => {
  const d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
};
const fmtMin = m => {
  const h = Math.floor(m / 60), mm = m % 60;
  return (((h + 11) % 12) + 1) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (h < 12 ? 'am' : 'pm');
};
const parseHHMM = (s, dflt) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  return m ? +m[1] * 60 + +m[2] : dflt;
};

/* ---- habit state ---- */
const slotDone = (days, k, u, h) => {
  const d = (days[k] || {})[u] || {};
  if (h === 'exe') return typeof d.exe === 'number' || typeof d.wrk === 'number';
  return typeof d[h] === 'number';
};
const slotResolved = (days, k, u, h) => {
  const d = (days[k] || {})[u] || {};
  if (h === 'exe') return slotDone(days, k, u, 'exe') || d.exe === 'skip' || d.wrk === 'skip';
  return slotDone(days, k, u, h) || d[h] === 'skip';
};
const remaining = (days, k, u) => SHARED.filter(h => !slotResolved(days, k, u, h)).length;
const isSweep = (days, k, u) =>
  SHARED.every(h => slotResolved(days, k, u, h)) && SHARED.some(h => slotDone(days, k, u, h));
function coupleStreak(days, endKey) {
  let n = 0, k = endKey;
  while (isSweep(days, k, 'C') && isSweep(days, k, 'A')) { n++; k = addDaysKey(k, -1); if (n > 3650) break; }
  return n;
}
function sweepTime(days, k, u, tz) {
  const d = (days[k] || {})[u] || {};
  const ts = Math.max(...SHARED.map(h => (typeof d[h] === 'number' ? d[h] : (h === 'exe' && typeof d.wrk === 'number' ? d.wrk : 0))));
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
}
function duelExposure(days, k, u, cfg) {
  // habits the partner has done and you haven't (unskipped) — what closing now costs
  let n = 0;
  for (const h of SHARED) {
    const d = (days[k] || {})[u] || {}, o = (days[k] || {})[OTHER(u)] || {};
    const skip = d[h] === 'skip' || o[h] === 'skip';
    if (!skip && !slotDone(days, k, u, h) && slotDone(days, k, OTHER(u), h)) n++;
  }
  return n * (cfg.duelLose || 2);
}

/* ---- main ---- */
const [days, cfgRaw, subsRaw, logRaw, presence, stateRaw] = await Promise.all([
  dbGet('fit/days'), dbGet('fit/config'), dbGet('push/subs'), dbGet('push/log'), dbGet('presence'),
  dbGet('push/state'),
]).then(r => r.map(x => x || {}));
const cfg = { duelLose: 2, coupleEvery: 7, jobBonus: 25, arcadeEpoch: '2026-09-01', tz: 'America/New_York',
  pushMorning: '08:00', pushEvening: '19:00', pushLast: '21:30', ...cfgRaw };
const { dateKey: tk, min: nowMin } = localParts(cfg.tz);
const epoch = cfg.arcadeEpoch;
const WINDOW = 30;   // a window stays open across several 5-min runs; push/log keeps it to one send
const inWindow = startMin => nowMin >= startMin && nowMin < startMin + WINDOW;
const fresh = u => presence[u] && presence[u].t && Date.now() - presence[u].t < 5 * 60000;

const sends = [];   // {slot, users: [u], mk: u => ({title, body, badge?})}
const wheelToday = wheelFor(tk, epoch);
const flame = coupleStreak(days, tk) || coupleStreak(days, addDaysKey(tk, -1));

if (inWindow(parseHHMM(cfg.pushMorning, 480))) {
  sends.push({
    slot: 'morning',
    users: ['C', 'A'].filter(u => !isSweep(days, tk, u)),
    mk: u => {
      const n = remaining(days, tk, u);
      const bits = [`${n} habit${n === 1 ? '' : 's'} today`];
      if (wheelToday[0] !== 'vanilla') bits.push(wheelToday[2]);
      if (flame > 0) bits.push(`💜 flame at ${flame}${(flame % cfg.coupleEvery) === cfg.coupleEvery - 1 ? ' — date credit day!' : ''}`);
      const nn = noonFor(tk, epoch);
      if (nn) bits.push(`🤠 standoff at ${fmtMin(nn.startMin)}`);
      const j = jobFor(tk, epoch);
      if (j) bits.push(`🏦 vault ${fmtMin(j.startMin)}`);
      return { title: '🌅 ppc — today\'s board', body: bits.join(' · '), badge: n };
    },
  });
}
if (inWindow(parseHHMM(cfg.pushEvening, 1140))) {
  sends.push({
    slot: 'evening',
    users: ['C', 'A'].filter(u => !isSweep(days, tk, u)),
    mk: u => {
      const o = OTHER(u);
      const n = remaining(days, tk, u);
      const exp = duelExposure(days, tk, u, cfg);
      const body = isSweep(days, tk, o)
        ? `${USER_NAMES[o]} swept at ${sweepTime(days, tk, o, cfg.tz)} — you have ${n} left${exp ? ` and −${exp} exposure` : ''}`
        : `${n} left tonight${exp ? ` · −${exp} exposure if the day ends now` : ''}`;
      return { title: '⚔️ ppc — evening report', body, badge: n };
    },
  });
}
if (inWindow(parseHHMM(cfg.pushLast, 1290))) {
  sends.push({
    slot: 'lastcall',
    users: ['C', 'A'].filter(u => !isSweep(days, tk, u)),
    mk: u => {
      const n = remaining(days, tk, u);
      const mins = 1440 - nowMin;
      const flameLine = flame > 0 && isSweep(days, tk, OTHER(u)) ? ` — the 💜 flame at ${flame} dies with it` : '';
      return { title: '⏳ ppc — last call', body: `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m left · ${n} habit${n === 1 ? '' : 's'} between you and the seal${flameLine}`, badge: n };
    },
  });
}
const nnNow = noonFor(tk, epoch);
if (nnNow && inWindow(nnNow.startMin)) {
  sends.push({
    slot: 'noon',
    users: ['C', 'A'].filter(u => !slotDone(days, tk, u, nnNow.habit)),
    mk: () => ({ title: '🤠 HIGH NOON', body: `${HM[nnNow.habit].toUpperCase()}. DRAW! First to log takes the pot — closes ${fmtMin(nnNow.endMin)}.` }),
  });
}
const jNow = jobFor(tk, epoch);
if (jNow && inWindow(jNow.startMin)) {
  sends.push({
    slot: 'job',
    users: ['C', 'A'],
    mk: () => ({ title: '🏦 THE VAULT IS OPEN', body: `90 minutes of 2× — and if you BOTH log inside, +${cfg.jobBonus} each.` }),
  });
}
const wheelTomorrow = wheelFor(addDaysKey(tk, 1), epoch);
if (inWindow(20 * 60) && wheelTomorrow[0] !== 'vanilla') {
  sends.push({
    slot: 'wheel',
    users: ['C', 'A'],
    mk: () => ({ title: '🎡 the 8pm spin', body: `Tomorrow: ${wheelTomorrow[2]}. Plan accordingly.` }),
  });
}

/* ---- dedupe, suppress, send ---- */
const log = logRaw[tk] || {};
let webpush = null;
if (!DRY) {
  webpush = (await import('web-push')).default;
  if (!process.env.VAPID_PRIVATE_KEY) { console.error('VAPID_PRIVATE_KEY missing'); process.exit(1); }
  webpush.setVapidDetails('mailto:cade.a.zawacki@gmail.com',
    'BLDjqScSs7wFz6yfdHv5lZw-8La0X1fBJSrthKp5jguCBgpHVXTf-GXF10C3OpsL4mGWhh56UTr4bYzst2OxTAI',
    process.env.VAPID_PRIVATE_KEY);
}
let sent = 0;
for (const s of sends) {
  if (log[s.slot]) { console.log(`skip ${s.slot}: already sent today`); continue; }
  let any = false;
  for (const u of s.users) {
    if (fresh(u)) { console.log(`skip ${s.slot}/${u}: in the app right now`); continue; }
    const payload = { ...s.mk(u), tag: 'ppc-' + s.slot, url: './ppc.html#fit' };
    const devices = Object.entries(subsRaw[u] || {}).filter(([, d]) => d && d.sub && !d.dead);
    if (!devices.length) { console.log(`skip ${s.slot}/${u}: no live subscription`); continue; }
    for (const [dev, d] of devices) {
      any = true;
      if (DRY) { console.log(`DRY ${s.slot}/${u}/${dev}:`, JSON.stringify(payload)); sent++; continue; }
      try {
        await webpush.sendNotification(d.sub, JSON.stringify(payload), { TTL: 3600 });
        sent++;
        console.log(`sent ${s.slot}/${u}/${dev}`);
      } catch (e) {
        console.error(`send fail ${s.slot}/${u}/${dev}: ${e.statusCode || e.message}`);
        if (e.statusCode === 404 || e.statusCode === 410) await dbPut(`push/subs/${u}/${dev}/dead`, true);
      }
    }
  }
  if (any && !DRY) await dbPut(`push/log/${tk}/${s.slot}`, Date.now());
}

/* ---- chat + feed relays (every run, per-item state — not the day/slot log) ---- */
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const ymOf = k => k.slice(0, 7);
const prevYm = ym => {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
};
// DRY never writes: it prints the state PUT it would make instead, so a
// preview run can't consume a pending real notification.
async function putState(kind, u, ts) {
  if (DRY) { console.log(`DRY state ${kind}/${u} -> ${ts}`); return; }
  await dbPut(`push/state/${kind}/${u}`, ts);
}
async function relay(kind, paths, url, mk) {
  // both months cover items written just before a month rolled over
  const months = await Promise.all(paths.map(p => dbGet(p).catch(() => null)));
  const state = stateRaw[kind] || {};
  for (const u of ['C', 'A']) {
    const o = OTHER(u);
    const items = [];
    for (const m of months) {
      for (const it of Object.values(m || {})) {
        if (it && it.by === o && typeof it.ts === 'number') items.push(it);
      }
    }
    items.sort((a, b) => a.ts - b.ts);
    if (state[u] == null) {
      // first sighting of this recipient: baseline silently — never blast history
      await putState(kind, u, NOW.getTime());
      console.log(`init ${kind}/${u}`);
      continue;
    }
    const news = items.filter(it => it.ts > state[u]);
    if (!news.length) continue;
    const newest = news[news.length - 1].ts;
    if (fresh(u)) {
      // in the app: the in-page toast covers anything up to their last
      // heartbeat. Items sent AFTER it stay pending — presence lingers fresh
      // for ~5 minutes after the app closes, and consuming those here would
      // drop the push for a message they never saw. Deferring also means no
      // buzz mid-conversation; the send happens once presence goes stale.
      const seenTo = Math.min(newest, presence[u].t);
      if (seenTo > state[u]) await putState(kind, u, seenTo);
      console.log(`seen ${kind}/${u}: in the app${seenTo < newest ? ' (newer items deferred)' : ''}`);
      continue;
    }
    // per-batch tag: batches stack like a messenger instead of silently
    // replacing a still-unread earlier notification
    const payload = { ...mk(o, news), tag: `ppc-${kind}-${newest}`, url };
    const devices = Object.entries(subsRaw[u] || {}).filter(([, d]) => d && d.sub && !d.dead);
    for (const [dev, d] of devices) {
      if (DRY) { console.log(`DRY ${kind}/${u}/${dev}:`, JSON.stringify(payload)); sent++; continue; }
      try {
        await webpush.sendNotification(d.sub, JSON.stringify(payload), { TTL: 3600 });
        sent++;
        console.log(`sent ${kind}/${u}/${dev}`);
      } catch (e) {
        console.error(`send fail ${kind}/${u}/${dev}: ${e.statusCode || e.message}`);
        if (e.statusCode === 404 || e.statusCode === 410) await dbPut(`push/subs/${u}/${dev}/dead`, true);
      }
    }
    if (!devices.length) console.log(`skip ${kind}/${u}: no live subscription`);
    await putState(kind, u, newest);
  }
}
const curYm = ymOf(tk);
if (cfg.pushChat !== false) {
  await relay('chat', [`chat/${curYm}`, `chat/${prevYm(curYm)}`], './ppc.html#notes/chat', (o, news) => ({
    title: '💬 ' + USER_NAMES[o],
    body: oneLine(news[news.length - 1].t, 110) + (news.length > 1 ? ` (+${news.length - 1} earlier)` : ''),
  }));
}
if (cfg.pushFeed !== false) {
  const HMF = { ...HM, wrk: 'Workout' };
  await relay('feed', [`fit/feed/${curYm}`, `fit/feed/${prevYm(curYm)}`], './ppc.html#fit/feed', (o, news) => {
    const p = news[news.length - 1];
    const what = p.caption ? `“${oneLine(p.caption, 90)}”` : (p.img ? 'a photo' : 'an update');
    return {
      title: '📸 ppc — proof drop',
      body: `${USER_NAMES[o]} posted ${what}${p.habit && HMF[p.habit] ? ` · ${HMF[p.habit]}` : ''}${news.length > 1 ? ` (+${news.length - 1} more)` : ''}`,
    };
  });
}
console.log(`done — ${sent} notification(s) ${DRY ? '(dry run)' : 'sent'} at ${tk} ${Math.floor(nowMin / 60)}:${String(nowMin % 60).padStart(2, '0')} ${cfg.tz}`);
