# ARG Desk

A planning desk for an alternate reality game, inside cade.txt. Open it from the
**Ctrl+K** palette ("ARG Desk"). Esc or the **‹ Cade.txt** button returns to the editor.

It is a planning tool, not a live-ops tracker: the game it plans is published all
at once, for a small private group, with hints that are rare.

## What's in it

| Section | Route token | What it does |
| --- | --- | --- |
| Overview | `overview` | Readiness by chapter → event, "work on next", puzzle pipeline, problems, decisions, library glance, assets/renewals, history-vs-trail chart. A "get started" checklist for a new game. |
| Trail | `trail`, `trail.<P>` | The puzzle chain: chapters → event bands → puzzles, clue flow, critical path, pacing, a player-view scrubber ("what players know after …"), an editing inspector. |
| Codex | `chapters events puzzles clues characters places timeline assets questions tasks notes problems`, any id | A page per thing, with properties, links, backlinks, a fact check, and a chapter outline. |
| Library | `research`, `ideas` | Research links (to read → read → verified) and an ideas board (raw → exploring → used/parked) with "Promote to…". |
| Puzzle crafter | `crafter`, `crafter.<P>`, `crafter.scratch` | Cipher bench (steps, round-trip verification, frequency / shift / key-length analysis), solve path, design checks. |
| Export / Import | menubar | Any page, sequence, event, chapter, collection or the whole game as LLM-ready JSON or Markdown; paste an LLM's reply back with a reviewed diff and undo. A cade.txt room can be imported as a note. |

## Data model (v3)

`chapters → events → puzzles`, with clues, characters, places, timeline entries,
assets, research, ideas, questions, tasks and notes around them.

| Type | Ids | Notes |
| --- | --- | --- |
| chapter | `CH0`… | `n` orders them. |
| event | `E01`… | Sits in a chapter (`chapter`, `order`). Carries `layer`, `when`, `place`, `record` (what's real), `twist` (our fiction), `research`. `chapter: null` = not placed yet. |
| puzzle | `P01`… | Sits in an event (`event`); its `chapter` follows the event automatically. `requires` chains puzzles; `inputs` are clues; `recipe`, `solvePath`, `aha`, `checks`, rare `hints`. |
| clue | `C01`… | `plantedIn` an asset (or a puzzle when it's a solution output), `usedBy` puzzles. |
| character / place | `c-slug` / `pl-slug` | Real people carry a `guard` the desk shows everywhere. |
| entry (timeline) | `TL01`… | Dated facts; `revealedBy` the puzzle that shows them to players. |
| asset, research, idea, question, task, note | `AS01`, `R01`, `I01`, `Q01`, `T01`, `N01` | Notes are free text where `#ID`, `@Name` and `[[Name]]` link. |

Every claim sits on one of three **reality layers**: `record` (documented),
`pseudo` (real-world mysteries, contested and fringe claims) and `fiction` (ours).
The field schema lives in `Kit.FIELDS` (shared/kit.js); it is also what the LLM
export describes.

## How it's built

- `arg.js` / `arg.css` — the cade.txt widget. It opens a full-screen overlay
  holding a same-origin **iframe** (`desk.html`), so the desk's CSS and scripts
  never touch the editor. The iframe is created on first open and kept (hidden)
  afterwards. `window.__argDesk = {open, close, isOpen}` is the bridge.
- `desk.html` — the iframe page. Loads `shared/model.js` (vocabulary),
  `sample/sample.js` (the sample game), `shared/kit.js` (data + helpers),
  `shared/desk.js` (shell) and `views/*.js` (one file per section).
- Views register with `Desk.registerView({id, title, routes, mount})`; the mount
  returns `{update, unmount, exportScope, navToken}`. See the header of
  `shared/desk.js`. All edits go through `Kit.update / create / remove / batch`,
  which keep two-way links in sync (puzzle.event ↔ event.puzzles, puzzle.inputs ↔
  clue.usedBy, clue.plantedIn ↔ asset.carries, event.research ↔ research.supports).
- Navigation never writes browser history (the desk lives in an iframe and would
  otherwise hijack the app's back gesture); `Desk.back()` keeps its own stack.

## Storage and sync

Each game is stored in `Cade.syncedBlob` blobs, so it is encrypted and synced
across the account's devices with no Firebase rules change:

- `argdesk-games` — the list of games.
- `argdesk-<game>-meta` — the game's title/premise and how many shards each
  collection uses.
- `argdesk-<game>-<collection>-<n>` — `{items: {id: entity}, dead: {id: time}}`.
  A collection splits into more shards (by id hash) whenever one would pass
  ~110 KB of JSON, keeping every encrypted blob under cade.txt's 256 KB cap.

Every entity carries `_m` (modified) and `_c` (created) times. When another
device's copy of a shard arrives, it is merged **per entity** (newest `_m` wins,
deletions travel as tombstones), so editing different things on the phone and the
desktop never overwrites either. Deleted ids are never reused.

The sample game lives in its own slot (`sample`) and never touches a real game.
Opened outside cade.txt (`desk.html` on its own), the desk falls back to
`localStorage` keys `argdesk-local:*`.

## LLM format (`arg-desk/3`)

```json
{
  "format": "arg-desk/3",
  "game": { "title": "…", "premise": "…" },
  "scope": { "kind": "sequence", "label": "Sequence P02 → P05" },
  "task": "optional instruction for the LLM",
  "instructions": ["…how to read and how to reply…"],
  "layers": { "record": "…", "pseudo": "…", "fiction": "…" },
  "schema": { "puzzle": { "title": "text — Puzzle name.", "…": "…" } },
  "entities": [ { "id": "P04", "type": "puzzle", "event": "E04", "…": "…" } ],
  "referenced": { "P02": "puzzle · Estate Sale" }
}
```

An LLM replies in the same shape with only the entities it changes or adds. New
ones use ids like `NEW-1` (and refer to each other by them); the importer gives
them the next free ids, shows every change field by field, skips invalid values
with a warning, and applies only what you tick. Undo reverts the whole import.
A whole-game export is also a backup: importing it into an empty game restores
the same ids.

## Testing

Serve the repo (`python3 -m http.server`) and open
`txt/widgets/arg/desk.html` directly for fast work on the local backend, or
`txt.html` → Ctrl+K → "ARG Desk" for the real thing. All module files are in the
manifest's `precache` list, so the desk works offline once loaded.
