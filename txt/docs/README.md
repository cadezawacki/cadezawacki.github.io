# Cade.txt — Module Developer Guide

This guide explains **exactly** how to build and integrate a new **script**,
**widget**, **plugin**, or **config** for Cade.txt. It is written so that an
agent with **no prior context** can create a fully working, fully integrated
module by following it top to bottom.

> TL;DR for the impatient: copy a template from `txt/docs/templates/`, drop it
> under `txt/<kind>/<id>/`, add one entry to `txt/manifest.json`, bump
> `CACHE_VERSION` in `sw.js`, and syntax-check. Details + examples below.

---

## 1. What Cade.txt is (the 30-second model)

Cade.txt is a **single-file** static web app: the entire core (the CodeMirror 6
editor, Firebase sync, local storage, settings, the command palette) lives in
**`txt.html`** and is hosted as static files on GitHub Pages (`*.github.io`).
There is **no build step** and **no server** — everything is plain static files
loaded directly by the browser, and a service worker (`sw.js`) makes it work
offline as a PWA.

To keep `txt.html` from growing forever, **leaf features live in external files**
under `txt/` and are loaded at runtime. The app discovers them through a single
index file, **`txt/manifest.json`**, and exposes a small global API,
**`window.Cade`**, that modules use to register themselves and talk to the core.

Four kinds of feature module, plus a data/config kind:

| Kind | Lives in | Appears as | Loads |
| --- | --- | --- | --- |
| **widget** | `txt/widgets/<id>/` | a row in the **Ctrl+K** command palette | lazily, on first open |
| **script** | `txt/scripts/<id>/` | a row in the **Ctrl+K** palette (text transforms) | lazily, on first run |
| **script-pack** | `txt/scripts/<id>/` | MANY rows in the **Ctrl+K** palette from ONE file | lazily, when any of its rows first runs |
| **plugin** | `txt/plugins/<id>/` | a toggle in **Settings** | lazily, when enabled |
| **config** | `txt/configs/<id>/` | data / settings only (no palette row) | at boot (json) or on demand (js) |

**Eager metadata, lazy code:** the manifest carries each module's name/icon/etc.
so the palette can list it **without** downloading its code. The code is fetched
only when the user actually opens/runs/enables it.

**Hard rule:** the app must still launch from `txt.html` if `manifest.json` is
missing or broken. The loader fails silently in that case. Never make core depend
on a module.

---

## 2. File map (where everything is)

```
txt.html                      ← CORE. You rarely edit this. Defines window.Cade,
                                 the loader (bootModules), and buildEditorExtensions.
sw.js                         ← service worker. You bump CACHE_VERSION here.
txt/
  manifest.json               ← THE INDEX. Add one entry per module. (you edit this)
  docs/
    README.md                 ← this file
    cade-api.md               ← exhaustive window.Cade + __CM6__ reference
    templates/                ← copy these to start a module
      widget-template.js
      plugin-template.js
      script-template.js
  widgets/<id>/<id>.js (+.css)   ← your widget modules
  plugins/<id>/<id>.js (+.css)   ← your plugin modules
  scripts/<id>/<id>.js           ← your script modules
  configs/<id>/...               ← config json / settings js
```

Each module is a **folder** named by its `id` (e.g. `txt/widgets/snake/`),
containing `<id>.js` and an optional `<id>.css`, plus any assets (images, etc.)
in subfolders. Single-file modules are allowed but a folder is the convention.

Real, working examples to read and copy from:
- Widget: `txt/widgets/breakout/breakout.js`, `txt/widgets/snake/snake.js`
- Widget using the room system (`Cade.roomsApi`) + a synced blob: `txt/widgets/calendar/calendar.js`
- Widget with core shims + module-registered settings: `txt/widgets/timer/timer.js`
- Script pack (many scripts, one file): `txt/scripts/pack-lines/pack-lines.js`
- Plugin: `txt/plugins/code-highlight/code-highlight.js`
- Game with HUD/log: `txt/widgets/crawler/crawler.js`

---

## 3. The universal integration checklist

Every module, regardless of kind, is integrated by these **five steps**:

1. **Create the module file(s)** under `txt/<kind>/<id>/<id>.js` (+ optional
   `<id>.css`). The file is a single IIFE that calls a `Cade.register*` function.
2. **Add one entry** to the `"modules"` array in `txt/manifest.json` describing it.
3. **Bump `manifest.version`** (any new string) in `txt/manifest.json`.
4. **Bump `CACHE_VERSION`** in `sw.js` (e.g. `55` → `56`). *Required* — the service
   worker only re-precaches module files (for offline) when `sw.js` changes.
5. **Validate**: `node -e "new Function(require('fs').readFileSync('txt/<path>/<id>.js','utf8'))"`
   and `node -e "JSON.parse(require('fs').readFileSync('txt/manifest.json','utf8'))"`.

That's it. No `txt.html` edit is needed for a normal module.

---

## 4. Module anatomy (rules that apply to all kinds)

A module file **must** be:

```js
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;   // safety: core not present
  var Cade = window.Cade;

  // 1) If you have a stylesheet, load it HERE (at module-load time):
  Cade.loadCSS('<id>.css');

  // 2) ...define your feature...

  // 3) Register exactly once:
  Cade.registerWidget({ /* ... */ });   // or registerScript / registerPlugin / registerSetting
})();
```

**Critical rules (these cause real bugs if ignored):**

- **Wrap everything in an IIFE.** Modules share the global scope. A top-level
  `function main(){}` or `var x` would collide with another module. Keep all
  names inside the IIFE.
- **Call `Cade.loadCSS('<id>.css')` at the top of the IIFE, NOT inside a deferred
  callback** like a widget's `open()`. `loadCSS` resolves the path against the
  module's own folder using a context that is only valid **during synchronous
  module load**. By the time `open()` runs (later), that context has moved to
  another module and the CSS path would be wrong. (If you truly must load CSS
  later, capture `var BASE = Cade.baseURL()` at the top and build an absolute
  `<link>` yourself.)
- **Reach the core only through `window.Cade`.** Do not assume other globals
  exist. See the API in §9 / `cade-api.md`.
- **Clean up.** If you add `document`-level listeners or `requestAnimationFrame`
  loops, remove/cancel them when your panel closes (use the panel's `_onClose`).

---

## 5. How to build a WIDGET (step by step)

A widget is a launchable tool — usually a floating panel. It shows up in the
Ctrl+K palette and opens when selected.

### 5.1 Create `txt/widgets/hello/hello.js`

```js
/* Hello widget — minimal example. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('hello.css');               // optional

  function open() {
    Cade.closeAllMenus();
    // Toggle: if already open, close it.
    if (document.getElementById('hello-panel')) { document.getElementById('hello-panel').remove(); return; }
    // Cade.mkPanel(id, title, innerHTML) returns a draggable, closeable panel.
    var p = Cade.mkPanel('hello-panel', '👋 Hello', '<div class="hello-body">Hi from a module!</div>');
    // p._onClose runs when the user closes the panel — clean up here.
    p._onClose = function () { /* stop timers / remove listeners */ };
    // Use the editor if you want:
    // Cade.editor.dispatch({ ... });
  }

  Cade.registerWidget({
    name: 'Hello',                          // shown in palette + used for dedupe
    description: 'A tiny example widget',   // shown in palette
    icon: '👋',                             // emoji or inline <svg> string
    tags: 'example,hello,demo',             // comma list, used for fuzzy search
    open: open,                             // REQUIRED: called when selected
  });
})();
```

### 5.2 Optional `txt/widgets/hello/hello.css`

```css
.hello-body { padding: 12px; font-size: var(--text-sm); color: var(--text); }
#hello-panel { top: 60px; right: 12px; width: 220px; }
```

CSS uses the app's theme variables (`--text`, `--surface`, `--accent`,
`--text-muted`, `--border`, `--surface-hover`, …). The panel chrome (title bar,
drag, close ×) is provided by `Cade.mkPanel`; you only style the body.

### 5.3 Add to `txt/manifest.json`

```json
{
  "id": "hello",
  "type": "widget",
  "name": "Hello",
  "description": "A tiny example widget",
  "icon": "👋",
  "tags": "example,hello,demo",
  "entry": "widgets/hello/hello.js",
  "css": "widgets/hello/hello.css"
}
```

The `name/description/icon/tags` **must match** what your `registerWidget` uses
(the manifest version powers the palette before code loads; the registered
version replaces it after load — they dedupe by `name`).

### 5.4 Finish

Bump `manifest.version`, bump `CACHE_VERSION` in `sw.js`, validate. Done — the
widget now appears in Ctrl+K and loads on first open.

> Patterns worth copying from the games: persistent high score via
> `Cade.store.get/set`, a `requestAnimationFrame` loop that self-stops when
> `panel`/`canvas.isConnected` is false, an `Escape`-to-close `keydown` handler
> registered with `{ capture:true }` and removed in `_onClose`, and touch
> support via `pointerdown`/`pointerup` swipe deltas.

---

## 6. How to build a SCRIPT (step by step)

A script is a **text transform** in the Ctrl+K palette. It receives the current
selection (or current line, or whole doc) and rewrites it. Scripts are the same
format whether inline or external.

A script module calls `Cade.registerScript(source)` where `source` is a **string**
beginning with a `/** … **/` JSON metadata header, followed by a `function main(ctx)`.

### 6.1 Create `txt/scripts/shout/shout.js`

```js
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  window.Cade.registerScript(`/**
    {
      "name": "Shout",
      "description": "UPPERCASE the selection (or whole document)",
      "icon": "📣",
      "tags": "uppercase,shout,caps"
    }
  **/
  function main(ctx) {
    var text = ctx.selection || ctx.fullText;
    var out = text.toUpperCase();
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  }`);
})();
```

### 6.2 The `ctx` API your `main(ctx)` receives

| Member | Meaning |
| --- | --- |
| `ctx.fullText` (get/set) | the entire document. Setting it replaces the whole doc. |
| `ctx.selection` (get/set) | the user's selected text; if there's no selection it is the current non-empty line; if the cursor is on an empty line, `ctx.selection` is `''` (so the idiom `ctx.selection || ctx.fullText` targets the whole doc). Setting it writes back to that range. |
| `ctx.text` (get) | convenience: the effective input (`selection` if present else `fullText`). |

**Idiom:** read with `var t = ctx.selection || ctx.fullText;`, then write with
`if (ctx.selection) ctx.selection = out; else ctx.fullText = out;`.

**Available globals inside `main`:** `window`, `document`, `ctx`, `showToast`.
If you declare it as `async function main(ctx)`, you additionally get
`secureKeywordPrompt`, `encryptText`, `decryptText`, and the host awaits it.

### 6.3 Add to `txt/manifest.json`

```json
{
  "id": "shout",
  "type": "script",
  "name": "Shout",
  "description": "UPPERCASE the selection (or whole document)",
  "icon": "📣",
  "tags": "uppercase,shout,caps",
  "entry": "scripts/shout/shout.js"
}
```

Then bump versions + validate as usual.

### 6.4 SCRIPT PACKS — many scripts in one module

When you have a family of related transforms, don't create one folder per
script. A **script-pack** is a single module file that calls
`Cade.registerScript(...)` once per script, with ONE manifest entry that lists
each script's palette metadata (the palette shows all rows before the code
loads; selecting any row loads the pack once and every script becomes live).

`txt/scripts/mypack/mypack.js`:
```js
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var registerScript = function (src) { window.Cade.registerScript(src); };

  registerScript(`/** {"name": "One", "description": "…", "icon": "1️⃣", "tags": "a,b"} **/
  function main(ctx) { /* … */ }`);

  registerScript(`/** {"name": "Two", "description": "…", "icon": "2️⃣", "tags": "c,d"} **/
  function main(ctx) { /* … */ }`);
})();
```

Manifest entry — `type: "script-pack"` plus a `scripts` array whose
`name/description/icon/tags` **must match** each registered script:
```json
{
  "id": "mypack",
  "type": "script-pack",
  "name": "My Pack",
  "description": "What the pack groups together",
  "entry": "scripts/mypack/mypack.js",
  "scripts": [
    { "name": "One", "description": "…", "icon": "1️⃣", "tags": "a,b" },
    { "name": "Two", "description": "…", "icon": "2️⃣", "tags": "c,d" }
  ]
}
```

Real examples: `txt/scripts/pack-lines/`, `pack-case/`, `pack-convert/`,
`pack-data/`, `pack-tools/`, `pack-fancy/`, `pack-clean/` — the bulk of the
built-in transform catalogue lives in these packs.

> Scripts that must stay INSIDE `txt.html` (do not move them into packs):
> `Bold (…)` / `Italic (…)` / `Underline (…)` (bound to Ctrl+B/I/U in core),
> the `Add Color` family + `Migrate Highlights` (core highlight sentinel),
> `Insert Image`, `Encode (AES)` / `Decode (AES)`, `Download`, `Select All`
> (each is welded to a core subsystem).

---

## 7. How to build a PLUGIN (editor injection, step by step)

A plugin injects a **CodeMirror 6 extension** (a `ViewPlugin`, a set of
decorations, a keymap, etc.) into the live editor. Plugins are **gated by a
Settings toggle** and load only when enabled. The core's plugin registry keeps
your extension alive **across room switches** (the editor state is rebuilt on
every room change) and lets the user toggle it on/off.

### 7.1 Create `txt/plugins/marker/marker.js`

```js
/* Example plugin: underline every TODO occurrence. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;                                   // = window.__CM6__
  if (!CM || !CM.ViewPlugin || !CM.Decoration) return;
  Cade.loadCSS('marker.css');

  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration;

  function build(view) {
    var ranges = [], doc = view.state.doc, re = /TODO/g;
    for (var r = 0; r < view.visibleRanges.length; r++) {       // VIEWPORT ONLY = fast
      var from = view.visibleRanges[r].from, to = view.visibleRanges[r].to;
      var s = doc.lineAt(from).number, e = doc.lineAt(to).number;
      for (var i = s; i <= e; i++) {
        var line = doc.line(i), m;
        re.lastIndex = 0;
        while ((m = re.exec(line.text)) !== null) {
          ranges.push(Decoration.mark({ class: 'cm-todo-mark' })
            .range(line.from + m.index, line.from + m.index + m[0].length));
        }
      }
    }
    ranges.sort(function (a, b) { return a.from - b.from || a.startSide - b.startSide; });
    return Decoration.set(ranges, true);
  }

  function P(view) { this.decorations = build(view); }
  P.prototype.update = function (u) {
    if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
  };
  var ext = ViewPlugin.fromClass(P, { decorations: function (v) { return v.decorations; } });

  // id MUST equal the manifest id (the on/off toggle re-activates by this id).
  Cade.registerPlugin({ id: 'marker', ext: ext });
})();
```

`txt/plugins/marker/marker.css`:
```css
.cm-todo-mark { text-decoration: underline wavy var(--accent); }
```

### 7.2 Add to `txt/manifest.json` (note the plugin-only fields)

```json
{
  "id": "marker",
  "type": "plugin",
  "name": "Highlight TODOs",
  "description": "Underline every TODO in the document",
  "entry": "plugins/marker/marker.js",
  "css": "plugins/marker/marker.css",
  "settingKey": "plugins.marker",
  "section": "Editor",
  "default": false
}
```

- `settingKey` (required for a togglable plugin): the loader auto-registers a
  toggle Setting under this key. When ON, your module is loaded; when OFF, your
  extension is removed from the editor.
- `section`: which Settings section the toggle appears in (`Appearance` /
  `Editor` / `Behavior` / `Plugins` / any custom string). Defaults to `Plugins`.
- `default`: initial toggle value (usually `false`).
- `eager` (rare): if `true` and there's no `settingKey`, load the plugin at boot.

### 7.3 Plugin rules

- `ext` is **any** CM6 extension: a `ViewPlugin`, `Cade.CM.keymap.of([...])`,
  a state field, or an array of these.
- **`id` must equal the manifest `id`.** Toggling the Setting off calls
  `__unregisterPlugin(id)`; toggling back on re-activates the stored extension by
  the same `id` (the module script itself is load-deduped and won't re-run).
- Build decorations from `view.visibleRanges` only (viewport) so large documents
  stay fast. Skip lines longer than ~2000 chars (embedded-image/data lines).
- Always-on, foundational editor behavior should stay in core. Plugins are for
  **optional/toggleable** editor features.

---

## 8. How to build a CONFIG (data or settings)

`txt/configs/` holds two flavors, dispatched by file extension:

- **JSON data** (`"entry": "configs/foo/foo.json"`): fetched at boot and stored
  at `window.Cade._configs["<id>"]` for the core/other modules to read.
- **Settings code** (`"entry": "configs/foo/foo.js"`): loaded like any module;
  inside, call `Cade.registerSetting({...})` to add grouped settings.

Manifest entry:
```json
{ "id": "mytheme", "type": "config", "entry": "configs/mytheme/mytheme.json" }
```

A settings `.js` config example:
```js
(function () {
  'use strict';
  var Cade = window.Cade;
  Cade.registerSetting({
    key: 'myfeature.enabled', label: 'Enable my feature', type: 'toggle',
    default: false, section: 'Behavior', hint: 'What this does.',
    apply: function (on) { /* react to the value */ }
  });
})();
```

---

## 9. `window.Cade` API (quick reference)

Full reference in `txt/docs/cade-api.md`. The essentials:

**Registration**
- `Cade.registerWidget({ name, description, icon, tags, open })`
- `Cade.registerScript(sourceString)` — `/** {json} **/ function main(ctx){}`
- `Cade.registerPlugin({ id, ext })` — `ext` = CM6 extension
- `Cade.registerSetting({ key, label, type, default, section, hint, options, apply, getState })`

**Core handles**
- `Cade.editor` — the CodeMirror `EditorView`
- `Cade.CM` — the CodeMirror exports (`= window.__CM6__`): `EditorView`,
  `EditorState`, `ViewPlugin`, `Decoration`, `WidgetType`, `Compartment`,
  `keymap`, `lineNumbers`, `history`, `undo`, `redo`, `basicSetup`, …
- `Cade.store` — synchronous key/value (localStorage-backed): `.get(k)`,
  `.set(k,v)`, `.remove(k)`, `.keys()`, `.sizeOf(k)`
- `Cade.idbStore` — async IndexedDB store for big blobs: `.get`/`.set`/`.remove`/`.keys` (Promises)
- `Cade.Settings` — `.get(key)`, `.set(key,val)`, `.onChange(key,cb)`

**UI helpers**
- `Cade.mkPanel(id, title, innerHTML)` → draggable/closeable panel element (set
  `panel._onClose` for cleanup)
- `Cade.showToast(message, type, durationMs)` — `type` ∈ `'info'|'success'|'error'`
- `Cade.haptic(ms)` — vibrate on supported devices
- `Cade.escapeHtml(str)` — HTML-escape for safe innerHTML
- `Cade.closeAllMenus()` — close any open header menus/dropdowns

**Lifecycle + assets**
- `Cade.onEditorUpdate(cb)` — `cb(viewUpdate)` on every editor change (for live
  panels like the outline). Check `update.docChanged` / `update.selectionSet`.
- `Cade.loadCSS(relPath)` — inject your module's stylesheet (call at load time)
- `Cade.asset(relPath)` / `Cade.baseURL()` — resolve a file inside your module folder

---

## 10. `manifest.json` schema

```jsonc
{
  "schema": 1,
  "version": "2026.06.26-5",        // bump on EVERY change (free-form string)
  "modules": [
    {
      "id": "snake",                 // REQUIRED, unique. = folder name + cache/dedupe key
      "type": "widget",              // REQUIRED: widget | script | script-pack | plugin | config
      "name": "Snake",               // widget/script: REQUIRED (palette label + dedupe)
      "description": "…",            // palette description
      "icon": "🐍",                  // emoji or inline <svg> string
      "tags": "game,snake,arcade",   // comma list, fuzzy-search keywords
      "entry": "widgets/snake/snake.js",   // REQUIRED. path RELATIVE to ./txt/
      "css": "widgets/snake/snake.css",    // optional, precached for offline
      "precache": ["widgets/snake/assets/x.png"], // optional extra files for offline
      "settingKey": "plugins.foo",   // plugin only: gates load behind a toggle
      "section": "Editor",           // plugin only: Settings section for the toggle
      "default": false,              // plugin only: initial toggle value
      "eager": false,                // plugin/other: load at boot (rare)
      "scripts": [                   // script-pack only: one palette row per entry;
        { "name": "…", "description": "…", "icon": "…", "tags": "…" }
      ]
    }
  ]
}
```

> No directory listing exists on static hosting, so the manifest is the **only**
> way the app (and the service worker) discover modules. If it isn't in the
> manifest, it does not exist. List concrete asset files in `precache` for
> offline (folders can't be auto-walked).

---

## 11. Offline / service worker

The service worker (`sw.js`) reads `txt/manifest.json` on install and precaches
every module's `entry`, `css`, and `precache` files, so modules work with **no
network**. Two consequences for you:

- **Bump `CACHE_VERSION` in `sw.js` on every module add/edit.** The install
  handler (which re-precaches) only re-runs when `sw.js` itself changes byte-wise.
  Forgetting this means existing users won't get your module offline.
- Same-origin module files are also cached on first online fetch
  (stale-while-revalidate), so between version bumps updates still propagate when
  online — but offline-from-cold needs the precache (hence the bump).

---

## 12. Validate & test

**Syntax-check (do this before every commit):**
```bash
# module JS parses?
node -e "new Function(require('fs').readFileSync('txt/widgets/<id>/<id>.js','utf8')); console.log('OK')"
# manifest is valid JSON?
node -e "JSON.parse(require('fs').readFileSync('txt/manifest.json','utf8')); console.log('OK')"
# (if you DID edit txt.html) every inline <script> still parses?
node -e "const h=require('fs').readFileSync('txt.html','utf8');[...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].forEach((m,i)=>{try{new Function(m[1])}catch(e){console.log('ERR',i,e.message)}});console.log('checked')"
```

**Manual test in the browser:**
- **Widget/script:** open Ctrl+K, type the name → it appears (from manifest
  metadata, before code loads). Select it → code fetches once (watch Network) →
  it runs. Reopen → no second fetch.
- **Plugin:** Settings → your section → toggle on → effect appears live; switch
  rooms → effect persists; toggle off → effect removed.
- **Offline:** load online once (so the SW precaches), then go offline and reload
  → the module still works.
- **Fallback:** temporarily rename `manifest.json` → the app still launches with
  built-in features intact (proves you didn't couple core to your module).

---

## 13. Common mistakes (read this!)

1. **Forgot to bump `CACHE_VERSION`** → module missing offline for existing users.
2. **`Cade.loadCSS` inside `open()`** instead of at module top → wrong CSS path /
   no styles. Load CSS at the top of the IIFE.
3. **No IIFE / top-level globals** → collisions with other modules. Wrap everything.
4. **Plugin `id` ≠ manifest `id`** → the on/off toggle can't re-activate the plugin.
5. **Manifest `name` ≠ registered `name`** (widgets/scripts) → duplicate palette rows.
6. **Building decorations over the whole doc** instead of `view.visibleRanges` →
   slow on big files. Viewport only; skip >2000-char lines.
7. **Leaking rAF loops / listeners** → set `panel._onClose` to cancel them and
   remove any `document`-level `keydown` handlers you added.
8. **Editing `txt.html` for a normal module** → unnecessary; only the manifest +
   `sw.js` cache bump are needed. Core only changes if you need a *new* Cade API.

---

## 14. If you genuinely need a new core capability

If your module needs something `window.Cade` doesn't expose yet (a new lifecycle
hook, a new core handle), add it to the `window.Cade` object in `txt.html` (near
the top of the main `<script>`) using a **late-bound** getter or a thin wrapper
around an existing internal, then document it in `cade-api.md`. Keep core
additions minimal and generic. Example precedent: `Cade.onEditorUpdate` was added
so panel modules (outline) could rebuild on edits.
