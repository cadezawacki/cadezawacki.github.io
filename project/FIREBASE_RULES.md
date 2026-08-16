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

`<fp>` is a fingerprint derived from your passphrase — not the passphrase
itself, and not reversible into it.

## Two things the rules must NOT do

**Do not type-constrain `rooms/<room>/text`.** A `.validate` of
`newData.isString()` looks reasonable and silently breaks large rooms: past
~8 MB the payload is written as a `{_chunks, parts}` object instead.

**Do not require auth.** Neither app authenticates — there is no sign-in
anywhere in either codebase. Rules demanding `auth != null` will reject
every read and write from both.

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
