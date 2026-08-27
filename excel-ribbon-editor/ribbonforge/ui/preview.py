"""Live, approximate rendering of the ribbon described by the XML.

The layout follows Office's rules closely enough to catch the mistakes that
matter: controls that will not fit, groups in the wrong order, missing
labels, large/normal sizing, split buttons, galleries and so on.  Clicking a
control selects it everywhere else in the editor.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import font as tkfont
from tkinter import ttk
from typing import Callable, Dict, List, Optional, Tuple

from ..core.simulator import Simulation
from ..core.xmldoc import Node
from .icons import IconCache, rounded_rect
from .widgets import PanelHeader, SegmentedControl, ToolButton

MODE_RIBBON = "ribbon"
MODE_BACKSTAGE = "backstage"
MODE_CONTEXT = "contextMenus"


class RibbonPreview(tk.Frame):
    def __init__(self, master, theme,
                 on_select: Optional[Callable[[Node], None]] = None,
                 zoom: float = 1.0) -> None:
        super().__init__(master, background=theme.c("panel"))
        self.theme = theme
        self.on_select = on_select
        self.icons = IconCache(theme)

        self.part = None
        self.zoom = zoom
        self.active_tab = 0
        self.mode = MODE_RIBBON
        self.selected_uid: Optional[int] = None
        self._hover_uid: Optional[int] = None
        self._node_map: Dict[int, Node] = {}
        self._tab_hits: List[Tuple[float, float, float, float, int]] = []
        self._fonts: Dict[str, tkfont.Font] = {}
        self._image_lookup: Callable[[str], Optional[bytes]] = lambda _rid: None
        self.on_mode_change: Optional[Callable[[str], None]] = None
        self.simulation = Simulation()

        self.header = PanelHeader(self, theme, "Live preview", "▤")
        self.header.pack(fill="x")
        self.mode_switch = SegmentedControl(
            self.header.tools, theme,
            [(MODE_RIBBON, "Ribbon"), (MODE_BACKSTAGE, "Backstage"), (MODE_CONTEXT, "Context")],
            command=self.set_mode)
        self.mode_switch.pack(side="left", padx=(0, 8))
        ToolButton(self.header.tools, theme, glyph="－", compact=True, tooltip="Zoom out",
                   command=lambda: self.set_zoom(self.zoom - 0.1)).pack(side="left")
        self.zoom_label = tk.Label(self.header.tools, text="100%", background=theme.c("panel"),
                                   foreground=theme.c("text_faint"), font=theme.font("tiny"),
                                   width=5)
        self.zoom_label.pack(side="left")
        ToolButton(self.header.tools, theme, glyph="＋", compact=True, tooltip="Zoom in",
                   command=lambda: self.set_zoom(self.zoom + 0.1)).pack(side="left")

        wrapper = tk.Frame(self, background=theme.c("canvas"))
        wrapper.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(wrapper, background=theme.c("canvas"), highlightthickness=0,
                                bd=0, takefocus=0, width=240, height=118)
        self.hbar = ttk.Scrollbar(wrapper, orient="horizontal", command=self.canvas.xview)
        self.canvas.configure(xscrollcommand=self.hbar.set)
        self.hbar.pack(side="bottom", fill="x")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _e: self.redraw())
        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<Motion>", self._on_motion)
        self.canvas.bind("<Leave>", lambda _e: self._set_hover(None))

        self._build_fonts()
        theme.subscribe(self._on_theme)

    # ------------------------------------------------------------------ setup
    def _build_fonts(self) -> None:
        family = self.theme.ui_family
        base = self.theme.ui_size
        z = self.zoom
        self._fonts = {
            "label": tkfont.Font(family=family, size=max(6, int(round((base - 1) * z)))),
            "group": tkfont.Font(family=family, size=max(6, int(round((base - 2) * z)))),
            "tab": tkfont.Font(family=family, size=max(6, int(round(base * z)))),
            "tab_bold": tkfont.Font(family=family, size=max(6, int(round(base * z))), weight="bold"),
            "title": tkfont.Font(family=family, size=max(7, int(round((base + 5) * z))), weight="bold"),
            "small": tkfont.Font(family=family, size=max(6, int(round((base - 2) * z)))),
        }

    def set_zoom(self, value: float) -> None:
        self.zoom = max(0.6, min(2.0, round(value, 2)))
        self.zoom_label.configure(text=f"{int(self.zoom * 100)}%")
        self._build_fonts()
        self.icons.clear()
        self.redraw()

    def set_mode(self, mode: str) -> None:
        changed = mode != self.mode
        self.mode = mode
        self.redraw()
        if changed and self.on_mode_change is not None:
            self.on_mode_change(mode)

    def set_image_lookup(self, lookup: Callable[[str], Optional[bytes]]) -> None:
        self._image_lookup = lookup

    @property
    def document(self):
        """Always read the live tree - a reparse replaces the object."""
        return self.part.tree if self.part is not None else None

    def set_part(self, part) -> None:
        self.part = part
        self.active_tab = 0
        self.redraw()

    def refresh(self) -> None:
        self.redraw()

    def select_node(self, node: Optional[Node]) -> None:
        self.selected_uid = node.uid if node is not None else None
        if node is not None:
            branch = self._branch_of(node)
            if branch and branch != self.mode:
                self.mode = branch
                self.mode_switch.select(branch, notify=False)
                if self.on_mode_change is not None:
                    self.on_mode_change(branch)
            self._focus_tab_for(node)
        self.redraw()

    def _branch_of(self, node: Node) -> str:
        chain = [node.local] + [a.local for a in node.ancestors()]
        if "backstage" in chain:
            return MODE_BACKSTAGE
        if "contextMenus" in chain:
            return MODE_CONTEXT
        return MODE_RIBBON

    def _focus_tab_for(self, node: Node) -> None:
        chain = [node] + list(node.ancestors())
        for candidate in chain:
            if candidate.local == "tab" and candidate.parent is not None:
                tabs = self._tabs()
                if candidate in tabs:
                    self.active_tab = tabs.index(candidate)
                return

    # ---------------------------------------------------------------- model
    def _root(self) -> Optional[Node]:
        return self.document.root if self.document is not None else None

    def _ribbon(self) -> Optional[Node]:
        root = self._root()
        return root.find("ribbon") if root is not None else None

    def _tabs(self) -> List[Node]:
        ribbon = self._ribbon()
        result: List[Node] = []
        if ribbon is None:
            return result
        tabs = ribbon.find("tabs")
        if tabs is not None:
            result.extend(tabs.elements)
        contextual = ribbon.find("contextualTabs")
        if contextual is not None:
            for tab_set in contextual.elements:
                result.extend(tab_set.elements)
        return [t for t in result if t.local == "tab"]

    # --------------------------------------------------------------- drawing
    def redraw(self) -> None:
        canvas = self.canvas
        canvas.delete("all")
        self._node_map.clear()
        self._tab_hits.clear()
        if self.document is None or self._root() is None:
            self._draw_empty("Nothing to preview yet.")
            return
        try:
            if self.mode == MODE_BACKSTAGE:
                self._draw_backstage()
            elif self.mode == MODE_CONTEXT:
                self._draw_context_menus()
            else:
                self._draw_ribbon()
        except tk.TclError:
            return
        bbox = canvas.bbox("all")
        if bbox:
            canvas.configure(scrollregion=(0, 0, bbox[2] + 20, bbox[3] + 10))

    def _draw_empty(self, message: str, hint: str = "") -> None:
        c = self.theme
        width = max(self.canvas.winfo_width(), 300)
        self.canvas.create_text(width / 2, 60, text=message, fill=c.c("text_faint"),
                                font=self._fonts["tab"])
        if hint:
            self.canvas.create_text(width / 2, 84, text=hint, fill=c.c("text_faint"),
                                    font=self._fonts["small"])

    def _z(self, value: float) -> float:
        return value * self.zoom

    # ------------------------------------------------------------------ ribbon
    def _draw_ribbon(self) -> None:
        c = self.theme
        canvas = self.canvas
        z = self._z
        width = max(self.canvas.winfo_width(), 200)
        ribbon = self._ribbon()
        scratch = (ribbon.get("startFromScratch") or "false").lower() in ("true", "1") if ribbon else False

        y = z(6)
        qat = ribbon.find("qat") if ribbon is not None else None
        if qat is not None:
            y = self._draw_qat(qat, z(10), y, width)

        tabs = self._tabs()
        strip_h = z(28)
        canvas.create_rectangle(0, y, width, y + strip_h, fill=c.c("ribbon_strip"), outline="")

        x = z(10)
        file_w = self._fonts["tab"].measure("File") + z(24)
        rounded_rect(canvas, x, y + z(3), file_w, strip_h - z(6), z(3), c.c("accent"))
        canvas.create_text(x + file_w / 2, y + strip_h / 2, text="File",
                           fill=c.c("on_accent"), font=self._fonts["tab"])
        x += file_w + z(6)

        builtin = [] if scratch else ["Home", "Insert", "Page Layout", "Formulas", "Data", "Review", "View"]
        for name in builtin:
            label_w = self._fonts["tab"].measure(name) + z(18)
            canvas.create_text(x + label_w / 2, y + strip_h / 2, text=name,
                               fill=c.c("ribbon_dim"), font=self._fonts["tab"])
            x += label_w
        if builtin:
            canvas.create_line(x + z(2), y + z(6), x + z(2), y + strip_h - z(6),
                               fill=c.c("ribbon_line"))
            x += z(8)

        for index, tab in enumerate(tabs):
            label = tab.get("label") or tab.get("idMso") or tab.get("id") or "tab"
            if tab.get("getLabel") and not tab.get("label"):
                label = f"⟨{tab.get('getLabel')}⟩"
            active = index == self.active_tab
            label_w = self._fonts["tab"].measure(label) + z(22)
            if active:
                rounded_rect(canvas, x, y + z(2), label_w, strip_h - z(2), z(3),
                             c.c("ribbon_bg"), tags=(f"node{tab.uid}",))
                canvas.create_rectangle(x, y, x + label_w, y + z(2.5),
                                        fill=c.c("accent"), outline="")
            hidden = (tab.get("visible") or "true").lower() in ("false", "0")
            colour = c.c("text_faint") if hidden else (c.c("ribbon_text") if active else c.c("ribbon_dim"))
            canvas.create_text(x + label_w / 2, y + strip_h / 2, text=label, fill=colour,
                               font=self._fonts["tab_bold"] if active else self._fonts["tab"],
                               tags=(f"node{tab.uid}",))
            self._node_map[tab.uid] = tab
            self._tab_hits.append((x, y, x + label_w, y + strip_h, index))
            if self.selected_uid == tab.uid:
                canvas.create_rectangle(x + 1, y + 1, x + label_w - 1, y + strip_h - 1,
                                        outline=c.c("accent"), width=2)
            x += label_w

        y += strip_h
        body_h = z(96)
        canvas.create_rectangle(0, y, width, y + body_h, fill=c.c("ribbon_bg"), outline="")
        canvas.create_line(0, y + body_h, width, y + body_h, fill=c.c("ribbon_line"))

        if not tabs:
            canvas.create_text(width / 2, y + body_h / 2,
                               text="No tabs yet - add <tab> under <tabs>",
                               fill=c.c("text_faint"), font=self._fonts["tab"])
            return

        tab = tabs[min(self.active_tab, len(tabs) - 1)]
        groups = [g for g in tab.elements if g.local == "group"]
        cursor = z(8)
        if not groups:
            canvas.create_text(width / 2, y + body_h / 2,
                               text="This tab has no groups",
                               fill=c.c("text_faint"), font=self._fonts["small"])
        for group in groups:
            cursor = self._draw_group(group, cursor, y, body_h)
            canvas.create_line(cursor + z(3), y + z(8), cursor + z(3), y + body_h - z(8),
                               fill=c.c("ribbon_line"))
            cursor += z(8)

    def _draw_qat(self, qat: Node, x: float, y: float, width: float) -> float:
        c = self.theme
        z = self._z
        height = z(20)
        self.canvas.create_rectangle(0, y, width, y + height, fill=c.c("ribbon_strip"), outline="")
        cursor = x
        for container in qat.elements:
            for control in container.elements:
                self._draw_icon(control, cursor, y + z(3), z(14))
                self._register(control, cursor, y, cursor + z(18), y + height)
                cursor += z(20)
        self.canvas.create_text(cursor + z(6), y + height / 2, anchor="w",
                                text="Quick Access Toolbar", fill=c.c("text_faint"),
                                font=self._fonts["small"])
        return y + height + z(2)

    def _draw_group(self, group: Node, x: float, y: float, height: float) -> float:
        c = self.theme
        z = self._z
        label = group.get("label") or group.get("idMso") or ""
        if group.get("getLabel") and not label:
            label = f"⟨{group.get('getLabel')}⟩"
        content_top = y + z(6)
        content_h = height - z(24)
        cursor = x + z(6)
        start = cursor

        pending_small: List[Node] = []

        def flush() -> None:
            nonlocal cursor, pending_small
            if not pending_small:
                return
            column_w = 0.0
            for index, control in enumerate(pending_small):
                width = self._draw_small(control, cursor, content_top + index * (content_h / 3), content_h / 3)
                column_w = max(column_w, width)
            cursor += column_w + z(4)
            pending_small = []

        for control in group.elements:
            if control.local == "dialogBoxLauncher":
                continue
            if self.simulation.enabled and not self._visible(control):
                continue
            if self._is_large(control):
                flush()
                cursor += self._draw_large(control, cursor, content_top, content_h) + z(3)
            elif control.local == "separator":
                flush()
                self.canvas.create_line(cursor + z(4), content_top + z(2),
                                        cursor + z(4), content_top + content_h - z(2),
                                        fill=c.c("ribbon_line"))
                self._register(control, cursor, content_top, cursor + z(9), content_top + content_h)
                cursor += z(10)
            elif control.local == "box":
                flush()
                cursor += self._draw_box(control, cursor, content_top, content_h) + z(4)
            elif control.local == "buttonGroup":
                flush()
                cursor += self._draw_button_group(control, cursor, content_top, content_h) + z(4)
            else:
                pending_small.append(control)
                if len(pending_small) == 3:
                    flush()
        flush()

        width = max(cursor - start, self._fonts["group"].measure(label) + z(16), z(48))
        if label:
            self.canvas.create_text(start + width / 2, y + height - z(11), text=label,
                                    fill=c.c("ribbon_dim"), font=self._fonts["group"],
                                    tags=(f"node{group.uid}",))
        launcher = group.find("dialogBoxLauncher")
        if launcher is not None:
            lx, ly = start + width - z(6), y + height - z(14)
            self.canvas.create_polygon(lx, ly, lx + z(7), ly, lx + z(7), ly + z(7),
                                       fill=c.c("ribbon_dim"), outline="")
            button = launcher.find("button")
            self._register(button or launcher, lx - z(2), ly - z(2), lx + z(9), ly + z(9))
        self._register(group, start - z(4), y + z(2), start + width + z(2), y + height - z(2),
                       outline_only=True)
        return start + width + z(4)

    def _is_large(self, control: Node) -> bool:
        if control.local in ("button", "toggleButton", "menu", "dynamicMenu", "splitButton",
                             "gallery", "control"):
            return (control.get("size") or "normal").lower() == "large" or bool(control.get("getSize"))
        return False

    # -------------------------------------------------------------- controls
    def _primary(self, control: Node) -> Node:
        """A splitButton shows the label and icon of the button inside it."""
        if control.local == "splitButton":
            for child in control.elements:
                if child.local in ("button", "toggleButton"):
                    return child
        return control

    def _label_of(self, control: Node) -> str:
        control = self._primary(control)
        resolved = self.simulation.resolve_text(control, "label", "getLabel")
        if resolved:
            return resolved
        if control.get("getLabel"):
            return f"⟨{control.get('getLabel')}⟩"
        return control.get("idMso") or control.get("id") or control.local

    def _enabled(self, control: Node) -> bool:
        return self.simulation.resolve_bool(control, "enabled", "getEnabled", True)

    def _visible(self, control: Node) -> bool:
        return self.simulation.resolve_bool(control, "visible", "getVisible", True)

    def _pressed(self, control: Node) -> bool:
        return self.simulation.resolve_bool(control, "", "getPressed", False)

    def _draw_icon(self, control: Node, x: float, y: float, size: float) -> None:
        tag_uid = control.uid
        control = self._primary(control)
        image_id = control.get("image")
        data = self._image_lookup(image_id) if image_id else None
        self.icons.draw(self.canvas, x, y, size,
                        image_mso=control.get("imageMso") or "",
                        image_data=data,
                        fallback=control.get("id") or control.get("idMso") or control.local,
                        tags=(f"node{tag_uid}",),
                        muted=not self._enabled(control))

    def _wrap(self, text: str, font: tkfont.Font, width: float, lines: int = 2) -> List[str]:
        words = text.split()
        rows: List[str] = []
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if font.measure(candidate) <= width or not current:
                current = candidate
            else:
                rows.append(current)
                current = word
            if len(rows) == lines:
                break
        if current and len(rows) < lines:
            rows.append(current)
        if not rows:
            rows = [text]
        return rows[:lines]

    def _draw_large(self, control: Node, x: float, y: float, height: float) -> float:
        c = self.theme
        z = self._z
        label = self._label_of(control)
        font = self._fonts["label"]
        has_menu = control.local in ("menu", "dynamicMenu", "splitButton", "gallery")
        max_text = z(64)
        rows = self._wrap(label, font, max_text, 2)
        text_w = max((font.measure(row) for row in rows), default=z(30))
        width = max(z(40), text_w + z(10))

        icon = z(30)
        icon_x = x + (width - icon) / 2
        self._draw_icon(control, icon_x, y + z(4), icon)
        colour = c.c("ribbon_text") if self._enabled(control) else c.c("text_faint")
        line_y = y + icon + z(9)
        for index, row in enumerate(rows):
            self.canvas.create_text(x + width / 2, line_y + index * (font.metrics("linespace")),
                                    text=row, fill=colour, font=font, tags=(f"node{control.uid}",))
        if has_menu:
            arrow_y = line_y + len(rows) * font.metrics("linespace") - z(2)
            self.canvas.create_text(x + width / 2, arrow_y, text="▾", fill=colour,
                                    font=self._fonts["small"], tags=(f"node{control.uid}",))
        if not self._visible(control):
            self._strike(x, y, width, height, control)
        self._register(control, x, y, x + width, y + height)
        return width

    def _draw_small(self, control: Node, x: float, y: float, height: float) -> float:
        c = self.theme
        z = self._z
        kind = control.local
        font = self._fonts["label"]
        colour = c.c("ribbon_text") if self._enabled(control) else c.c("text_faint")
        label = self._label_of(control)
        show_label = (control.get("showLabel") or "true").lower() not in ("false", "0")
        cursor = x + z(2)
        top = y + (height - z(18)) / 2

        if kind == "checkBox":
            box = z(11)
            self.canvas.create_rectangle(cursor, top + z(3), cursor + box, top + z(3) + box,
                                         outline=c.c("ribbon_dim"), fill=c.c("ribbon_strip"),
                                         tags=(f"node{control.uid}",))
            if self._pressed(control) if self.simulation.enabled else control.get("getPressed"):
                self.canvas.create_line(cursor + z(2), top + z(8), cursor + z(4.5), top + z(11),
                                        cursor + z(9), top + z(5), fill=c.c("accent"), width=max(1, z(1.6)))
            cursor += box + z(5)
        elif kind in ("editBox", "comboBox", "dropDown"):
            if show_label and label:
                self.canvas.create_text(cursor, y + height / 2, anchor="w", text=label + ":",
                                        fill=colour, font=font, tags=(f"node{control.uid}",))
                cursor += font.measure(label + ":") + z(5)
            size_string = control.get("sizeString") or "WWWWWWW"
            field_w = max(z(46), font.measure(size_string) + z(8))
            field_h = z(15)
            fy = y + (height - field_h) / 2
            self.canvas.create_rectangle(cursor, fy, cursor + field_w, fy + field_h,
                                         fill=c.c("ribbon_strip"), outline=c.c("ribbon_line"),
                                         tags=(f"node{control.uid}",))
            if kind == "editBox":
                typed = self.simulation.resolve_text(control, "", "getText")
                if typed:
                    self.canvas.create_text(cursor + z(4), fy + field_h / 2, anchor="w",
                                            text=typed[:16], fill=c.c("ribbon_text"),
                                            font=self._fonts["small"])
            else:
                self.canvas.create_text(cursor + field_w - z(7), fy + field_h / 2, text="▾",
                                        fill=c.c("ribbon_dim"), font=self._fonts["small"],
                                        tags=(f"node{control.uid}",))
                shown = None
                if self.simulation.enabled and control.get("getItemCount"):
                    count = self.simulation.resolve_number(control, "getItemCount", 3)
                    labels = self.simulation.item_labels(control, count)
                    index = self.simulation.resolve_number(control, "getSelectedItemIndex", 0)
                    if labels:
                        shown = labels[min(index, len(labels) - 1)]
                if shown is None:
                    first = control.find("item")
                    if first is not None and first.get("label"):
                        shown = first.get("label")
                if shown:
                    self.canvas.create_text(cursor + z(4), fy + field_h / 2, anchor="w",
                                            text=shown[:14], fill=c.c("ribbon_dim"),
                                            font=self._fonts["small"])
            width = cursor + field_w - x
            self._register(control, x, y, x + width, y + height)
            return width
        elif kind == "labelControl":
            self.canvas.create_text(cursor, y + height / 2, anchor="w", text=label, fill=colour,
                                    font=font, tags=(f"node{control.uid}",))
            width = font.measure(label) + z(8)
            self._register(control, x, y, x + width, y + height)
            return width
        elif kind == "menuSeparator":
            self.canvas.create_line(x, y + height / 2, x + z(60), y + height / 2,
                                    fill=c.c("ribbon_line"))
            self._register(control, x, y, x + z(60), y + height)
            return z(60)
        else:
            show_image = (control.get("showImage") or "true").lower() not in ("false", "0")
            if show_image:
                self._draw_icon(control, cursor, top + z(2), z(14))
                cursor += z(18)

        if show_label and label and kind not in ("editBox", "comboBox", "dropDown"):
            self.canvas.create_text(cursor, y + height / 2, anchor="w", text=label, fill=colour,
                                    font=font, tags=(f"node{control.uid}",))
            cursor += font.measure(label) + z(6)
        if kind in ("menu", "dynamicMenu", "splitButton", "gallery"):
            self.canvas.create_text(cursor, y + height / 2, anchor="w", text="▾", fill=colour,
                                    font=self._fonts["small"], tags=(f"node{control.uid}",))
            cursor += z(9)
        toggled = (self._pressed(control) if self.simulation.enabled
                   else bool(control.get("getPressed")))
        if control.local == "toggleButton" and toggled:
            self.canvas.create_rectangle(x, top - z(1), cursor, top + z(19),
                                         outline=self.theme.c("accent"),
                                         width=2 if self.simulation.enabled else 1)

        width = max(cursor - x, z(20))
        if not self._visible(control):
            self._strike(x, y, width, height, control)
        self._register(control, x, y, x + width, y + height)
        return width

    def _draw_box(self, box: Node, x: float, y: float, height: float) -> float:
        z = self._z
        style = (box.get("boxStyle") or "horizontal").lower()
        children = [c for c in box.elements]
        if not children:
            self._register(box, x, y, x + z(24), y + height, outline_only=True)
            return z(24)
        if style == "vertical":
            row_h = height / max(1, min(3, len(children)))
            width = 0.0
            for index, child in enumerate(children):
                width = max(width, self._draw_small(child, x, y + index * row_h, row_h))
            self._register(box, x - z(2), y, x + width + z(2), y + height, outline_only=True)
            return width
        cursor = x
        for child in children:
            if self._is_large(child):
                cursor += self._draw_large(child, cursor, y, height) + z(3)
            else:
                cursor += self._draw_small(child, cursor, y, height) + z(3)
        self._register(box, x - z(2), y, cursor, y + height, outline_only=True)
        return cursor - x

    def _draw_button_group(self, group: Node, x: float, y: float, height: float) -> float:
        c = self.theme
        z = self._z
        children = group.elements
        if not children:
            self._register(group, x, y, x + z(24), y + height, outline_only=True)
            return z(24)
        large = any(self._is_large(child) for child in children)
        cursor = x
        top = y if large else y + (height - z(20)) / 2
        box_h = height if large else z(20)
        for child in children:
            if large:
                width = self._draw_large(child, cursor, y, height)
            else:
                width = max(z(22), self._draw_small(child, cursor + z(2), top, box_h))
                self.canvas.create_rectangle(cursor, top, cursor + width + z(4), top + box_h,
                                             outline=c.c("ribbon_line"))
                width += z(4)
            cursor += width
        self._register(group, x, top, cursor, top + box_h, outline_only=True)
        return cursor - x

    def _strike(self, x: float, y: float, width: float, height: float, node: Node) -> None:
        self.canvas.create_line(x, y + height * 0.2, x + width, y + height * 0.8,
                                fill=self.theme.c("text_faint"), dash=(2, 2))

    # ------------------------------------------------------------- backstage
    def _draw_backstage(self) -> None:
        c = self.theme
        z = self._z
        root = self._root()
        backstage = root.find("backstage") if root is not None else None
        width = max(self.canvas.winfo_width(), 320)
        if backstage is None or not backstage.elements:
            self._draw_empty("No <backstage> section in this part.",
                             "Backstage requires customUI14.xml (Office 2010+).")
            return
        nav_w = z(120)
        height = max(z(240), self.canvas.winfo_height() - z(10))
        self.canvas.create_rectangle(0, 0, width, height, fill=c.c("ribbon_bg"), outline="")
        self.canvas.create_rectangle(0, 0, nav_w, height, fill=c.c("accent"), outline="")

        y = z(14)
        self.canvas.create_text(z(12), y, anchor="nw", text="Info\nSave\nSave As\nPrint",
                                fill=c.c("on_accent"), font=self._fonts["tab"])
        y += z(70)
        selected_tab = None
        for child in backstage.elements:
            label = child.get("label") or child.get("id") or child.local
            self.canvas.create_text(z(12), y, anchor="nw", text=label,
                                    fill=c.c("on_accent"), font=self._fonts["tab_bold"],
                                    tags=(f"node{child.uid}",))
            self._register(child, 0, y - z(3), nav_w, y + z(18))
            if child.local == "tab" and selected_tab is None:
                selected_tab = child
            y += z(24)

        if selected_tab is None:
            return
        cursor_x = nav_w + z(24)
        title = selected_tab.get("title") or selected_tab.get("label") or ""
        self.canvas.create_text(cursor_x, z(20), anchor="nw", text=title,
                                fill=c.c("ribbon_text"), font=self._fonts["title"])
        column_y = z(56)
        for column in selected_tab.elements:
            column_x = cursor_x if column.local == "firstColumn" else cursor_x + z(200)
            self._draw_backstage_column(column, column_x, column_y)

    def _draw_backstage_column(self, column: Node, x: float, y: float) -> None:
        c = self.theme
        z = self._z
        cursor = y
        for group in column.elements:
            label = group.get("label") or group.get("id") or ""
            self.canvas.create_text(x, cursor, anchor="nw", text=label,
                                    fill=c.c("ribbon_text"), font=self._fonts["tab_bold"],
                                    tags=(f"node{group.uid}",))
            self._register(group, x - z(4), cursor - z(3), x + z(180), cursor + z(16))
            cursor += z(20)
            helper = group.get("helperText")
            if helper:
                self.canvas.create_text(x, cursor, anchor="nw", text=helper[:60],
                                        fill=c.c("ribbon_dim"), font=self._fonts["small"])
                cursor += z(16)
            for holder in group.elements:
                for control in ([holder] if holder.local not in
                                ("primaryItem", "topItems", "bottomItems") else holder.elements):
                    text = control.get("label") or control.get("id") or control.local
                    glyph = "▸" if control.local != "checkBox" else "☐"
                    self.canvas.create_text(x + z(8), cursor, anchor="nw", text=f"{glyph} {text}",
                                            fill=c.c("ribbon_dim"), font=self._fonts["label"],
                                            tags=(f"node{control.uid}",))
                    self._register(control, x + z(4), cursor - z(2), x + z(180), cursor + z(14))
                    cursor += z(18)
            cursor += z(14)

    # ---------------------------------------------------------- context menus
    def _draw_context_menus(self) -> None:
        c = self.theme
        z = self._z
        root = self._root()
        menus = root.find("contextMenus") if root is not None else None
        if menus is None or not menus.elements:
            self._draw_empty("No <contextMenus> section in this part.",
                             "Right-click menus require customUI14.xml (Office 2010+).")
            return
        x = z(20)
        y = z(16)
        for menu in menus.elements:
            title = menu.get("idMso") or "contextMenu"
            self.canvas.create_text(x, y, anchor="nw", text=title, fill=c.c("text_faint"),
                                    font=self._fonts["small"])
            y += z(18)
            items = menu.elements
            width = z(170)
            height = z(8) + len(items) * z(22) + z(8)
            rounded_rect(self.canvas, x, y, width, height, z(4), c.c("elevated"),
                         outline=c.c("border"))
            item_y = y + z(8)
            for item in items:
                if item.local == "menuSeparator":
                    self.canvas.create_line(x + z(8), item_y + z(10), x + width - z(8),
                                            item_y + z(10), fill=c.c("border"))
                else:
                    self._draw_icon(item, x + z(8), item_y + z(3), z(14))
                    label = item.get("label") or item.get("idMso") or item.local
                    self.canvas.create_text(x + z(30), item_y + z(10), anchor="w", text=label,
                                            fill=c.c("text"), font=self._fonts["label"],
                                            tags=(f"node{item.uid}",))
                    if item.local in ("menu", "dynamicMenu"):
                        self.canvas.create_text(x + width - z(12), item_y + z(10), text="▸",
                                                fill=c.c("text_dim"), font=self._fonts["small"])
                self._register(item, x + z(2), item_y, x + width - z(2), item_y + z(20))
                item_y += z(22)
            self._register(menu, x - z(2), y - z(2), x + width + z(2), y + height + z(2),
                           outline_only=True)
            x += width + z(28)

    # -------------------------------------------------------------- hit-test
    def _register(self, node: Node, x1: float, y1: float, x2: float, y2: float,
                  outline_only: bool = False) -> None:
        if node is None:
            return
        self._node_map[node.uid] = node
        rect = self.canvas.create_rectangle(x1, y1, x2, y2, outline="", fill="",
                                            tags=(f"hit{node.uid}", "hit"))
        self.canvas.tag_lower(rect)
        if self.selected_uid == node.uid:
            self.canvas.create_rectangle(x1, y1, x2, y2, outline=self.theme.c("accent"),
                                         width=2, dash=() if not outline_only else (3, 2))


    def _hit(self, x: float, y: float) -> Optional[Node]:
        canvas_x = self.canvas.canvasx(x)
        canvas_y = self.canvas.canvasy(y)
        best: Optional[Node] = None
        best_area = None
        for item in self.canvas.find_overlapping(canvas_x, canvas_y, canvas_x, canvas_y):
            for tag in self.canvas.gettags(item):
                if tag.startswith("hit") and tag != "hit":
                    uid = int(tag[3:])
                    node = self._node_map.get(uid)
                    if node is None:
                        continue
                    box = self.canvas.bbox(item)
                    area = (box[2] - box[0]) * (box[3] - box[1]) if box else 0
                    if best_area is None or area < best_area:
                        best, best_area = node, area
        return best

    def _on_click(self, event) -> None:
        for x1, y1, x2, y2, index in self._tab_hits:
            cx, cy = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
            if x1 <= cx <= x2 and y1 <= cy <= y2:
                self.active_tab = index
                node = self._hit(event.x, event.y)
                self.redraw()
                if node is not None and self.on_select is not None:
                    self.on_select(node)
                return
        node = self._hit(event.x, event.y)
        if node is not None and self.on_select is not None:
            self.on_select(node)

    def _on_motion(self, event) -> None:
        node = self._hit(event.x, event.y)
        self._set_hover(node.uid if node is not None else None)

    def _set_hover(self, uid: Optional[int]) -> None:
        if uid == self._hover_uid:
            return
        self._hover_uid = uid
        self.canvas.configure(cursor="hand2" if uid is not None else "")
        # Redrawing everything on every mouse move makes the whole app feel
        # laggy - draw just the hover outline instead.
        self.canvas.delete("hoverbox")
        if uid is None:
            return
        for item in self.canvas.find_withtag(f"hit{uid}"):
            box = self.canvas.bbox(item)
            if box:
                self.canvas.create_rectangle(box[0] + 1, box[1] + 1, box[2] - 1, box[3] - 1,
                                             outline=self.theme.c("border"), width=1,
                                             tags=("hoverbox",))
            break

    def _on_theme(self) -> None:
        self.icons.clear()
        self._build_fonts()
        try:
            self.configure(background=self.theme.c("panel"))
            self.canvas.configure(background=self.theme.c("canvas"))
            self.zoom_label.configure(background=self.theme.c("panel"),
                                      foreground=self.theme.c("text_faint"))
        except tk.TclError:
            pass
        self.redraw()
