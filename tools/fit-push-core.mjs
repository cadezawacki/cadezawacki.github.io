// The Wire — core pass shared by the GitHub Actions script (tools/fit-push.mjs)
// and the Cloudflare Worker (wire/src/index.mjs). Reads the RTDB over REST,
// decides which notification (if any) is due for each partner right now, and
// hands payloads to the caller's `send`.
//
// Design rules:
//  - silence is the reward: a finished day gets NO evening/last-call sends
//  - never send to someone who is in the app right now (fresh presence)
//  - one send per window per day, deduped through push/log; chat + feed are
//    continuous and watermarked in push/seen/<u> instead
//  - every derived event (wheel/noon/job/flash/quest/featured game) ports the
//    page's seeded kernel — keep the two in sync when either changes
//
// runWire({ db, base, now, dry, send, log, vapidPublicKey })
//   send(subscription, payloadJson, ttlSeconds) → resolves on delivery, throws
//   an Error with .statusCode on failure (404/410 = dead subscription).

export const DEFAULT_DB = 'https://cadetxt-default-rtdb.firebaseio.com';
export const DEFAULT_BASE = 'rooms/__ppc';

const USER_NAMES = { C: 'Cade', A: 'Avery' };
const OTHER = u => (u === 'C' ? 'A' : 'C');
const SHARED = ['med', 'str', 'exe'];
const HM = { med: 'Meditation', str: 'Stretch', exe: 'Exercise' };

export async function runWire(opts) {
const DB = opts.db || DEFAULT_DB;
const BASE = opts.base || DEFAULT_BASE;
const DRY = !!opts.dry;
const NOW = opts.now ? new Date(opts.now) : new Date();
const out = opts.log || console.log;
const outErr = opts.logErr || console.error;
async function dbGet(path) {
  const r = await fetch(`${DB}/${BASE}/${path}.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
}
async function dbPut(path, val) {
  await fetch(`${DB}/${BASE}/${path}.json`, { method: 'PUT', body: JSON.stringify(val) });
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
  // 🎲 Loaded Dice re-spins — mirrors ppc.html (one suffix per player who played it)
  const rr = ['C', 'A'].filter(u => playsFor(k, u).dice).length;
  let r = rand01('wheel:' + k + (rr ? ':r' + rr : '')) * WEDGES.reduce((a, w) => a + w[1], 0);
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

/* ---- arcade II seeded pieces (MUST match ppc.html) ---- */
function seededShuffle(arr, seed) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = seedHash(seed + ':' + i) % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const FLASH_POOL = ['20 jumping jacks', '15 squats', 'a 30-second plank', 'drink a full glass of water', '10 push-ups',
  'walk around the block', '1 minute of deep breathing', 'stretch your hamstrings for 60s', 'a 45-second wall sit',
  '20 lunges', 'stand up and shake it out for 30s', 'text your partner one thing you appreciate', '25 calf raises',
  'balance on one foot, 30s each side', '10 burpees', 'dance to one song', '5 sun salutations', '30 mountain climbers',
  'take the stairs twice', 'sit in a deep squat for 60s', '2 minutes of neck and shoulder rolls', 'a 20-second dead hang',
  '15 glute bridges', 'a cold splash of water on your face', 'hold a hollow body for 30s', 'drink water, then 10 squats'];
function flashSlots(k, epoch) {
  if (k < epoch) return [];
  const n = 1 + (rand01('flashn:' + k) < 0.55 ? 1 : 0) + (rand01('flashn2:' + k) < 0.3 ? 1 : 0);
  const starts = seededShuffle(Array.from({ length: 24 }, (_, i) => 9 * 60 + i * 30), 'flashs:' + k).slice(0, n).sort((a, b) => a - b);
  return starts.map((startMin, i) => ({ i, startMin, endMin: startMin + 40, task: FLASH_POOL[seedHash('flasht:' + k + i) % FLASH_POOL.length] }));
}
const QUESTS = [
  ['🚶', 'walk 20 minutes outside'], ['💧', 'drink 8 glasses of water'], ['🧗', 'take the stairs every single time'],
  ['🛏', 'in bed by 10:30 with no phone'], ['🥗', 'a vegetable with every meal'], ['🫁', '5 extra minutes of breathing'],
  ['📵', 'no phone for the first 30 minutes awake'], ['🍳', 'cook a meal from scratch'], ['🙆', 'stretch 10 extra minutes'],
  ['🏃', '5,000 extra steps'], ['🧹', 'tidy one whole room'], ['🌅', 'log a habit before 8am'],
  ['🚿', 'finish your shower cold (30s)'], ['🍬', 'zero added sugar today'], ['🥤', 'no caffeine after noon'],
  ['📖', 'read 15 pages'], ['🧠', 'learn one new thing and tell your partner'], ['💬', 'a real compliment, out loud'],
  ['🎧', 'walk with a podcast'], ['🪥', 'floss (yes, actually)'], ['🌳', '10 minutes in the sun'],
  ['🧴', 'sunscreen before you leave'], ['🍎', 'fruit instead of the snack'], ['⏰', 'up at the first alarm'],
  ['🦶', '2 minutes of balance work'], ['🧍', 'stand up every hour'], ['🏋️', '3 sets of anything, anywhere'],
  ['🥶', '1 minute of cold water on the wrists'], ['🍽', 'one meal with zero screens'], ['🧘', 'a 2-minute body scan before bed'],
  ['🚰', 'a full glass of water before coffee'], ['🪟', 'open the windows and air the place out'], ['🛒', 'no takeout today'],
  ['🧦', 'put the laundry AWAY, not on the chair'], ['🎵', 'dance to one full song'], ['🏞', 'a photo of something green outside'],
];
const COUPLE_QUESTS = [
  ['🤝', 'a 15-minute walk together'], ['🍳', 'cook dinner together'], ['🧘', 'meditate side by side'],
  ['🙆', 'stretch together for 10 minutes'], ['🎲', 'play one round of any game together'], ['📵', 'a phone-free dinner'],
  ['💌', 'write each other one line of thanks'], ['🛌', 'lights out at the same time'], ['🏃', 'work out at the same time'],
  ['🗣', 'tell each other your win of the day'], ['☕', 'coffee on the porch, no phones'], ['🧹', 'a 10-minute tidy blitz together'],
];
function questFor(k, epoch) {
  if (k < epoch) return null;
  const couple = rand01('questc:' + k) < 0.3;
  const pool = couple ? COUPLE_QUESTS : QUESTS;
  const [icon, text] = pool[seedHash('quest:' + k) % pool.length];
  return { icon, text, couple };
}
const questDone = (k, u) => !!(((A('quests')[k] || {})[u] || {}).done);
const VS_GAMES = ['react', 'taps', 'math', 'memory', 'hold', 'bar', 'simon', 'aim', 'hilo', 'dice'];
const GAME_NAMES = { react: 'Reflex', taps: 'Rep Race', math: 'Quick Math', memory: 'Memory', hold: 'Steady Hand', bar: 'Timing Bar', simon: 'Simon', aim: 'Pop', hilo: 'Hi-Lo', dice: 'Dice Duel' };
const gotd = k => VS_GAMES[seedHash('gotd:' + k) % VS_GAMES.length];
const gamePlayed = (k, g, u) => !!(((A('games')[k] || {})[g] || {})[u]);
function dareStatus(d) {
  if (!d) return 'gone';
  if (d.status === 'done' || d.status === 'declined') return d.status;
  if (d.dl && Date.now() > d.dl) return 'failed';
  return d.status || 'open';
}
const pendingDares = u => Object.values(A('dares')).filter(d => d && d.to === u && dareStatus(d) === 'open');
const flashClaimed = (k, i, u) => typeof (((A('flash')[k] || {})['s' + i] || {})[u]) === 'number';

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
const [days, cfgRaw, subsRaw, logRaw, presence, arc, prefs, seenRaw] = await Promise.all([
  dbGet('fit/days'), dbGet('fit/config'), dbGet('push/subs'), dbGet('push/log'), dbGet('presence'), dbGet('fit/arc'),
  dbGet('push/prefs'), dbGet('push/seen'),
]).then(r => r.map(x => x || {}));
const A = kind => arc[kind] || {};
const playsFor = (k, u) => (A('plays')[k] || {})[u] || {};
const cfg = { duelLose: 2, coupleEvery: 7, jobBonus: 25, arcadeEpoch: '2026-09-01', tz: 'America/New_York',
  pushMorning: '08:00', pushEvening: '19:00', pushLast: '21:30', ...cfgRaw };
const { dateKey: tk, min: nowMin } = localParts(cfg.tz);
// chat + feed are month-sharded by the phones' LOCAL month — same month key as the page
const [chatRaw, feedRaw] = await Promise.all([dbGet('chat/' + tk.slice(0, 7)), dbGet('fit/feed/' + tk.slice(0, 7))]).then(r => r.map(x => x || {}));
const epoch = cfg.arcadeEpoch;
const WINDOW = 30;   // matches the cron cadence
const inWindow = startMin => nowMin >= startMin && nowMin < startMin + WINDOW;
const freshFor = (u, ms) => !!(presence[u] && presence[u].t && Date.now() - presence[u].t < ms);
const fresh = u => freshFor(u, 5 * 60000);

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
      const q = questFor(tk, epoch);
      if (q) bits.push(`${q.icon} quest: ${q.text}`);
      const fl = flashSlots(tk, epoch);
      if (fl.length) bits.push(`⚡ ${fl.length} flash task${fl.length === 1 ? '' : 's'} (first ${fmtMin(fl[0].startMin)})`);
      bits.push(`🕹 featured: ${GAME_NAMES[gotd(tk)]} 2×`);
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
      let body = isSweep(days, tk, o)
        ? `${USER_NAMES[o]} swept at ${sweepTime(days, tk, o, cfg.tz)} — you have ${n} left${exp ? ` and −${exp} exposure` : ''}`
        : `${n} left tonight${exp ? ` · −${exp} exposure if the day ends now` : ''}`;
      const pd = pendingDares(u).length;
      if (pd) body += ` · 😈 ${pd} dare${pd === 1 ? '' : 's'} waiting`;
      if (questFor(tk, epoch) && !questDone(tk, u)) body += ' · 🗺 quest open';
      if (!gamePlayed(tk, gotd(tk), u)) body += ` · 🕹 ${GAME_NAMES[gotd(tk)]} unplayed`;
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
// ⚡ flash tasks — one send per window, to whoever hasn't claimed it
for (const f of flashSlots(tk, epoch)) {
  if (!inWindow(f.startMin)) continue;
  sends.push({
    slot: 'flash' + f.i,
    users: ['C', 'A'].filter(u => !flashClaimed(tk, f.i, u)),
    mk: () => ({ title: '⚡ FLASH TASK', body: `${f.task} — claim it in the app before ${fmtMin(f.endMin)}. First one in gets the bonus.` }),
  });
}
// 🏆 Monday morning: last week's result (the page mints fit/arc/weeks; we just announce)
{
  const sinceMon = (new Date(tk + 'T12:00:00Z').getUTCDay() + 6) % 7;   // days since this week's Monday
  const monK = addDaysKey(tk, -(sinceMon + 7));                            // last week's Monday
  const w = A('weeks')[monK];
  if (sinceMon === 0 && w && inWindow(parseHHMM(cfg.pushMorning, 480) + WINDOW)) {
    sends.push({
      slot: 'showdown',
      users: ['C', 'A'],
      mk: u => ({ title: w.winner ? `🏆 ${USER_NAMES[w.winner]} took the week` : '🤝 dead heat', body: `Cade ${w.c} · Avery ${w.a}${w.forfeit ? (w.winner === u ? ` — ${USER_NAMES[OTHER(u)]} owes you: ${w.forfeit}` : ` — you owe: ${w.forfeit}`) : ''}` }),
    });
  }
}
// 😈 a dare that has sat unanswered for 2h+ gets one poke
for (const u of ['C', 'A']) {
  const stale = pendingDares(u).filter(d => d.ts && Date.now() - d.ts > 2 * 3600000);
  if (stale.length) sends.push({ slot: 'dare-' + u, users: [u], mk: () => ({ title: '😈 a dare is waiting', body: `${USER_NAMES[stale[0].by]}: ${stale[0].text} — ${stale[0].stake || 0} coins on it. Accept or decline in Quests.` }) });
}
const wheelTomorrow = wheelFor(addDaysKey(tk, 1), epoch);
if (inWindow(20 * 60) && wheelTomorrow[0] !== 'vanilla') {
  sends.push({
    slot: 'wheel',
    users: ['C', 'A'],
    mk: () => ({ title: '🎡 the 8pm spin', body: `Tomorrow: ${wheelTomorrow[2]}. Plan accordingly.` }),
  });
}

/* ---- chat + feed: continuous, watermarked (not once-a-day slots) ---- */
const prefOn = (u, kind) => !(prefs[u] && prefs[u][kind] === false);
const seenMarks = {};   // path → ts to PUT after the loop
for (const u of ['C', 'A']) {
  const o = OTHER(u);
  const since = (seenRaw[u] && seenRaw[u].chat) || (Date.now() - 12 * 3600000);
  const msgs = Object.values(chatRaw).filter(m => m && m.by === o && typeof m.ts === 'number' && m.ts > since)
    .sort((a, b) => a.ts - b.ts);
  if (msgs.length && prefOn(u, 'chat')) {
    const last = msgs[msgs.length - 1];
    seenMarks[`push/seen/${u}/chat`] = last.ts;
    sends.push({
      slot: 'chat-' + u + '-' + last.ts, users: [u], freshMs: 2 * 60000,
      mk: () => ({ title: `💬 ${USER_NAMES[o]}`, body: String(last.t || '').slice(0, 140) + (msgs.length > 1 ? ` (+${msgs.length - 1} more)` : ''), url: './ppc.html#notes', tag: 'ppc-chat' }),
    });
  }
  const sinceF = (seenRaw[u] && seenRaw[u].feed) || (Date.now() - 12 * 3600000);
  const posts = Object.values(feedRaw).filter(p => p && p.by === o && typeof p.ts === 'number' && p.ts > sinceF)
    .sort((a, b) => a.ts - b.ts);
  if (posts.length && prefOn(u, 'feed')) {
    const last = posts[posts.length - 1];
    seenMarks[`push/seen/${u}/feed`] = last.ts;
    sends.push({
      slot: 'feed-' + u + '-' + last.ts, users: [u], freshMs: 2 * 60000,
      mk: () => ({ title: `📸 ${USER_NAMES[o]} posted`, body: (last.caption ? String(last.caption).slice(0, 140) : (last.img ? 'a photo' : 'something')) + (posts.length > 1 ? ` (+${posts.length - 1} more)` : ''), url: './ppc.html#fit/feed', tag: 'ppc-feed' }),
    });
  }
}

/* ---- dedupe, suppress, send ---- */
const log = logRaw[tk] || {};
if (!DRY && typeof opts.send !== 'function') throw new Error('runWire: send(sub, payload, ttl) is required unless dry');
let sent = 0;
for (const s of sends) {
  if (log[s.slot]) { out(`skip ${s.slot}: already sent today`); continue; }
  let any = false;
  for (const u of s.users) {
    if (freshFor(u, s.freshMs || 5 * 60000)) { out(`skip ${s.slot}/${u}: in the app right now`); continue; }
    const payload = { tag: 'ppc-' + s.slot, url: './ppc.html#fit', ...s.mk(u) };
    const devices = Object.entries(subsRaw[u] || {}).filter(([, d]) => d && d.sub && !d.dead);
    if (!devices.length) { out(`skip ${s.slot}/${u}: no live subscription`); continue; }
    for (const [dev, d] of devices) {
      any = true;
      if (DRY) { out(`DRY ${s.slot}/${u}/${dev}: ${JSON.stringify(payload)}`); sent++; continue; }
      try {
        await opts.send(d.sub, JSON.stringify(payload), 3600);
        sent++;
        out(`sent ${s.slot}/${u}/${dev}`);
      } catch (e) {
        outErr(`send fail ${s.slot}/${u}/${dev}: ${e.statusCode || e.message}`);
        if (e.statusCode === 404 || e.statusCode === 410) await dbPut(`push/subs/${u}/${dev}/dead`, true);
      }
    }
  }
  if (any && !DRY) await dbPut(`push/log/${tk}/${s.slot}`, Date.now());
}
// chat/feed watermarks advance whether we sent, or skipped because they were
// in the app (they saw it) — never on a DRY run
if (!DRY) for (const [path, ts] of Object.entries(seenMarks)) await dbPut(path, ts);
out(`done — ${sent} notification(s) ${DRY ? '(dry run)' : 'sent'} at ${tk} ${Math.floor(nowMin / 60)}:${String(nowMin % 60).padStart(2, '0')} ${cfg.tz}`);
return { sent, tk, nowMin, tz: cfg.tz };
}
