"""Attribute editor. Every row is generated from the schema, so the panel
always offers exactly the attributes Office accepts on the selected element."""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Callable, Dict, List, Optional

from ..core import schema
from ..core.xmldoc import COMMENT, Node
from .widgets import PanelHeader, ScrollFrame, ToolButton, Tooltip, make_menu

COLLAPSED_BY_DEFAULT = {schema.G_POSITION, schema.G_ADVANCED}


class PropertiesPanel(tk.Frame):
    def __init__(self, master, theme,
                 on_change: Optional[Callable[[str], None]] = None,
                 image_provider: Optional[Callable[[], List[str]]] = None,
                 pick_image_mso: Optional[Callable[[str], Optional[str]]] = None,
                 pick_control_mso: Optional[Callable[[str], Optional[str]]] = None,
                 import_image: Optional[Callable[[], Optional[str]]] = None,
                 show_callbacks: Optional[Callable[[str], None]] = None) -> None:
        super().__init__(master, background=theme.c("panel"))
        self.theme = theme
        self.on_change = on_change
        self.image_provider = image_provider or (lambda: [])
        self.pick_image_mso = pick_image_mso
        self.pick_control_mso = pick_control_mso
        self.import_image = import_image
        self.show_callbacks = show_callbacks

        self.node: Optional[Node] = None
        self.report = None
        self._vars: Dict[str, tk.StringVar] = {}
        self._rows: Dict[str, tk.Widget] = {}
        self._collapsed: Dict[str, bool] = {g: g in COLLAPSED_BY_DEFAULT for g in schema.GROUP_ORDER}
        self._show_all = tk.BooleanVar(value=False)

        self.header = PanelHeader(self, theme, "Properties", "⚙")
        self.header.pack(fill="x")
        ToolButton(self.header.tools, theme, glyph="⋯", compact=True,
                   tooltip="Panel options", command=self._panel_menu).pack(side="left")

        self.title_box = tk.Frame(self, background=theme.c("panel_alt"))
        self.title_label = tk.Label(self.title_box, text="", background=theme.c("panel_alt"),
                                    foreground=theme.c("text"), font=theme.font("h3"),
                                    anchor="w", padx=12)
        self.title_label.pack(fill="x", pady=(10, 0))
        self.doc_label = tk.Label(self.title_box, text="", background=theme.c("panel_alt"),
                                  foreground=theme.c("text_dim"), font=theme.font("small"),
                                  anchor="w", justify="left", padx=12,
                                  wraplength=300)
        self.doc_label.pack(fill="x", pady=(3, 10))

        self.scroll = ScrollFrame(self, theme)
        self.scroll.pack(fill="both", expand=True)
        self.body = self.scroll.body

        self.placeholder = tk.Label(
            self.body, background=theme.c("panel"), foreground=theme.c("text_faint"),
            font=theme.font("small"), wraplength=260, justify="center",
            text="Select something in the structure tree or the preview\n"
                 "to edit its attributes here.")
        self.placeholder.pack(pady=40, padx=20)
        theme.subscribe(self.restyle)

    # ------------------------------------------------------------------- API
    def show_node(self, node: Optional[Node], report=None) -> None:
        self.node = node
        self.report = report
        self._render()

    def refresh(self) -> None:
        self._render()

    def retarget(self, node: Optional[Node], report=None) -> None:
        """Point the panel at the same logical node after a reparse, without
        rebuilding the widgets (which would steal keyboard focus)."""
        self.node = node
        self.report = report

    def _panel_menu(self) -> None:
        menu = make_menu(self, self.theme)
        menu.add_checkbutton(label="Show attributes that are not set", variable=self._show_all,
                             command=self._render)
        menu.add_separator()
        menu.add_command(label="Expand all groups", command=lambda: self._set_all_groups(False))
        menu.add_command(label="Collapse optional groups", command=lambda: self._set_all_groups(True))
        try:
            menu.tk_popup(self.header.winfo_rootx() + self.header.winfo_width() - 40,
                          self.header.winfo_rooty() + self.header.winfo_height())
        finally:
            menu.grab_release()

    def _set_all_groups(self, collapsed: bool) -> None:
        for group in schema.GROUP_ORDER:
            self._collapsed[group] = collapsed and group in COLLAPSED_BY_DEFAULT
        self._render()

    # ---------------------------------------------------------------- render
    def _clear(self) -> None:
        for child in self.body.winfo_children():
            child.destroy()
        self._vars.clear()
        self._rows.clear()

    def _render(self) -> None:
        self._clear()
        c = self.theme
        node = self.node
        if node is None:
            self.title_box.pack_forget()
            self.placeholder = tk.Label(
                self.body, background=c.c("panel"), foreground=c.c("text_faint"),
                font=c.font("small"), wraplength=260, justify="center",
                text="Select something in the structure tree or the preview\n"
                     "to edit its attributes here.")
            self.placeholder.pack(pady=40, padx=20)
            return

        self.title_box.pack(fill="x", after=self.header)

        if node.kind == COMMENT:
            self.title_label.configure(text="💬  Comment")
            self.doc_label.configure(text="Comments are preserved when the document is reformatted.")
            box = tk.Frame(self.body, background=c.c("panel"))
            box.pack(fill="both", expand=True, padx=12, pady=10)
            text = tk.Text(box, height=6, background=c.c("panel_alt"), foreground=c.c("text"),
                           font=c.font("mono_small"), relief="flat", wrap="word",
                           insertbackground=c.c("text"), padx=8, pady=6, highlightthickness=1,
                           highlightbackground=c.c("border"), highlightcolor=c.c("accent"))
            text.insert("1.0", node.text.strip())
            text.pack(fill="both", expand=True)

            def commit(_event=None):
                value = text.get("1.0", "end-1c")
                if value != node.text:
                    node.text = f" {value.strip()} "
                    self._notify("Edit comment")

            text.bind("<FocusOut>", commit)
            return

        elem = schema.elem_for_node(node)
        glyph = elem.glyph if elem else "⚠"
        self.title_label.configure(text=f"{glyph}  {node.tag}")
        if elem is None:
            parent_name = node.parent.tag if node.parent else "the document"
            self.doc_label.configure(
                text=f"<{node.tag}> is not a CustomUI element that can appear inside {parent_name}.")
            return
        self.doc_label.configure(text=elem.doc)

        node_issues = self.report.for_node(node.uid) if self.report is not None else []
        issue_by_attr = {}
        for issue in node_issues:
            if issue.attribute:
                issue_by_attr.setdefault(issue.attribute, issue)
        general = [i for i in node_issues if not i.attribute]
        if general:
            for issue in general[:3]:
                self._issue_banner(issue)

        grouped: Dict[str, List[schema.Attr]] = {}
        for attr in elem.attrs:
            grouped.setdefault(attr.group, []).append(attr)

        show_all = self._show_all.get()
        for group in schema.GROUP_ORDER:
            attrs = grouped.get(group)
            if not attrs:
                continue
            visible = [a for a in attrs if show_all or node.has(a.name) or
                       group not in COLLAPSED_BY_DEFAULT]
            if not visible:
                visible = [a for a in attrs if node.has(a.name)]
            if not visible:
                if not show_all:
                    self._group_header(group, len(attrs), collapsed=True, empty=True)
                    continue
                visible = attrs
            collapsed = self._collapsed.get(group, False) and not any(node.has(a.name) for a in visible)
            self._group_header(group, len(visible), collapsed=collapsed)
            if collapsed:
                continue
            for attr in visible:
                self._attribute_row(node, attr, issue_by_attr.get(attr.name))

        self._footer(node, elem)

    def _issue_banner(self, issue) -> None:
        c = self.theme
        tone = {"error": ("error_soft", "error"), "warning": ("warn_soft", "warn")}.get(
            issue.severity, ("info_soft", "info"))
        frame = tk.Frame(self.body, background=c.c(tone[0]))
        frame.pack(fill="x", padx=10, pady=(8, 0))
        tk.Frame(frame, background=c.c(tone[1]), width=3).pack(side="left", fill="y")
        message = issue.message + (f"\n{issue.hint}" if issue.hint else "")
        tk.Label(frame, text=message, background=c.c(tone[0]), foreground=c.c("text"),
                 font=c.font("small"), justify="left", anchor="w", wraplength=270,
                 padx=8, pady=6).pack(side="left", fill="x", expand=True)

    def _group_header(self, group: str, count: int, collapsed: bool, empty: bool = False) -> None:
        c = self.theme
        row = tk.Frame(self.body, background=c.c("panel"), cursor="hand2")
        row.pack(fill="x", pady=(12, 2), padx=10)
        arrow = "▸" if collapsed else "▾"
        label = tk.Label(row, text=f"{arrow}  {group.upper()}", background=c.c("panel"),
                         foreground=c.c("text_faint"), font=c.font("small_bold"), anchor="w")
        label.pack(side="left")
        if empty:
            tk.Label(row, text=f"{count} unset", background=c.c("panel"),
                     foreground=c.c("text_faint"), font=c.font("tiny")).pack(side="right")

        def toggle(_event=None):
            self._collapsed[group] = not self._collapsed.get(group, False)
            self._render()

        for widget in (row, label):
            widget.bind("<Button-1>", toggle)

    def _attribute_row(self, node: Node, attr: schema.Attr, issue=None) -> None:
        c = self.theme
        value = node.get(attr.name) or ""
        row = tk.Frame(self.body, background=c.c("panel"))
        row.pack(fill="x", padx=10, pady=1)

        label_row = tk.Frame(row, background=c.c("panel"))
        label_row.pack(fill="x")
        dot = tk.Label(label_row, text="●" if value else "", background=c.c("panel"),
                       foreground=c.c("accent"), font=c.font("tiny"), width=1)
        dot.pack(side="left")
        name = tk.Label(label_row, text=attr.name, background=c.c("panel"),
                        foreground=c.c("error") if issue and issue.severity == "error" else c.c("text_dim"),
                        font=c.font("small"), anchor="w")
        name.pack(side="left")
        if attr.doc:
            Tooltip(name, f"{attr.name}\n\n{attr.doc}", c)
        if value:
            clear = tk.Label(label_row, text="✕", background=c.c("panel"),
                             foreground=c.c("text_faint"), font=c.font("tiny"), cursor="hand2")
            clear.pack(side="right")
            clear.bind("<Button-1>", lambda _e, a=attr.name: self._set_value(node, a, ""))
            Tooltip(clear, f"Remove the {attr.name} attribute", c)

        var = tk.StringVar(value=value)
        self._vars[attr.name] = var
        field = tk.Frame(row, background=c.c("panel"))
        field.pack(fill="x", pady=(0, 4))

        widget: tk.Widget
        if attr.kind == schema.BOOL or (attr.values and set(attr.values) == {"true", "false"}):
            widget = ttk.Combobox(field, textvariable=var, values=["", "true", "false"],
                                  state="readonly", height=3)
            widget.bind("<<ComboboxSelected>>", lambda _e, a=attr.name: self._commit(node, a, var))
        elif attr.kind == schema.ENUM:
            widget = ttk.Combobox(field, textvariable=var, values=[""] + list(attr.values),
                                  state="readonly", height=6)
            widget.bind("<<ComboboxSelected>>", lambda _e, a=attr.name: self._commit(node, a, var))
        elif attr.kind == schema.IMAGE:
            options = [""] + list(self.image_provider())
            widget = ttk.Combobox(field, textvariable=var, values=options, height=8)
            widget.bind("<<ComboboxSelected>>", lambda _e, a=attr.name: self._commit(node, a, var))
            widget.bind("<Return>", lambda _e, a=attr.name: self._commit(node, a, var))
            widget.bind("<FocusOut>", lambda _e, a=attr.name: self._commit(node, a, var))
            if self.import_image is not None:
                button = ToolButton(field, c, glyph="＋", compact=True, padx=6, pady=2,
                                    tooltip="Import a picture into this part",
                                    command=lambda a=attr.name: self._do_import(node, a, var))
                button.pack(side="right", padx=(4, 0))
        else:
            widget = ttk.Entry(field, textvariable=var)
            widget.bind("<Return>", lambda _e, a=attr.name: self._commit(node, a, var))
            widget.bind("<FocusOut>", lambda _e, a=attr.name: self._commit(node, a, var))
            if attr.kind == schema.IMAGE_MSO and self.pick_image_mso is not None:
                ToolButton(field, c, glyph="⊞", compact=True, padx=6, pady=2,
                           tooltip="Browse the icon gallery",
                           command=lambda a=attr.name: self._do_pick_image(node, a, var)
                           ).pack(side="right", padx=(4, 0))
            elif attr.kind == schema.CONTROL_MSO and self.pick_control_mso is not None:
                ToolButton(field, c, glyph="⊞", compact=True, padx=6, pady=2,
                           tooltip="Browse built-in control identifiers",
                           command=lambda a=attr.name: self._do_pick_control(node, a, var)
                           ).pack(side="right", padx=(4, 0))
            elif attr.kind == schema.CALLBACK and self.show_callbacks is not None:
                ToolButton(field, c, glyph="ƒ", compact=True, padx=6, pady=2,
                           tooltip="Show the VBA signature for this callback",
                           command=lambda a=attr.name: self.show_callbacks(a)
                           ).pack(side="right", padx=(4, 0))
        widget.pack(side="left", fill="x", expand=True)
        self._rows[attr.name] = widget

        if issue is not None:
            tone = "error" if issue.severity == "error" else "warn"
            tk.Label(row, text=issue.message, background=c.c("panel"), foreground=c.c(tone),
                     font=c.font("tiny"), anchor="w", justify="left", wraplength=280
                     ).pack(fill="x", pady=(0, 4))

    def _footer(self, node: Node, elem: schema.Elem) -> None:
        c = self.theme
        callbacks = [a for a in elem.attrs if a.kind == schema.CALLBACK and node.has(a.name)]
        frame = tk.Frame(self.body, background=c.c("panel"))
        frame.pack(fill="x", padx=10, pady=(18, 16))
        tk.Frame(frame, background=c.c("border_soft"), height=1).pack(fill="x", pady=(0, 8))
        if callbacks:
            tk.Label(frame, text="VBA this control needs", background=c.c("panel"),
                     foreground=c.c("text_faint"), font=c.font("small_bold"), anchor="w"
                     ).pack(fill="x")
            from ..core.callbacks import signature_for
            for attr in callbacks:
                params, _returns, _default = signature_for(elem.key, attr.name)
                name = node.get(attr.name)
                tk.Label(frame, text=f"Sub {name}({params})", background=c.c("panel"),
                         foreground=c.c("text_dim"), font=c.font("mono_small"), anchor="w",
                         justify="left", wraplength=290).pack(fill="x", pady=1)
        children = schema.allowed_children(node)
        if children:
            names = ", ".join(sorted({e.name for e in children}))
            tk.Label(frame, text=f"Can contain: {names}", background=c.c("panel"),
                     foreground=c.c("text_faint"), font=c.font("tiny"), anchor="w",
                     justify="left", wraplength=290).pack(fill="x", pady=(8, 0))

    # ---------------------------------------------------------------- commits
    def _commit(self, node: Node, name: str, var: tk.StringVar) -> None:
        self._set_value(node, name, var.get().strip(), rerender=False)

    def _set_value(self, node: Node, name: str, value: str, rerender: bool = True) -> None:
        current = node.get(name) or ""
        if current == value:
            return
        node.set(name, value)
        self._notify(f"Set {name}")
        if rerender:
            self._render()

    def _notify(self, description: str) -> None:
        if self.on_change is not None:
            self.on_change(description)

    def _do_pick_image(self, node: Node, name: str, var: tk.StringVar) -> None:
        if self.pick_image_mso is None:
            return
        chosen = self.pick_image_mso(var.get())
        if chosen:
            var.set(chosen)
            self._set_value(node, name, chosen)

    def _do_pick_control(self, node: Node, name: str, var: tk.StringVar) -> None:
        if self.pick_control_mso is None:
            return
        chosen = self.pick_control_mso(var.get())
        if chosen:
            var.set(chosen)
            self._set_value(node, name, chosen)

    def _do_import(self, node: Node, name: str, var: tk.StringVar) -> None:
        if self.import_image is None:
            return
        rel_id = self.import_image()
        if rel_id:
            var.set(rel_id)
            self._set_value(node, name, rel_id)

    # ----------------------------------------------------------------- theme
    def restyle(self) -> None:
        c = self.theme
        try:
            self.configure(background=c.c("panel"))
            self.title_box.configure(background=c.c("panel_alt"))
            self.title_label.configure(background=c.c("panel_alt"), foreground=c.c("text"),
                                       font=c.font("h3"))
            self.doc_label.configure(background=c.c("panel_alt"), foreground=c.c("text_dim"),
                                     font=c.font("small"))
            self._render()
        except tk.TclError:
            pass
