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
| `roomsApi.inWorkspace(name, wsId)` | membership test |
| `roomsApi.isPinned(name)` / `isArchived(name)` | flag tests |
| `roomsApi.modifiedAt(name)` / `createdAt(name)` | sort timestamps (ms, 0 if unknown) |
| `roomsApi.orderRooms(list)` | apply the user's room-sort preference to a list |
| `roomsApi.activeRoom()` / `activeWorkspace()` | current context |
| `roomsApi.setActiveWorkspace(id)` | switch workspace context (persists) |
| `roomsApi.switchRoom(name)` | switch to a room (async, may prompt for lock) |
| `roomsApi.ensureRoom(name)` | add a room to the tab list without switching (no-op if it exists / invalid; joins the active workspace) |
| `roomsApi.WS_ALL` / `roomsApi.WS_UNLABELED` | sentinel workspace ids |

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
