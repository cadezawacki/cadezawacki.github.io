# Cade.project IDE Tracker

An IntelliJ plugin that records what the IDE was actually used for and hands
each work session to [Cade.project](https://cadezawacki.github.io/project/) as
tracked time and a planner block.

Two halves that never share a process:

```
IntelliJ plugin (Kotlin)              cade.project (JS, ../project)
├─ ActivityMonitor   state machine    ├─ ide.js    drains the queue
├─ SessionBuilder    aggregation      ├─ app.js    inits it
├─ CadeCrypto        CP1 envelope     ├─ state.js  two link fields
├─ CadeClient        REST + queue     └─ rules     one path
└─ listeners/        IDE signals
```

Transport is the Firebase Realtime Database REST API, into an append-only
queue at `ide/<fp>/q/<uuid>`. The plugin never touches `cade/<fp>`: it is not
a participant in sync.js's merge protocol, which is the whole point. It hands
work over a queue, and the app owns the write.

## Setting it up

1. **Publish the rule.** Add `ide` to the database rules — see
   [`../project/FIREBASE_RULES.md`](../project/FIREBASE_RULES.md). Confirm it
   before writing any Kotlin:

   ```
   curl -X PUT -d '{"hello":1}' 'https://<db>.firebaseio.com/ide/test.json'
   ```

   A 403 here means stop and fix the rules first.

2. **Build and install.**

   ```
   ./gradlew buildPlugin          # → build/distributions/cade-ide-tracker-0.1.0.zip
   ```

   Settings ▸ Plugins ▸ ⚙ ▸ Install Plugin from Disk. Or `./gradlew runIde`
   for a sandbox IDE with it already loaded.

3. **Configure.** Settings ▸ Tools ▸ Cade.project Tracker. The database URL
   and the *same passphrase Cade.project syncs with* — the passphrase is the
   key and the address both, so a mismatched one writes ciphertext nobody can
   read to a path nobody reads, with no error on either side. **Show
   fingerprint** prints the path segment so you can compare it against the
   app's, and **Test connection** writes a throwaway record and reports the
   status code verbatim.

4. **Prove the pipe.** Tools ▸ Cade.project Tracker ▸ Send Test Session. A
   ten-minute block should appear on today's planner in the app within a
   moment. Nothing about the state machine is involved yet, which is the
   point of doing it in this order.

The passphrase goes to `PasswordSafe`, never to `cade-tracker.xml` — that file
travels with Settings Sync and ends up in dotfiles repos by accident.

## The state machine

Everything else serves this.

| State | Enter when | Counts as |
|---|---|---|
| `ACTIVE` | focused and input within `softIdle` (120s) | work (active) |
| `READING` | focused, input within `hardIdle` (900s), a file open — or the debugger suspended, or a run/test process alive | work (reading) |
| `BACKGROUND` | unfocused, within `bgGrace` (180s) of losing focus | work, tagged |
| `IDLE` | anything else | nothing |
| `AWAY` | wall clock jumped by more than three ticks | nothing |

Two rules decide whether the numbers are honest:

**Retroactive trim.** Closing on idle ends the session at `lastActivity +
trimGrace`, never at `now()`. Without it every session is inflated by exactly
the idle threshold — silently, forever, and the totals look plausible the
whole time. It is the single reason hand-rolled trackers flatter their
authors.

**Gap detection.** The ticker compares elapsed wall clock against its own
scheduled interval. A 30-second tick that arrives forty minutes late means the
lid was closed. The span is discarded and the session closed retroactively.
(`nanoTime` corroborates on Linux and macOS, where `CLOCK_MONOTONIC` excludes
suspend; it is unreliable on Windows, so interval drift is the primary
signal.)

"Last activity" is the last *evidence* of work, which is not the same as the
last keystroke: a twenty-minute test suite you sat and watched produces no
input at all, and trimming that session back to the last key would end it
before most of the work it recorded — sometimes before its own start. Input
counts as evidence, and so does a live run/test process or a debugger sitting
on a breakpoint. A file merely left open does not.

Sessions are force-closed at 30 minutes and reopened, which bounds crash loss
and keeps records small.

Reading is work. A breakpoint you are staring at is work. A test suite you are
watching is work. Keystroke-only detection scores all three as idle and
undercounts a real day badly — hence the debugger and process signals, and
hence scrolling being tracked at all.

## Verifying it

```
node tools/parity/ingest.test.js                  # ide.js ingestion, 20 checks
KOTLINC_JARS=<dir> ./tools/parity/run.sh          # Kotlin → sync.js crypto parity
```

`run.sh` compiles the real `CadeCrypto.kt`, encrypts a record with it, and
decrypts that with the real `../project/sync.js` under Node, then compares
both fingerprints. Neither half is a reimplementation of the other — a parity
check whose two sides are both copies proves only that the copies agree. Use
`kotlinc` on `PATH`, or point `KOTLINC_JARS` at a directory holding
`kotlin-compiler-embeddable` and its dependencies.

`ingest.test.js` runs the real `../project/ide.js` against a stub `State`,
covering the sub-minute floor, the background switch, cross-tab dedupe, and a
session that runs past midnight.

`gradle verifyPlugin` runs the JetBrains Plugin Verifier over the built
artifact. Last run: **Compatible** against IC-243.28141.18, and eligible for
dynamic load.

## Tuning

Every log carries `closedBy` and the raw `activeSeconds` / `readingSeconds` /
`backgroundSeconds` split.

One thing to know before reading those numbers: reading credit accrues for up
to `hardIdle` after the last input, while the session's *span* ends at the last
evidence plus `trimGrace`. So on a day of long reading `readingSeconds` can
exceed the wall-clock span of its own planner block, by up to `hardIdle -
trimGrace`. That is the design — reading is work — but it is the reason to
look at the split rather than at the totals when deciding whether `hardIdle`
is set where you want it. Run a week, look at the histogram, and only then
touch a threshold. The defaults (120s soft, 900s hard, 180s background, 60s
trim) are WakaTime-ish and a reasonable prior, but reading-heavy days and
pairing days pull in opposite directions and only your own data settles it.

## Traps, ranked by how long they cost

1. **Retroactive trim.** Skip it and every session is +15 minutes, plausibly.
2. **The two salt encodings.** `SALT` is used as raw bytes for key derivation
   and as a JS-coerced decimal string for the fingerprint. Silent when wrong.
3. **Sleep detection.** One closed lid is one eight-hour session, and it looks
   great.
4. **Writing under `cade/<fp>`.** Correct, and it wakes every open tab on
   every heartbeat to re-decrypt the whole dataset.
5. **Heartbeat-granularity logs.** The app re-gzips, re-encrypts and re-uploads
   its entire dataset on every push. One log per session, not per heartbeat.
6. **Per-project services.** Two windows, both "active", sixteen hours in an
   eight-hour day. One app-level service arbitrates; OS focus is exclusive, so
   trust it.
7. **EDT I/O.** Listeners fire on every keystroke. Atomics, then return.
8. **A missing `Disposable` on the multicaster listeners.** Leaks one per
   plugin reload, and shows up only as an IDE that gets slower to type in.
9. **Deleting an undecryptable record.** That is a wrong-passphrase symptom,
   not a corrupt record. Deleting it destroys recoverable data; it stays
   queued.
10. **`localhost` HTTP as a transport.** cadezawacki.github.io is HTTPS, and
    mixed-content rules for `http://localhost` are browser- and
    version-dependent. Firebase is the reliable path.

## The wire format

`ide/<fp>/q/<uuid>` — the outer envelope carries no plaintext:

```json
{ "v": 1,
  "id": "9f2c…",
  "enc": "Q1AxA…",
  "at": { ".sv": "timestamp" } }
```

`enc` is `CP1` + iv(12) + ciphertext+tag, base64 — the identical format
sync.js uses. It decrypts (gzip → JSON) to the session record: device, ide,
project name and path, branch, start and end, the active/reading/background
split, up to forty files with seconds and edit counts, run/debug/test counts,
and `closedBy` (`idle` | `away` | `rollover` | `shutdown` | `disabled`).
