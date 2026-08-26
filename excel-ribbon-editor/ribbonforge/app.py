"""RibbonForge - the main application window."""

from __future__ import annotations

import os
import sys
import tkinter as tk
import webbrowser
from tkinter import filedialog, messagebox, ttk
from typing import Callable, Dict, List, Optional, Tuple

from . import __version__
from .core import callbacks as cbmod
from .core import msodata, schema, templates, validator
from .core.document import KIND_PACKAGE, KIND_XML, PartState, RibbonDocument
from .core.ooxml import (NAMESPACE_FOR, OPEN_FILTER, PART_LABEL, V2007, V2010,
                         PackageError)
from .core.settings import Settings, config_dir
from .core.xmldoc import Node
from .ui import dialogs
from .ui.designer import DesignerPalette, PreviewDragController
from .ui.codeeditor import CodeEditor, Completion, CompletionContext
from .ui.preview import RibbonPreview
from .ui.properties import PropertiesPanel
from .ui.structure import StructureTree
from .ui.theme import Theme
from .ui.widgets import (Chip, PanelHeader, SegmentedControl, Separator, Toast,
                         ToolButton, make_menu)

APP_TITLE = "RibbonForge"


class RibbonForgeApp(tk.Tk):
    def __init__(self, initial_files: Optional[List[str]] = None) -> None:
        super().__init__()
        self.settings = Settings()
        self.withdraw()

        self.title(APP_TITLE)
        self.minsize(1024, 620)
        geometry = self.settings["geometry"]
        if geometry:
            try:
                self.geometry(geometry)
            except tk.TclError:
                self.geometry("1400x880")
        else:
            self.geometry("1400x880")

        self.theme = Theme(self, self.settings["theme"], self.settings["accent"],
                           ui_size=int(self.settings["ui_font_size"]),
                           mono_family=self.settings["editor_font"],
                           mono_size=int(self.settings["editor_font_size"]))
        self.configure(background=self.theme.c("bg"))
        self._set_icon()

        msodata.load_user_catalogue(
            os.path.join(config_dir(), "imagemso.txt"),
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "imagemso.txt"),
        )

        self.documents: List[RibbonDocument] = []
        self.document: Optional[RibbonDocument] = None
        self.part: Optional[PartState] = None
        self._syncing = False
        self.view_mode = "both"
        self._explorer_items: Dict[str, Tuple[RibbonDocument, Optional[str], str]] = {}
        self.toast = Toast(self, self.theme)

        self._build_menu()
        self._build_toolbar()
        self._build_layout()
        self._build_statusbar()
        self._bind_keys()

        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.deiconify()
        self.after(60, lambda: self._open_initial(initial_files or []))

    # ---------------------------------------------------------------- chrome
    def _set_icon(self) -> None:
        try:
            image = tk.PhotoImage(width=32, height=32)
            accent = self.theme.c("accent")
            image.put(accent, to=(0, 0, 32, 32))
            image.put(self.theme.c("on_accent"), to=(6, 8, 26, 12))
            image.put(self.theme.c("on_accent"), to=(6, 15, 18, 19))
            image.put(self.theme.c("on_accent"), to=(6, 22, 22, 26))
            self.iconphoto(True, image)
            self._icon_ref = image
        except tk.TclError:
            pass

    def _build_menu(self) -> None:
        menubar = tk.Menu(self, tearoff=0)

        file_menu = make_menu(menubar, self.theme)
        file_menu.add_command(label="New ribbon...", accelerator="Ctrl+N", command=self.new_document)
        file_menu.add_command(label="Open...", accelerator="Ctrl+O", command=self.open_dialog)
        self.recent_menu = make_menu(file_menu, self.theme)
        file_menu.add_cascade(label="Open recent", menu=self.recent_menu)
        file_menu.add_separator()
        file_menu.add_command(label="Save", accelerator="Ctrl+S", command=self.save)
        file_menu.add_command(label="Save as...", accelerator="Ctrl+Shift+S", command=self.save_as)
        file_menu.add_command(label="Export this part as XML...", command=self.export_part)
        file_menu.add_separator()
        file_menu.add_command(label="Close document", accelerator="Ctrl+W", command=self.close_document)
        file_menu.add_command(label="Exit", command=self.on_close)
        menubar.add_cascade(label="File", menu=file_menu)

        edit_menu = make_menu(menubar, self.theme)
        edit_menu.add_command(label="Undo", accelerator="Ctrl+Z", command=lambda: self._editor_edit("undo"))
        edit_menu.add_command(label="Redo", accelerator="Ctrl+Y", command=lambda: self._editor_edit("redo"))
        edit_menu.add_separator()
        edit_menu.add_command(label="Find...", accelerator="Ctrl+F",
                              command=lambda: self.editor.show_find())
        edit_menu.add_command(label="Replace...", accelerator="Ctrl+H",
                              command=lambda: self.editor.show_find(replace=True))
        edit_menu.add_command(label="Go to line...", accelerator="Ctrl+G",
                              command=lambda: self.editor.prompt_goto())
        edit_menu.add_separator()
        edit_menu.add_command(label="Reformat document", accelerator="Ctrl+Shift+F",
                              command=self.format_document)
        edit_menu.add_command(label="Preferences...", command=self.show_preferences)
        menubar.add_cascade(label="Edit", menu=edit_menu)

        insert_menu = make_menu(menubar, self.theme)
        self.insert_menu = insert_menu
        menubar.add_cascade(label="Insert", menu=insert_menu)
        self._rebuild_insert_menu()

        part_menu = make_menu(menubar, self.theme)
        part_menu.add_command(label="Add customUI14.xml  (Office 2010+)",
                              command=lambda: self.add_part(V2010))
        part_menu.add_command(label="Add customUI.xml  (Office 2007)",
                              command=lambda: self.add_part(V2007))
        part_menu.add_command(label="Remove this part", command=self.remove_part)
        part_menu.add_separator()
        part_menu.add_command(label="Embedded pictures...", command=self.show_images)
        part_menu.add_command(label="Icon gallery...", command=lambda: self.pick_image_mso(""))
        part_menu.add_command(label="Built-in control ids...", command=lambda: self.pick_control_mso(""))
        part_menu.add_separator()
        part_menu.add_command(label="Validate now", accelerator="F5", command=self.validate_now)
        part_menu.add_command(label="Generate VBA callbacks...", accelerator="F9",
                              command=self.show_callbacks)
        part_menu.add_command(label="Copy XML to clipboard", command=self.copy_xml)
        menubar.add_cascade(label="Ribbon", menu=part_menu)

        view_menu = make_menu(menubar, self.theme)
        self.show_preview_var = tk.BooleanVar(value=bool(self.settings["show_preview"]))
        self.show_props_var = tk.BooleanVar(value=bool(self.settings["show_properties"]))
        self.show_problems_var = tk.BooleanVar(value=bool(self.settings["show_problems"]))
        view_menu.add_checkbutton(label="Live preview", variable=self.show_preview_var,
                                  command=self._apply_visibility)
        view_menu.add_checkbutton(label="Properties", variable=self.show_props_var,
                                  command=self._apply_visibility)
        view_menu.add_checkbutton(label="Problems", variable=self.show_problems_var,
                                  command=self._apply_visibility)
        view_menu.add_separator()
        view_menu.add_command(label="Dark theme", command=lambda: self.set_theme("dark"))
        view_menu.add_command(label="Light theme", command=lambda: self.set_theme("light"))
        view_menu.add_separator()
        view_menu.add_command(label="Command palette", accelerator="Ctrl+Shift+P",
                              command=self.show_palette)
        menubar.add_cascade(label="View", menu=view_menu)

        help_menu = make_menu(menubar, self.theme)
        help_menu.add_command(label="Keyboard shortcuts", accelerator="F1",
                              command=lambda: dialogs.ShortcutsDialog(self, self.theme).show())
        help_menu.add_command(label="Microsoft CustomUI reference",
                              command=lambda: webbrowser.open(
                                  "https://learn.microsoft.com/en-us/openspecs/office_standards/ms-customui/"))
        help_menu.add_separator()
        help_menu.add_command(label="About RibbonForge",
                              command=lambda: dialogs.AboutDialog(self, self.theme, __version__).show())
        menubar.add_cascade(label="Help", menu=help_menu)

        self.configure(menu=menubar)
        self._refresh_recent_menu()

    def _build_toolbar(self) -> None:
        c = self.theme
        bar = tk.Frame(self, background=c.c("panel"))
        bar.pack(fill="x")
        self.toolbar = bar

        def add(text, icon, command, tooltip="", accent=False):
            button = ToolButton(bar, c, text=text, icon=icon, command=command,
                                tooltip=tooltip, accent=accent)
            button.pack(side="left", padx=1, pady=4)
            return button

        tk.Label(bar, text="  ⬢", background=c.c("panel"), foreground=c.c("accent"),
                 font=c.font("h2")).pack(side="left", padx=(10, 2))
        tk.Label(bar, text="RibbonForge", background=c.c("panel"), foreground=c.c("text"),
                 font=c.font("h3")).pack(side="left", padx=(0, 14))

        add("Open", "open", self.open_dialog, "Open a workbook or ribbon XML file  (Ctrl+O)")
        add("New", "page", self.new_document, "Start a new ribbon from a template  (Ctrl+N)")
        self.save_button = add("Save", "save", self.save, "Save the document  (Ctrl+S)", accent=True)
        Separator(bar, c, "vertical").pack(side="left", fill="y", pady=8, padx=8)
        add("Insert", "plus", self.show_insert_menu, "Insert a control into the selected container")
        add("Format", "code", self.format_document, "Reformat the XML  (Ctrl+Shift+F)")
        add("Validate", "check", self.validate_now, "Check the ribbon against the schema  (F5)")
        add("Callbacks", "fx", self.show_callbacks, "Generate the VBA this ribbon needs  (F9)")
        add("Pictures", "image", self.show_images, "Manage pictures embedded in this part")
        Separator(bar, c, "vertical").pack(side="left", fill="y", pady=8, padx=8)
        add("Icons", "palette", lambda: self.pick_image_mso(""), "Browse the built-in icon gallery")

        right = tk.Frame(bar, background=c.c("panel"))
        right.pack(side="right", padx=8)
        ToolButton(right, c, icon="search", tooltip="Command palette  (Ctrl+Shift+P)",
                   command=self.show_palette, compact=True, padx=6).pack(side="left")
        self.theme_button = ToolButton(
            right, c, glyph="◐", tooltip="Switch between the dark and light themes",
            command=self.toggle_theme, compact=True)
        self.theme_button.pack(side="left")
        ToolButton(right, c, icon="info", tooltip="Keyboard shortcuts  (F1)", compact=True,
                   padx=6,
                   command=lambda: dialogs.ShortcutsDialog(self, self.theme).show()).pack(side="left")

        Separator(self, c).pack(fill="x")

    def _build_layout(self) -> None:
        c = self.theme
        self.main = ttk.PanedWindow(self, orient="horizontal")
        self.main.pack(fill="both", expand=True)

        # ---- left column: explorer + structure
        self.left = ttk.PanedWindow(self.main, orient="vertical")
        explorer = tk.Frame(self.left, background=c.c("panel"))
        header = PanelHeader(explorer, c, "Documents", "🗂")
        header.pack(fill="x")
        ToolButton(header.tools, c, glyph="＋", compact=True, tooltip="Add a custom UI part",
                   command=self.show_add_part_menu).pack(side="left")
        ToolButton(header.tools, c, glyph="✕", compact=True, tooltip="Close document  (Ctrl+W)",
                   command=self.close_document).pack(side="left")
        tree_holder = tk.Frame(explorer, background=c.c("panel"))
        tree_holder.pack(fill="both", expand=True)
        self.explorer = ttk.Treeview(tree_holder, style="Plain.Treeview", show="tree",
                                     selectmode="browse", columns=("badge",), height=4)
        self.explorer.column("#0", width=210, stretch=True)
        self.explorer.column("badge", width=54, stretch=False, anchor="e")
        scroll = ttk.Scrollbar(tree_holder, orient="vertical", command=self.explorer.yview)
        self.explorer.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.explorer.pack(side="left", fill="both", expand=True)
        self.explorer.bind("<<TreeviewSelect>>", self._on_explorer_select)
        self.explorer.bind("<Button-3>", self._on_explorer_context)
        self.explorer.tag_configure("dirty", foreground=self.theme.c("accent"))
        self.explorer.tag_configure("error", foreground=self.theme.c("error"))
        self.explorer.tag_configure("muted", foreground=self.theme.c("text_dim"))
        self.left.add(explorer, weight=0)

        self.structure = StructureTree(self.left, c, on_select=self.on_node_selected,
                                       on_change=self.on_tree_change,
                                       on_activate=self.focus_node_in_editor)
        self.left.add(self.structure, weight=1)
        self.main.add(self.left, weight=0)

        # ---- centre column
        centre = tk.Frame(self.main, background=c.c("bg"))
        self.centre = centre
        view_bar = tk.Frame(centre, background=c.c("panel"))
        view_bar.pack(fill="x")
        self.view_switch = SegmentedControl(
            view_bar, c,
            [("design", "✦ Design"), ("both", "Preview + XML"), ("xml", "XML only"),
             ("preview", "Preview only")],
            command=self.set_view_mode, value="both")
        self.view_switch.pack(side="left", padx=8, pady=5)
        self.part_label = tk.Label(view_bar, text="", background=c.c("panel"),
                                   foreground=c.c("text_dim"), font=c.font("small"))
        self.part_label.pack(side="left", padx=10)
        self.parse_chip = Chip(view_bar, c, "", "muted")
        self.parse_chip.pack(side="right", padx=10)

        self.centre_panes = ttk.PanedWindow(centre, orient="vertical")
        self.centre_panes.pack(fill="both", expand=True)

        self.design_row = tk.Frame(self.centre_panes, background=c.c("panel"))
        self.preview = RibbonPreview(self.design_row, c, on_select=self.on_preview_select,
                                     zoom=float(self.settings["preview_zoom"]))
        self.palette = DesignerPalette(
            self.design_row, c, self.preview,
            on_insert=self.designer_insert,
            quest_state=self.settings.get("quests") or {},
            on_quest=self._quest_done)
        self.drag_controller = PreviewDragController(self.preview, self.palette,
                                                     on_move=self.designer_move)
        self.preview.pack(side="left", fill="both", expand=True)
        self.preview.set_image_lookup(self._image_bytes)
        self.preview.on_mode_change = self._preview_mode_changed
        self.centre_panes.add(self.design_row, weight=0)

        editor_holder = tk.Frame(self.centre_panes, background=c.c("code_bg"))
        self.editor = CodeEditor(editor_holder, c, on_change=self.on_editor_change,
                                 on_caret=self.on_caret_move,
                                 completion_provider=self.provide_completions,
                                 on_node_focus=self.on_editor_caret_node)
        self.editor.pack(fill="both", expand=True)
        for sequence, action in (("<Control-z>", "undo"), ("<Control-Z>", "redo"),
                                 ("<Control-y>", "redo")):
            self.editor.text.bind(
                sequence, lambda _e, a=action: (self._editor_edit(a), "break")[1])
        self.editor.text.bind("<Control-a>", self._select_all_text)
        self.centre_panes.add(editor_holder, weight=3)

        self.problems = ProblemsPanel(self.centre_panes, c, on_activate=self.goto_issue,
                                      on_fix=self.apply_fix)
        self.centre_panes.add(self.problems, weight=0)

        self.main.add(centre, weight=1)

        # ---- right column
        self.properties = PropertiesPanel(
            self.main, c, on_change=lambda d: self.on_tree_change(d, source="props"),
            image_provider=self._image_ids,
            pick_image_mso=self.pick_image_mso,
            pick_control_mso=self.pick_control_mso,
            import_image=self.import_image,
            show_callbacks=self.show_callback_for)
        self.main.add(self.properties, weight=0)

        self.welcome = WelcomeScreen(centre, c, self)
        self._show_welcome()
        self.after(140, self._restore_sashes)

    def _restore_sashes(self) -> None:
        try:
            self.main.sashpos(0, int(self.settings["sash_tree"]))
            width = self.winfo_width()
            self.main.sashpos(1, max(600, width - int(self.settings["sash_props"])))
            self.left.sashpos(0, 170)
        except tk.TclError:
            pass
        self._apply_visibility()
        self._reset_centre_sashes()

    def _build_statusbar(self) -> None:
        c = self.theme
        Separator(self, c).pack(fill="x")
        bar = tk.Frame(self, background=c.c("panel"))
        bar.pack(fill="x")
        self.status_left = tk.Label(bar, text="Ready", background=c.c("panel"),
                                    foreground=c.c("text_dim"), font=c.font("small"),
                                    anchor="w", padx=12, pady=5)
        self.status_left.pack(side="left")
        self.status_right = tk.Label(bar, text="", background=c.c("panel"),
                                     foreground=c.c("text_faint"), font=c.font("small"),
                                     anchor="e", padx=12)
        self.status_right.pack(side="right")
        self.status_chips = tk.Frame(bar, background=c.c("panel"))
        self.status_chips.pack(side="right", padx=6)
        self.chip_error = Chip(self.status_chips, c, "0", "error")
        self.chip_warn = Chip(self.status_chips, c, "0", "warn")
        self.chip_info = Chip(self.status_chips, c, "0", "info")
        for chip in (self.chip_error, self.chip_warn, self.chip_info):
            chip.pack(side="left", padx=2)
        self.statusbar = bar

    def _bind_keys(self) -> None:
        binds = {
            "<Control-o>": lambda e: self.open_dialog(),
            "<Control-n>": lambda e: self.new_document(),
            "<Control-s>": lambda e: self.save(),
            "<Control-S>": lambda e: self.save_as(),
            "<Control-Shift-S>": lambda e: self.save_as(),
            "<Control-w>": lambda e: self.close_document(),
            "<Control-Shift-F>": lambda e: self.format_document(),
            "<Control-F>": lambda e: self.format_document(),
            "<F5>": lambda e: self.validate_now(),
            "<F9>": lambda e: self.show_callbacks(),
            "<F1>": lambda e: dialogs.ShortcutsDialog(self, self.theme).show(),
            "<Control-P>": lambda e: self.show_palette(),
            "<Control-Shift-P>": lambda e: self.show_palette(),
            "<Control-Key-1>": lambda e: self.structure.tree.focus_set(),
            "<Control-Key-2>": lambda e: self.editor.focus_editor(),
            "<Control-Key-3>": lambda e: self.preview.canvas.focus_set(),
            "<Control-Tab>": lambda e: self.cycle_document(1),
            "<F6>": lambda e: self.cycle_panel(),
        }
        for sequence, handler in binds.items():
            self.bind_all(sequence, lambda event, fn=handler: (fn(event), "break")[1])

    # ------------------------------------------------------------- documents
    def _open_initial(self, paths: List[str]) -> None:
        opened = False
        for path in paths:
            if os.path.isfile(path):
                opened = self.open_path(path) or opened
        if not opened:
            self._show_welcome()

    def open_dialog(self) -> None:
        path = filedialog.askopenfilename(parent=self, title="Open workbook or ribbon XML",
                                          filetypes=OPEN_FILTER)
        if path:
            self.open_path(path)

    def open_path(self, path: str) -> bool:
        path = os.path.abspath(path)
        for document in self.documents:
            if document.path and os.path.normcase(document.path) == os.path.normcase(path):
                self.activate(document, document.first_part())
                return True
        try:
            if path.lower().endswith(".xml"):
                document = RibbonDocument.open_xml(path)
            else:
                document = RibbonDocument.open_package(path)
        except PackageError as exc:
            messagebox.showerror("Could not open", str(exc), parent=self)
            self.settings.drop_recent(path)
            self._refresh_recent_menu()
            return False
        except OSError as exc:
            messagebox.showerror("Could not open", f"{path}\n\n{exc}", parent=self)
            return False

        self.documents.append(document)
        self.settings.push_recent(path)
        self._refresh_recent_menu()

        if document.kind == KIND_PACKAGE and not document.parts:
            if messagebox.askyesno(
                    "No ribbon customisation",
                    f"{document.name} does not contain a ribbon customisation yet.\n\n"
                    f"Add a customUI14.xml part (Office 2010 and later)?", parent=self):
                document.add_part(V2010, self._ask_template(V2010) or "starter")
        self.refresh_explorer()
        self.activate(document, document.first_part())
        self.toast.show(f"Opened {document.name}", "ok")
        return True

    def new_document(self) -> None:
        key = self._ask_template(V2010)
        if key is None:
            return
        document = RibbonDocument.new_xml(V2010, key)
        self.documents.append(document)
        self.refresh_explorer()
        self.activate(document, document.first_part())

    def _ask_template(self, variant: str) -> Optional[str]:
        dialog = dialogs.TemplateGallery(self, self.theme, PART_LABEL.get(variant, ""))
        return dialog.show()

    def close_document(self) -> None:
        document = self.document
        if document is None:
            return
        if document.dirty:
            answer = messagebox.askyesnocancel(
                "Unsaved changes",
                f"Save the changes to {document.name} before closing?", parent=self)
            if answer is None:
                return
            if answer and not self.save():
                return
        self.documents.remove(document)
        self.document = None
        self.part = None
        self.refresh_explorer()
        following = self.documents[-1] if self.documents else None
        if following is not None:
            self.activate(following, following.first_part())
        else:
            self._show_welcome()
            self.structure.set_part(None)
            self.preview.set_part(None)
            self.properties.show_node(None)
            self.problems.set_report(None, None)
            self.editor.set_text("", mark_undo=False)
            self._update_status()

    def cycle_document(self, delta: int) -> None:
        if len(self.documents) < 2 or self.document is None:
            return
        index = (self.documents.index(self.document) + delta) % len(self.documents)
        document = self.documents[index]
        self.activate(document, document.first_part())

    def activate(self, document: RibbonDocument, part: Optional[PartState]) -> None:
        self.document = document
        self.part = part
        self._hide_welcome()
        self._syncing = True
        try:
            if part is not None:
                self.editor.set_text(part.text, mark_undo=False)
                self.editor.text.edit_reset()
            else:
                self.editor.set_text("", mark_undo=False)
        finally:
            self._syncing = False
        self.structure.set_part(part)
        self.preview.set_part(part)
        self.properties.show_node(None)
        self.refresh_explorer()
        self.revalidate()
        self._update_status()
        if part is not None:
            self.part_label.configure(
                text=f"{part.label}   ·   {part.office_hint}")
        self.title(f"{document.name} - {APP_TITLE}")

    # -------------------------------------------------------------- explorer
    def refresh_explorer(self) -> None:
        signature = tuple(
            (document.name, document.dirty,
             tuple((variant, document.parts[variant].report.counts(),
                    len(document.parts[variant].images()),
                    document.parts[variant] is self.part)
                   for variant in document.variants()))
            for document in self.documents)
        if signature == getattr(self, "_explorer_signature", None):
            return
        self._explorer_signature = signature
        selected = self.explorer.selection()
        self.explorer.delete(*self.explorer.get_children(""))
        self._explorer_items.clear()
        for document in self.documents:
            marker = "●  " if document.dirty else ""
            item = self.explorer.insert("", "end", text=f"{marker}{document.name}",
                                        values=("",), open=True,
                                        tags=("dirty",) if document.dirty else ())
            self._explorer_items[item] = (document, None, "document")
            for variant in document.variants():
                part = document.parts[variant]
                errors, warnings, _ = part.report.counts()
                badge = f"{errors}⨯" if errors else (f"{warnings}!" if warnings else "")
                label = part.label if document.kind == KIND_PACKAGE else "ribbon XML"
                tags = ["error"] if errors else ([] if part is self.part else ["muted"])
                child = self.explorer.insert(item, "end", text=f"   {label}", values=(badge,),
                                             tags=tuple(tags))
                self._explorer_items[child] = (document, variant, "part")
                if part is self.part:
                    self.explorer.selection_set(child)
                images = part.images()
                if images:
                    node = self.explorer.insert(child, "end",
                                                text=f"   pictures ({len(images)})",
                                                values=("",), tags=("muted",))
                    self._explorer_items[node] = (document, variant, "images")
        if not self.explorer.selection() and selected:
            for item in selected:
                if item in self._explorer_items:
                    self.explorer.selection_set(item)

    def _on_explorer_select(self, _event=None) -> None:
        selection = self.explorer.selection()
        if not selection:
            return
        entry = self._explorer_items.get(selection[0])
        if entry is None:
            return
        document, variant, kind = entry
        if kind == "images":
            self.activate(document, document.parts.get(variant))
            self.show_images()
            return
        part = document.parts.get(variant) if variant else document.first_part()
        if document is not self.document or part is not self.part:
            self.activate(document, part)

    def _on_explorer_context(self, event) -> None:
        item = self.explorer.identify_row(event.y)
        if item:
            self.explorer.selection_set(item)
        entry = self._explorer_items.get(item)
        menu = make_menu(self, self.theme)
        if entry is not None:
            document, variant, _kind = entry
            menu.add_command(label="Save", command=self.save)
            menu.add_command(label="Save as...", command=self.save_as)
            menu.add_separator()
            if variant:
                menu.add_command(label=f"Remove {PART_LABEL[variant]}",
                                 command=lambda v=variant: self.remove_part(v))
                other = V2007 if variant == V2010 else V2010
                if other not in document.parts:
                    menu.add_command(label=f"Add {PART_LABEL[other]}",
                                     command=lambda v=other: self.add_part(v))
                menu.add_command(label="Embedded pictures...", command=self.show_images)
            menu.add_separator()
            if document.path:
                menu.add_command(label="Show in folder",
                                 command=lambda p=document.folder: _reveal(p))
            menu.add_command(label="Close document", command=self.close_document)
        else:
            menu.add_command(label="Open...", command=self.open_dialog)
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    # ------------------------------------------------------------- part edits
    def show_add_part_menu(self) -> None:
        menu = make_menu(self, self.theme)
        for variant in (V2010, V2007):
            state = "disabled" if self.document and variant in self.document.parts else "normal"
            menu.add_command(label=f"Add {PART_LABEL[variant]}", state=state,
                             command=lambda v=variant: self.add_part(v))
        try:
            menu.tk_popup(self.winfo_pointerx(), self.winfo_pointery())
        finally:
            menu.grab_release()

    def add_part(self, variant: str) -> None:
        if self.document is None:
            self.new_document()
            return
        if variant in self.document.parts:
            self.activate(self.document, self.document.parts[variant])
            return
        key = self._ask_template(variant)
        if key is None:
            return
        part = self.document.add_part(variant, key)
        self.refresh_explorer()
        self.activate(self.document, part)
        self.toast.show(f"Added {PART_LABEL[variant]}", "ok")

    def remove_part(self, variant: Optional[str] = None) -> None:
        if self.document is None:
            return
        variant = variant or (self.part.variant if self.part else None)
        if variant is None or variant not in self.document.parts:
            return
        if self.document.kind == KIND_XML:
            messagebox.showinfo("Not applicable",
                                "This is a loose XML file - close it instead.", parent=self)
            return
        if not messagebox.askyesno(
                "Remove part",
                f"Remove {PART_LABEL[variant]} from {self.document.name}?\n\n"
                f"The ribbon customisation it contains will be deleted when you save.",
                parent=self):
            return
        self.document.remove_part(variant)
        self.refresh_explorer()
        self.activate(self.document, self.document.first_part())

    # ------------------------------------------------------------------ save
    def save(self) -> bool:
        document = self.document
        if document is None:
            return False
        if not document.path:
            return self.save_as()
        if self.settings["confirm_overwrite_office"] and _looks_locked(document.path):
            if not messagebox.askyesno(
                    "File may be open",
                    f"{document.name} looks like it is open in Office right now.\n\n"
                    f"Office will not see the new ribbon until the file is closed and "
                    f"reopened, and saving from Office afterwards would overwrite these "
                    f"changes.\n\nSave anyway?", parent=self):
                return False
        return self._write(document, None)

    def save_as(self) -> bool:
        document = self.document
        if document is None:
            return False
        if document.kind == KIND_XML:
            filetypes = [("Ribbon XML", "*.xml"), ("All files", "*.*")]
            default = ".xml"
            initial = document.name if document.path else "customUI14.xml"
        else:
            extension = os.path.splitext(document.path)[1] or ".xlsm"
            filetypes = [(f"Office document (*{extension})", f"*{extension}"), ("All files", "*.*")]
            default = extension
            initial = document.name
        path = filedialog.asksaveasfilename(parent=self, title="Save as", defaultextension=default,
                                            initialfile=initial, filetypes=filetypes)
        if not path:
            return False
        return self._write(document, path)

    def _write(self, document: RibbonDocument, target: Optional[str]) -> bool:
        self._flush_editor()
        try:
            written = document.save(target, make_backup=bool(self.settings["backup_on_save"]))
        except (PackageError, OSError) as exc:
            messagebox.showerror("Could not save", str(exc), parent=self)
            return False
        self.settings.push_recent(written)
        self._refresh_recent_menu()
        self.refresh_explorer()
        self._update_status()
        self.title(f"{document.name} - {APP_TITLE}")
        backup = " (a .bak copy was kept)" if self.settings["backup_on_save"] else ""
        self.toast.show(f"Saved {os.path.basename(written)}{backup}", "ok")
        self.palette.mark_quest("save")
        return True

    def export_part(self) -> None:
        if self.part is None:
            return
        path = filedialog.asksaveasfilename(
            parent=self, title="Export part as XML", defaultextension=".xml",
            initialfile=PART_LABEL.get(self.part.variant, "customUI.xml"),
            filetypes=[("Ribbon XML", "*.xml"), ("All files", "*.*")])
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(self.editor.get_text())
        except OSError as exc:
            messagebox.showerror("Could not export", str(exc), parent=self)
            return
        self.toast.show(f"Exported {os.path.basename(path)}", "ok")

    def copy_xml(self) -> None:
        self.clipboard_clear()
        self.clipboard_append(self.editor.get_text())
        self.toast.show("XML copied to the clipboard", "ok")

    # ------------------------------------------------------------ sync logic
    def _flush_editor(self) -> None:
        if self.part is None:
            return
        text = self.editor.get_text()
        if text != self.part.text:
            self.part.set_text(text)
            self.part.flush()
        else:
            self.part.flush()

    @staticmethod
    def _tree_signature(document) -> int:
        from .core.xmldoc import tree_signature
        return tree_signature(document)

    def on_editor_change(self) -> None:
        if self._syncing or self.part is None:
            return
        old_signature = self._tree_signature(self.part.tree)
        self.part.set_text(self.editor.get_text())
        new_signature = self._tree_signature(self.part.tree)
        structure_changed = new_signature != old_signature

        if structure_changed:
            selected = self.structure.selected_node()
            key = selected.path_key() if selected is not None else None
            self.structure.rebuild()
            if key:
                node = self.part.tree.find_path(key)
                if node is not None:
                    self.structure.select_uid(node.uid, notify=False)
                    self.properties.show_node(node, self.part.report)
                    self.preview.selected_uid = node.uid
            self.preview.refresh()
        self.revalidate(reparse=False, rebuild_tree=structure_changed)
        self.refresh_explorer()
        self._update_status()

    def on_tree_change(self, description: str, source: str = "tree") -> None:
        """A structured edit happened - re-serialise and push into the editor."""
        if self.part is None:
            return
        node = self.structure.selected_node() or self.properties.node
        key = node.path_key() if node is not None else None
        text = self.part.tree.serialize(
            indent=self.settings["indent"],
            wrap_attrs=bool(self.settings["wrap_attributes"]),
            wrap_width=int(self.settings["wrap_width"]))
        self._syncing = True
        try:
            self.editor.set_text(text, keep_view=True)
            self.part.set_text(text)
        finally:
            self._syncing = False
        self.structure.rebuild()
        target = self.part.tree.find_path(key) if key else None
        if target is not None:
            self.structure.select_uid(target.uid, notify=False)
            if source == "props":
                # Re-point the panel at the reparsed node without rebuilding
                # its widgets - a full re-render would steal the focus from
                # the field the user is typing in.
                self.properties.retarget(target, self.part.report)
            else:
                self.properties.show_node(target, self.part.report)
            self.preview.select_node(target)
        else:
            self.preview.refresh()
        self.revalidate(reparse=False, rebuild_tree=False)
        self.refresh_explorer()
        self._update_status(description)
        if description.startswith(("Set imageMso", "Set image")):
            self.palette.mark_quest("icon")
        elif description.startswith("Set label"):
            self.palette.mark_quest("label")

    def on_node_selected(self, node: Optional[Node]) -> None:
        self.properties.show_node(node, self.part.report if self.part else None)
        self.preview.select_node(node)
        if node is not None and node.start >= 0 and self.part is not None:
            start = node.position()
            end = node.end_position()
            self.editor.highlight_range(start, end)
        else:
            self.editor.clear_node_highlight()

    def on_preview_select(self, node: Node) -> None:
        self.structure.select_node(node, notify=False)
        self.on_node_selected(node)
        self.palette.mark_quest("preview")

    def focus_node_in_editor(self, node: Node) -> None:
        line, column = node.position()
        self.editor.goto(line, column)
        self.editor.focus_editor()

    def on_editor_caret_node(self, line: int, column: int) -> None:
        if self.part is None or not self.part.parse_ok:
            return
        offset = self.part.document.pos_to_offset(line, column)
        node = self.part.document.node_at_offset(offset)
        if node is None:
            return
        self.structure.select_uid(node.uid, notify=False)
        self.properties.show_node(node, self.part.report)
        self.preview.select_node(node)

    def on_caret_move(self, line: int, column: int) -> None:
        variant = self.part.variant if self.part else ""
        label = PART_LABEL.get(variant, "")
        self.status_right.configure(text=f"Ln {line}, Col {column + 1}    {label}")

    # ------------------------------------------------------------ validation
    def revalidate(self, reparse: bool = True, rebuild_tree: bool = True) -> None:
        if self.part is None:
            self.problems.set_report(None, None)
            return
        if reparse:
            self.part.reparse()
        report = self.part.validate(strict_imagemso=bool(self.settings["strict_imagemso"]))
        self.problems.set_report(report, self.part)
        if rebuild_tree:
            self.structure.rebuild()
        lines = {}
        for issue in report.issues:
            existing = lines.get(issue.line)
            if existing == "error":
                continue
            lines[issue.line] = issue.severity
        self.editor.set_issue_lines(lines)
        errors, warnings, infos = report.counts()
        self._autosize_problems(len(report.issues))
        self.chip_error.set(str(errors), "error")
        self.chip_warn.set(str(warnings), "warn")
        self.chip_info.set(str(infos), "info")
        if self.part.parse_ok:
            self.parse_chip.set("well formed", "ok")
        else:
            self.parse_chip.set("XML not well formed", "error")

    def _autosize_problems(self, count: int) -> None:
        """Keep the problems pane out of the way until there is something in it."""
        if not self.show_problems_var.get():
            return
        try:
            total = self.centre_panes.winfo_height()
            if total < 200:
                return
            current = total - self.centre_panes.sashpos(1)
            header = 34
            if count == 0 and current > header + 12:
                self.centre_panes.sashpos(1, total - header)
            elif count and current < header + 12:
                self.centre_panes.sashpos(1, total - min(190, max(90, 40 + count * 26)))
        except tk.TclError:
            pass

    def validate_now(self) -> None:
        if self.part is None:
            return
        self._flush_editor()
        self.revalidate()
        errors, warnings, _ = self.part.report.counts()
        if errors:
            self.toast.show(f"{errors} error{'s' if errors != 1 else ''} found", "error")
            self.show_problems_var.set(True)
            self._apply_visibility()
        elif warnings:
            self.toast.show(f"No errors, {warnings} warning{'s' if warnings != 1 else ''}", "warn")
        else:
            self.toast.show("This ribbon is valid", "ok")

    def goto_issue(self, issue) -> None:
        self.editor.goto(issue.line, issue.column)
        self.editor.focus_editor()
        if issue.node_uid and self.part is not None:
            node = self.part.tree.find_uid(issue.node_uid)
            if node is not None:
                self.structure.select_uid(node.uid, notify=False)
                self.properties.show_node(node, self.part.report)
                self.preview.select_node(node)

    def apply_fix(self, issue) -> None:
        if self.part is None:
            return
        if validator.apply_fix(self.part.tree, issue, self.part.variant):
            self.on_tree_change(f"Fix {issue.code}")
            self.toast.show("Fixed", "ok")

    # -------------------------------------------------------------- commands
    def format_document(self) -> None:
        if self.part is None:
            return
        self._flush_editor()
        if not self.part.parse_ok:
            messagebox.showwarning(
                "Cannot reformat",
                "The XML has to be well formed before it can be reformatted.\n\n"
                f"{self.part.document.error}", parent=self)
            return
        text = self.part.document.serialize(
            indent=self.settings["indent"],
            wrap_attrs=bool(self.settings["wrap_attributes"]),
            wrap_width=int(self.settings["wrap_width"]))
        self._syncing = True
        try:
            self.editor.set_text(text, keep_view=True)
            self.part.set_text(text)
        finally:
            self._syncing = False
        self.structure.rebuild()
        self.preview.refresh()
        self.revalidate(reparse=False)
        self.toast.show("Document reformatted", "ok")

    def show_insert_menu(self) -> None:
        if self.part is None:
            return
        if self.structure.selected_node() is None and self.part.tree.root is not None:
            self.structure.select_uid(self.part.tree.root.uid, notify=True)
        menu = make_menu(self, self.theme)
        node = self.structure.selected_node()
        options = self.structure.insert_options(node) if node else []
        if options:
            for elem in options:
                menu.add_command(label=f"  {elem.glyph}   {elem.name}",
                                 command=lambda k=elem.key: self.structure.insert_child(k))
            menu.add_separator()
        snippets = make_menu(menu, self.theme)
        for name, body in templates.SNIPPETS.items():
            snippets.add_command(label=name, command=lambda b=body: self.insert_snippet(b))
        menu.add_cascade(label="Paste a snippet at the caret", menu=snippets)
        try:
            menu.tk_popup(self.winfo_pointerx(), self.winfo_pointery())
        finally:
            menu.grab_release()

    def insert_snippet(self, body: str) -> None:
        indent = self.editor._current_indent()
        text = "\n".join((indent + line) if index else line
                         for index, line in enumerate(body.splitlines()))
        self.editor.text.edit_separator()
        self.editor.text.insert("insert", text)
        self.editor.highlight()
        self.on_editor_change()

    def show_callbacks(self) -> None:
        if self.part is None:
            return
        self._flush_editor()
        dialogs.CallbackDialog(self, self.theme, self.part.tree, self.settings).show()

    def show_callback_for(self, attribute: str) -> None:
        node = self.properties.node
        if node is None or self.part is None:
            return
        name = node.get(attribute) or ""
        dialogs.CallbackDialog(self, self.theme, self.part.tree, self.settings,
                               highlight=f"Sub {name}(").show()

    def show_images(self) -> None:
        if self.document is None or self.part is None:
            return
        if self.document.package is None:
            messagebox.showinfo(
                "Pictures need a package",
                "Embedded pictures live inside the Office file. Open an .xlsm/.xlam "
                "(or another Open XML document) to manage them.", parent=self)
            return
        dialogs.ImageManager(self, self.theme, self.document.package, self.part,
                             on_change=self._after_image_change).show()

    def _after_image_change(self) -> None:
        self.properties.refresh()
        self.preview.refresh()
        self.revalidate(reparse=False)
        self.refresh_explorer()

    def import_image(self) -> Optional[str]:
        if self.document is None or self.part is None or self.document.package is None:
            messagebox.showinfo("Pictures need a package",
                                "Open an Office document to embed pictures.", parent=self)
            return None
        path = filedialog.askopenfilename(
            parent=self, title="Import a picture",
            filetypes=[("Pictures", "*.png *.jpg *.jpeg *.gif *.bmp *.ico"), ("All files", "*.*")])
        if not path:
            return None
        try:
            with open(path, "rb") as handle:
                data = handle.read()
            image = self.document.package.add_image(self.part.variant, data,
                                                    os.path.basename(path))
        except (OSError, PackageError) as exc:
            messagebox.showerror("Could not import", str(exc), parent=self)
            return None
        self.document.touch()
        self._after_image_change()
        self.toast.show(f"Embedded {image.file_name} as {image.rel_id}", "ok")
        return image.rel_id

    def pick_image_mso(self, current: str) -> Optional[str]:
        return dialogs.IconGallery(self, self.theme, current).show()

    def pick_control_mso(self, current: str) -> Optional[str]:
        return dialogs.ControlIdBrowser(self, self.theme, current).show()

    def _image_ids(self) -> List[str]:
        return self.part.image_ids() if self.part else []

    def _image_bytes(self, rel_id: str) -> Optional[bytes]:
        if not rel_id or self.part is None:
            return None
        for image in self.part.images():
            if image.rel_id == rel_id:
                return image.data
        return None

    # ----------------------------------------------------------- completions
    def provide_completions(self, context: CompletionContext) -> List[Completion]:
        if self.part is None:
            return []
        items: List[Completion] = []
        if context.kind == "element":
            key = schema.key_for_chain(context.stack) if context.stack else None
            if key is None and not context.stack:
                items.append(Completion("customUI", f'customUI xmlns="{self.part.namespace}">$0',
                                        "root element"))
                return items
            elem = schema.SCHEMA.get(key) if key else None
            if elem is None:
                return []
            for child_key in elem.children:
                child = schema.SCHEMA.get(child_key)
                if child is None:
                    continue
                attrs = schema.DEFAULT_ATTRS.get(child_key, {})
                rendered = " ".join(f'{k}="{v}"' for k, v in attrs.items())
                body = f"{child.name}{' ' + rendered if rendered else ''}"
                closing = "/>" if not child.children else f"></{child.name}>"
                items.append(Completion(child.name, body + closing, child.doc.split(".")[0][:44]))
            return items

        if context.kind == "attribute":
            key = schema.key_for_chain(context.stack + [context.tag])
            elem = schema.SCHEMA.get(key) if key else schema.any_elem_named(context.tag)
            if elem is None:
                return []
            for attr in elem.attrs:
                if attr.name in context.used_attributes:
                    continue
                items.append(Completion(attr.name, f'{attr.name}="$0"',
                                        attr.doc.split(".")[0][:46], attr.kind))
            return items

        if context.kind == "value":
            key = schema.key_for_chain(context.stack + [context.tag])
            elem = schema.SCHEMA.get(key) if key else schema.any_elem_named(context.tag)
            attr = elem.attr(context.attribute) if elem else None
            if attr is None:
                return []
            if attr.name == "xmlns":
                return [Completion(NAMESPACE_FOR[V2010], detail="Office 2010+"),
                        Completion(NAMESPACE_FOR[V2007], detail="Office 2007")]
            if attr.kind == schema.BOOL or set(attr.values) == {"true", "false"}:
                return [Completion("true"), Completion("false")]
            if attr.values:
                return [Completion(value) for value in attr.values]
            if attr.kind == schema.IMAGE_MSO:
                return [Completion(name, detail=category)
                        for name, category in msodata.FLAT_IMAGE_MSO]
            if attr.kind == schema.CONTROL_MSO:
                return [Completion(name, detail=category)
                        for name, category in msodata.FLAT_CONTROL_IDMSO]
            if attr.kind == schema.IMAGE:
                return [Completion(rid, detail="embedded picture") for rid in self._image_ids()]
            if attr.kind == schema.CALLBACK:
                names = sorted({c.name for c in cbmod.collect(self.part.tree)})
                suggestion = _suggest_callback(context.tag, attr.name)
                return ([Completion(suggestion, detail="new")] if suggestion else []) + \
                       [Completion(name, detail="already used") for name in names]
        return []

    # ------------------------------------------------------------------ view
    def set_view_mode(self, mode: str) -> None:
        self.view_mode = mode
        self.show_preview_var.set(mode != "xml")
        self._apply_visibility()
        if mode == "design":
            self.preview.set_zoom(max(self.preview.zoom, 1.3))

    def _apply_visibility(self) -> None:
        """Rebuild the centre panes so their order is always preview / editor /
        problems, whichever of them are switched on."""
        if not self.show_preview_var.get() and self.view_mode not in ("xml",):
            self.view_mode = "xml"
        elif self.show_preview_var.get() and self.view_mode == "xml":
            self.view_mode = "both"
        if hasattr(self, "view_switch"):
            self.view_switch.select(self.view_mode, notify=False)

        design = self.view_mode == "design"
        self.drag_controller.enabled = design
        if design:
            self.palette.pack(side="right", fill="y")
        else:
            self.palette.pack_forget()

        wanted = []
        if self.view_mode in ("both", "preview", "design"):
            wanted.append((self.design_row, 3 if design or self.view_mode == "preview" else 0))
        if self.view_mode in ("both", "xml"):
            wanted.append((self.editor.master, 3))
        if self.show_problems_var.get():
            wanted.append((self.problems, 0))

        try:
            current = list(self.centre_panes.panes())
            if [str(widget) for widget, _ in wanted] != current:
                for pane in current:
                    self.centre_panes.forget(pane)
                for widget, weight in wanted:
                    self.centre_panes.add(widget, weight=weight)
                self.after_idle(self._reset_centre_sashes)

            main_panes = list(self.main.panes())
            if self.show_props_var.get():
                if str(self.properties) not in main_panes:
                    self.main.add(self.properties, weight=0)
            elif str(self.properties) in main_panes:
                self.main.forget(self.properties)
        except tk.TclError:
            pass
        self.settings["show_preview"] = bool(self.show_preview_var.get())
        self.settings["show_properties"] = bool(self.show_props_var.get())
        self.settings["show_problems"] = bool(self.show_problems_var.get())

    def _preview_mode_changed(self, mode: str) -> None:
        """Backstage pages and context menus need more vertical room than a ribbon."""
        if self.view_mode != "both":
            return
        try:
            self.centre_panes.sashpos(0, 182 if mode == "ribbon" else 330)
        except (tk.TclError, IndexError):
            pass

    def _reset_centre_sashes(self, attempt: int = 0) -> None:
        """Lay the centre panes out again.

        Sash positions clamp against their neighbours, so they have to be set
        from the bottom up - otherwise the first sash is pinned to whatever
        the (still collapsed) one below it happens to be.
        """
        try:
            self.centre_panes.update_idletasks()
            panes = [str(pane) for pane in self.centre_panes.panes()]
            total = self.centre_panes.winfo_height()
        except tk.TclError:
            return
        if total < 150:
            if attempt < 8:
                self.after(50, lambda: self._reset_centre_sashes(attempt + 1))
            return
        if len(panes) < 2:
            return

        targets = []
        if str(self.problems) in panes:
            issues = len(self.part.report.issues) if self.part else 0
            height = 34 if not issues else min(190, max(90, 40 + issues * 26))
            targets.append((len(panes) - 2, max(120, total - height)))
        if str(self.design_row) in panes and str(self.editor.master) in panes:
            targets.append((0, 182))

        try:
            for index, position in sorted(targets, reverse=True):
                self.centre_panes.sashpos(index, position)
            self.centre_panes.update_idletasks()
            missed = any(abs(self.centre_panes.sashpos(i) - pos) > 10 for i, pos in targets)
        except (tk.TclError, IndexError):
            return
        if missed and attempt < 3:
            self.after(40, lambda: self._reset_centre_sashes(attempt + 1))

    def cycle_panel(self) -> None:
        order = [self.structure.tree, self.editor.text, self.preview.canvas]
        try:
            current = self.focus_get()
            index = (order.index(current) + 1) % len(order) if current in order else 0
        except (ValueError, tk.TclError):
            index = 0
        order[index].focus_set()

    def toggle_theme(self) -> None:
        self.set_theme("light" if self.theme.name == "dark" else "dark")

    def set_theme(self, name: str) -> None:
        self.settings["theme"] = name
        self.theme.set_theme(name)
        self.configure(background=self.theme.c("bg"))
        self._restyle_static()

    def _restyle_static(self) -> None:
        c = self.theme
        for widget, kwargs in (
            (self.toolbar, {"background": c.c("panel")}),
            (self.statusbar, {"background": c.c("panel")}),
            (self.status_chips, {"background": c.c("panel")}),
            (self.centre, {"background": c.c("bg")}),
        ):
            try:
                widget.configure(**kwargs)
            except tk.TclError:
                pass
        for label, colour in ((self.status_left, "text_dim"), (self.status_right, "text_faint"),
                              (self.part_label, "text_dim")):
            try:
                label.configure(background=c.c("panel"), foreground=c.c(colour))
            except tk.TclError:
                pass
        for widget in self.toolbar.winfo_children():
            if isinstance(widget, tk.Label):
                widget.configure(background=c.c("panel"))
        self.explorer.tag_configure("dirty", foreground=c.c("accent"))
        self.explorer.tag_configure("error", foreground=c.c("error"))
        self.explorer.tag_configure("muted", foreground=c.c("text_dim"))
        if self.welcome is not None:
            self.welcome.restyle()

    def show_preferences(self) -> None:
        def apply() -> None:
            self.theme.set_theme(self.settings["theme"])
            self.theme.set_accent(self.settings["accent"])
            self.theme.set_ui_size(int(self.settings["ui_font_size"]))
            self.theme.set_mono(self.settings["editor_font"], int(self.settings["editor_font_size"]))
            self.configure(background=self.theme.c("bg"))
            self._restyle_static()
            self.revalidate(reparse=False)

        dialogs.Preferences(self, self.theme, self.settings, apply).show()
        self.settings.save()

    def show_palette(self) -> None:
        commands = [
            ("Open workbook or XML...", "Ctrl+O", self.open_dialog),
            ("New ribbon from template...", "Ctrl+N", self.new_document),
            ("Save", "Ctrl+S", self.save),
            ("Save as...", "Ctrl+Shift+S", self.save_as),
            ("Close document", "Ctrl+W", self.close_document),
            ("Validate the ribbon", "F5", self.validate_now),
            ("Reformat the XML", "Ctrl+Shift+F", self.format_document),
            ("Generate VBA callbacks...", "F9", self.show_callbacks),
            ("Manage embedded pictures...", "", self.show_images),
            ("Browse the icon gallery...", "", lambda: self.pick_image_mso("")),
            ("Browse built-in control ids...", "", lambda: self.pick_control_mso("")),
            ("Add customUI14.xml part", "", lambda: self.add_part(V2010)),
            ("Add customUI.xml part", "", lambda: self.add_part(V2007)),
            ("Remove the current part", "", self.remove_part),
            ("Export this part as XML...", "", self.export_part),
            ("Copy the XML to the clipboard", "", self.copy_xml),
            ("Toggle the live preview", "", lambda: (self.show_preview_var.set(
                not self.show_preview_var.get()), self._apply_visibility())),
            ("Toggle the properties panel", "", lambda: (self.show_props_var.set(
                not self.show_props_var.get()), self._apply_visibility())),
            ("Toggle the problems panel", "", lambda: (self.show_problems_var.set(
                not self.show_problems_var.get()), self._apply_visibility())),
            ("Switch to the dark theme", "", lambda: self.set_theme("dark")),
            ("Switch to the light theme", "", lambda: self.set_theme("light")),
            ("Preferences...", "", self.show_preferences),
            ("Keyboard shortcuts", "F1", lambda: dialogs.ShortcutsDialog(self, self.theme).show()),
            ("Expand the whole structure tree", "", self.structure.expand_all),
            ("Collapse the structure tree", "", self.structure.collapse_all),
            ("About RibbonForge", "", lambda: dialogs.AboutDialog(self, self.theme, __version__).show()),
        ]
        dialogs.CommandPalette(self, self.theme, commands)

    def _select_all_text(self, _event=None) -> str:
        self.editor.text.tag_add("sel", "1.0", "end-1c")
        self.editor.text.mark_set("insert", "1.0")
        return "break"

    # ------------------------------------------------------------- designer
    def designer_insert(self, key: str, target: Node) -> None:
        """A palette card was dropped on ``target`` in the preview."""
        if self.part is None:
            return
        child = schema.make_node(key, __import__("ribbonforge.core.xmldoc", fromlist=["build"]))
        if child is None:
            return
        self.structure._ensure_unique_ids(child)
        target.add(child)
        self.on_tree_change(f"Add {child.local}")
        self.structure.select_uid(child.uid)
        elem = schema.SCHEMA.get(key)
        self.toast.show(f"{elem.glyph}  Added a {elem.name} to <{target.tag}>", "ok", 1800)

    def designer_move(self, node: Node, target: Node) -> None:
        if self.part is None or node.parent is None:
            return
        if target is not node.parent:
            node.parent.remove(node)
            target.add(node)
        self.on_tree_change(f"Move {node.local}")
        self.structure.select_uid(node.uid)

    def _quest_done(self, key: str) -> None:
        titles = dict(__import__("ribbonforge.ui.designer", fromlist=["QUESTS"]).QUESTS)
        self.settings["quests"] = dict(self.palette.quests)
        done = sum(1 for value in self.palette.quests.values() if value)
        self.toast.show(f"✓  {titles.get(key, key)}   ({done}/{len(titles)})", "ok", 1600)

    def _editor_edit(self, action: str) -> None:
        try:
            if action == "undo":
                self.editor.text.edit_undo()
            else:
                self.editor.text.edit_redo()
        except tk.TclError:
            return
        self.editor.highlight()
        self.on_editor_change()

    def _rebuild_insert_menu(self) -> None:
        menu = self.insert_menu
        menu.delete(0, "end")
        for name, body in templates.SNIPPETS.items():
            menu.add_command(label=name, command=lambda b=body: self.insert_snippet(b))

    def _refresh_recent_menu(self) -> None:
        self.recent_menu.delete(0, "end")
        recent = self.settings.recent
        if not recent:
            self.recent_menu.add_command(label="(nothing yet)", state="disabled")
            return
        for path in recent:
            label = os.path.basename(path)
            folder = os.path.dirname(path)
            self.recent_menu.add_command(
                label=f"{label}      {folder}",
                command=lambda p=path: self.open_path(p))
        self.recent_menu.add_separator()
        self.recent_menu.add_command(label="Clear the list",
                                     command=lambda: (self.settings.clear_recent(),
                                                      self._refresh_recent_menu()))

    # -------------------------------------------------------------- welcome
    def _show_welcome(self) -> None:
        if self.welcome is None:
            return
        self.welcome.refresh()
        self.welcome.place(relx=0, rely=0, relwidth=1, relheight=1)
        self.welcome.lift()

    def _hide_welcome(self) -> None:
        if self.welcome is not None:
            self.welcome.place_forget()

    # --------------------------------------------------------------- status
    def _update_status(self, message: str = "") -> None:
        document = self.document
        if document is None:
            self.status_left.configure(text="Ready  ·  open a workbook to begin")
            self.title(APP_TITLE)
            return
        bits = [document.path or "(not saved yet)"]
        if document.dirty:
            bits.append("modified")
        if message:
            bits.append(message)
        self.status_left.configure(text="   ·   ".join(bits))
        self.title(f"{'*' if document.dirty else ''}{document.name} - {APP_TITLE}")

    # ----------------------------------------------------------------- close
    def on_close(self) -> None:
        for document in list(self.documents):
            if document.dirty:
                answer = messagebox.askyesnocancel(
                    "Unsaved changes",
                    f"Save the changes to {document.name} before closing?", parent=self)
                if answer is None:
                    return
                if answer:
                    self.document = document
                    self.part = document.first_part()
                    if not self.save():
                        return
        try:
            self.settings["geometry"] = self.geometry()
            self.settings["sash_tree"] = int(self.main.sashpos(0))
            self.settings["sash_props"] = max(240, self.winfo_width() - int(self.main.sashpos(1)))
            self.settings["preview_zoom"] = float(self.preview.zoom)
        except (tk.TclError, ValueError):
            pass
        self.settings.save()
        self.destroy()


class ProblemsPanel(tk.Frame):
    """Errors, warnings and hints with jump-to-source and one-click fixes."""

    def __init__(self, master, theme, on_activate: Callable, on_fix: Callable) -> None:
        super().__init__(master, background=theme.c("panel"))
        self.theme = theme
        self.on_activate = on_activate
        self.on_fix = on_fix
        self.report = None
        self.part = None
        self._issues: Dict[str, object] = {}

        header = PanelHeader(self, theme, "Problems", "⚠")
        header.pack(fill="x")
        self.summary = tk.Label(header.tools, text="", background=theme.c("panel"),
                                foreground=theme.c("text_faint"), font=theme.font("small"))
        self.summary.pack(side="left", padx=8)
        self.fix_button = ToolButton(header.tools, theme, text="Fix", glyph="✚", compact=True,
                                     tooltip="Apply the suggested fix to the selected problem",
                                     command=self._fix_selected)
        self.fix_button.pack(side="left")

        holder = tk.Frame(self, background=theme.c("panel"))
        holder.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(holder, style="Plain.Treeview", columns=("where",),
                                 show="tree", selectmode="browse", height=1)
        self.tree.column("#0", width=560, stretch=True)
        self.tree.column("where", width=90, stretch=False, anchor="e")
        scroll = ttk.Scrollbar(holder, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        self.tree.bind("<Double-Button-1>", self._activate)
        self.tree.bind("<Return>", self._activate)
        self.tree.tag_configure("error", foreground=theme.c("error"))
        self.tree.tag_configure("warning", foreground=theme.c("warn"))
        self.tree.tag_configure("info", foreground=theme.c("text_dim"))
        theme.subscribe(self._restyle)

    def set_report(self, report, part) -> None:
        self.report = report
        self.part = part
        self.tree.delete(*self.tree.get_children(""))
        self._issues.clear()
        if report is None:
            self.summary.configure(text="")
            return
        errors, warnings, infos = report.counts()
        if not report.issues:
            self.summary.configure(text="no problems found")
        else:
            self.summary.configure(text=f"{errors} errors · {warnings} warnings · {infos} hints")
        glyphs = {"error": "⨯", "warning": "!", "info": "i"}
        for issue in report.issues:
            text = f" {glyphs.get(issue.severity, '·')}   {issue.message}"
            if issue.hint:
                text += f"      {issue.hint}"
            if validator.can_fix(issue):
                text += "   [fixable]"
            item = self.tree.insert("", "end", text=text, values=(f"line {issue.line}",),
                                    tags=(issue.severity,))
            self._issues[item] = issue

    def _selected_issue(self):
        selection = self.tree.selection()
        return self._issues.get(selection[0]) if selection else None

    def _activate(self, _event=None) -> None:
        issue = self._selected_issue()
        if issue is not None:
            self.on_activate(issue)

    def _fix_selected(self) -> None:
        issue = self._selected_issue()
        if issue is not None and validator.can_fix(issue):
            self.on_fix(issue)

    def _restyle(self) -> None:
        c = self.theme
        try:
            self.configure(background=c.c("panel"))
            self.summary.configure(background=c.c("panel"), foreground=c.c("text_faint"))
            self.tree.tag_configure("error", foreground=c.c("error"))
            self.tree.tag_configure("warning", foreground=c.c("warn"))
            self.tree.tag_configure("info", foreground=c.c("text_dim"))
        except tk.TclError:
            pass


class WelcomeScreen(tk.Frame):
    """Shown when nothing is open."""

    def __init__(self, master, theme, app: "RibbonForgeApp") -> None:
        super().__init__(master, background=theme.c("bg"))
        self.theme = theme
        self.app = app
        self.build()

    def build(self) -> None:
        for child in self.winfo_children():
            child.destroy()
        c = self.theme
        self.configure(background=c.c("bg"))
        centre = tk.Frame(self, background=c.c("bg"))
        centre.place(relx=0.5, rely=0.42, anchor="center")

        tk.Label(centre, text="⬢", background=c.c("bg"), foreground=c.c("accent"),
                 font=(c.ui_family, 46)).pack()
        tk.Label(centre, text="RibbonForge", background=c.c("bg"), foreground=c.c("text"),
                 font=(c.ui_family, 26, "bold")).pack(pady=(6, 0))
        tk.Label(centre, text="Design, validate and embed Excel ribbons",
                 background=c.c("bg"), foreground=c.c("text_dim"),
                 font=c.font("ui")).pack(pady=(2, 22))

        row = tk.Frame(centre, background=c.c("bg"))
        row.pack()
        ToolButton(row, c, text="Open a workbook", glyph="📂", accent=True, padx=18, pady=9,
                   command=self.app.open_dialog).pack(side="left", padx=6)
        ToolButton(row, c, text="Start a new ribbon", glyph="✚", padx=18, pady=9,
                   command=self.app.new_document).pack(side="left", padx=6)

        recent = self.app.settings.recent[:6]
        if recent:
            tk.Label(centre, text="RECENT", background=c.c("bg"), foreground=c.c("text_faint"),
                     font=c.font("small_bold")).pack(pady=(26, 6))
            for path in recent:
                item = tk.Frame(centre, background=c.c("bg"), cursor="hand2")
                item.pack(fill="x", pady=1)
                name = tk.Label(item, text=os.path.basename(path), background=c.c("bg"),
                                foreground=c.c("accent"), font=c.font("ui"), anchor="w")
                name.pack(side="left")
                folder = tk.Label(item, text="   " + os.path.dirname(path), background=c.c("bg"),
                                  foreground=c.c("text_faint"), font=c.font("small"), anchor="w")
                folder.pack(side="left")
                for widget in (item, name, folder):
                    widget.bind("<Button-1>", lambda _e, p=path: self.app.open_path(p))

        tk.Label(self, text="Ctrl+Shift+P for the command palette   ·   F1 for keyboard shortcuts",
                 background=c.c("bg"), foreground=c.c("text_faint"),
                 font=c.font("small")).place(relx=0.5, rely=0.93, anchor="center")

    def refresh(self) -> None:
        self.build()

    def restyle(self) -> None:
        self.build()


def _suggest_callback(tag: str, attribute: str) -> str:
    stem = attribute[3:] if attribute.startswith("get") else attribute
    stem = stem[0].upper() + stem[1:] if stem else "Action"
    prefix = "Get" if attribute.startswith("get") else ("On" if attribute.startswith("on") else "")
    if attribute.startswith("on"):
        stem = attribute[2:]
        stem = stem[0].upper() + stem[1:] if stem else "Action"
    base = tag[0].upper() + tag[1:]
    return f"{prefix}{base}{stem}"


def _looks_locked(path: str) -> bool:
    """Office keeps a ~$ lock file next to open documents."""
    folder, name = os.path.split(path)
    return os.path.exists(os.path.join(folder, "~$" + name))


def _reveal(folder: str) -> None:
    try:
        if sys.platform.startswith("win"):
            os.startfile(folder)  # noqa: S606 - user-initiated
        elif sys.platform == "darwin":
            os.system(f'open "{folder}"')
        else:
            os.system(f'xdg-open "{folder}"')
    except OSError:
        pass


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    app = RibbonForgeApp(argv)
    app.mainloop()
    return 0
