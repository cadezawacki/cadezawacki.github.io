"""The ribbon structure tree: navigate, insert, reorder and delete controls."""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Callable, Dict, List, Optional, Tuple

from ..core import schema, xmldoc
from ..core.xmldoc import COMMENT, ELEMENT, Node
from .widgets import PanelHeader, SearchEntry, ToolButton, make_menu


class StructureTree(tk.Frame):
    """Tree view over the parsed customUI document."""

    def __init__(self, master, theme,
                 on_select: Optional[Callable[[Optional[Node]], None]] = None,
                 on_change: Optional[Callable[[str], None]] = None,
                 on_activate: Optional[Callable[[Node], None]] = None) -> None:
        super().__init__(master, background=theme.c("panel"))
        self.theme = theme
        self.on_select = on_select
        self.on_change = on_change
        self.on_activate = on_activate

        self.part = None
        self._items: Dict[str, int] = {}       # tree item -> node uid
        self._by_uid: Dict[int, str] = {}      # node uid -> tree item
        self._paths: Dict[str, tuple] = {}     # tree item -> stable path key
        self._filter = ""
        self._drag_item: Optional[str] = None
        self._drop_marker: Optional[Tuple[str, str]] = None
        self._clipboard: Optional[Node] = None
        self._ready = False

        header = PanelHeader(self, theme, "Structure", "❖")
        header.pack(fill="x")
        self.header = header
        ToolButton(header.tools, theme, glyph="⊕", tooltip="Insert a child control  (Insert)",
                   compact=True, command=self.show_insert_menu).pack(side="left")
        ToolButton(header.tools, theme, glyph="⧉", tooltip="Duplicate  (Ctrl+D)",
                   compact=True, command=self.duplicate_selected).pack(side="left")
        ToolButton(header.tools, theme, glyph="⌃", tooltip="Move up  (Ctrl+Up)",
                   compact=True, command=lambda: self.move_selected(-1)).pack(side="left")
        ToolButton(header.tools, theme, glyph="⌄", tooltip="Move down  (Ctrl+Down)",
                   compact=True, command=lambda: self.move_selected(1)).pack(side="left")
        ToolButton(header.tools, theme, glyph="🗑", tooltip="Delete  (Del)",
                   compact=True, command=self.delete_selected).pack(side="left")

        search_row = tk.Frame(self, background=theme.c("panel"))
        search_row.pack(fill="x", padx=8, pady=(0, 6))
        self.search = SearchEntry(search_row, theme, placeholder="Filter controls",
                                  command=self._on_filter, width=16)
        self.search.pack(fill="x")

        body = tk.Frame(self, background=theme.c("panel"))
        body.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(body, style="Plain.Treeview", columns=("detail",),
                                 selectmode="browse", show="tree", height=6)
        self.tree.column("#0", width=190, stretch=True, anchor="w")
        self.tree.column("detail", width=110, stretch=False, anchor="w")
        self.scroll = ttk.Scrollbar(body, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=self.scroll.set)
        self.scroll.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)

        self.empty = tk.Label(body, text="", background=theme.c("panel"),
                              foreground=theme.c("text_faint"), font=theme.font("small"),
                              wraplength=210, justify="center")

        self.tree.bind("<<TreeviewSelect>>", self._on_tree_select)
        self.tree.bind("<Double-Button-1>", self._on_double)
        self.tree.bind("<Button-3>", self._on_context)
        self.tree.bind("<Delete>", lambda _e: self.delete_selected())
        self.tree.bind("<Control-d>", lambda _e: (self.duplicate_selected(), "break"))
        self.tree.bind("<Control-Up>", lambda _e: (self.move_selected(-1), "break"))
        self.tree.bind("<Control-Down>", lambda _e: (self.move_selected(1), "break"))
        self.tree.bind("<Insert>", lambda _e: self.show_insert_menu())
        self.tree.bind("<Control-c>", lambda _e: self.copy_selected())
        self.tree.bind("<Control-v>", lambda _e: self.paste_into_selected())
        self.tree.bind("<ButtonPress-1>", self._drag_start, add="+")
        self.tree.bind("<B1-Motion>", self._drag_motion, add="+")
        self.tree.bind("<ButtonRelease-1>", self._drag_release, add="+")

        self._configure_tags()
        self._ready = True
        theme.subscribe(self.restyle)

    # ------------------------------------------------------------------ state
    @property
    def document(self) -> Optional[xmldoc.XmlDocument]:
        """Always the part's live tree - a reparse swaps the object out."""
        return self.part.tree if self.part is not None else None

    def _configure_tags(self) -> None:
        c = self.theme
        self.tree.tag_configure("error", foreground=c.c("error"))
        self.tree.tag_configure("warning", foreground=c.c("warn"))
        self.tree.tag_configure("comment", foreground=c.c("text_faint"))
        self.tree.tag_configure("dim", foreground=c.c("text_dim"))
        self.tree.tag_configure("root", foreground=c.c("accent"))
        self.tree.tag_configure("drop", background=c.c("accent_soft"))

    def set_part(self, part) -> None:
        changed = part is not self.part
        self.part = part
        self.rebuild(keep_view=not changed)

    def rebuild(self, keep_view: bool = True) -> None:
        # Node identities change on every reparse, so expansion and selection
        # are remembered by their position in the tree instead.
        expanded = {self._paths.get(item) for item in self._expanded_items()} if keep_view else set()
        expanded.discard(None)
        selected = self.selected_node()
        selected_key = selected.path_key() if selected is not None else None
        scroll = self.tree.yview()[0]

        self.tree.delete(*self.tree.get_children(""))
        self._items.clear()
        self._by_uid.clear()
        self._paths.clear()

        if self.part is None:
            self._show_placeholder("Open a workbook or create a custom UI part to begin.")
            return
        root = self.document.root if self.document else None
        if root is None:
            self._show_placeholder("Nothing to show yet - the XML has no <customUI> root.")
            return
        self._hide_placeholder()

        report = getattr(self.part, "report", None)
        self._insert_node("", root, report, first=True)

        if keep_view:
            restored = 0
            for item, key in self._paths.items():
                if key in expanded:
                    self.tree.item(item, open=True)
                    restored += 1
            if not restored:
                self.expand_default()
            if selected_key is not None:
                for item, key in self._paths.items():
                    if key == selected_key:
                        self.tree.selection_set(item)
                        self.tree.see(item)
                        break
            try:
                self.tree.yview_moveto(scroll)
            except tk.TclError:
                pass
        else:
            self.expand_default()

    def _expanded_items(self) -> List[str]:
        result = []

        def walk(parent: str) -> None:
            for item in self.tree.get_children(parent):
                if self.tree.item(item, "open"):
                    result.append(item)
                walk(item)

        walk("")
        return result

    def _insert_node(self, parent_item: str, node: Node, report, first: bool = False) -> str:
        if node.kind not in (ELEMENT, COMMENT):
            return ""
        elem = schema.elem_for_node(node) if node.kind == ELEMENT else None
        if node.kind == COMMENT:
            text = "💬  comment"
            detail = node.display_label()[5:-4].strip()
            tags = ["comment"]
        else:
            glyph = elem.glyph if elem else "⚠"
            text = f"{glyph}  {node.tag}"
            detail = node.descriptor()
            tags = ["root"] if first else []
            if elem is None:
                tags = ["error"]
            severity = report.worst_for_node(node.uid) if report else None
            if severity in ("error", "warning"):
                tags = [severity]

        if self._filter and not self._matches(node):
            if not any(self._matches(child) for child in node.walk()):
                return ""

        item = self.tree.insert(parent_item, "end", text=text, values=(detail,), tags=tuple(tags))
        self._items[item] = node.uid
        self._by_uid[node.uid] = item
        self._paths[item] = node.path_key() if node.kind == ELEMENT else (("#comment", "", 0),)
        for child in node.children:
            self._insert_node(item, child, report)
        return item

    def _matches(self, node: Node) -> bool:
        needle = self._filter.lower()
        if not needle:
            return True
        if needle in node.tag.lower():
            return True
        for value in node.attrs.values():
            if needle in value.lower():
                return True
        return False

    def _on_filter(self, value: str) -> None:
        if not getattr(self, "_ready", False):
            return
        self._filter = value.strip()
        self.rebuild(keep_view=False)
        if self._filter:
            self.expand_all()

    def _show_placeholder(self, message: str) -> None:
        self.tree.pack_forget()
        self.scroll.pack_forget()
        self.empty.configure(text=message)
        self.empty.pack(fill="both", expand=True, padx=20, pady=30)

    def _hide_placeholder(self) -> None:
        self.empty.pack_forget()
        self.scroll.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)

    # -------------------------------------------------------------- selection
    def selected_item(self) -> Optional[str]:
        selection = self.tree.selection()
        return selection[0] if selection else None

    def selected_uid(self) -> Optional[int]:
        item = self.selected_item()
        return self._items.get(item) if item else None

    def selected_node(self) -> Optional[Node]:
        uid = self.selected_uid()
        if uid is None or self.document is None:
            return None
        return self.document.find_uid(uid)

    def select_uid(self, uid: int, notify: bool = True) -> None:
        item = self._by_uid.get(uid)
        if not item:
            return
        parent = self.tree.parent(item)
        while parent:
            self.tree.item(parent, open=True)
            parent = self.tree.parent(parent)
        self.tree.selection_set(item)
        self.tree.focus(item)
        self.tree.see(item)
        if notify and self.on_select is not None:
            self.on_select(self.selected_node())

    def select_node(self, node: Optional[Node], notify: bool = True) -> None:
        if node is not None:
            self.select_uid(node.uid, notify=notify)

    def expand_default(self) -> None:
        for item in self.tree.get_children(""):
            self._expand_to_depth(item, 4)

    def _expand_to_depth(self, item: str, depth: int) -> None:
        if depth <= 0:
            return
        self.tree.item(item, open=True)
        for child in self.tree.get_children(item):
            self._expand_to_depth(child, depth - 1)

    def expand_all(self) -> None:
        for item in self._all_items():
            self.tree.item(item, open=True)

    def collapse_all(self) -> None:
        for item in self._all_items():
            self.tree.item(item, open=False)
        for item in self.tree.get_children(""):
            self.tree.item(item, open=True)

    def _all_items(self) -> List[str]:
        result: List[str] = []

        def walk(parent: str) -> None:
            for item in self.tree.get_children(parent):
                result.append(item)
                walk(item)

        walk("")
        return result

    def _on_tree_select(self, _event=None) -> None:
        if self.on_select is not None:
            self.on_select(self.selected_node())

    def _on_double(self, _event=None) -> None:
        node = self.selected_node()
        if node is not None and self.on_activate is not None:
            self.on_activate(node)

    # ------------------------------------------------------------ mutations
    def _notify(self, description: str) -> None:
        if self.on_change is not None:
            self.on_change(description)

    def insert_child(self, key: str, node: Optional[Node] = None) -> None:
        target = node or self.selected_node()
        if target is None or self.document is None:
            return
        elem = schema.SCHEMA.get(key)
        if elem is None:
            return
        if key not in {e.key for e in schema.allowed_children(target)}:
            # Not valid here - offer it as a sibling instead of building
            # markup Office would reject.
            if target.parent is not None and key in {e.key for e in schema.allowed_children(target.parent)}:
                self.insert_sibling(key)
            return
        child = schema.make_node(key, xmldoc)
        if child is None:
            return
        self._ensure_unique_ids(child)
        target.add(child)
        self._notify(f"Insert {elem.name}")
        self.rebuild()
        self.select_uid(child.uid)

    def insert_sibling(self, key: str) -> None:
        node = self.selected_node()
        if node is None or node.parent is None:
            return self.insert_child(key)
        parent = node.parent
        allowed = [e.key for e in schema.allowed_children(parent)]
        if key not in allowed:
            return
        child = schema.make_node(key, xmldoc)
        if child is None:
            return
        self._ensure_unique_ids(child)
        parent.add(child, parent.index_of(node) + 1)
        self._notify(f"Insert {schema.SCHEMA[key].name}")
        self.rebuild()
        self.select_uid(child.uid)

    def _ensure_unique_ids(self, node: Node) -> None:
        if self.document is None or self.document.root is None:
            return
        used = {n.get("id") for n in self.document.root.iter_elements() if n.get("id")}
        for candidate in node.walk():
            base = candidate.get("id")
            if not base:
                continue
            name = base
            index = 1
            while name in used:
                index += 1
                name = f"{base}{index}"
            candidate.set("id", name)
            used.add(name)

    def duplicate_selected(self) -> None:
        node = self.selected_node()
        if node is None or node.parent is None:
            return
        copy = node.clone()
        self._ensure_unique_ids(copy)
        node.parent.add(copy, node.parent.index_of(node) + 1)
        self._notify(f"Duplicate {node.tag}")
        self.rebuild()
        self.select_uid(copy.uid)

    def delete_selected(self) -> None:
        node = self.selected_node()
        if node is None or node.parent is None:
            return
        parent = node.parent
        index = parent.index_of(node)
        parent.remove(node)
        self._notify(f"Delete {node.tag}")
        self.rebuild()
        siblings = parent.children
        following = siblings[min(index, len(siblings) - 1)] if siblings else parent
        self.select_uid(following.uid)

    def move_selected(self, delta: int) -> None:
        node = self.selected_node()
        if node is None or node.parent is None:
            return
        parent = node.parent
        index = parent.index_of(node)
        target = index + delta
        if target < 0 or target >= len(parent.children):
            return
        parent.children.pop(index)
        parent.children.insert(target, node)
        self._notify(f"Move {node.tag}")
        self.rebuild()
        self.select_uid(node.uid)

    def copy_selected(self) -> None:
        node = self.selected_node()
        if node is not None:
            self._clipboard = node.clone()

    def paste_into_selected(self) -> None:
        node = self.selected_node()
        if node is None or self._clipboard is None:
            return
        allowed = {e.name for e in schema.allowed_children(node)}
        clone = self._clipboard.clone()
        if clone.local not in allowed:
            if node.parent is not None and clone.local in {e.name for e in schema.allowed_children(node.parent)}:
                self._ensure_unique_ids(clone)
                node.parent.add(clone, node.parent.index_of(node) + 1)
            else:
                return
        else:
            self._ensure_unique_ids(clone)
            node.add(clone)
        self._notify(f"Paste {clone.tag}")
        self.rebuild()
        self.select_uid(clone.uid)

    def wrap_in_box(self) -> None:
        node = self.selected_node()
        if node is None or node.parent is None:
            return
        parent = node.parent
        if "box" not in {e.name for e in schema.allowed_children(parent)}:
            return
        box = schema.make_node("box", xmldoc)
        if box is None:
            return
        self._ensure_unique_ids(box)
        index = parent.index_of(node)
        parent.remove(node)
        box.add(node)
        parent.add(box, index)
        self._notify("Wrap in box")
        self.rebuild()
        self.select_uid(box.uid)

    # ------------------------------------------------------------- insert UI
    def insert_options(self, node: Optional[Node] = None) -> List[schema.Elem]:
        target = node or self.selected_node()
        if target is None:
            return []
        return schema.allowed_children(target)

    def show_insert_menu(self, event=None) -> None:
        node = self.selected_node()
        if node is None:
            return
        options = self.insert_options(node)
        menu = make_menu(self, self.theme)
        if not options:
            menu.add_command(label=f"<{node.tag}> takes no child elements", state="disabled")
        else:
            quick = [e for e in options if e.key in schema.QUICK_INSERT]
            rest = [e for e in options if e.key not in schema.QUICK_INSERT]
            for elem in quick + rest:
                menu.add_command(label=f"  {elem.glyph}   {elem.name}",
                                 command=lambda k=elem.key: self.insert_child(k))
            if quick and rest:
                menu.insert_separator(len(quick))
        sibling_parent = node.parent
        if sibling_parent is not None:
            siblings = schema.allowed_children(sibling_parent)
            if siblings:
                menu.add_separator()
                submenu = make_menu(menu, self.theme)
                for elem in siblings:
                    submenu.add_command(label=f"  {elem.glyph}   {elem.name}",
                                        command=lambda k=elem.key: self.insert_sibling(k))
                menu.add_cascade(label="Insert after this one", menu=submenu)
        self._post(menu, event)

    def _on_context(self, event) -> None:
        item = self.tree.identify_row(event.y)
        if item:
            self.tree.selection_set(item)
            self.tree.focus(item)
        node = self.selected_node()
        menu = make_menu(self, self.theme)
        if node is not None:
            options = self.insert_options(node)
            if options:
                submenu = make_menu(menu, self.theme)
                for elem in options:
                    submenu.add_command(label=f"  {elem.glyph}   {elem.name}",
                                        command=lambda k=elem.key: self.insert_child(k))
                menu.add_cascade(label="Insert inside", menu=submenu)
            if node.parent is not None:
                siblings = schema.allowed_children(node.parent)
                if siblings:
                    submenu = make_menu(menu, self.theme)
                    for elem in siblings:
                        submenu.add_command(label=f"  {elem.glyph}   {elem.name}",
                                            command=lambda k=elem.key: self.insert_sibling(k))
                    menu.add_cascade(label="Insert after", menu=submenu)
            menu.add_separator()
            menu.add_command(label="Duplicate\tCtrl+D", command=self.duplicate_selected)
            menu.add_command(label="Copy\tCtrl+C", command=self.copy_selected)
            menu.add_command(label="Paste\tCtrl+V", command=self.paste_into_selected,
                             state="normal" if self._clipboard else "disabled")
            menu.add_command(label="Wrap in box", command=self.wrap_in_box)
            menu.add_separator()
            menu.add_command(label="Move up\tCtrl+Up", command=lambda: self.move_selected(-1))
            menu.add_command(label="Move down\tCtrl+Down", command=lambda: self.move_selected(1))
            menu.add_separator()
            menu.add_command(label="Delete\tDel", command=self.delete_selected)
            menu.add_separator()
        menu.add_command(label="Expand all", command=self.expand_all)
        menu.add_command(label="Collapse all", command=self.collapse_all)
        self._post(menu, event)

    def _post(self, menu: tk.Menu, event=None) -> None:
        try:
            if event is not None and hasattr(event, "x_root"):
                menu.tk_popup(event.x_root, event.y_root)
            else:
                x = self.header.winfo_rootx() + 20
                y = self.header.winfo_rooty() + self.header.winfo_height()
                menu.tk_popup(x, y)
        finally:
            menu.grab_release()

    # ------------------------------------------------------------ drag & drop
    def _drag_start(self, event) -> None:
        self._drag_item = self.tree.identify_row(event.y)

    def _drag_motion(self, event) -> None:
        if not self._drag_item:
            return
        target = self.tree.identify_row(event.y)
        self._clear_drop_marker()
        if not target or target == self._drag_item:
            return
        box = self.tree.bbox(target)
        if not box:
            return
        relative = (event.y - box[1]) / max(1, box[3])
        mode = "before" if relative < 0.28 else ("after" if relative > 0.72 else "into")
        if not self._can_drop(self._drag_item, target, mode):
            self.tree.configure(cursor="X_cursor")
            return
        self.tree.configure(cursor="hand2")
        self._drop_marker = (target, mode)
        self.tree.item(target, tags=tuple(list(self.tree.item(target, "tags")) + ["drop"]))

    def _clear_drop_marker(self) -> None:
        if self._drop_marker:
            item = self._drop_marker[0]
            try:
                tags = [t for t in self.tree.item(item, "tags") if t != "drop"]
                self.tree.item(item, tags=tuple(tags))
            except tk.TclError:
                pass
        self._drop_marker = None

    def _node_for_item(self, item: str) -> Optional[Node]:
        uid = self._items.get(item)
        if uid is None or self.document is None:
            return None
        return self.document.find_uid(uid)

    def _can_drop(self, source_item: str, target_item: str, mode: str) -> bool:
        source = self._node_for_item(source_item)
        target = self._node_for_item(target_item)
        if source is None or target is None or source is target:
            return False
        if source.parent is None:
            return False
        cursor = target
        while cursor is not None:
            if cursor is source:
                return False
            cursor = cursor.parent
        parent = target if mode == "into" else target.parent
        if parent is None:
            return False
        allowed = {e.name for e in schema.allowed_children(parent)}
        return source.local in allowed

    def _drag_release(self, event) -> None:
        self.tree.configure(cursor="")
        source_item, marker = self._drag_item, self._drop_marker
        self._drag_item = None
        self._clear_drop_marker()
        if not source_item or not marker:
            return
        target_item, mode = marker
        source = self._node_for_item(source_item)
        target = self._node_for_item(target_item)
        if source is None or target is None or source.parent is None:
            return
        source.parent.remove(source)
        if mode == "into":
            target.add(source)
        else:
            parent = target.parent
            if parent is None:
                return
            index = parent.index_of(target) + (1 if mode == "after" else 0)
            parent.add(source, index)
        self._notify(f"Move {source.tag}")
        self.rebuild()
        self.select_uid(source.uid)

    # ---------------------------------------------------------------- theme
    def restyle(self) -> None:
        c = self.theme
        try:
            self.configure(background=c.c("panel"))
            for child in self.winfo_children():
                if isinstance(child, tk.Frame) and not child.winfo_children():
                    continue
            self.empty.configure(background=c.c("panel"), foreground=c.c("text_faint"))
            self._configure_tags()
        except tk.TclError:
            pass
