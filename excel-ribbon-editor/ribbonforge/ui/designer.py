"""Design mode: build the ribbon by dragging controls onto the preview.

A palette of control cards sits beside the live preview.  Dragging a card
over the preview lights up every container that can legally accept it;
dropping inserts a fully scaffolded control and selects it.  Existing
controls can be picked up and moved the same way.  A small "getting
started" quest list turns the first session into a guided tour.
"""

from __future__ import annotations

import tkinter as tk
from typing import Callable, Dict, Optional, Tuple

from ..core import schema
from ..core.xmldoc import Node
from .icons import IconCache, rounded_rect
from .widgets import bind_mousewheel

PALETTE = [
    ("button",       "Button",        "A click runs your macro"),
    ("toggleButton", "Toggle",        "Stays pressed until clicked again"),
    ("checkBox",     "Check box",     "On/off option"),
    ("editBox",      "Text box",      "Single line of typed input"),
    ("comboBox",     "Combo box",     "Pick from a list or type"),
    ("dropDown",     "Drop-down",     "Pick one item from a list"),
    ("gallery",      "Gallery",       "A grid of pictures to choose from"),
    ("menu",         "Menu",          "A drop-down full of more controls"),
    ("dynamicMenu",  "Dynamic menu",  "Your VBA builds it at drop time"),
    ("splitButton",  "Split button",  "A button with a menu attached"),
    ("labelControl", "Label",         "A bit of static text"),
    ("separator",    "Separator",     "A dividing line"),
    ("box",          "Box",           "Stacks controls in a column"),
    ("buttonGroup",  "Button group",  "Buttons fused into one strip"),
    ("group",        "Group",         "A new box of controls on the tab"),
    ("tab",          "Tab",           "A whole new ribbon tab"),
]

QUESTS = [
    ("tab",      "Add a tab"),
    ("group",    "Add a group"),
    ("button",   "Drop in a button"),
    ("icon",     "Give something an icon"),
    ("label",    "Rename a control"),
    ("preview",  "Click a control in the preview"),
    ("save",     "Save your workbook"),
]


class DesignerPalette(tk.Frame):
    """The card strip plus quest list shown in design mode."""

    CARD_H = 52

    def __init__(self, master, theme, preview,
                 on_insert: Callable[[str, Node], None],
                 quest_state: Optional[Dict[str, bool]] = None,
                 on_quest: Optional[Callable[[str], None]] = None) -> None:
        super().__init__(master, background=theme.c("panel"))
        self.theme = theme
        self.preview = preview
        self.on_insert = on_insert
        self.on_quest = on_quest
        self.quests = quest_state if quest_state is not None else {}
        self.icons = IconCache(theme)

        self._drag_key: Optional[str] = None
        self._drag_node: Optional[Node] = None
        self._ghost: Optional[tk.Toplevel] = None
        self._target: Optional[Node] = None

        header = tk.Label(self, text="DRAG A CONTROL ONTO THE RIBBON",
                          background=theme.c("panel"), foreground=theme.c("text_faint"),
                          font=theme.font("small_bold"), anchor="w", padx=12, pady=8)
        header.pack(fill="x")

        holder = tk.Frame(self, background=theme.c("panel"))
        holder.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(holder, background=theme.c("panel"), highlightthickness=0,
                                bd=0, width=196)
        from tkinter import ttk
        self.vbar = ttk.Scrollbar(holder, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self._on_scrolled)
        self.canvas.pack(side="left", fill="both", expand=True)
        bind_mousewheel(self.canvas, self.canvas)
        self.canvas.bind("<Configure>", lambda _e: self.render())
        self.canvas.bind("<ButtonPress-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._motion)
        self.canvas.bind("<ButtonRelease-1>", self._release)

        self.quest_box = tk.Frame(self, background=theme.c("panel_alt"))
        self.quest_box.pack(fill="x", side="bottom")
        self.render()
        self.render_quests()
        theme.subscribe(self._restyle)

    # ---------------------------------------------------------------- palette
    def _on_scrolled(self, first, last) -> None:
        if float(first) <= 0.0 and float(last) >= 1.0:
            self.vbar.pack_forget()
        else:
            self.vbar.pack(side="right", fill="y")
        self.vbar.set(first, last)

    def _card_glyphs(self) -> Dict[str, str]:
        return {key: schema.SCHEMA[key].glyph for key, _t, _s in PALETTE if key in schema.SCHEMA}

    def render(self) -> None:
        c = self.theme
        canvas = self.canvas
        canvas.delete("all")
        width = max(canvas.winfo_width(), 100)
        y = 4
        for key, title, subtitle in PALETTE:
            elem = schema.SCHEMA.get(key)
            if elem is None:
                continue
            tag = f"card_{key}"
            rounded_rect(canvas, 8, y, width - 16, self.CARD_H - 6, 7,
                         c.c("panel_alt"), tags=(tag,), outline=c.c("border_soft"))
            canvas.create_text(26, y + (self.CARD_H - 6) / 2, text=elem.glyph,
                               fill=c.c("accent"), font=c.font("h3"), tags=(tag,))
            canvas.create_text(44, y + 14, text=title, anchor="w",
                               fill=c.c("text"), font=c.font("ui_bold"), tags=(tag,))
            canvas.create_text(44, y + 32, text=subtitle, anchor="w",
                               fill=c.c("text_faint"), font=c.font("tiny"),
                               width=width - 60, tags=(tag,))
            y += self.CARD_H
        canvas.configure(scrollregion=(0, 0, width, y + 6))

    def _key_at(self, x: float, y: float) -> Optional[str]:
        cy = self.canvas.canvasy(y)
        index = int((cy - 4) // self.CARD_H)
        if 0 <= index < len(PALETTE):
            return PALETTE[index][0]
        return None

    # ------------------------------------------------------------------- drag
    def _press(self, event) -> None:
        self._drag_key = self._key_at(event.x, event.y)

    def _motion(self, event) -> None:
        if self._drag_key is None:
            return
        if self._ghost is None:
            self._make_ghost(self._drag_key)
        self._move_ghost(event)
        self._highlight_target(event)

    def _release(self, event) -> None:
        key, target = self._drag_key, self._target
        self._drag_key = None
        self._clear_ghost()
        self._set_target(None)
        if key is None or target is None:
            return
        self.on_insert(key, target)
        self.mark_quest(key if key in ("tab", "group", "button") else "")

    def _make_ghost(self, key: str) -> None:
        c = self.theme
        elem = schema.SCHEMA.get(key)
        ghost = tk.Toplevel(self)
        ghost.wm_overrideredirect(True)
        try:
            ghost.wm_attributes("-topmost", True)
            ghost.wm_attributes("-alpha", 0.88)
        except tk.TclError:
            pass
        frame = tk.Frame(ghost, background=c.c("accent"))
        frame.pack(fill="both", expand=True)
        tk.Label(frame, text=f"{elem.glyph}  {elem.name}", background=c.c("accent"),
                 foreground=c.c("on_accent"), font=c.font("ui_bold"),
                 padx=12, pady=6).pack()
        self._ghost = ghost

    def _move_ghost(self, event) -> None:
        if self._ghost is None:
            return
        try:
            self._ghost.wm_geometry(f"+{event.x_root + 14}+{event.y_root + 10}")
        except tk.TclError:
            pass

    def _clear_ghost(self) -> None:
        if self._ghost is not None:
            try:
                self._ghost.destroy()
            except tk.TclError:
                pass
            self._ghost = None

    # ----------------------------------------------------------- drop targets
    def _preview_coords(self, event) -> Optional[Tuple[float, float]]:
        canvas = self.preview.canvas
        try:
            px = event.x_root - canvas.winfo_rootx()
            py = event.y_root - canvas.winfo_rooty()
        except tk.TclError:
            return None
        if 0 <= px <= canvas.winfo_width() and 0 <= py <= canvas.winfo_height():
            return (px, py)
        return None

    def drop_target_for(self, key: str, event) -> Optional[Node]:
        """The deepest container under the pointer that accepts ``key``."""
        coords = self._preview_coords(event)
        document = self.preview.document
        if coords is None or document is None or document.root is None:
            return None
        node = self.preview._hit(*coords)
        cursor = node
        while cursor is not None:
            allowed = {e.key for e in schema.allowed_children(cursor)}
            if key in allowed:
                return cursor
            cursor = cursor.parent
        # Nothing under the pointer: fall back to sensible homes.
        return self._fallback_target(key, document)

    def _fallback_target(self, key: str, document) -> Optional[Node]:
        root = document.root
        if key == "tab":
            ribbon = root.find("ribbon")
            tabs = ribbon.find("tabs") if ribbon is not None else None
            return tabs
        if key == "group":
            tabs = root.find_all("tab")
            index = getattr(self.preview, "active_tab", 0)
            ribbon_tabs = [t for t in tabs if "backstage" not in
                           [a.local for a in t.ancestors()]]
            if ribbon_tabs:
                return ribbon_tabs[min(index, len(ribbon_tabs) - 1)]
            return None
        groups = [g for g in root.find_all("group") if "backstage" not in
                  [a.local for a in g.ancestors()]]
        for group in groups:
            if key in {e.key for e in schema.allowed_children(group)}:
                return group
        return None

    def _highlight_target(self, event) -> None:
        if self._drag_key is None:
            return
        target = self.drop_target_for(self._drag_key, event)
        self._set_target(target)

    def _set_target(self, target: Optional[Node]) -> None:
        if target is self._target:
            return
        self._target = target
        canvas = self.preview.canvas
        canvas.delete("dropglow")
        if target is None:
            return
        for item in canvas.find_withtag(f"hit{target.uid}"):
            box = canvas.bbox(item)
            if box:
                canvas.create_rectangle(box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2,
                                        outline=self.theme.c("accent"), width=3,
                                        dash=(6, 3), tags=("dropglow",))
            break

    # ----------------------------------------------------------------- quests
    def mark_quest(self, key: str) -> None:
        if key and key in dict(QUESTS) and not self.quests.get(key):
            self.quests[key] = True
            self.render_quests()
            if self.on_quest is not None:
                self.on_quest(key)

    def render_quests(self) -> None:
        c = self.theme
        for child in self.quest_box.winfo_children():
            child.destroy()
        done = sum(1 for key, _t in QUESTS if self.quests.get(key))
        total = len(QUESTS)
        if done >= total:
            tk.Label(self.quest_box, text="🏆  Ribbon builder - all steps done!",
                     background=c.c("panel_alt"), foreground=c.c("accent"),
                     font=c.font("small_bold"), padx=12, pady=8).pack(fill="x")
            return
        head = tk.Frame(self.quest_box, background=c.c("panel_alt"))
        head.pack(fill="x", padx=12, pady=(8, 2))
        tk.Label(head, text="GETTING STARTED", background=c.c("panel_alt"),
                 foreground=c.c("text_faint"), font=c.font("small_bold")).pack(side="left")
        tk.Label(head, text=f"{done}/{total}", background=c.c("panel_alt"),
                 foreground=c.c("accent"), font=c.font("small_bold")).pack(side="right")
        bar = tk.Canvas(self.quest_box, height=4, background=c.c("border_soft"),
                        highlightthickness=0)
        bar.pack(fill="x", padx=12, pady=(0, 4))
        bar.bind("<Configure>", lambda e: (bar.delete("all"), bar.create_rectangle(
            0, 0, e.width * done / total, 4, fill=c.c("accent"), outline="")))
        for key, title in QUESTS:
            if self.quests.get(key):
                text, colour = f"✓  {title}", c.c("text_faint")
            else:
                text, colour = f"○  {title}", c.c("text_dim")
            tk.Label(self.quest_box, text=text, background=c.c("panel_alt"),
                     foreground=colour, font=c.font("small"), anchor="w",
                     padx=14).pack(fill="x")
        tk.Frame(self.quest_box, background=c.c("panel_alt"), height=8).pack()

    def _restyle(self) -> None:
        try:
            self.configure(background=self.theme.c("panel"))
            self.canvas.configure(background=self.theme.c("panel"))
            self.quest_box.configure(background=self.theme.c("panel_alt"))
            self.render()
            self.render_quests()
        except tk.TclError:
            pass


class PreviewDragController:
    """Lets existing controls in the preview be picked up and moved."""

    THRESHOLD = 6

    def __init__(self, preview, palette: DesignerPalette,
                 on_move: Callable[[Node, Node], None]) -> None:
        self.preview = preview
        self.palette = palette
        self.on_move = on_move
        self.enabled = False
        self._press_xy: Optional[Tuple[int, int]] = None
        self._node: Optional[Node] = None
        self._dragging = False
        canvas = preview.canvas
        canvas.bind("<ButtonPress-1>", self._press, add="+")
        canvas.bind("<B1-Motion>", self._motion, add="+")
        canvas.bind("<ButtonRelease-1>", self._release, add="+")

    def _press(self, event) -> None:
        if not self.enabled:
            return
        self._press_xy = (event.x_root, event.y_root)
        self._node = self.preview._hit(event.x, event.y)
        self._dragging = False

    def _movable(self, node: Optional[Node]) -> bool:
        return (node is not None and node.parent is not None
                and node.local not in ("customUI", "ribbon", "tabs"))

    def _motion(self, event) -> None:
        if not self.enabled or self._press_xy is None or not self._movable(self._node):
            return
        dx = abs(event.x_root - self._press_xy[0])
        dy = abs(event.y_root - self._press_xy[1])
        if not self._dragging and max(dx, dy) < self.THRESHOLD:
            return
        if not self._dragging:
            self._dragging = True
            key = schema.key_for_node(self._node) or self._node.local
            self.palette._drag_key = key
            self.palette._drag_node = self._node
            self.palette._make_ghost(key)
        self.palette._move_ghost(event)
        target = self.palette.drop_target_for(self.palette._drag_key, event)
        # never drop a node into itself or its own subtree
        cursor = target
        while cursor is not None:
            if cursor is self._node:
                target = None
                break
            cursor = cursor.parent
        self.palette._set_target(target)

    def _release(self, event) -> None:
        if not self._dragging:
            self._press_xy = None
            self._node = None
            return
        node, target = self._node, self.palette._target
        self.palette._drag_key = None
        self.palette._drag_node = None
        self.palette._clear_ghost()
        self.palette._set_target(None)
        self._press_xy = None
        self._node = None
        self._dragging = False
        if node is not None and target is not None and target is not node.parent:
            self.on_move(node, target)
        elif node is not None and target is node.parent:
            # Same container: reorder by horizontal position.
            self._reorder_within(node, event)

    def _reorder_within(self, node: Node, event) -> None:
        parent = node.parent
        if parent is None:
            return
        canvas = self.preview.canvas
        try:
            px = event.x_root - canvas.winfo_rootx()
        except tk.TclError:
            return
        cx = canvas.canvasx(px)
        siblings = [s for s in parent.elements if s is not node]
        best_index = len(siblings)
        for index, sibling in enumerate(siblings):
            for item in canvas.find_withtag(f"hit{sibling.uid}"):
                box = canvas.bbox(item)
                if box and cx < (box[0] + box[2]) / 2:
                    best_index = min(best_index, index)
                break
        parent.remove(node)
        anchor = siblings[best_index] if best_index < len(siblings) else None
        position = parent.index_of(anchor) if anchor is not None else len(parent.children)
        parent.add(node, position)
        self.on_move(node, parent)
