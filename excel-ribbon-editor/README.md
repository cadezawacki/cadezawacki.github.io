# RibbonForge

A ribbon (CustomUI) editor for Excel — and the rest of Office — written in
pure Python 3.11 with a Tkinter interface. It opens `.xlsm` / `.xlam` /
`.xlsx` (and Word/PowerPoint) files directly, edits the ribbon markup inside
them, and writes the package back with everything else untouched.

No third-party dependencies. Nothing to install beyond Python itself.

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

**Four views of the same document, always in sync.**

| View | What it gives you |
| --- | --- |
| Structure tree | The whole ribbon as a tree. Insert, duplicate, reorder, delete, drag and drop between containers — every move is checked against the schema first. |
| XML editor | Syntax highlighting, a line-number gutter with problem markers, tag matching, auto-closing tags, auto-indent, comment toggling, line moving/duplication, find and replace with regex, and go-to-line. |
| Properties | Every attribute the selected element actually accepts, grouped and documented, with the right editor for each: booleans and enumerations as drop-downs, `imageMso` with an icon browser, `image` with the pictures embedded in the part, `idMso` with a catalogue browser, and callbacks with their exact VBA signature. |
| Live preview | An approximate render of the tab strip, groups, and every control type, plus Backstage pages and context menus. Click anything to select it everywhere else. |

Editing in any view updates the others. Structured edits are re-serialised
into the editor as one undo step, so `Ctrl+Z` walks back through tree and
property changes as well as typing.

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

**The rest.** Eleven starter templates and eighteen snippets, a curated
catalogue of built-in icons and control ids (extensible with your own list —
see below), a command palette (`Ctrl+Shift+P`), dark and light themes with
six accent colours, a recent-file list, per-document `.bak` backups, and a
warning when the file you are about to save looks like it is open in Office.

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

## Extending the icon catalogue

Office ships thousands of `imageMso` ids; RibbonForge includes a curated few
hundred of the ones people actually use, grouped by category. Any valid name
can always be typed by hand. To extend the browsable gallery, drop a
plain-text file at `%APPDATA%\RibbonForge\imagemso.txt` with one id per line
(optionally `Id, Category`); it is merged in at start-up. Microsoft publishes
the complete list as a set of Office icon-gallery workbooks.

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
  It is there to catch structural mistakes, not to be pixel-perfect — and it
  cannot show real `imageMso` artwork, which lives inside Office, so built-in
  icons are drawn as recognisable stand-ins.
* Unknown `imageMso` names are reported as hints, never errors: the catalogue
  is deliberately incomplete.
* `.xls`, `.doc` and `.ppt` are not Open XML packages and cannot carry a
  ribbon at all.

## Tests

```
py -3.11 -m unittest discover -s tests          # 54 headless tests
py -3.12 tests/gui_smoke.py sample.xlsm         # drives the real window
```

`tests/test_core.py` covers XML round-tripping and source positions, schema
resolution, every validation rule and auto-fix, callback signatures, and the
package layer — including that unrelated parts survive a save byte-for-byte.
`tests/gui_smoke.py` builds the actual window and exercises opening, editing
from every panel, drag and drop, undo, view switching, all dialogs, theming
and saving; run it under `xvfb-run` on a headless machine.
`tests/make_sample.py` writes the sample workbook both suites use.
