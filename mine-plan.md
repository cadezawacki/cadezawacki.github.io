# Cade.Mines — premium Minesweeper (as-built)

Status: **as-built**. This documents what shipped in `mine.html` + `mine/`,
how it mirrors the txt.html / ppc.html infrastructure, and where each piece
of the feature spec landed. Verified by 67 Node engine tests + 66 Playwright
browser tests at build time (suites live outside the repo; the engine is
re-runnable headless via `window.MINE`).

## Files

| File | Role |
|---|---|
| `mine.html` | The whole app, one file (~250 KB), §-sectioned like ppc.html |
| `mine/assets/modern/*.svg` | Default board art (flag, mine, boom, question) |
| `mine/assets/retro/*.svg` | Win3.1 nostalgia art pack |
| `mine/icon-180.png`, `mine/icon-512.png` | Flag-mark app icons (apple-touch + manifest) |
| `mines.webmanifest` | Install-to-homescreen manifest (standalone, cream) |
| `mine/README.md` | How to swap art / add packs |
| `tools/mine-make-login.mjs` | Regenerates the embedded login ciphertexts |
| `sw.js` | Bumped to v100; precaches mine.html, both art packs, icons + manifest, and mine's fontshare stylesheet; `mine` in the app-shell fallback regex |

## Infrastructure mirror (txt/ppc parity)

- **Offline**: registers `./sw.js` exactly like ppc.html (SKIP_WAITING +
  REFRESH_CACHE on reconnect). Page + art precached; plays fully offline.
- **Connect gate**: ppc scheme — the Firebase URL ships only as two AES-GCM
  ciphertexts (`LOGIN_CTS`); either existing access word decodes it. A raw
  `https://*.firebaseio.com` URL pastes in directly (txt.html style). The
  gate is anti-spam, not security; the game never requires it.
- **Crypto**: byte-identical wire format to txt/ppc
  (`base64(CA DE 01 00 · IV12 · AES-GCM(deflate-raw(text)))`, PBKDF2
  100k/SHA-256, salt `cade.txt-salt`). **Every Firebase value is ciphertext**;
  data key = `FB_URL + '|mine1'`.
- **Data layout**: everything under `rooms/__mine/…` so the existing DB rules
  cover it — `lb/<board>/<user>`, `daily/<date>`, `heat/<date>/<user>`,
  `players/<user>`, `trn/<code>`.
- **Sync points only**: no realtime listeners. Reads/writes happen at daily
  fetch, leaderboard view, game finish, tournament actions; the socket idles
  out ~25 s after the last op. Failed writes queue in localStorage and flush
  on `online` / next op (sync-on-reconnect).
- **Identity**: naive trusted usernames, no password/oauth (by design).
  `players/<userKey>` holds the encrypted profile snapshot; history merges by
  timestamp union so any device converges.

## Engine

- **Cell-graph boards**: every grid builds `{polygon, center, neighbors}`
  where neighbors = "shares ≥1 vertex" — one rule that yields 8-neighbor
  squares, 6-neighbor hexes, 12-neighbor triangles. Torus wraps the vertex
  keys so edges genuinely touch. Shape masks: analytic (circle, diamond,
  ring, heart, swiss gaps) and pixel-art (skull, cat, star, invader);
  the largest connected component survives masking.
- **Seeded boards**: board = pure function of `(spec, seed, start)`.
  Mulberry32 seeded by xmur3; share links (`#s=`) and challenges (`#c=`)
  carry the canonical spec, so everyone digs the identical field (shared
  boards fix a marked safe-start cell; fresh boards guarantee a safe first
  click by generating on it).
- **No-guess guarantee**: deterministic sub-seed retries until the tiered
  solver clears the board — tier 1 trivial counts, tier 2 subset
  elimination, tier 3 bounded component enumeration, tier 4 global
  mine-count endgame (with interior feasibility). Presets all land
  guess-free (extreme = 40×22/190 within ~120 tries, <200 ms). Failures
  fall back to best-effort and the board chip says "may need guesses".
- **Ratings**: complexity ★1–5 from solver tier depth + enumeration count +
  density; 3BV computed grid-agnostically.
- **Loss recap**: the same deduction engine replays the visible position at
  the fatal click and rules it a blunder ("provably a mine"), unforced ("N
  provably safe tiles existed") or a forced guess; all mines shown, wrong
  flags crossed.

## Gameplay (spec → shipped)

- Reveal / flag / question / chord with **remappable** mouse (left, right,
  middle, double) and touch (tap, long-press, double-tap) bindings; smart
  actions: middle = chord-on-number / ?-on-unopened, long-press =
  chord-on-number / flag-on-unopened. Chord both reveals satisfied numbers
  and flags saturated ones.
- Keyboard-only play: arrow-key spatial cursor + remappable
  reveal/flag/chord/? keys, P/N/±/0/Esc.
- Zoom/pan: wheel + pinch, drag with inertia, fit button, virtualized canvas
  rendering (bucketed culling + LOD) for huge boards (up to ~16 k cells).
- Undo: practice mode only (mine hits can be taken back there; nothing is
  recorded in practice). Rated play has no undo.
- Pause/resume with frozen timer and hidden board; auto-pause on
  blur/visibility loss; crash-safe autosave every move (debounced) +
  pagehide; saved games restore across sessions into a paused state.
- Practice mode: no timer, nothing recorded, undo allowed.
- Countdown mode: optional beat-the-clock on new boards — fixed budgets or
  Auto (~2.5s per 3BV point); the clock hitting zero is a loss.
- Presets easy/medium/hard/extreme + full custom builder (grid, size, mines,
  torus, shape, seed). The no-guess guarantee is always on.

## Scoring, stats, meta

- `score = difficulty · progress^1.5 · (1 + speed bonus)` — counts on losses
  too; difficulty from mines/density/grid/complexity. Skill rating is
  ELO-style vs board difficulty driven by 3BV/s efficiency.
- Local profile: per-difficulty best/avg/win-rate, streaks, 500-game
  history; trend graphs (time per difficulty, rating) on canvas; synced
  encrypted under the username.
- Leaderboards: all-time, per-preset best times (clean wins), per-day
  daily, per-seed challenge boards, continuous runs — one best entry per
  player per board.
- Daily challenge (one attempt per day, no retries): spec is a pure function of the UTC date (grids, shapes,
  weekend-bigger), stored get-or-create at `daily/<date>` (identical docs, so
  last-write-wins is invisible); offline players derive it locally and still
  match. Losses feed the day's **heat-map** (fatal tile, drawn over the real
  board silhouette) + fatal-move-number histogram, shown under the scores.

## Modes

- **Continuous**: seeded chained boards escalating in size/density/variety,
  ×1.15 compounding stage multiplier, run persistence, personal best +
  cloud run board.
- **Tournaments**: create (players, 1–5 seeded rounds, flavor) → 5-char code
  under `trn/<code>`; single-elim bracket decided by combined score through
  each tier, byes auto; async play, read-merge-write results, share via
  `#t=code`.
- **Async challenges**: "beat my time" links carry spec+seed+start+result;
  the recipient's finish compares head-to-head and posts to the seed board.

## Theming & design language

- Default light theme is a **cozy cream** — warm paper ground, ivory tiles
  (never pure white), soft warm shadows, muted warm number colors; dark is a
  warmed charcoal. Both are built over the attached palette (embedded
  verbatim as CSS tokens). Retro theme = Win3.1 homage (silver bevels, red
  LCD counters, classic number colors) that also swaps to the retro art
  pack; every soft-theme flourish below deliberately skips retro.
- **Typography**: Clash Display (fontshare) is the display voice — wordmark,
  panel titles, end-card headlines and the board numbers themselves (canvas
  preloads the face and repaints when it lands); General Sans stays the body,
  JetBrains Mono the numerals-in-tables. Retro keeps Tahoma everywhere.
- **Board depth**: raised ivory tiles cast real shadows onto an opaque board
  mat (soft drop shadow below, hairline edge on top); the revealed ground is
  a deeper linen, and both hidden and revealed cells alternate a ~2%
  two-tone checker by (col+row) parity — woven-cloth texture that also makes
  rows countable. Figure/ground: page → mat → open linen → raised tiles.
- **Motion**: staggered flood-reveal wave (numbers land instantly with their
  tile — no per-number animation, snappiness wins); hovered tiles lift toward
  you (eased, the cast shadow grows); planting a flag kicks up a dust puff; the win sweep
  rains themed confetti (paper strips + tiny flags + sparkles + dots — plain
  paper in retro); explosion shake + haptics. Countdown's final 10 seconds
  put a heartbeat on the clock and breathe a warm vignette at the stage
  edges. A fresh untouched board whispers "tap/click anywhere to begin" in a
  pill that fades on the first move. `prefers-reduced-motion` deliberately
  ignored; the Animations toggle kills all of it.
- **Sound**: a tiny synthesized WebAudio set (no samples, no network) — soft
  pock on reveal with a hush on big floods, thock on flag, whump + sine-drop
  on boom, warm G-major arpeggio on the clear, two-tone descent on timeout.
  On by default at a low mix; Settings → Sound turns it off. Engine-safe:
  every call no-ops without an AudioContext.
- **Branding**: the flag mark (brick pennant, charcoal pole) is the favicon,
  the wordmark prefix in the topbar + drawer, and the PNG app icons;
  `mines.webmanifest` installs the game standalone over the cream.
- **Chrome**: 3-column header grid (HUD truly centered), flat and
  shadow-free; minimal restart glyph tinted by game state (no smiley); thin
  cleared-progress hairline under the header; on phones (≤600px) a bottom
  action bar (New game / Daily / Ranks) sits in thumb reach.
- **Pickers**: preset cards carry live-palette mini-board thumbnails drawn at
  each preset's true proportions (the four cards read as a size/danger
  scale); shapes are chosen from silhouette chips rasterized from the real
  masks; grid types carry square/hex/triangle glyphs.
- **Leaderboards**: gold/silver/bronze medal chips on the top three, a
  hairline bar under every row showing how close it runs to the leader, and
  your own row tinted + outlined.
- `Renderer.setFlavor` offers a per-board palette overlay any mode can pass
  through `meta.flavor`; retro ignores flavors.

## Notes for future work

- `window.MINE` exposes the engine (newGame, solver, generators, crypto…)
  for console poking and headless tests.
- New art pack: folder under `mine/assets/` + register in `ASSET_PACKS`
  (§08) + add files to sw.js PRECACHE.
- New shape: add to `SHAPES`/`SHAPE_PX` (§05) — pixel art strings work as-is.
- Board size hard cap: 16 k cells (UI enforced) — solver budgets and the
  renderer LOD are tuned around that.
