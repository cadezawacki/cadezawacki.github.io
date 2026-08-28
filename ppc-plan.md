# ppc.html — Cade & Avery Life Planner — Implementation Plan

Status: **planning complete — approved for implementation.**
Scope: new page `ppc.html` + small `sw.js` extension + `tools/ppc-make-login.mjs`. No card on index.html.

## Context

A shared, mobile-first, offline-capable planner at `cadezawacki.github.io/ppc.html`, syncing in near-realtime between two users via the existing Firebase RTDB (`https://cadetxt-default-rtdb.firebaseio.com`), gated by a nondescript single-input login that doubles as user identification (`cades` → Cade, `aves` → Avery). Three apps inside: **Shared Notes** (slimmed txt.html with per-line authorship colors), **House Remodel** (floorplan zones with budgets, item lists, layout builder, moodboards), and a gamified **Fitness Tracker**. The frame mirrors txt.html and reuses its proven subsystems (crypto, sync engine, store wrapper, CM6 editor, settings registry, mobile handling).

**Locked decisions:**
- Navigation: **header segmented tabs** in the menubar (Notes | Home | Fit) — purest txt.html mirror, no bottom dock.
- Firebase base path: **`rooms/__ppc`** — works under the existing DB rules with zero console changes (rules allow only `rooms/`, `config/`, `images/`, `files/`, `cade/`; txt.html already nests `rooms/__cade_ws_<fp>` this way and forbids user rooms starting with `__`). A single `PPC_BASE` constant keeps it movable.
- Fitness: **full duel scoring system** (points, sweeps, streak multipliers, duels, weekly showdown).
- **Login page is nondescript**: no app name, no couple names, no hints. Neutral glyph + one input + Enter. Failure notice: "That's not it." Neutral `<title>` ("ppc") pre-login; no app UI revealed until the gate passes.

---

## 1. File plan — ppc.html internal layout

Single self-contained HTML file (~620–660KB: CM6 bundle ~385KB + CSS ~35KB + app JS ~200KB), banner-commented sections:

```
<head>   viewport (user-scalable=no, viewport-fit=cover), theme-color, color-scheme,
         Fontshare link (same URL as txt.html — already SW-precached), neutral <title>ppc</title>
<style>  css-core (tokens/theme/frame/primitives) · css-notes · css-home · css-fit
<body>
  #login-screen  (nondescript gate; only thing visible until authed)
  #app (hidden)
    .menubar   [glyph logo] [Notes|Home|Fit segmented tabs] [⋯ per-app dropdown] [sync-dot] [theme]
    #screen-notes / #screen-home / #screen-fit  (one mounted at a time)
    .footer    clock · app stat · partner presence · sync mirror
  modals: settings, room manager, item editor, conflict, confirm, context-menu, status sheet
<script>  CM6 bundle — VERBATIM copy of txt.html (the single minified line + window.__CM6__ exports),
          with dated banner comment for future resync
<script src gstatic firebase-app-compat 9.23.0>      (already in SW PRECACHE_CROSS_ORIGIN)
<script src gstatic firebase-database-compat 9.23.0>
<script>  main IIFE:
  §00 util  §01 store (port: chunking/mem-fallback/quota sweep — sweep must ONLY evict ppc-* keys)
  §02 idbStore (port; DB_NAME 'ppc-blobs')  §03 crypto (verbatim port: deriveKey memoized,
      salt 'cade.txt-salt', magic CA DE 01 00, deflate-raw, encryptText/decryptText)
  §04 login  §05 fb core (init/.info/connected/REST/presence)  §06 KV channel
  §07 Blob channel (notes sync)  §08 images (resize pipeline port)  §09 shell (router/tabs/clock/theme)
  §10 settings registry (port; PREFIX 'ppc-pref:')  §11 notes  §12 home  §13 fit  §14 boot
```

**Editor decision: copy the CM6 bundle from txt.html.** Per-line full-background highlighting under soft wrap requires CM6 `Decoration.line({class})`; textarea-mirror and contenteditable alternatives are fragile on iOS. Ports come from txt.html: crypto (~9157–9310), sync/reconcile (~9400–10300: `_pushSig` 9452, `reconcileRoom` 10096, `_lineDiffOps` 10275), store (~3311–3507), image pipeline (~16708–16725), settings registry (~17238–17400), frame/theme CSS (30–124, 157–298, 905–931), mobile kit (visualViewport pinning 7177–7209, coarse-pointer rules 395–404, ≤600px block 1791–1865).

Theme: same tokens as txt.html (light `#fafaf9/#fff/#1c1917`, dark `#111110/#1a1918/#e7e5e3`, accent `#0f9598`), `data-theme` on `<html>`, key `ppc-theme`, default from `prefers-color-scheme`.

## 2. Firebase data model (all under `const PPC_BASE = 'rooms/__ppc'`)

```
meta/ {schema:1}
presence/ C|A/ {t:<ms>, page}                    # heartbeat 60s while visible + edges
notes/
  index/<roomId>/ {name, color, lastModified, createdBy}     # light: powers dropdown
  rooms/<roomId>/ {blob, v}                       # blob ENCRYPTED (txt wire format), v = txn counter
home/
  zones/<zoneId>/ {status, statusTs, statusBy, budgetMax, budgetTs, budgetBy}
  items/<zoneId>/<itemId>/ {title, desc, price, url, dims, img:<imgId>, by, createdAt, ts}
  builder/<zoneId>/shapes/<shapeId>/ {type:'box|circle|tri|draw|text', x,y,w,h,rot,fill,stroke,sw,
                                      text,fs, pts[], href:<itemId|null>, lx,ly, z, ts, by}
  mood/<zoneId>/<cardId>/ {kind:'url|img|text', url,title,desc,img,text, by, ts}
  img/<imgId>/ {d:<base64 ≤90KB>, by, ts}
fit/
  goals/ C|A/ {text, targetDate, ts}
  days/<YYYY-MM-DD>/ C/{med,str,exe,wrk:<ms>} A/{med,str,exe:<ms>}   # key present = done
  feed/<YYYY-MM>/<postId>/ {by, ts, img:<imgId|null>, caption, habit}  # month-sharded
  img/<imgId>/ {d, by, ts}
```

`zoneId` ∈ `terrace|kitchen|office|foyer|bedroom|living|bedcloset|hallcloset` (dining is stored and displayed as "office"). Users are `'C'|'A'`.

**Encrypted vs plain:** only `notes/rooms/*/blob` is encrypted (txt-compatible wire format — prose is the personal payload, and it makes txt.html's blob sync drop in unchanged). Everything else is plain JSON: fine-grained merge needs individual server-side fields, the threat model is anti-spam rather than secrecy, and the Firebase console stays debuggable. Shared key: `ENC_KEY = fbUrl + '|ppc1'` — both users derive it automatically; exactly as protected as the URL itself (i.e., by the login gate).

## 3. Sync engine

Init mirrors txt.html: `firebase.initializeApp({databaseURL}, 'ppc-'+seq)`; `.info/connected` + online/offline events + visibilitychange/pageshow resume (`goOffline();goOnline()` after ≥10s hidden) + REST reconcile bypass (`fetch(url+'.json',{cache:'no-store'})` to dodge SDK cache staleness after mobile sleep).

**Channel A — notes blob** (full txt.html semantics): 300ms local persist → `ppc-notes-cache:<roomId>` `{t,a,ver,dirty}`; 500ms broadcast; `_pushSig` echo-suppression ring of 8 noted before `.set()`; transaction-bump `v`; 15s push timeout; remote deferred while typing <4s, applied on a 500ms idle-check after ≥2s idle; dirty flags flushed per-room on the connect true-edge; `reconcileNotesRoom()` ports txt.html's decision tree (equal→synced / serverV≤localV→push / empty rules / containment→superset / else conflict modal with `_lineDiffOps` diff and keep-local / keep-server / keep-both — "keep both" appends server text under a `--- server copy ---` divider since rooms are shared).

**Channel B — KV** (all structured data):
- `KV.watch(relPath, cb)` → `on('value')`, snapshot cached to `ppc-kv-cache:<relPath>` for offline first paint; returns an unwatch fn; screens hold unwatch arrays.
- `KV.set(relPath, val)` → stamps `ts`/`by`, optimistic local render, `.set()` with 10s timeout; failure/offline → `ppc-pending-ops` queue (coalesced per path, FIFO replay on connect true-edge with an LWW guard: `once()` the target first, drop the op if `remote.ts > op.ts`).
- Write policy: discrete edits immediate; builder drags throttled 150ms + final commit on pointerup; text inputs (mood/goals) 500ms debounce.
- Renders are pure functions of state with a JSON-equality early-out — no echo problem except builder drag locks (§7).

**Listener lifecycle** (attach on mount / detach on unmount): notes → `notes/index` + open room blob; floorplan → `home/zones` + `home/items`; zone page → that zone's zones/items/mood (+ `builder/<z>/shapes` in builder); fit → `fit/days` limited `.orderByKey().startAt(<today−27d>)` + `fit/goals`; feed → current month only, older via `once()`. `img/*` is never watched — fetched by id via `once()`, cached in IndexedDB, uploaded through the `ppc-img-pending` queue.

**localStorage keys (all `ppc-`, no `cade-` collisions):** `ppc-user`, `ppc-fb-url`, `ppc-theme`, `ppc-pref:<key>`, `ppc-notes-room`, `ppc-notes-cache:<id>`, `ppc-pending-ops`, `ppc-img-pending`, `ppc-kv-cache:<path>`, `ppc-fit-timer-cfg`. Cross-tab: `BroadcastChannel('ppc-tabs')`. The store quota sweep is hard-guarded to only evict `ppc-kv-cache:*`/`ppc-notes-cache:*` — never `cade-*`.

## 4. Per-line authorship (Shared Notes)

- `authors` = a string of `C|A|B` chars, one per document line (length always === line count).
- **Maintained via CM6 changeset mapping** (`update.changes.iterChanges`) in a ViewPlugin — exact for typing, paste, join, split, undo. Resulting lines get `me`, or `'B'` if any replaced old line was the partner's or `'B'`; a join of differing authors → `'B'`; pasted lines → `me`.
- Fallback deriver for whole-doc replacements (conflict keep-both, cache restore): the ported `_lineDiffOps` — `=` keeps its author, `+` gets the editor, and a paired `-`/`+` where the removed line was the other's → `'B'`.
- **Wire:** `blob = encryptText(JSON.stringify({t:text, a:authors, by:ME, ts}), ENC_KEY)` — text and authors are atomic; remote arrives with its authors, no re-derivation. Degradation: missing `a` → fill with `by||'B'`; length mismatch → truncate/pad; non-JSON plaintext → all-`'B'`.
- **Render:** `Decoration.line` classes `auth-c|auth-a|auth-b`:
  ```css
  :root { --auth-c:#d9f1ef; --auth-a:#fce3e1; --auth-b:#e9e3f8; }
  [data-theme="dark"] { --auth-c:#0f2b28; --auth-a:#38201f; --auth-b:#2a2340; }
  ```
- Toggle `ppc-pref:notes.authorHighlight` (default on) via a Compartment reconfigure; legend chips (Cade / Avery / both) shown when on.

**Rooms:** dropdown sorted by `lastModified` desc, title text tinted by category `color` (8-color palette from txt.html ws tokens); manager modal = create/rename/delete/recolor; delete confirms and removes both the `index` node and the room node.

## 5. Login (nondescript gate)

```js
const LOGIN_CTS = [{ct:'<BASE64_CADES>', user:'C', name:'Cade'},
                   {ct:'<BASE64_AVES>',  user:'A', name:'Avery'}];
const FB_URL_RE = /^https:\/\/[a-z0-9.-]+\.firebaseio\.com\/?$/;
```
`tryLogin(raw)`: `trim().toLowerCase()` → `decryptText(ct, input)` for both ciphertexts → a non-null match of `FB_URL_RE` wins → persist `ppc-user` + `ppc-fb-url` → boot the app (skip the gate on future visits; a Logout row in Settings clears both). 2×PBKDF2-100k ≈ 200–600ms on a phone; `deriveKey` is memoized. States: idle (autofocus, `enterkeyhint=go`, autocorrect/autocapitalize off) → checking (disabled) → fail (300ms shake, "That's not it.", text selected) → success (fade to app). **Screen shows only: a neutral glyph, the input (placeholder `···`), and an Enter button. Nothing else.** After 3 consecutive fails, microcopy "ask the other one".

**Generator `tools/ppc-make-login.mjs`** (Node ≥18, run once, paste output into `LOGIN_CTS`): PBKDF2(salt `'cade.txt-salt'`, 100k, SHA-256) → AES-GCM over `deflateRawSync(url)` → `[CA DE 01 00][iv 12][ct]` base64 — byte-compatible with the page's `decryptText`. Verify both usernames decode and garbage fails before shipping.

## 6. Shell / navigation (header tabs)

- Frame: `body{position:fixed;inset:0;flex column;overflow:hidden}`; `.menubar` 36px+safe-area-top; `.footer` 18px+safe-area-bottom — txt.html CSS ported.
- Menubar: `[glyph] [Notes|Home|Fit segmented control] [⋯ dropdown] [sync-dot] [theme]`. ≤480px: icons + short labels (inline SVG icons, not emoji). The `⋯` dropdown content swaps per route (Notes: New room, Manage rooms, Highlighting; Home: legend/budgets; Fit: Goals, Tools, Feed). Pure-CSS-class dropdown pattern from txt.html.
- Routing: hash-based — `#notes(/roomId)`, `#home`, `#home/<z>`, `#home/<z>/build`, `#fit`, `#fit/feed`, `#fit/tools`. `router()` unmounts (unwatch all + clear drag state) then mounts; the back button works natively on mobile. Default route: `ppc-pref:ui.lastApp`.
- Footer: clock (modes via `ppc-pref:ui.clockMode`, tabular-nums) · app stat (Notes: room + lines; Home: `$spent/$budget`; Fit: `n/m today`) · partner presence dot ("A · 2m" when `presence.<other>.t` < 5min) · sync-state mirror.
- Mobile kit: per-control `-webkit-tap-highlight-color:transparent`, `touch-action:manipulation`, 16px inputs ≤600px (no iOS zoom-on-focus), `pointer:coarse` min-heights ≥40px, visualViewport height/top pinning (notes + input modals; never CSS transforms), `user-select:none` on chrome only.
- SW registration: txt.html pattern (`register('./sw.js')`, SKIP_WAITING on waiting/updatefound, `online` → REFRESH_CACHE).

## 7. House Remodel

**Floorplan (`#home`):** `<svg viewBox="0 0 1206 1400">` with `<image href="assets/floorplan.jpeg">` + one `<g class="zone">` per zone containing traced polygons (a `ZONES` constant; fine-tune vertices visually in M3 — data-only tuning). The bedroom-closet zone renders its 2–3 "cl."+lin.cl. cells as one hit target; closets get invisible fat-stroke hit expansion (`stroke-width:14; stroke-opacity:0`). Status → fill at 28% opacity + 2.5px stroke: `none` #9ca3af · `planning` #8b5cf6 · `active` #eab308 · `blocked` #dc2626 · `done` #16a34a. A total-spent chip (Σ all item prices — derived, never stored) floats over the plan. Tap a zone → `#home/<z>`.

**Zone page:** status pill (tap → 5-option sheet) + sections as a segmented row (Budget · List · Builder · Mood):
1. **Budget:** CSS bar, `spent = Σ prices`; `spent > max` → red `.over` segment + `+$N over` chip; tap the max label → numeric modal → `zones/<z>/budgetMax`; unset → "set budget" link.
2. **Official List:** cards (thumb · title · price · desc/dims · "added by X"); `+` opens a modal with From-URL and Custom tabs; everything editable afterwards; title is the only required field. **URL metadata chain** (static site, no backend): `api.microlink.io` (CORS-enabled free tier) → `api.allorigins.win/raw` + client-side OG-tag parse (`og:title/og:image/og:price:amount`) → graceful manual entry (title prefilled from the URL slug). 6s timeout per hop, spinner, never blocks manual entry.
3. **Builder (`#home/<z>/build`, fullscreen):** an SVG-element editor (shapes are data objects; hit-testing, z-order, and co-editing come free). Stage viewBox = zone bbox + 40px pad (the crop itself), the full floorplan `<image>` behind a theme-aware dim overlay. Bottom toolbar: select · box · circle · triangle · text · freedraw · eraser · fill/stroke swatches (txt.html 8-color tokens) · stroke width. Coordinates live in floorplan px. Selection → move (body drag), 4 corner resize handles, rotate handle; pointer events with `setPointerCapture`, fat invisible hit circles (r=18); `touch-action:none` on the stage. **Warp:** move/resize/rotate for all shapes; boxes/triangles additionally convert to polygons on corner-handle drag for true free warp (circles stay affine). Freedraw: ≥4px point spacing, Catmull-Rom live path, Douglas-Peucker simplify (ε=1.5, cap 400 pts) on release; eraser = whole-stroke delete (other shapes delete via the context menu). Long-press 500ms (cancel on 10px move) / right-click → context menu: Delete · Bring to front · Send to back · Forward · Backward · Link to item… · Edit text · Unlink. `z` floats (front=max+1, back=min−1, forward/backward=neighbor midpoint, re-spread when gaps <1e-6); render order = sort by z. **Linked datalabel:** the item title inside the shape if it fits 80% of the bbox (measured via a hidden `<text>`), else a callout line to a draggable label at `(lx,ly)`; a deleted item renders "(removed)". Sync: per-shape nodes, 150ms drag throttle + commit on release; a `dragLock` set holds remote updates for locally-manipulated shapes until pointerup (then LWW by ts). Scale ruler: `PX_PER_FT ≈ 26` (re-calibrate from the final trace against bedroom 14'0"), a 5ft bar bottom-left, toggle `ppc-pref:home.showRuler`. Text-shape editing uses a modal input — never in-SVG editing (dodges iOS keyboard-over-canvas).
4. **Moodboard:** CSS-columns masonry (2 cols, 3 ≥700px). Cards: url (fetchUrlMeta preview) / img / text (inline-editable). Add via a `+` sheet AND a paste listener (image→img card, `https://…`→url card, other text→text card). Long-press → edit/delete.

**Images:** txt.html pipeline verbatim — maxDim 800, ≤90KB base64, AVIF→WebP→JPEG cascade; `imgId` = hash slice; IndexedDB cache + `ppc-img-pending` offline queue.

## 8. Fitness (full duel system)

```js
const HABITS = {C:['med','str','exe','wrk'], A:['med','str','exe']};  const SHARED = ['med','str','exe'];
```
Mark = `KV.set('fit/days/<date>/<U>/<h>', Date.now())`; unmark = remove (same day only). Local-date keys (same-household timezone — documented assumption). **Scoring — all derived client-side, deterministic, nothing stored:** habit 10pts · own-sweep +5 · streak = consecutive sweep days, multiplier `×(1+0.05·min(streak,10))`, flame at ≥3 · duel evaluated on closed days only (per shared habit: doer +3 / slacker −2; `wrk` is Cade-personal, no duel) · weekly showdown Mon–Sun: winner +25, tie +10 each, crown count per quarter.

Screens: `#fit` = Today checklist (big tap rows, partner column read-only alongside for ambient pressure), week grid (7×habits dots for both users, swipe to prior weeks), head-to-head weekly points bar, streak flames, goals card. `#fit/feed` = reverse-chron day-grouped posts (photo via the resize pipeline → `fit/img` + caption + habit tag), lazy image `once()` + IDB cache, "load earlier" fetches prior months. `#fit/tools` = countdown + stopwatch ported from `txt/widgets/timer/timer.js` (`performance.now()`, laps, cfg in `ppc-fit-timer-cfg`), `navigator.wakeLock` while running (silent skip where unsupported), countdown end → vibrate + flashing footer.

## 9. sw.js — exact edits

1. `const CACHE_VERSION = 95;` → `96`.
2. `PRECACHE`: append `'./ppc.html', './assets/floorplan.jpeg'`.
3. `navigationHandler`: replace `isAppShell` with
   `const shellMatch = url.origin===self.location.origin && url.pathname.match(/(^|\/)(txt|ppc)\.html$/);`
   `const shellKey = shellMatch ? './'+shellMatch[2]+'.html' : null;`
   and use `shellKey` for both the canonical `cache.put` and the offline-fallback match.

Nothing else: the firebaseio bypass, gstatic Firebase scripts, and Fontshare CSS are already handled. Microlink/allorigins calls are runtime-only and fail gracefully offline.

## 10. Settings (ported registry, PREFIX `ppc-pref:`)

`ui.clockMode` · `notes.authorHighlight` (default on) · `notes.fontSize` (15) · `notes.lineNumbers` (off) · `home.showRuler` (on) · `fit.weekStart` (Mon) · `sync.debug` (off; shows a log pane) · theme row (mirrors the toggle, key `ppc-theme`) · Logout row (Advanced).

## 11. Implementation milestones (each shippable; commit per milestone)

- **M1 Shell + login + SW:** frame, theme, header tabs, hash router with stubs, footer clock, nondescript login (run the generator, paste ciphertexts), settings modal, sw.js edits. *Verify:* cades/aves/garbage login paths; iOS safe areas; theme persistence; airplane-mode reload serves ppc.html from the SW; back button walks hash history; txt.html unaffected.
- **M2 Notes:** CM6 copy, blob channel, room index/manager/colors, authorship plugin + toggle, conflict modal. *Verify (two browsers):* convergence ≤1s idle; colors after my new lines / editing partner's line (→lavender) / a 50-line paste / join+split / undo; offline edit → reconnect flush; divergent edits → conflict modal; grep ppc code for accidental `cade-` key writes.
- **M3 Home (floorplan + zone + budget + list):** SVG overlay (tune `ZONES` against the real jpeg), status flow, budget bar + overflow, item CRUD + URL metadata chain + images. *Verify:* phone zone taps incl. closets; status sync <2s across browsers; microlink prefill on a real product URL; offline item add replays; spent-chip math.
- **M4 Builder:** shapes/transforms/warp, freedraw + eraser, context menu, layers, links + datalabels/callouts, drag sync. *Verify:* finger draw/resize/rotate; long-press menu; no page scroll on the stage; concurrent different-shape drags merge; same-shape LWW without ghosting; label inside vs callout.
- **M5 Moodboard:** cards, paste handlers, masonry. *Verify:* paste an image and a URL on the phone; long-press delete.
- **M6 Fitness:** days model, checklist, week grid, scoring/duel, goals, feed, timers. *Verify:* hand-check a fixture week's scores identical on both clients; tick/untick sync; camera-roll feed post; stopwatch survives backgrounding; countdown fires.
- **M7 Polish:** presence footer, sync-debug pane, quota-sweep guard test, final CM6-resync banner comment, full mobile pass.

## 12. Risks & mitigations

- **RTDB size:** 90KB image cap, month-sharded feed, id-referenced blobs, never watch `img/` parents; an Advanced storage report via shallow REST (`?shallow=true`).
- **iOS keyboard:** visualViewport pinning ported; builder text edits happen in a modal, never in-canvas.
- **Concurrent builder edits:** per-shape nodes + dragLock + LWW ts; worst case is a lost drag on the same shape — acceptable for two cooperating users.
- **Forgotten username:** deliberately no hints; "ask the other one" microcopy after 3 fails; the repo owner can regenerate ciphertexts.
- **Shared-origin storage beside txt.html:** all `ppc-*` keys; the sweep guard never touches `cade-*`; blobs live in the separate `ppc-blobs` IndexedDB.
- **CM6 drift:** verbatim copy + dated banner; only the stable `__CM6__` surface is used, so upstream txt.html changes don't break ppc until a deliberate re-copy.
- **Metadata APIs disappearing:** the fetch chain ends in manual entry — degrades, never blocks.
- **`rooms/__ppc` collision:** txt.html hides `__`-prefixed rooms and only touches `__cade_ws_*`/`__cade_blob_*`; ppc only touches `__ppc`; `PPC_BASE` makes a future move to a top-level `ppc/` (one-line rules addition) trivial.

## Key reference files

- `txt.html` — every ported subsystem (line refs in §1)
- `sw.js` — lines 14, 19–24, 208–241
- `project/FIREBASE_RULES.md` — the deployed rules shape justifying `rooms/__ppc`
- `assets/floorplan.jpeg` — 1206×1400 trace source + builder background
- `txt/widgets/timer/timer.js` — countdown/stopwatch port source
