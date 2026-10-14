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

Read-mostly, late-bound surface over the live room/workspace state (never hold
stale copies; call again when you need fresh values). Used by e.g. the
`calendar` widget (daily-note rooms + per-day room activity).

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
| `roomsApi.WS_ALL` / `roomsApi.WS_UNLABELED` | sentinel workspace ids |

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
