# Firebase Realtime Database rules

Both apps share one database. **Cade.project's bridge introduces no new
top-level paths** — it reads and writes only under `rooms/`, which Cade.txt
already uses. If Cade.txt syncs today, the bridge needs one addition only:
`cade/`, for Cade.project's own dataset.

## The rules

Paste into **Realtime Database → Rules** in the Firebase console.

```json
{
  "rules": {
    "rooms": {
      ".read": true,
      ".write": true
    },
    "config": {
      ".read": true,
      ".write": true
    },
    "images": {
      ".read": true,
      ".write": true
    },
    "files": {
      ".read": true,
      ".write": true
    },
    "cade": {
      ".read": true,
      ".write": true
    },
    "ide": {
      ".read": true,
      ".write": true
    },
    "$other": {
      ".read": false,
      ".write": false
    }
  }
}
```

## What each path is for

| Path | Written by | Holds |
|---|---|---|
| `rooms/<room>/text` | Cade.txt, bridge | The room document, encrypted. A plain string, or `{_chunks, parts}` when very large. |
| `rooms/<room>/v` | Cade.txt, bridge | Version counter, bumped on every write. |
| `rooms/<room>/locked` | Cade.txt | Whether the room has a password. The bridge **reads** this and refuses to write a locked room. |
| `rooms/<room>/verify` | Cade.txt | Password verification blob. |
| `rooms/__cade_ws_<fp>/blob` | Cade.txt, bridge | The workspace / room-list config. Deliberately under `rooms/` so it inherits these rules. |
| `rooms/__cade_blob_<id>_<fp>/blob` | Cade.txt | Share-link payloads. |
| `config/<fp>/workspaces` | Cade.txt | Where the workspace config used to live. Kept readable so older data still migrates. |
| `images/<fp>/<hash>` | Cade.txt | Out-of-document images. |
| `files/<fp>/<hash>` | Cade.txt | Attached files. |
| `cade/<fp>/{data,version,meta}` | Cade.project | Cade.project's own encrypted dataset. |
| `ide/<fp>/q/<id>` | The IDE plugin | Encrypted session records awaiting pickup. Drained and deleted by Cade.project. |

`<fp>` is a fingerprint derived from your passphrase — not the passphrase
itself, and not reversible into it.

## Why `ide/` is a sibling of `cade/` and not a child

The IDE plugin writes one encrypted record per work session, append-only,
each under its own id. That is deliberately *not* how `cade/` works: every
open tab subscribes to the whole of `cade/<fp>`, so a heartbeat written
underneath it would wake all of them and make each re-decrypt the entire
dataset. As a sibling it wakes only `ide.js`, which drains the queue, writes
the sessions into the normal `logs` and `planner` collections, and deletes
the nodes it has taken.

The plugin never reads or writes `cade/<fp>`. It is not a participant in the
merge protocol — it hands work over a queue and Cade.project owns the write.
Adding `ide` to the rules is the whole server-side change.

## Two things the rules must NOT do

**Do not type-constrain `rooms/<room>/text`.** A `.validate` of
`newData.isString()` looks reasonable and silently breaks large rooms: past
~8 MB the payload is written as a `{_chunks, parts}` object instead.

**Do not require auth.** Neither app authenticates — there is no sign-in
anywhere in either codebase. Rules demanding `auth != null` will reject
every read and write from both.

## "permission_denied"

If the browser console shows

```
FIREBASE WARNING: update at / failed: permission_denied
sync.js  Push error: Error: PERMISSION_DENIED: Permission denied
```

then the database is refusing to store Cade.project's data. Nothing is lost —
it is all still on the device — but it is not reaching the server, and so not
reaching your other devices. Cade.project now says so on the sync dot and on
**Data ▸ Firebase Sync**, with the fix, rather than only in the console.

Almost always the cause is a database that was set up for Cade.txt alone.
Cade.txt writes under `rooms/`; Cade.project writes under `cade/`, and rules
that grant the first and deny everything else refuse the second. Add:

```json
"cade": {
  ".read": true,
  ".write": true
},
```

publish the rules, and press **Reconnect**. The full set is at the top of this
file.

The IDE plugin fails the same way one path over. Rules that grant `cade` but
not `ide` make its queue writes return **403**, which the plugin reports in
its status bar (a growing queue depth) and in **Settings ▸ Tools ▸
Cade.project Tracker ▸ Test connection**, which prints the status code
verbatim. The browser console says the read half of it:

```
IdeLink: the database refused to read ide/<fp> — add the "ide" rule
```

Nothing is lost while this is broken: the plugin keeps unsent records on
disk and retries, and the queue drains once the rule is published.

Two rarer causes worth ruling out:

- **Rules requiring `auth != null`.** Neither app signs in, so every read and
  write is refused. See below.
- **A `.validate` on `rooms/$room/text`.** Also below — it breaks large rooms
  specifically, so most rooms work and the big ones do not.

## What this does and does not protect

Every payload is encrypted in the browser before it is sent, so the database
never sees your text, and neither does anyone who reads it.

Confidentiality is real; **availability is not**. Anyone who learns the
database URL can overwrite or delete the ciphertext even though they can
never read it. If that matters to you, the options are Firebase App Check,
or anonymous auth with `".read": "auth != null"` — the latter needs code
changes in both apps, which I have not made.

Keep regular backups either way: Cade.project's **Data ▸ Export Backup**
writes a plain JSON file.

## Existing rooms and workspaces

They fill in on their own.

- **Workspaces** and the **room list** come from storage shared with
  Cade.txt on the same browser, so they appear as soon as Cade.project
  opens. Every workspace becomes a project.
- **Room contents** need the room's text. Cade.txt only stores a room's text
  on a device once you have opened it there, so rooms created on your phone
  are not on your laptop. Cade.project fetches those from Firebase itself,
  25 at a time, and records them as synced.
- A room that has **never been synced from any device** has no document to
  fetch, so it stays listed as not fetched however often you rescan. Open it
  once in Cade.txt with sync on and it uploads.
- A room becomes a sub-project **only if it contains a todo list** — a line
  starting with `[ ]` or `[x]`. Prose rooms are left alone.
- **Password-locked rooms are skipped.** Their text uses a key derived from
  the room password, which the bridge does not hold.

**Data ▸ Cade.txt Link** lists what has linked, what is still being
fetched, and which rooms have no todo list. **Rescan now** forces a fetch
immediately instead of waiting for the next scan.
