# RibbonForge

A ribbon (CustomUI) editor for Excel — and the rest of Office — written in
pure Python 3.11 with a Tkinter interface. It opens `.xlsm` / `.xlam` /
`.xlsx` (and Word/PowerPoint) files directly, edits the ribbon markup inside
them, and writes the package back with everything else untouched.

It does several things no other ribbon editor does: it **reads the
workbook's actual VBA** (straight out of `vbaProject.bin`, no Excel needed)
so it knows which callbacks really exist; it **drives a live Excel over COM**
to test the ribbon, inject the generated macros, and harvest real icons; it
**simulates dynamic callbacks** so you can watch `getVisible`/`getEnabled`
states in the preview; and it keeps a **visual snapshot history** of every
save.

No third-party dependencies. Nothing to install beyond Python itself
(Windows ships tkinter and PowerShell; Pillow is used if present).

```
excel-ribbon-editor/
├── RibbonForge.bat            double-click launcher for Windows
├── run_ribbon_editor.pyw      no-console entry point
├── run_ribbon_editor.py       console entry point (tracebacks stay visible)
└── ribbonforge/
    ├── core/                  no GUI code lives here
    │   ├── xmldoc.py          position-aware XML parser and pretty printer
    │   ├── schema.py          the CustomUI schema (elements, attributes, docs)
    │   ├── ooxml.py           reads and writes the Open XML package
    │   ├── validator.py       schema + real-world rule checking, with fixes
    │   ├── callbacks.py       VBA callback discovery and code generation
    │   ├── msodata.py         built-in imageMso / idMso catalogues
    │   ├── templates.py       starter documents and snippets
    │   ├── document.py        open documents, parts and edit state
    │   └── settings.py        preferences and the recent-file list
    └── ui/                    theme, widgets, editor, tree, preview, dialogs
```

## Running it

Windows, Python 3.11 (tkinter ships with the standard Windows installer):

```
py -3.11 run_ribbon_editor.py            # or double-click RibbonForge.bat
py -3.11 run_ribbon_editor.py Book1.xlsm # open a workbook straight away
py -3.11 -m ribbonforge                  # same thing, as a module
```

Pillow is optional. If it happens to be installed, embedded pictures are
scaled with better filtering; without it Tk's own PNG/GIF support is used.

## What it does

**Works on the real file.** Opens the Open XML package, finds
`customUI/customUI.xml` (Office 2007) and `customUI/customUI14.xml`
(Office 2010 and later), and lets you add, edit or remove either. Saving
copies every other part through byte-for-byte, repairs
`[Content_Types].xml` and the relationship parts, and keeps a `.bak` copy.
Files that cannot carry a ribbon (`.xls`, anything that is not a ZIP
package) are rejected with an explanation rather than a traceback.

**Five views of the same document, always in sync.**

| View | What it gives you |
| --- | --- |
| ✦ Design mode | Build the ribbon by dragging control cards straight onto the live preview. Valid drop targets light up as you drag, existing controls can be picked up and moved between groups or reordered, and a "getting started" quest list with a progress bar walks newcomers through their first ribbon. |
| Structure tree | The whole ribbon as a tree. Insert, duplicate, reorder, delete, drag and drop between containers — every move is checked against the schema first. |
| XML editor | Syntax highlighting, a line-number gutter with problem markers, tag matching, auto-closing tags, auto-indent, comment toggling, line moving/duplication, find and replace with regex, and go-to-line. |
| Properties | Every attribute the selected element actually accepts, grouped and documented, with the right editor for each: booleans and enumerations as drop-downs, `imageMso` with an icon browser, `image` with the pictures embedded in the part, `idMso` with a catalogue browser, and callbacks with their exact VBA signature. |
| Live preview | An approximate render of the tab strip, groups, and every control type, plus Backstage pages and context menus. Click anything to select it everywhere else. |

Editing in any view updates the others. Structured edits are re-serialised
into the editor as one undo step, so `Ctrl+Z` walks back through tree and
property changes as well as typing.

### What makes it different

**VBA X-Ray — see the macros without opening Excel.** An `.xlsm` keeps its
code in an OLE compound file using MS-OVBA compression; RibbonForge reads
both formats in pure Python. So the moment a workbook opens it knows every
procedure in every module, and validation tells you *precisely* which ribbon
callbacks already exist, which are in the wrong (non-standard) module where
Office can't call them, and which take the wrong number of arguments — with
jump-to-line, before you ever run the file.

**Excel Live Bridge — one machine, both apps.** On Windows with Office,
RibbonForge talks to a running Excel through PowerShell + COM (no pip
packages):

* **Test in Excel** (F8) saves, then closes and reopens the workbook inside
  Excel so your ribbon appears in seconds.
* **Inject VBA callbacks** imports the generated `.bas` straight into the
  workbook's VBA project (it detects and explains the one Trust Center
  setting this needs).
* **Harvest icons** asks Office itself for `imageMso` artwork at 32 px via
  `CommandBars.GetImageMso`, alpha channel intact, and caches it so every
  icon in the editor is pixel-for-pixel what your Excel shows.

**Callback Lab — see a dynamic ribbon come alive.** A ribbon driven by
`getVisible`, `getEnabled`, `getLabel`, `getItemCount`… is normally
invisible outside Excel. The Lab gives you a switch, number, or text box per
callback; flip them and the live preview responds exactly as the real ribbon
would — controls appear and disappear, toggles press in, drop-downs fill.

**Time Machine — never lose a ribbon.** Every save stores a snapshot of each
part. Browse them by time, see a colour-coded diff against the current XML,
and restore any version as a single undoable edit.

**Exported customisations.** Opens and round-trips Excel's own
`.exportedUI` files (the prefixed-namespace form Excel writes when you
export your Quick Access Toolbar and ribbon customisations), preserving the
`mso:` prefixes exactly.

**Context-aware autocomplete.** `Ctrl+Space` (or just typing `<`) offers
exactly the elements valid at that point in the tree, then the attributes
that element accepts, then the values that attribute takes — enumerations,
`true`/`false`, the icon catalogue, embedded picture ids, or callback names
already used elsewhere in the document.

**Validation that catches what Office silently ignores.** Beyond
well-formedness: elements in the wrong parent, unknown or misspelled
attributes (with "did you mean"), duplicate ids, `id`/`idQ`/`idMso` used
together, out-of-range numbers, bad enumeration values, invalid VBA
procedure names, `image` pointing at a picture that is not embedded,
Office 2010 features in a 2007 part, a namespace that does not match the
part it lives in, malformed `splitButton`s, a `dynamicMenu` with no
`getContent`, a `qat` section without `startFromScratch`, and more. Findings
land in the problems panel with the exact line; several have a one-click
fix.

**VBA generation.** Every callback referenced by the ribbon, with the
correct signature for the control it sits on — `onAction` alone on a button,
with `pressed` on a toggle, with `selectedId`/`selectedIndex` on a gallery
or drop-down, with `cancelDefault` on a repurposed command. Controls sharing
a callback through `tag` get a `Select Case` skeleton. The module includes
the `IRibbonUI` plumbing and, optionally, the pointer-recovery trick that
survives a VBA state reset. Save it as a `.bas` and import it into the VBE.

**Pictures.** Import PNG/JPEG/GIF/BMP/ICO into the part, preview them,
rename their ids, export them again, or delete them. Relationships and
content types are maintained for you.

**Real icons.** The complete list of 3,244 built-in `imageMso`
identifiers ships with the app, searchable in a virtualised gallery that
stays instant however fast you scroll. A one-click download (~300 KB, from
bert-toolkit.com's published reference sheet) installs the genuine Office
artwork so every icon in the gallery and the preview looks exactly as it
will in Excel; until then the gallery shows neutral monograms rather than
guesses.

**The rest.** Eleven starter templates and eighteen snippets, a command
palette (`Ctrl+Shift+P`), dark and light themes with six accent colours, a
recent-file list, per-document `.bak` backups, and a warning when the file
you are about to save looks like it is open in Office.

## A five-minute tour

1. **Open** a macro-enabled workbook. If it has no ribbon yet, RibbonForge
   offers to add one and shows the template gallery.
2. Pick a control in the **structure tree**. Its attributes appear on the
   right and it is outlined in the preview.
3. Change `label`, or click the browse button next to `imageMso` and pick an
   icon. The XML and the preview update as you type.
4. Right-click a group and **insert** a `gallery`. Only the controls Office
   allows inside a group are offered.
5. Press **F9** to see the VBA the ribbon now needs, and save it as a `.bas`.
6. Press **F5** to validate, then **Ctrl+S**. Reopen the workbook in Excel to
   see the ribbon.

## The icon catalogue

All 3,244 published `imageMso` identifiers are built in; on top of them a
curated set — every name verified against that list — is grouped into
categories so the browser stays navigable. Anything newer that Office
understands can still be typed by hand, and extra ids can be added to the
gallery via `%APPDATA%\RibbonForge\imagemso.txt` (one id per line,
optionally `Id, Category`). The real artwork lives in
`%APPDATA%\RibbonForge\msoicons\` once downloaded from the gallery.

## Keyboard

`Ctrl+O` open · `Ctrl+N` new · `Ctrl+S` save · `Ctrl+Shift+S` save as ·
`Ctrl+W` close · `Ctrl+Space` autocomplete · `Ctrl+F` / `Ctrl+H` find and
replace · `F3` find next · `Ctrl+G` go to line · `Ctrl+/` comment ·
`Ctrl+D` duplicate · `Alt+↑`/`Alt+↓` move line · `Ctrl+Shift+F` reformat ·
`F5` validate · `F9` callbacks · `F1` shortcuts · `Ctrl+Shift+P` command
palette · `Ctrl+1/2/3` focus tree / editor / preview · `Insert`, `Delete`,
`Ctrl+↑`, `Ctrl+↓` in the tree.

## Notes and limits

* Office reads the ribbon when a file is **opened**. Save from RibbonForge
  while the workbook is closed, then open it in Excel.
* The preview is a faithful approximation, not Office's own layout engine.
  It is there to catch structural mistakes, not to be pixel-perfect. With the
  icon pack installed it shows the real artwork at 16/32 px; without it,
  recognisable vector stand-ins.
* Unknown `imageMso` names are reported as hints, never errors — Office
  versions newer than the reference list may add ids.
* `.xls`, `.doc` and `.ppt` are not Open XML packages and cannot carry a
  ribbon at all.
* The Excel Live Bridge and icon harvesting need Windows with Office
  installed; on other platforms those actions are disabled and the rest of
  the editor works normally. VBA X-Ray is pure Python and works everywhere.

## Tests

```
py -3.11 -m unittest discover -s tests          # 70 headless tests
py -3.12 tests/gui_smoke.py sample.xlsm         # drives the real window
```

The VBA reader is tested against both a synthetic project (built by
`tests/make_vba.py`, exercising raw *and* copy-token OVBA compression) and
real-world `vbaProject.bin` files; the Excel bridge is tested end-to-end
through a fake PowerShell so the script generation and JSON handling are
verified without needing Office.

`tests/test_core.py` covers XML round-tripping and source positions, schema
resolution, every validation rule and auto-fix, callback signatures, and the
package layer — including that unrelated parts survive a save byte-for-byte.
`tests/gui_smoke.py` builds the actual window and exercises opening, editing
from every panel, drag and drop, undo, view switching, all dialogs, theming
and saving; run it under `xvfb-run` on a headless machine.
`tests/make_sample.py` writes the sample workbook both suites use.
