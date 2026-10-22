# `window.Cade` — full API reference

The single global that feature modules use. Defined at the top of the main
`<script>` in `txt.html`. All accessors are **late-bound** (they resolve core
handles at call time), so a module may call any of these from inside its
callbacks even though it loaded before/after various core pieces.

## Registration

### `Cade.registerWidget(widget)`
Adds a launchable widget to the Ctrl+K palette.
```ts
widget = {
  name: string,          // REQUIRED. palette label; also the dedupe key
  description?: string,  // palette subtitle
  icon?: string,         // emoji or inline "<svg ...>...</svg>" string
  tags?: string,         // comma-separated fuzzy-search keywords
  open: () => void,      // REQUIRED. invoked when the user selects it
}
```
Typical `open()` toggles a `Cade.mkPanel(...)`. The widget object may carry extra
fields freely.

### `Cade.registerScript(source: string)`
Registers a Ctrl+K text-transform. `source` is a string:
```
/**
  { "name": "...", "description": "...", "icon": "...", "tags": "..." }
**/
function main(ctx) { /* read/write ctx.fullText / ctx.selection */ }
```
`main` may be `async function main(ctx)`. Inside `main` you have globals:
`window`, `document`, `ctx`, `showToast` (and for async: `secureKeywordPrompt`,
`encryptText`, `decryptText`).

**`ctx`:** `ctx.fullText` (get/set whole doc), `ctx.selection` (get/set the
selection / current line; `''` when the cursor is on an empty line), `ctx.text`
(get effective input).

### `Cade.registerPlugin({ id, ext })`
Injects a CodeMirror 6 extension into the live editor and keeps it across room
switches.
- `id: string` — **must equal the module's manifest `id`** (used by the on/off
  toggle to re-activate).
- `ext` — any CM6 extension: a `ViewPlugin`, `Cade.CM.keymap.of([...])`, a state
  field, or an array of these.

### `Cade.registerSetting(def)`
Adds a Settings entry. (Plugins usually get one auto-created from `settingKey`.)
```ts
def = {
  key: string,                 // storage key, e.g. "myfeature.enabled"
  label: string,
  type: 'toggle'|'select'|'text'|'number',
  default?: any,
  section?: 'Appearance'|'Editor'|'Behavior'|'Plugins'|string,
  hint?: string,
  options?: { value, label }[], // for type:'select'
  apply?: (value) => void,      // called on change AND once at registration
  getState?: () => any,         // proxy a value owned elsewhere (then not persisted here)
}
```

## Core handles

| Accessor | Is |
| --- | --- |
| `Cade.editor` | the CodeMirror `EditorView` (live editor) |
| `Cade.CM` | `window.__CM6__`, the CodeMirror exports (see below) |
| `Cade.store` | synchronous KV store (localStorage-backed, chunked) |
| `Cade.idbStore` | async IndexedDB store for large blobs |
| `Cade.Settings` | settings registry/get/set/onChange |

### `Cade.store` (sync)
`get(key) -> string|null`, `set(key, val)`, `remove(key)`,
`keys() -> string[]`, `sizeOf(key) -> bytes`. Values are strings — JSON-encode
objects yourself. Namespacing convention: `cade-<feature>-<thing>`.

### `Cade.idbStore` (async, Promises)
`get(key)`, `set(key, value) -> Promise<boolean durable>`, `remove(key)`,
`keys()`. Use for image/byte payloads, not small prefs.

### `Cade.Settings`
`get(key)`, `set(key, value)`, `onChange(key, cb) -> unsubscribe`. See
`registerSetting` for adding entries.

### `Cade.CM` exports (`window.__CM6__`)
`Decoration`, `WidgetType`, `ViewPlugin`, `Compartment`, `EditorState`,
`EditorView`, `basicSetup`, `highlightActiveLine`, `highlightActiveLineGutter`,
`history`, `keymap`, `lineNumbers`, `redo`, `undo`.

State, range and gutter primitives (same API as `@codemirror/state` /
`@codemirror/view`):
`StateField`, `StateEffect`, `Facet`, `Prec`, `RangeSet`, `MapMode`,
`GutterMarker`, `gutter`, `gutterLineClass`. They are the inlined bundle's
minified identifiers, so feature-detect them (`if (CM.StateField) …`) and
keep a fallback where cheap. Notes:
- A `StateField` can hold decorations that must map through edits or replace
  line breaks (`provide: f => EditorView.decorations.from(f, v => v.deco)`).
- `gutterLineClass.from(field, v => rangeSetOfMarkers)` adds a marker's
  `elementClass` to every gutter element of a line — the way to tag line
  numbers without adding a gutter column. A new `gutter({...})` column lives
  inside `.cm-gutters`, which the core hides wholesale when line numbers are
  off, so give such features a non-gutter fallback.
- ES5 subclass of `GutterMarker`: `var M = function () {}; M.prototype =
  Object.create(CM.GutterMarker.prototype); M.prototype.constructor = M;
  M.prototype.elementClass = 'x'; M.prototype.eq = function (o) { return o instanceof M; };`

Common usage:
- Decorations: `Cade.CM.Decoration.mark({ class })`, `.replace({})`,
  `Decoration.set(ranges, true)`.
- View plugin: `Cade.CM.ViewPlugin.fromClass(Class, { decorations: v => v.decorations })`.
- Keymap extension: `Cade.CM.keymap.of([{ key: 'Mod-k', run: view => {...} }])`.
- Scroll: `Cade.editor.dispatch({ effects: Cade.CM.EditorView.scrollIntoView(pos, { y:'start' }) })`.

## UI helpers

| Call | Does |
| --- | --- |
| `Cade.mkPanel(id, title, innerHTML)` | create/return a draggable, closeable floating panel; set `panel._onClose = fn` for cleanup. Calling again with the same `id` returns the existing panel. |
| `Cade.showToast(msg, type, ms)` | toast; `type` ∈ `'info'`/`'success'`/`'error'` |
| `Cade.haptic(ms)` | vibrate (no-op where unsupported) |
| `Cade.escapeHtml(s)` | HTML-escape a string |
| `Cade.closeAllMenus()` | close open header menus / workspace dropdown |

## Lifecycle + assets

| Call | Does |
| --- | --- |
| `Cade.onEditorUpdate(cb)` | register `cb(viewUpdate)` run on every editor update. Inspect `update.docChanged`, `update.selectionSet`, `update.viewportChanged`, `update.view`, `update.state`. |
| `Cade.offEditorUpdate(cb)` | unregister a callback added with `onEditorUpdate` |
| `Cade.roomText(name)` | Promise of another room's text (this device's copy, else the server's) — the active room returns the editor's text |
| `Cade.readOnlyExtensions()` | extensions for a read-only `EditorView` styled like the editor (wrapping, theme; no gutters) — Origami's mirror panes |
| `cade-room-switched` (event on `document`, `detail.room`) | fired after every room switch commits locally |
| `Cade.loadCSS(rel)` | inject `<link>` to `rel` resolved against the module folder. **Call at module-load time** (the folder context is only valid then). Deduped. |
| `Cade.baseURL()` | the current module's folder URL, e.g. `./txt/widgets/snake/` |
| `Cade.asset(rel)` | `baseURL() + rel` — URL for an image/font/etc. in your folder |

## Commands & editor context

For alternative launchers (e.g. the `slash` plugin's "/" menu) and editor
plugins that need the core's own view of the document.

| Call | Does |
| --- | --- |
| `Cade.commands()` | array of `{ name, description, icon, tags, kind: 'widget'\|'script' }` — exactly the Ctrl+K palette's rows (deduped, lazy manifest stubs included). A fresh copy per call; cache it while a menu is open. |
| `Cade.runCommand(name)` | run a palette row by name (case-insensitive) with the palette's own semantics: a widget opens, a lazy module loads first, a script applies to the selection → current non-empty line → whole doc. Returns `false` if no row has that name. |
| `Cade.inCodeFence(pos)` | `true` when `pos` is inside a ``` fenced block (fence lines included), from the core's tracked fence state — O(log n), no doc scan. Current as of the last view update (plugins in the plugin compartment see this transaction's state). |
| `Cade.slashCodes()` | copy of the core's `"/code"` → symbol map (`{ '->': '➞', check: '✓', … }`). Codes are case-sensitive. |
| `Cade.claimSlash(fn)` | register `fn() → boolean`; while it returns `true` the core's `/code` autocomplete dropdown stays closed (so a module's own "/" menu doesn't get a second popup stacked on it). One claimant; pass `null` to release. |

## Widget preferences — `Cade.prefs(id)`

Per-widget / per-feature settings belong here, not in `registerSetting` (that
long Preferences list keeps only on/off toggles). The "Widget preferences…"
modal (View menu, or "Widget preferences" in Ctrl+K) shows one page per
module whose manifest entry has `"prefs"`, plus pages added with
`Cade.prefs.define`; it opens on the widget panel you touched last.

```jsonc
// manifest entry
"prefs": { "title": "Speed Reader", "fields": [
  { "key": "wpm", "type": "slider", "label": "Speed", "default": 350, "min": 100, "max": 1000, "step": 25, "unit": "wpm" },
  { "key": "ctx", "type": "toggle", "label": "Show surrounding text", "default": true, "hint": "…" },
  { "key": "dim", "type": "slider", "label": "Opacity around it", "default": 25, "min": 0, "max": 100, "step": 5, "unit": "%", "showIf": "ctx" }
] }
```
Field types: `text`, `textarea`, `number`, `slider`, `toggle`, `checkbox`
(multi → array), `radio`, `select`, `date` (`YYYY-MM-DD`), `time` (`HH:MM`),
`color` (`#rrggbb`), `heading` (no value). Keys: `key`, `type`, `label`,
`hint`, `default`; `min`/`max`/`step`/`unit`; `options: [{value,label}]`;
`placeholder`, `maxLength`; `showIf: "key"` / `"!key"` (a toggle).

```js
var P = Cade.prefs('speedreader');
P.get('wpm');                 // stored value, else the default — always valid for the schema
P.all();                      // { key: value } with defaults filled in
P.set('wpm', 400);            // validated (clamped / stepped / option-checked); false if rejected
var off = P.on(function (key, value, all) { … });   // set(), modal edits, reset, sync — call off() on close
Cade.prefs.open('speedreader');                     // the modal on that page (e.g. a ⚙ in your panel)
Cade.prefs.define('codeblocks', { title: 'Code blocks', icon: '⌨', description: '…', fields: [ … ] });
window.addEventListener('cade-prefs-change', e => e.detail /* { id, key, value } */);
```
Stored per device in `Cade.store` `cade-prefs:<id>` (only non-default values).
Each page has a "Keep in sync on all my devices" toggle (needs Sync): it is
account-wide (on/off on one device switches the others), synced pages travel
in `Cade.syncedBlob('prefs')`, last writer wins per page, and remote changes
fire `P.on` live. The panel→page match uses the widget name the panel was
opened under, else `panel.dataset.prefs`, else the panel id (`<id>` /
`<id>-panel`).

## Per-account synced JSON — `Cade.syncedBlob(id, {onChange})`

A small offline-first store that syncs across the account's devices when sync
is configured — the engine behind managed reminders, Calendar Events and RSS
subscriptions. Each blob is encrypted with the sync key and stored at
`rooms/__cade_blob_<id>_<keyFp>/blob` (under `rooms/*`, so **no Firebase
rules change is ever needed**). Whole-blob last-write-wins by timestamp,
echo-suppressed, 256 KB cap, fresh clients pull-before-push.

```js
var blobStore = Cade.syncedBlob('myfeature', {
  onChange(data, source) { /* a newer copy arrived from another device */ },
});
var data = blobStore.get();     // last known data (null if none yet)
blobStore.set({ ... });          // persists locally now, syncs debounced
```

Rules: `id` is a short `[a-z0-9-]` slug (unique per feature); keep the data
SMALL (encrypt+push runs on every set, debounced 800ms) and normalize
defensively in `onChange` — another device may run older code. Works fully
offline; catches up when creds + network appear.

## Room system — `Cade.roomsApi`

Late-bound surface over the live room/workspace state (never hold stale
copies; call again when you need fresh values). Used by e.g. the `calendar`
widget (daily-note rooms + per-day room activity). Room TEXT goes through
`read` / `write` / `onChange` / `watch` — the only safe way for a module to
change a room other than the open one.

| Call | Does |
| --- | --- |
| `roomsApi.list()` | array of room names (the tab list, copy) |
| `roomsApi.meta(name)` | `{pinned, archived, created, modified}` (may be `{}`) |
| `roomsApi.workspaceIds(name)` | workspace ids the room belongs to (array) |
| `roomsApi.workspaceById(id)` | workspace object `{id, name, color, …}` or `null` |
| `roomsApi.workspaces()` | all workspaces as `[{id, name, color}]` (copy) |
| `roomsApi.inWorkspace(name, wsId)` | membership test |
| `roomsApi.isPinned(name)` / `isArchived(name)` | flag tests |
| `roomsApi.modifiedAt(name)` / `createdAt(name)` | sort timestamps (ms, 0 if unknown) |
| `roomsApi.orderRooms(list)` | apply the user's room-sort preference to a list |
| `roomsApi.activeRoom()` / `activeWorkspace()` | current context |
| `roomsApi.setActiveWorkspace(id)` | switch workspace context (persists) |
| `roomsApi.switchRoom(name)` | switch to a room (async, may prompt for lock) |
| `roomsApi.ensureRoom(name)` | add a room to the tab list without switching (no-op if it exists / invalid; joins the active workspace) |
| `roomsApi.read(name)` | Promise of the room's text: the editor for the open room, else this device's copy, else the server's. `null` when there's no such room or the text can't be read right now (offline and not on this device, a locked room) — `''` is a real, empty room |
| `roomsApi.write(name, text, opts?)` | Promise: change a room as if the user edited it (see below) → `{ text, changed, merged, open?, pushed?, pending? }` |
| `roomsApi.onChange(cb)` | `cb(name, text, info)` after a room's text changes here or arrives from another device, debounced (~400 ms per room). Returns `off()`. Costs nothing while nobody listens |
| `roomsApi.watch(names)` | keep this device's copies of these rooms fresh while you need them (follows each room's server version; a remote edit is fetched and reported through `onChange`). Returns `off()` — call it when hidden / closed |
| `roomsApi.WS_ALL` / `roomsApi.WS_UNLABELED` | sentinel workspace ids |

### Changing room text — `roomsApi.write(name, text, { reason, create, workspace, base })`

- **The open room** gets ONE editor transaction (`userEvent: 'input.api'`): the
  smallest change (common start and end kept, so the caret and scroll stay put),
  its own undo step, then the normal persist + broadcast path.
- **Any other room**: its local cache is updated (dirty against its synced base)
  and pushed — but only after reading the server copy: unchanged since the
  synced base → pushed; moved on → three-way merged (the merge lands in the
  cache first); a real conflict stays local and dirty, and the room's next
  reconcile (when it is opened) shows the merge screen. Nothing bypasses
  conflict handling. A sibling tab showing the room adopts it.
- `base` (optional) makes it a compare-and-swap: the text you last saw. Edits
  made since are merged with yours; if both changed the same lines it rejects
  with `code: 'conflict'` (and `err.current`, the room's text now).
- `create: true` makes the room if it doesn't exist (`workspace`: an id, `null`
  for none; omitted = the active workspace, like adding a room).
- `reason` is passed back in `onChange`'s `info.reason`, so you can tell your
  own writes from other changes.
- Text is stored with `\n` line ends (as the editor would).
- Rejects with `err.code`: `'invalid'` (bad name), `'no-room'`, `'locked'`
  (password room not unlocked here), `'read-only'` (open room, Read-only mode),
  `'busy'` (the open room is mid-reconcile — retry shortly), `'offline'`
  (a sync-only room, or text that only the unreachable server has),
  `'conflict'` (see `base`).

`onChange` info: `{ kind: 'text' | 'rename' | 'delete', source: 'editor' |
'api' | 'remote', reason?, from? }` — `'editor'` is the open room's own
persist (typing, and remote edits that landed in it), `'api'` a `write()`,
`'remote'` another device's edit to a room that isn't open (via `watch`) or a
reconcile result. A rename fires `(newName, text, { kind: 'rename', from })`
and then `(oldName, null, { kind: 'delete' })`; removing a room (here or on
another device) fires `kind: 'delete'` with `text` null. Used by the Folder
Mirror widget (`txt/widgets/mirror/`).

## Cross-module hooks (globals set by modules; feature-detect them)

| Hook | Set by | Does |
| --- | --- | --- |
| `window.__calAddEventFor(dateKey, title, 'HH:MM'?)` | `widgets/calendar` (on load) | opens Calendar Events on that day with the add form prefilled; the user reviews + saves. `false` for a bad `YYYY-MM-DD`. The widget is lazy: when the hook is missing, `Cade.runCommand('Calendar Events')` loads + opens it, then the hook exists. |
| `window.__calAgenda(dateKey)` | `widgets/calendar` | that day's events (copies) |
| `window.__cadeDateParse(text, now?)` | `plugins/datechips` | natural-language / absolute dates in `text` → `[{from, to, y, mo, d, time:{h,mi}\|null, rel, …}]` |
| `window.__cadeSpoilerToggle()` | `plugins/spoiler` | wrap / unwrap the editor selection in `\|\|…\|\|` |
| `window.__cadeTrInline` | `widgets/decodelab/decodelab-inline.js` (lazy: loaded by the `translate-blocks` chips and the "Translate to English" script) | on-device translation into a ```English block below the source (or ```Spanish … for a pair fence: ```English to Spanish, ```en>es, ```to Spanish): `translateAtCursor()` → Promise (rejects with a readable Error); chip API `statusAt / pressAt / consentAt / cancelAt(openFrom)`, `version` bumps on state changes |
| `window.__cadeHtmlPreview` | `widgets/htmlpreview/htmlpreview.js` (Live Preview, once loaded) | `openAt(pos)` opens / retargets the preview at an html / css block (the Code Runner's Preview chip — shows the page even when the view is set to Markdown), `isOpen()` |
| `window.__cadeMdPreview` | `widgets/htmlpreview/htmlpreview-md.js` (lazy, with marked) | Live Preview's Markdown renderer: `create(marked)` → `render(src, {embed, image})` → keyed blocks `{k, l, h}`, `shellDoc`, `staticDoc` |
| `window.__DecodeLabTranslate` | `widgets/decodelab/decodelab-translate.js` (lazy: Decode Lab, the Translate widget, the inline runtime) | the translator: `create({workerUrl, core})` → manager with `status(code, to)`, `download(code, onProgress, to)`, `translate(text, code, onProgress, to)` (`to` defaults to `'en'`; X → Y goes through English), `downloaded()`, `usage()`, `remove(code, 'from'\|'to'\|'both')`, `detect(text)`, `dispose()`; helpers `route`, `pairFromInfo`, `langFromName`, `LANGS` |

## Internal (loader-only — don't call from modules)
`Cade._setCurrent(ctx)`, `Cade._ctx()`, `Cade._configs`. The loader sets the
per-module context right before injecting your script; that's why `loadCSS` /
`asset` must be used during synchronous module load.

## Theme CSS variables (use these in module CSS)
`--bg`, `--surface`, `--surface-hover`, `--surface-2`, `--text`, `--text-muted`,
`--text-faint`, `--border`, `--accent`, `--accent-bg`, `--success`,
`--text-base`, `--text-sm`, `--text-xs`, `--font-mono`, `--space-1..4`. Theme is
toggled via `[data-theme="light"]` on `<html>` — scope light overrides with that
prefix.

## Game panels — `Cade.markGamePanel(panel)`
Call right after `Cade.mkPanel(...)` for arcade/action games. While any marked panel is
open the core blocks pointer input aimed at the editor, blurs the editor (the iOS soft
keyboard retracts) and disables text selection inside the panel. Released automatically
when the last marked panel is removed. Text-input games (e.g. the text adventure) and
puzzles that let you keep writing beside them should not use it.

## Minimized panels — `Cade.isMinimized(el)`
Every `mkPanel` panel has a Minimize button (–) beside ×: the panel is hidden (still in
the DOM, class `cade-minimized`) and waits as a chip in a dock at the bottom; the chip,
or running the widget's command again, restores it. While a game panel is minimized the
editor is usable again.
| Call / event | Does |
| --- | --- |
| `Cade.isMinimized(el)` | `true` when `el` (a panel or anything inside one) is minimized |
| `Cade.minimizePanel(p)` / `Cade.restorePanel(p)` | do it from code |
| `cade-panel-minimize` / `cade-panel-restore` | bubbling events dispatched on the panel |
| `panel.__cadeMinTo = 'footer'` | minimize into the footer as a live chip instead of the dock (falls back to the dock while the footer is hidden, e.g. zen); optional `panel.__cadeMinLabel = () => text` labels it, and the module may update `panel.__dockChip.textContent` while minimized (Weather shows the temperature) |
| `panel.__cadeMinimize = fn` | take minimizing over entirely (the Timer removes its panel and keeps running as its own footer chip) |

Modules with GLOBAL key handlers must return early (no `preventDefault`) while their panel
is minimized — otherwise they steal the user's typing — and real-time games should pause
on `cade-panel-minimize`. Guard with `Cade.isMinimized && Cade.isMinimized(panel)` (an
older cached core may load a newer module).

## Room lock — panels that show the open note
Panels whose content *is* the open note (Kanban, Eisenhower, Outline, Text Stats, Live
Preview) can be locked to one room. A lock button appears in the header in Origami (and
stays once locked); it pins the panel to the room open now. While another room is open
(another Origami pane is live, Ctrl+P…), a locked panel keeps showing its room, a bar says
so, input to it is held back (so nothing edits the wrong note), and a tap brings its room
back — in Origami by making that room's pane live, without focusing the editor. The lock
is remembered per widget; reopened while its room isn't open, the panel's content stays
hidden until it is.
| Call / event | Does |
| --- | --- |
| `Cade.roomLock(panel)` | opt a panel in (call right after `mkPanel`) |
| `Cade.roomAway(panel)` | `true` while locked to a room that isn't open — skip refreshes then |
| `Cade.lockedRoom(panel)` | the locked room, or `null` |
| `Cade.focusRoom(name)` | bring a room up to edit (Origami pane, else a room switch) → `Promise<boolean>` |
| `cade-panel-room` | dispatched on an opted-in panel whenever its room is the open one again (a room switch while unlocked, its room coming back, unlocking) — refresh on it |

## Pop out — a panel in its own window (desktop)
Every panel header has a pop-out button on desktop (hidden on touch screens and game
panels). Chrome / Edge open an always-on-top Picture-in-Picture window; other browsers a
pop-up window. The panel's DOM moves there with its listeners and state; stylesheets
(including ones loaded later) and the theme are mirrored. Closing that window, or the
button again, brings it back; the panel's × closes both. `document.getElementById` also
finds a popped-out panel and its contents. Caveats for modules: handlers on the app's
`document` / `window` (keys, resize) don't see events in the other window, and an iframe
reloads when it moves (listen for `message` on `panel.ownerDocument.defaultView`).
| Call / event | Does |
| --- | --- |
| `Cade.popOut(panel)` / `Cade.popIn(panel)` | do it from code (`popOut` needs a user gesture) |
| `Cade.isPoppedOut(panel)` | `true` while it lives in its own window |
| `cade-panel-popout` / `cade-panel-popin` | bubbling events dispatched on the panel after the move |

## Storage — `Cade.storage`
| Call | Does |
| --- | --- |
| `Cade.storage.openManager()` | open the core "Manage Storage" dialog (per-room offline cleanup) |
| `Cade.storage.openFileManager()` | open the core "Attached Files" manager |
| `Cade.storage.keyFingerprint()` | `Promise<string\|null>` — the sync key's Firebase path fingerprint (`images/<fp>`, `files/<fp>`), `null` without sync |

Core modals (`.modal-overlay`) render below floating panels — close your panel before
opening them.

## Service worker: `cache: 'no-store'`
`fetch(url, { cache: 'no-store' })` bypasses the service worker entirely (nothing is
stored in the versioned `cade-vN` cache). Use it for live data and for assets a module
keeps in its own Cache Storage bucket (e.g. `cade-convert-v1`, `cade-tts-hd-v1`).

## Cade.ai — your own model, from any device (opt-in)

Registered by the AI widget (`txt/widgets/ai/`) once it has loaded. Nothing answers until the user has set AI up: either "This computer" (a local Ollama / LM Studio / OpenAI-compatible server) or "Another of my devices" (a device sharing its model through Sync, end-to-end encrypted with the sync key).

- `Cade.ai.status()` → Promise `{ available, via: 'local' | 'host' | null, host, model, reason, message, setup }`
- `Cade.ai.chat(messages, { model, temperature, maxTokens, signal, onToken(delta, full) })` → Promise of the full answer. `messages` may be a string; the AI preferences' system prompt is added when none is given. Rejects with an Error carrying `.code`, `.info { title, steps }` and `.partial` (text received so far).
- `Cade.ai.models()` → Promise of the model names of whatever would answer.
- `Cade.ai.open()` opens the AI panel.
