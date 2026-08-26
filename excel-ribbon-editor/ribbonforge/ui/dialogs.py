"""Modal dialogs: icon gallery, control browser, templates, embedded images,
callback generator, preferences, command palette and about."""

from __future__ import annotations

import os
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Callable, Dict, Optional, Sequence, Tuple

from ..core import callbacks as cb
from ..core import msodata, templates
from ..core.ooxml import PackageError
from .icons import IconCache, rounded_rect
from .widgets import (Chip, ScrollFrame, SearchEntry, Separator, ToolButton,
                      bind_mousewheel, center_window)


class Dialog(tk.Toplevel):
    """Base modal window with the app's chrome."""

    def __init__(self, parent, theme, title: str, width: int = 720, height: int = 520,
                 subtitle: str = "") -> None:
        super().__init__(parent)
        self.theme = theme
        self.result = None
        self.withdraw()
        self.title(title)
        self.configure(background=theme.c("panel"))
        self.transient(parent)
        self.resizable(True, True)
        self.minsize(360, 240)

        head = tk.Frame(self, background=theme.c("panel"))
        head.pack(fill="x", padx=18, pady=(16, 6))
        tk.Label(head, text=title, background=theme.c("panel"), foreground=theme.c("text"),
                 font=theme.font("h2"), anchor="w").pack(fill="x")
        if subtitle:
            tk.Label(head, text=subtitle, background=theme.c("panel"),
                     foreground=theme.c("text_dim"), font=theme.font("small"),
                     anchor="w", justify="left", wraplength=width - 60).pack(fill="x", pady=(3, 0))

        self.body = tk.Frame(self, background=theme.c("panel"))
        self.body.pack(fill="both", expand=True, padx=18, pady=8)

        Separator(self, theme).pack(fill="x")
        self.footer = tk.Frame(self, background=theme.c("panel"))
        self.footer.pack(fill="x", padx=18, pady=12)

        self.bind("<Escape>", lambda _e: self.cancel())
        self.protocol("WM_DELETE_WINDOW", self.cancel)
        center_window(self, parent, width, height)

    def add_button(self, text: str, command: Callable, accent: bool = False,
                   side: str = "right") -> ToolButton:
        button = ToolButton(self.footer, self.theme, text=text, command=command, accent=accent,
                            padx=16, pady=6)
        button.pack(side=side, padx=(6, 0) if side == "right" else (0, 6))
        return button

    def show(self):
        self.deiconify()
        self.lift()
        self.focus_force()
        self.grab_set()
        self.wait_window()
        return self.result

    def cancel(self) -> None:
        self.result = None
        self.destroy()

    def accept(self, value=None) -> None:
        self.result = value
        self.destroy()


class IconGallery(Dialog):
    """Browse and pick an imageMso identifier.

    Renders only the visible rows, so scrolling through all 3,244 icons
    stays instant. When the downloadable icon pack is installed the tiles
    show Microsoft's real artwork; otherwise a neutral monogram.
    """

    CELL_W, CELL_H = 100, 78

    def __init__(self, parent, theme, current: str = "") -> None:
        from ..core import msoicons
        self.msoicons = msoicons
        super().__init__(parent, theme, "Icon gallery", 820, 600,
                         subtitle=f"All {len(msoicons.load_index()):,} built-in imageMso "
                                  f"identifiers, searchable by name.")
        self.icons = IconCache(theme)
        self.selected = current
        self._items = msodata.FLAT_IMAGE_MSO
        self._columns = 1
        self._render_job = None

        top = tk.Frame(self.body, background=theme.c("panel"))
        top.pack(fill="x", pady=(0, 8))
        self.search = SearchEntry(top, theme, placeholder="Search icons", command=self._filter, width=24)
        self.search.pack(side="left")
        self.category = ttk.Combobox(top, values=["All categories"] + list(msodata.IMAGE_MSO),
                                     state="readonly", width=22)
        self.category.current(0)
        self.category.bind("<<ComboboxSelected>>", lambda _e: self._filter(self.search.value))
        self.category.pack(side="left", padx=8)
        self.count = tk.Label(top, text="", background=theme.c("panel"),
                              foreground=theme.c("text_faint"), font=theme.font("small"))
        self.count.pack(side="left", padx=6)

        holder = tk.Frame(self.body, background=theme.c("code_bg"), highlightthickness=1,
                          highlightbackground=theme.c("border"))
        holder.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(holder, background=theme.c("code_bg"), highlightthickness=0, bd=0)
        self.vbar = ttk.Scrollbar(holder, orient="vertical", command=self._yview)
        self.canvas.configure(yscrollcommand=self._on_scrolled)
        self.vbar.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _e: self._layout())
        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<Double-Button-1>", self._on_double)
        bind_mousewheel(self.canvas, self.canvas)

        if not msoicons.is_installed():
            self.pack_bar = tk.Frame(self.body, background=theme.c("info_soft"))
            self.pack_bar.pack(fill="x", pady=(8, 0))
            tk.Label(self.pack_bar,
                     text="Icons are shown as placeholders. Download the real Office artwork "
                          f"(about 300 KB, from {msoicons.SPRITE_SOURCE}) to see every icon "
                          "as it appears in Excel.",
                     background=theme.c("info_soft"), foreground=theme.c("text"),
                     font=theme.font("small"), justify="left", wraplength=560,
                     padx=10, pady=8).pack(side="left", fill="x", expand=True)
            self.pack_button = ToolButton(self.pack_bar, theme, text="Download icons",
                                          accent=True, command=self._download_pack)
            self.pack_button.pack(side="right", padx=8, pady=6)
        else:
            self.pack_bar = None

        row = tk.Frame(self.body, background=theme.c("panel"))
        row.pack(fill="x", pady=(8, 0))
        tk.Label(row, text="imageMso", background=theme.c("panel"), foreground=theme.c("text_dim"),
                 font=theme.font("small")).pack(side="left")
        self.manual = ttk.Entry(row)
        self.manual.insert(0, current)
        self.manual.pack(side="left", fill="x", expand=True, padx=8)
        self.manual.bind("<Return>", lambda _e: self.accept(self.manual.get().strip()))

        self.add_button("Use this icon", lambda: self.accept(self.manual.get().strip()), accent=True)
        self.add_button("Cancel", self.cancel)
        self._filter("")

    # ------------------------------------------------------------ downloading
    def _download_pack(self) -> None:
        self.pack_button.set_enabled(False)
        self.pack_button.set_text("Downloading...")

        import threading

        def worker() -> None:
            try:
                self.msoicons.download()
                error = None
            except OSError as exc:
                error = str(exc)
            try:
                self.after(0, lambda: self._download_done(error))
            except tk.TclError:
                pass

        threading.Thread(target=worker, daemon=True).start()

    def _download_done(self, error) -> None:
        if error:
            self.pack_button.set_enabled(True)
            self.pack_button.set_text("Download icons")
            messagebox.showerror("Download failed", error, parent=self)
            return
        self.msoicons.pack().forget()
        self.icons = IconCache(self.theme)
        if self.pack_bar is not None:
            self.pack_bar.destroy()
            self.pack_bar = None
        self._render()

    # --------------------------------------------------------------- filtering
    def _filter(self, query: str) -> None:
        if not hasattr(self, "category"):
            return
        category = self.category.get()
        category = "" if category.startswith("All") else category
        self._items = msodata.search_image_mso(query, category)
        self.count.configure(text=f"{len(self._items):,} icons")
        self.canvas.yview_moveto(0.0)
        self._layout()

    # ------------------------------------------------------------ virtual grid
    def _layout(self) -> None:
        width = max(self.canvas.winfo_width(), 200)
        self._columns = max(1, int(width // self.CELL_W))
        rows = (len(self._items) + self._columns - 1) // self._columns
        self.canvas.configure(scrollregion=(0, 0, width, rows * self.CELL_H + 16))
        self._render()

    def _yview(self, *args) -> None:
        self.canvas.yview(*args)
        self._schedule_render()

    def _on_scrolled(self, first, last) -> None:
        self.vbar.set(first, last)
        self._schedule_render()

    def _schedule_render(self) -> None:
        if self._render_job is None:
            self._render_job = self.after(16, self._render)

    def _render(self) -> None:
        self._render_job = None
        canvas = self.canvas
        canvas.delete("all")
        c = self.theme
        columns = self._columns
        top = canvas.canvasy(0)
        bottom = top + canvas.winfo_height()
        first_row = max(0, int(top // self.CELL_H) - 1)
        last_row = int(bottom // self.CELL_H) + 1
        start = first_row * columns
        stop = min(len(self._items), (last_row + 1) * columns)
        for index in range(start, stop):
            name, _category = self._items[index]
            column, row = index % columns, index // columns
            x = column * self.CELL_W + 8
            y = row * self.CELL_H + 8
            if name == self.selected:
                rounded_rect(canvas, x - 3, y - 3, self.CELL_W - 10, self.CELL_H - 8, 5,
                             c.c("accent_soft"), outline=c.c("accent"))
            self.icons.draw(canvas, x + (self.CELL_W - 16 - 32) / 2, y + 4, 32, image_mso=name, honest=True)
            label = name if len(name) <= 16 else name[:15] + "\u2026"
            canvas.create_text(x + (self.CELL_W - 16) / 2, y + 52, text=label,
                               fill=c.c("text_dim"), font=c.font("tiny"), width=self.CELL_W - 12)

    def _cell_at(self, x: float, y: float):
        cx, cy = self.canvas.canvasx(x), self.canvas.canvasy(y)
        column = int((cx - 8) // self.CELL_W)
        row = int((cy - 8) // self.CELL_H)
        if not (0 <= column < self._columns):
            return None
        index = row * self._columns + column
        if 0 <= index < len(self._items):
            return self._items[index][0]
        return None

    def _on_click(self, event) -> None:
        name = self._cell_at(event.x, event.y)
        if name:
            self.selected = name
            self.manual.delete(0, "end")
            self.manual.insert(0, name)
            self._render()

    def _on_double(self, event) -> None:
        name = self._cell_at(event.x, event.y)
        if name:
            self.accept(name)


class ControlIdBrowser(Dialog):
    """Browse built-in control identifiers (idMso, insertAfterMso, ...)."""

    def __init__(self, parent, theme, current: str = "") -> None:
        super().__init__(parent, theme, "Built-in control identifiers", 620, 560,
                         subtitle="Common Excel tab, group, command and context-menu ids. "
                                  "Any valid idMso can also be typed directly.")
        top = tk.Frame(self.body, background=theme.c("panel"))
        top.pack(fill="x", pady=(0, 8))
        self.search = SearchEntry(top, theme, placeholder="Search identifiers",
                                  command=lambda _v: self._fill(), width=30)
        self.search.pack(side="left")

        holder = tk.Frame(self.body, background=theme.c("panel"))
        holder.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(holder, columns=("category",), show="tree headings",
                                 style="Plain.Treeview", selectmode="browse")
        self.tree.heading("#0", text="Identifier")
        self.tree.heading("category", text="Where it lives")
        self.tree.column("#0", width=300)
        self.tree.column("category", width=220)
        scroll = ttk.Scrollbar(holder, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        self.tree.bind("<Double-Button-1>", lambda _e: self._use())
        self.tree.bind("<<TreeviewSelect>>", lambda _e: self._sync_entry())

        row = tk.Frame(self.body, background=theme.c("panel"))
        row.pack(fill="x", pady=(8, 0))
        tk.Label(row, text="Identifier", background=theme.c("panel"), foreground=theme.c("text_dim"),
                 font=theme.font("small")).pack(side="left")
        self.manual = ttk.Entry(row)
        self.manual.insert(0, current)
        self.manual.pack(side="left", fill="x", expand=True, padx=8)
        self.manual.bind("<Return>", lambda _e: self.accept(self.manual.get().strip()))

        self.add_button("Use this id", lambda: self.accept(self.manual.get().strip()), accent=True)
        self.add_button("Cancel", self.cancel)
        self._fill()

    def _fill(self) -> None:
        needle = self.search.value.lower()
        self.tree.delete(*self.tree.get_children(""))
        for category, names in msodata.CONTROL_IDMSO.items():
            matches = [n for n in names if not needle or needle in n.lower()]
            if not matches:
                continue
            parent = self.tree.insert("", "end", text=category, values=("",), open=bool(needle))
            for name in matches:
                self.tree.insert(parent, "end", text=name, values=(category,))

    def _sync_entry(self) -> None:
        selection = self.tree.selection()
        if not selection:
            return
        text = self.tree.item(selection[0], "text")
        if self.tree.item(selection[0], "values")[0]:
            self.manual.delete(0, "end")
            self.manual.insert(0, text)

    def _use(self) -> None:
        value = self.manual.get().strip()
        if value:
            self.accept(value)


class TemplateGallery(Dialog):
    """Pick a starting point for a new custom UI part."""

    def __init__(self, parent, theme, variant_label: str = "") -> None:
        super().__init__(parent, theme, "Choose a starting point", 640, 560,
                         subtitle=f"Templates are inserted into {variant_label}." if variant_label else "")
        self.selected_key = "starter"
        scroll = ScrollFrame(self.body, theme)
        scroll.pack(fill="both", expand=True)
        self.cards: Dict[str, tk.Frame] = {}
        for category, items in templates.by_category().items():
            tk.Label(scroll.body, text=category.upper(), background=theme.c("panel"),
                     foreground=theme.c("text_faint"), font=theme.font("small_bold"),
                     anchor="w").pack(fill="x", pady=(12, 4), padx=4)
            for template in items:
                self.cards[template.key] = self._card(scroll.body, template)
        self._highlight()
        self.add_button("Create", lambda: self.accept(self.selected_key), accent=True)
        self.add_button("Cancel", self.cancel)

    def _card(self, parent, template) -> tk.Frame:
        c = self.theme
        card = tk.Frame(parent, background=c.c("panel_alt"), cursor="hand2",
                        highlightthickness=1, highlightbackground=c.c("border"))
        card.pack(fill="x", pady=3, padx=4)
        glyph = tk.Label(card, text=template.glyph, background=c.c("panel_alt"),
                         foreground=c.c("accent"), font=c.font("h2"), width=3)
        glyph.pack(side="left", padx=(8, 4), pady=10)
        text = tk.Frame(card, background=c.c("panel_alt"))
        text.pack(side="left", fill="x", expand=True, pady=8, padx=(2, 10))
        title = tk.Label(text, text=template.title, background=c.c("panel_alt"),
                         foreground=c.c("text"), font=c.font("ui_bold"), anchor="w")
        title.pack(fill="x")
        summary = tk.Label(text, text=template.summary, background=c.c("panel_alt"),
                           foreground=c.c("text_dim"), font=c.font("small"), anchor="w",
                           justify="left", wraplength=460)
        summary.pack(fill="x")
        for widget in (card, glyph, text, title, summary):
            widget.bind("<Button-1>", lambda _e, k=template.key: self._select(k))
            widget.bind("<Double-Button-1>", lambda _e, k=template.key: self.accept(k))
        return card

    def _select(self, key: str) -> None:
        self.selected_key = key
        self._highlight()

    def _highlight(self) -> None:
        c = self.theme
        for key, card in self.cards.items():
            active = key == self.selected_key
            card.configure(highlightbackground=c.c("accent") if active else c.c("border"),
                           highlightthickness=2 if active else 1)


class ImageManager(Dialog):
    """Import, export, rename and delete the pictures embedded in a part."""

    def __init__(self, parent, theme, package, part_state, on_change: Callable[[], None]) -> None:
        variant_label = part_state.label
        super().__init__(parent, theme, "Embedded pictures", 660, 520,
                         subtitle=f"Pictures stored inside {variant_label}. Reference one from any "
                                  f"control with image=\"<id>\".")
        self.package = package
        self.part_state = part_state
        self.on_change = on_change
        self.icons = IconCache(theme)

        holder = tk.Frame(self.body, background=theme.c("panel"))
        holder.pack(fill="both", expand=True)

        left = tk.Frame(holder, background=theme.c("panel"))
        left.pack(side="left", fill="both", expand=True)
        self.tree = ttk.Treeview(left, columns=("file", "size"), show="tree headings",
                                 style="Plain.Treeview", selectmode="browse")
        self.tree.heading("#0", text="Id (use in image=)")
        self.tree.heading("file", text="File")
        self.tree.heading("size", text="Size")
        self.tree.column("#0", width=180)
        self.tree.column("file", width=180)
        self.tree.column("size", width=80, anchor="e")
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", lambda _e: self._show_preview())

        right = tk.Frame(holder, background=theme.c("panel_alt"), width=180)
        right.pack(side="right", fill="y", padx=(10, 0))
        right.pack_propagate(False)
        self.preview = tk.Canvas(right, background=theme.c("panel_alt"), highlightthickness=0,
                                 height=150)
        self.preview.pack(fill="x", pady=10, padx=10)
        self.info = tk.Label(right, text="", background=theme.c("panel_alt"),
                             foreground=theme.c("text_dim"), font=theme.font("small"),
                             wraplength=160, justify="left")
        self.info.pack(fill="x", padx=10)

        tools = tk.Frame(self.body, background=theme.c("panel"))
        tools.pack(fill="x", pady=(10, 0))
        ToolButton(tools, theme, text="Import...", glyph="＋", command=self.do_import).pack(side="left")
        ToolButton(tools, theme, text="Export...", glyph="⇩", command=self.do_export).pack(side="left", padx=4)
        ToolButton(tools, theme, text="Rename id", glyph="✎", command=self.do_rename).pack(side="left")
        ToolButton(tools, theme, text="Remove", glyph="🗑", command=self.do_delete).pack(side="left", padx=4)

        self.add_button("Close", lambda: self.accept("ok"), accent=True)
        self.refresh()

    def refresh(self) -> None:
        self.tree.delete(*self.tree.get_children(""))
        for image in self.part_state.images():
            self.tree.insert("", "end", iid=image.rel_id, text=image.rel_id,
                             values=(image.file_name, _human_size(image.size)))
        self._show_preview()

    def _selected(self) -> Optional[str]:
        selection = self.tree.selection()
        return selection[0] if selection else None

    def _show_preview(self) -> None:
        self.preview.delete("all")
        rel_id = self._selected()
        images = {i.rel_id: i for i in self.part_state.images()}
        image = images.get(rel_id) if rel_id else None
        if image is None:
            self.info.configure(text="Select a picture to preview it.")
            return
        photo = self.icons.photo(image.data, 128)
        if photo is not None:
            self.preview.create_image(80, 75, image=photo)
        else:
            self.preview.create_text(80, 75, text="(no preview)", fill=self.theme.c("text_faint"),
                                     font=self.theme.font("small"))
        self.info.configure(
            text=f"{image.file_name}\n{_human_size(image.size)}\n\nUse in XML:\nimage=\"{image.rel_id}\"")

    def do_import(self) -> None:
        paths = filedialog.askopenfilenames(
            parent=self, title="Import pictures",
            filetypes=[("Pictures", "*.png *.jpg *.jpeg *.gif *.bmp *.ico"), ("All files", "*.*")])
        added = 0
        for path in paths:
            try:
                with open(path, "rb") as handle:
                    data = handle.read()
                self.package.add_image(self.part_state.variant, data, os.path.basename(path))
                added += 1
            except (OSError, PackageError) as exc:
                messagebox.showerror("Could not import", str(exc), parent=self)
        if added:
            self.part_state.owner.touch()
            self.refresh()
            self.on_change()

    def do_export(self) -> None:
        rel_id = self._selected()
        if not rel_id:
            return
        images = {i.rel_id: i for i in self.part_state.images()}
        image = images[rel_id]
        path = filedialog.asksaveasfilename(parent=self, title="Export picture",
                                            initialfile=image.file_name,
                                            defaultextension=os.path.splitext(image.file_name)[1])
        if not path:
            return
        try:
            self.package.export_image(self.part_state.variant, rel_id, path)
        except (OSError, PackageError) as exc:
            messagebox.showerror("Could not export", str(exc), parent=self)

    def do_rename(self) -> None:
        rel_id = self._selected()
        if not rel_id:
            return
        from tkinter import simpledialog
        new_id = simpledialog.askstring("Rename picture id", "New id:", initialvalue=rel_id, parent=self)
        if not new_id or new_id == rel_id:
            return
        try:
            self.package.rename_image(self.part_state.variant, rel_id, new_id)
        except PackageError as exc:
            messagebox.showerror("Could not rename", str(exc), parent=self)
            return
        self.part_state.owner.touch()
        self.refresh()
        self.on_change()

    def do_delete(self) -> None:
        rel_id = self._selected()
        if not rel_id:
            return
        if not messagebox.askyesno(
                "Remove picture",
                f"Remove '{rel_id}' from the package?\n\nControls that reference it will show "
                f"no icon until you point them somewhere else.", parent=self):
            return
        self.package.remove_image(self.part_state.variant, rel_id)
        self.part_state.owner.touch()
        self.refresh()
        self.on_change()


class CallbackDialog(Dialog):
    """Show, copy and export the VBA the current ribbon needs."""

    def __init__(self, parent, theme, document, settings, highlight: str = "") -> None:
        super().__init__(parent, theme, "VBA callbacks", 780, 620,
                         subtitle="Every callback referenced by this ribbon, with the exact "
                                  "signature Office expects.")
        self.document = document
        self.settings = settings

        options = tk.Frame(self.body, background=theme.c("panel"))
        options.pack(fill="x", pady=(0, 8))
        tk.Label(options, text="Module name", background=theme.c("panel"),
                 foreground=theme.c("text_dim"), font=theme.font("small")).pack(side="left")
        self.module = ttk.Entry(options, width=24)
        self.module.insert(0, settings["callback_module"])
        self.module.pack(side="left", padx=8)
        self.module.bind("<KeyRelease>", lambda _e: self.regenerate())
        self.pointer = tk.BooleanVar(value=bool(settings["callback_pointer_recovery"]))
        ttk.Checkbutton(options, text="Include IRibbonUI pointer recovery",
                        variable=self.pointer, command=self.regenerate).pack(side="left", padx=10)
        self.comments = tk.BooleanVar(value=True)
        ttk.Checkbutton(options, text="Usage comments", variable=self.comments,
                        command=self.regenerate).pack(side="left")

        summary = cb.summary(document)
        chip_row = tk.Frame(self.body, background=theme.c("panel"))
        chip_row.pack(fill="x", pady=(0, 6))
        Chip(chip_row, theme, f"{len(summary)} callbacks", "ok").pack(side="left", padx=(0, 6))
        conflicts = [c for c in cb.collect(document) if c.conflict]
        if conflicts:
            Chip(chip_row, theme, f"{len(conflicts)} signature clash", "error").pack(side="left")

        holder = tk.Frame(self.body, background=theme.c("code_bg"), highlightthickness=1,
                          highlightbackground=theme.c("border"))
        holder.pack(fill="both", expand=True)
        self.text = tk.Text(holder, background=theme.c("code_bg"), foreground=theme.c("text"),
                            font=theme.font("mono_small"), relief="flat", wrap="none",
                            insertbackground=theme.c("text"), padx=10, pady=8, highlightthickness=0)
        scroll = ttk.Scrollbar(holder, orient="vertical", command=self.text.yview)
        self.text.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.text.pack(side="left", fill="both", expand=True)
        self.text.tag_configure("comment", foreground=theme.c("syn_comment"))
        self.text.tag_configure("keyword", foreground=theme.c("syn_decl"))
        self.text.tag_configure("hit", background=theme.c("find"))

        self.add_button("Save as .bas...", self.save_module, accent=True)
        self.add_button("Copy", self.copy_all)
        self.add_button("Close", self.cancel)
        self.regenerate()
        if highlight:
            self.find(highlight)

    def regenerate(self) -> None:
        module = self.module.get().strip() or "RibbonCallbacks"
        code = cb.generate_module(
            self.document, module_name=module,
            include_pointer_recovery=self.pointer.get(),
            include_usage_comments=self.comments.get())
        self.text.delete("1.0", "end")
        self.text.insert("1.0", code)
        self._colourise()
        self.settings["callback_module"] = module
        self.settings["callback_pointer_recovery"] = self.pointer.get()

    def _colourise(self) -> None:
        import re
        source = self.text.get("1.0", "end-1c")
        for tag in ("comment", "keyword"):
            self.text.tag_remove(tag, "1.0", "end")
        for index, line in enumerate(source.splitlines(), start=1):
            stripped = line.lstrip()
            if stripped.startswith("'"):
                self.text.tag_add("comment", f"{index}.0", f"{index}.end")
                continue
            for match in re.finditer(r"\b(Public|Private|Sub|End Sub|Function|Dim|As|Set|If|Then|"
                                     r"Else|ElseIf|End If|Select Case|Case|Exit Sub|Declare|"
                                     r"PtrSafe|Optional|ByRef|ByVal)\b", line):
                self.text.tag_add("keyword", f"{index}.{match.start()}", f"{index}.{match.end()}")

    def find(self, needle: str) -> None:
        self.text.tag_remove("hit", "1.0", "end")
        index = self.text.search(needle, "1.0", stopindex="end")
        if index:
            self.text.tag_add("hit", index, f"{index} lineend")
            self.text.see(index)

    def copy_all(self) -> None:
        self.clipboard_clear()
        self.clipboard_append(self.text.get("1.0", "end-1c"))

    def save_module(self) -> None:
        module = self.module.get().strip() or "RibbonCallbacks"
        path = filedialog.asksaveasfilename(
            parent=self, title="Save VBA module", initialfile=f"{module}.bas",
            defaultextension=".bas", filetypes=[("VBA module", "*.bas"), ("All files", "*.*")])
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8", newline="\r\n") as handle:
                handle.write(self.text.get("1.0", "end-1c"))
        except OSError as exc:
            messagebox.showerror("Could not save", str(exc), parent=self)
            return
        self.accept(path)


class Preferences(Dialog):
    def __init__(self, parent, theme, settings, on_apply: Callable[[], None]) -> None:
        super().__init__(parent, theme, "Preferences", 560, 560)
        self.settings = settings
        self.on_apply = on_apply
        c = theme

        scroll = ScrollFrame(self.body, theme)
        scroll.pack(fill="both", expand=True)
        body = scroll.body

        self._section(body, "Appearance")
        self.theme_var = tk.StringVar(value=settings["theme"])
        row = self._row(body, "Colour scheme")
        for name in ("dark", "light"):
            ttk.Radiobutton(row, text=name.title(), value=name, variable=self.theme_var,
                            command=self._apply_live).pack(side="left", padx=(0, 10))

        from .theme import ACCENTS
        self.accent_var = tk.StringVar(value=settings["accent"])
        row = self._row(body, "Accent")
        accent_box = ttk.Combobox(row, values=list(ACCENTS), textvariable=self.accent_var,
                                  state="readonly", width=12)
        accent_box.pack(side="left")
        accent_box.bind("<<ComboboxSelected>>", lambda _e: self._apply_live())

        self.ui_size = tk.IntVar(value=settings["ui_font_size"])
        row = self._row(body, "Interface text size")
        ttk.Spinbox(row, from_=8, to=14, textvariable=self.ui_size, width=6,
                    command=self._apply_live).pack(side="left")

        self._section(body, "Editor")
        self.mono_family = tk.StringVar(value=settings["editor_font"])
        row = self._row(body, "Editor font")
        from tkinter import font as tkfont
        families = sorted({f for f in tkfont.families(parent) if not f.startswith("@")})
        ttk.Combobox(row, values=families, textvariable=self.mono_family, width=24).pack(side="left")
        self.mono_size = tk.IntVar(value=settings["editor_font_size"])
        row = self._row(body, "Editor font size")
        ttk.Spinbox(row, from_=8, to=24, textvariable=self.mono_size, width=6).pack(side="left")

        self.wrap_attrs = tk.BooleanVar(value=settings["wrap_attributes"])
        self._check(body, "Wrap long attribute lists when reformatting", self.wrap_attrs)
        self.validate_live = tk.BooleanVar(value=settings["validate_as_you_type"])
        self._check(body, "Validate as you type", self.validate_live)
        self.strict = tk.BooleanVar(value=settings["strict_imagemso"])
        self._check(body, "Warn about imageMso names outside the catalogue", self.strict)

        self._section(body, "Files")
        self.backup = tk.BooleanVar(value=settings["backup_on_save"])
        self._check(body, "Keep a .bak copy every time a document is saved", self.backup)
        self.confirm = tk.BooleanVar(value=settings["confirm_overwrite_office"])
        self._check(body, "Warn before saving a file that may be open in Office", self.confirm)

        note = tk.Label(body, background=c.c("panel"), foreground=c.c("text_faint"),
                        font=c.font("tiny"), justify="left", anchor="w", wraplength=460,
                        text=f"Settings are stored in {os.path.join(_config_dir(), 'settings.json')}")
        note.pack(fill="x", pady=(16, 4), padx=4)

        self.add_button("Done", self.apply_and_close, accent=True)
        self.add_button("Cancel", self.cancel)

    def _section(self, parent, title: str) -> None:
        tk.Label(parent, text=title.upper(), background=self.theme.c("panel"),
                 foreground=self.theme.c("text_faint"), font=self.theme.font("small_bold"),
                 anchor="w").pack(fill="x", pady=(14, 4), padx=4)

    def _row(self, parent, label: str) -> tk.Frame:
        row = tk.Frame(parent, background=self.theme.c("panel"))
        row.pack(fill="x", pady=3, padx=4)
        tk.Label(row, text=label, background=self.theme.c("panel"),
                 foreground=self.theme.c("text_dim"), font=self.theme.font("ui"),
                 width=24, anchor="w").pack(side="left")
        return row

    def _check(self, parent, label: str, variable: tk.BooleanVar) -> None:
        ttk.Checkbutton(parent, text=label, variable=variable).pack(fill="x", pady=2, padx=4)

    def _apply_live(self) -> None:
        self.settings["theme"] = self.theme_var.get()
        self.settings["accent"] = self.accent_var.get()
        self.settings["ui_font_size"] = int(self.ui_size.get())
        self.on_apply()

    def apply_and_close(self) -> None:
        self.settings["theme"] = self.theme_var.get()
        self.settings["accent"] = self.accent_var.get()
        self.settings["ui_font_size"] = int(self.ui_size.get())
        self.settings["editor_font"] = self.mono_family.get()
        self.settings["editor_font_size"] = int(self.mono_size.get())
        self.settings["wrap_attributes"] = bool(self.wrap_attrs.get())
        self.settings["validate_as_you_type"] = bool(self.validate_live.get())
        self.settings["strict_imagemso"] = bool(self.strict.get())
        self.settings["backup_on_save"] = bool(self.backup.get())
        self.settings["confirm_overwrite_office"] = bool(self.confirm.get())
        self.on_apply()
        self.accept("ok")


class CommandPalette(tk.Toplevel):
    """Ctrl+Shift+P style launcher for every command in the app."""

    def __init__(self, parent, theme, commands: Sequence[Tuple[str, str, Callable]]) -> None:
        super().__init__(parent)
        self.theme = theme
        self.commands = list(commands)
        self.filtered = list(self.commands)
        self.withdraw()
        self.overrideredirect(True)
        self.transient(parent)
        self.configure(background=theme.c("border"))

        frame = tk.Frame(self, background=theme.c("elevated"))
        frame.pack(fill="both", expand=True, padx=1, pady=1)
        self.entry = tk.Entry(frame, background=theme.c("elevated"), foreground=theme.c("text"),
                              insertbackground=theme.c("accent"), font=theme.font("h3"),
                              relief="flat", highlightthickness=0, bd=0)
        self.entry.pack(fill="x", padx=14, pady=(12, 8))
        tk.Frame(frame, background=theme.c("border"), height=1).pack(fill="x")
        self.listbox = tk.Listbox(frame, background=theme.c("elevated"), foreground=theme.c("text"),
                                  selectbackground=theme.c("accent_soft"),
                                  selectforeground=theme.c("text"), font=theme.font("ui"),
                                  relief="flat", highlightthickness=0, activestyle="none",
                                  height=12)
        self.listbox.pack(fill="both", expand=True, padx=6, pady=6)
        self.listbox.bind("<Double-Button-1>", lambda _e: self._run())

        self.entry.bind("<KeyRelease>", self._filter)
        self.entry.bind("<Down>", lambda _e: self._move(1))
        self.entry.bind("<Up>", lambda _e: self._move(-1))
        self.entry.bind("<Return>", lambda _e: self._run())
        self.entry.bind("<Escape>", lambda _e: self.destroy())
        self.bind("<FocusOut>", lambda _e: self.after(120, self._maybe_close))

        width, height = 560, 380
        try:
            x = parent.winfo_rootx() + (parent.winfo_width() - width) // 2
            y = parent.winfo_rooty() + 90
        except tk.TclError:
            x, y = 200, 200
        self.geometry(f"{width}x{height}+{max(0, x)}+{max(0, y)}")
        self._fill()
        self.deiconify()
        self.lift()
        self.entry.focus_force()
        self.grab_set()

    def _maybe_close(self) -> None:
        try:
            if self.focus_displayof() is None:
                self.destroy()
        except (tk.TclError, KeyError):
            pass

    def _fill(self) -> None:
        self.listbox.delete(0, "end")
        for title, hint, _command in self.filtered:
            self.listbox.insert("end", f"  {title}" + (f"      {hint}" if hint else ""))
        if self.filtered:
            self.listbox.selection_set(0)

    def _filter(self, event=None) -> None:
        if event is not None and event.keysym in ("Up", "Down", "Return", "Escape"):
            return
        needle = self.entry.get().strip().lower()
        if not needle:
            self.filtered = list(self.commands)
        else:
            scored = []
            for item in self.commands:
                title = item[0].lower()
                if needle in title:
                    scored.append((0 if title.startswith(needle) else 1, item))
                elif all(part in title for part in needle.split()):
                    scored.append((2, item))
            scored.sort(key=lambda pair: pair[0])
            self.filtered = [item for _score, item in scored]
        self._fill()

    def _move(self, delta: int) -> str:
        if not self.filtered:
            return "break"
        current = self.listbox.curselection()
        index = (current[0] if current else 0) + delta
        index = max(0, min(len(self.filtered) - 1, index))
        self.listbox.selection_clear(0, "end")
        self.listbox.selection_set(index)
        self.listbox.see(index)
        return "break"

    def _run(self) -> None:
        if not self.filtered:
            return
        selection = self.listbox.curselection()
        _title, _hint, command = self.filtered[selection[0] if selection else 0]
        self.destroy()
        command()


class AboutDialog(Dialog):
    def __init__(self, parent, theme, version: str) -> None:
        super().__init__(parent, theme, "About RibbonForge", 560, 460)
        c = theme
        canvas = tk.Canvas(self.body, background=c.c("panel"), height=88, highlightthickness=0)
        canvas.pack(fill="x")
        rounded_rect(canvas, 10, 12, 64, 64, 14, c.c("accent"))
        canvas.create_text(42, 44, text="R", fill=c.c("on_accent"), font=(theme.ui_family, 30, "bold"))
        canvas.create_text(92, 34, anchor="w", text="RibbonForge", fill=c.c("text"),
                           font=(theme.ui_family, 20, "bold"))
        canvas.create_text(92, 60, anchor="w", text=f"Excel ribbon editor  ·  version {version}",
                           fill=c.c("text_dim"), font=theme.font("small"))

        text = (
            "Design, validate and embed Office CustomUI markup without leaving the keyboard.\n\n"
            "•  Reads and writes customUI.xml (Office 2007) and customUI14.xml (2010+) "
            "directly inside .xlsm, .xlsx, .xlam, .docm, .pptm and friends.\n"
            "•  Everything else in the package is copied through untouched, and a .bak "
            "copy is kept on every save.\n"
            "•  Structure tree, schema-driven property grid, live preview, validation and "
            "VBA callback generation stay in sync with the XML at all times.\n\n"
            "Built with Python and Tkinter - no external dependencies required "
            "(Pillow is used for nicer picture scaling when available)."
        )
        tk.Label(self.body, text=text, background=c.c("panel"), foreground=c.c("text_dim"),
                 font=c.font("ui"), justify="left", anchor="nw", wraplength=490).pack(
            fill="both", expand=True, pady=(14, 0))
        self.add_button("Close", lambda: self.accept("ok"), accent=True)


class ShortcutsDialog(Dialog):
    SHORTCUTS = [
        ("File", [
            ("Ctrl+O", "Open a workbook or XML file"),
            ("Ctrl+N", "New ribbon from a template"),
            ("Ctrl+S", "Save"),
            ("Ctrl+Shift+S", "Save as"),
            ("Ctrl+W", "Close the current document"),
        ]),
        ("Editing", [
            ("Ctrl+Space", "Context-aware autocomplete"),
            ("Ctrl+F / Ctrl+H", "Find / find and replace"),
            ("F3", "Find next"),
            ("Ctrl+G", "Go to line"),
            ("Ctrl+/", "Comment or uncomment"),
            ("Ctrl+D", "Duplicate line (editor) or control (tree)"),
            ("Alt+Up / Alt+Down", "Move the current line"),
            ("Tab / Shift+Tab", "Indent or outdent the selection"),
            ("Ctrl+Shift+F", "Reformat the whole document"),
        ]),
        ("Structure", [
            ("Insert", "Insert a child control"),
            ("Delete", "Delete the selected control"),
            ("Ctrl+Up / Ctrl+Down", "Move the selected control"),
            ("Ctrl+C / Ctrl+V", "Copy and paste controls"),
            ("Drag and drop", "Reparent or reorder controls"),
        ]),
        ("Everything else", [
            ("Ctrl+Shift+P", "Command palette"),
            ("F5", "Validate now"),
            ("F6", "Cycle panels"),
            ("F9", "Generate VBA callbacks"),
            ("Ctrl+1 / Ctrl+2 / Ctrl+3", "Focus tree, editor, preview"),
            ("Ctrl+Tab", "Next open document"),
        ]),
    ]

    def __init__(self, parent, theme) -> None:
        super().__init__(parent, theme, "Keyboard shortcuts", 600, 620)
        scroll = ScrollFrame(self.body, theme)
        scroll.pack(fill="both", expand=True)
        c = theme
        for section, rows in self.SHORTCUTS:
            tk.Label(scroll.body, text=section.upper(), background=c.c("panel"),
                     foreground=c.c("text_faint"), font=c.font("small_bold"), anchor="w"
                     ).pack(fill="x", pady=(14, 6), padx=4)
            for keys, description in rows:
                row = tk.Frame(scroll.body, background=c.c("panel"))
                row.pack(fill="x", pady=1, padx=4)
                tk.Label(row, text=keys, background=c.c("panel_alt"), foreground=c.c("text"),
                         font=c.font("mono_small"), padx=8, pady=2, width=20, anchor="w"
                         ).pack(side="left")
                tk.Label(row, text=description, background=c.c("panel"),
                         foreground=c.c("text_dim"), font=c.font("ui"), anchor="w"
                         ).pack(side="left", padx=10)
        self.add_button("Close", lambda: self.accept("ok"), accent=True)


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def _config_dir() -> str:
    from ..core.settings import config_dir
    return config_dir()
