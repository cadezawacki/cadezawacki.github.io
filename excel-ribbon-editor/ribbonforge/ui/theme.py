"""Colour palettes, fonts and ttk styling.

Everything visual reads its colours from a single :class:`Theme` instance so
that switching between dark and light is one call plus a redraw.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import font as tkfont
from tkinter import ttk
from typing import Callable, Dict, List

DARK: Dict[str, str] = {
    "bg": "#14161a",
    "panel": "#1b1e23",
    "panel_alt": "#22262c",
    "elevated": "#272c33",
    "hover": "#2c323a",
    "border": "#30353d",
    "border_soft": "#23282f",
    "text": "#e8eaed",
    "text_dim": "#a5adb8",
    "text_faint": "#6f7883",
    "accent": "#2fa26a",
    "accent_hover": "#3ab97a",
    "accent_soft": "#1c3a2c",
    "on_accent": "#ffffff",
    "error": "#f0605f",
    "error_soft": "#3a2024",
    "warn": "#e2a63c",
    "warn_soft": "#382e1c",
    "ok": "#3fb37f",
    "info": "#5aa9e6",
    "info_soft": "#1c2c3a",
    "code_bg": "#16191d",
    "code_current": "#1d2127",
    "gutter_bg": "#16191d",
    "gutter_fg": "#525a64",
    "gutter_active": "#9aa3ae",
    "sel_bg": "#2c4a6b",
    "sel_fg": "#ffffff",
    "syn_tag": "#63b3ed",
    "syn_attr": "#d8bd72",
    "syn_value": "#9bd28c",
    "syn_comment": "#6b7683",
    "syn_punct": "#7f8994",
    "syn_decl": "#a98bd6",
    "syn_ns": "#7fa8c9",
    "match": "#3a4a55",
    "node_hl": "#1c2b25",
    "find": "#5a4a1e",
    "shadow": "#0d0f12",
    "canvas": "#1b1e23",
    "ribbon_bg": "#22262c",
    "ribbon_strip": "#1b1e23",
    "ribbon_line": "#343a42",
    "ribbon_text": "#e2e5e9",
    "ribbon_dim": "#98a1ac",
    "ribbon_hl": "#2e343c",
}

LIGHT: Dict[str, str] = {
    "bg": "#eceef1",
    "panel": "#ffffff",
    "panel_alt": "#f4f6f8",
    "elevated": "#ffffff",
    "hover": "#e7ebef",
    "border": "#d3d8de",
    "border_soft": "#e4e8ec",
    "text": "#1b1f24",
    "text_dim": "#5a6672",
    "text_faint": "#8b95a1",
    "accent": "#217346",
    "accent_hover": "#1a5c38",
    "accent_soft": "#e2f0e8",
    "on_accent": "#ffffff",
    "error": "#c0392b",
    "error_soft": "#fbe9e7",
    "warn": "#a86a12",
    "warn_soft": "#fdf3e0",
    "ok": "#217346",
    "info": "#1c6ea4",
    "info_soft": "#e6f1f9",
    "code_bg": "#ffffff",
    "code_current": "#f3f6f9",
    "gutter_bg": "#ffffff",
    "gutter_fg": "#a2abb6",
    "gutter_active": "#4a5560",
    "sel_bg": "#cfe3f7",
    "sel_fg": "#10151a",
    "syn_tag": "#0550ae",
    "syn_attr": "#8a5000",
    "syn_value": "#0a6640",
    "syn_comment": "#6e7781",
    "syn_punct": "#57606a",
    "syn_decl": "#6639ba",
    "syn_ns": "#3b6ea5",
    "match": "#dbe7f2",
    "node_hl": "#eef6f1",
    "find": "#fff2a8",
    "shadow": "#c9cdd3",
    "canvas": "#f4f6f8",
    "ribbon_bg": "#f6f7f9",
    "ribbon_strip": "#ffffff",
    "ribbon_line": "#dfe3e8",
    "ribbon_text": "#20242a",
    "ribbon_dim": "#5f6b77",
    "ribbon_hl": "#e6ebf0",
}

PALETTES = {"dark": DARK, "light": LIGHT}

ACCENTS = {
    "excel": ("#2fa26a", "#217346"),
    "blue": ("#4c92e8", "#1f66c1"),
    "violet": ("#9a7bea", "#6b46c1"),
    "amber": ("#e0a13a", "#b8791a"),
    "rose": ("#e06a86", "#c03858"),
    "teal": ("#2fb3a6", "#177f76"),
}

UI_FAMILIES = ["Segoe UI Variable Text", "Segoe UI", "Inter", "Noto Sans",
               "DejaVu Sans", "Helvetica", "TkDefaultFont"]
MONO_FAMILIES = ["Cascadia Mono", "Consolas", "JetBrains Mono", "Fira Mono",
                 "DejaVu Sans Mono", "Courier New", "TkFixedFont"]


def _pick(candidates: List[str], available: List[str]) -> str:
    lowered = {name.lower() for name in available}
    for name in candidates:
        if name.lower() in lowered:
            return name
    return candidates[-1]


class Theme:
    """Holds the active palette and pushes it into ttk."""

    def __init__(self, root: tk.Misc, name: str = "dark", accent: str = "excel",
                 ui_size: int = 10, mono_family: str = "", mono_size: int = 11) -> None:
        self.root = root
        self.name = name if name in PALETTES else "dark"
        self.accent_name = accent if accent in ACCENTS else "excel"
        self.colors: Dict[str, str] = dict(PALETTES[self.name])
        self._subscribers: List[Callable[[], None]] = []
        self.style = ttk.Style(root)

        families = list(tkfont.families(root))
        self.ui_family = _pick(UI_FAMILIES, families)
        self.mono_family = mono_family if mono_family and mono_family in families \
            else _pick(MONO_FAMILIES, families)
        self.ui_size = ui_size
        self.mono_size = mono_size
        self._build_fonts()
        self.apply()

    # ------------------------------------------------------------------ fonts
    def _build_fonts(self) -> None:
        size = self.ui_size
        self.fonts = {
            "ui": tkfont.Font(family=self.ui_family, size=size),
            "ui_bold": tkfont.Font(family=self.ui_family, size=size, weight="bold"),
            "small": tkfont.Font(family=self.ui_family, size=max(7, size - 1)),
            "small_bold": tkfont.Font(family=self.ui_family, size=max(7, size - 1), weight="bold"),
            "tiny": tkfont.Font(family=self.ui_family, size=max(6, size - 2)),
            "h1": tkfont.Font(family=self.ui_family, size=size + 7, weight="bold"),
            "h2": tkfont.Font(family=self.ui_family, size=size + 3, weight="bold"),
            "h3": tkfont.Font(family=self.ui_family, size=size + 1, weight="bold"),
            "mono": tkfont.Font(family=self.mono_family, size=self.mono_size),
            "mono_bold": tkfont.Font(family=self.mono_family, size=self.mono_size, weight="bold"),
            "mono_small": tkfont.Font(family=self.mono_family, size=max(7, self.mono_size - 1)),
            "glyph": tkfont.Font(family=self.ui_family, size=size + 2),
        }

    def font(self, role: str = "ui") -> tkfont.Font:
        return self.fonts.get(role, self.fonts["ui"])

    def set_ui_size(self, size: int) -> None:
        self.ui_size = max(7, min(16, int(size)))
        self._build_fonts()
        self.apply()
        self.notify()

    def set_mono(self, family: str, size: int) -> None:
        families = list(tkfont.families(self.root))
        if family and family in families:
            self.mono_family = family
        self.mono_size = max(7, min(28, int(size)))
        self._build_fonts()
        self.apply()
        self.notify()

    # ----------------------------------------------------------------- colors
    def c(self, key: str) -> str:
        return self.colors.get(key, "#ff00ff")

    def set_theme(self, name: str) -> None:
        if name not in PALETTES:
            return
        self.name = name
        self.colors = dict(PALETTES[name])
        self._apply_accent()
        self.apply()
        self.notify()

    def set_accent(self, accent: str) -> None:
        if accent not in ACCENTS:
            return
        self.accent_name = accent
        self._apply_accent()
        self.apply()
        self.notify()

    def _apply_accent(self) -> None:
        dark_accent, light_accent = ACCENTS[self.accent_name]
        base = dark_accent if self.name == "dark" else light_accent
        self.colors["accent"] = base
        self.colors["accent_hover"] = _shift(base, 14 if self.name == "dark" else -18)
        self.colors["accent_soft"] = _mix(base, self.colors["panel"], 0.18 if self.name == "dark" else 0.14)
        self.colors["node_hl"] = _mix(base, self.colors["code_bg"], 0.13 if self.name == "dark" else 0.10)

    # ------------------------------------------------------------ subscribers
    def subscribe(self, callback: Callable[[], None]) -> None:
        self._subscribers.append(callback)

    def notify(self) -> None:
        for callback in list(self._subscribers):
            try:
                callback()
            except tk.TclError:
                self._subscribers.remove(callback)

    # ------------------------------------------------------------------ ttk
    def apply(self) -> None:
        c = self.colors
        style = self.style
        try:
            style.theme_use("clam")
        except tk.TclError:  # pragma: no cover - clam ships with Tk
            pass

        self.root.option_add("*Font", self.fonts["ui"])
        self.root.option_add("*TCombobox*Listbox.background", c["elevated"])
        self.root.option_add("*TCombobox*Listbox.foreground", c["text"])
        self.root.option_add("*TCombobox*Listbox.selectBackground", c["accent"])
        self.root.option_add("*TCombobox*Listbox.selectForeground", c["on_accent"])
        self.root.option_add("*TCombobox*Listbox.font", self.fonts["ui"])
        self.root.option_add("*Menu.background", c["elevated"])
        self.root.option_add("*Menu.foreground", c["text"])
        self.root.option_add("*Menu.activeBackground", c["accent"])
        self.root.option_add("*Menu.activeForeground", c["on_accent"])
        self.root.option_add("*Menu.relief", "flat")
        self.root.option_add("*Menu.borderWidth", 1)
        self.root.option_add("*Menu.activeBorderWidth", 0)
        self.root.option_add("*Menu.font", self.fonts["ui"])
        try:
            self.root.configure(background=c["bg"])
        except tk.TclError:
            pass

        style.configure(".", background=c["panel"], foreground=c["text"],
                        fieldbackground=c["panel_alt"], bordercolor=c["border"],
                        focuscolor=c["accent"], font=self.fonts["ui"])

        style.configure("TFrame", background=c["panel"])
        style.configure("App.TFrame", background=c["bg"])
        style.configure("Panel.TFrame", background=c["panel"])
        style.configure("Alt.TFrame", background=c["panel_alt"])
        style.configure("Card.TFrame", background=c["panel"], relief="flat")
        style.configure("Toolbar.TFrame", background=c["panel"])

        style.configure("TLabel", background=c["panel"], foreground=c["text"])
        style.configure("Alt.TLabel", background=c["panel_alt"], foreground=c["text"])
        style.configure("Dim.TLabel", background=c["panel"], foreground=c["text_dim"],
                        font=self.fonts["small"])
        style.configure("Faint.TLabel", background=c["panel"], foreground=c["text_faint"],
                        font=self.fonts["small"])
        style.configure("H1.TLabel", background=c["panel"], foreground=c["text"], font=self.fonts["h1"])
        style.configure("H2.TLabel", background=c["panel"], foreground=c["text"], font=self.fonts["h2"])
        style.configure("H3.TLabel", background=c["panel"], foreground=c["text"], font=self.fonts["h3"])
        style.configure("Section.TLabel", background=c["panel"], foreground=c["text_dim"],
                        font=self.fonts["small_bold"])
        style.configure("Accent.TLabel", background=c["panel"], foreground=c["accent"],
                        font=self.fonts["small_bold"])
        style.configure("Error.TLabel", background=c["panel"], foreground=c["error"],
                        font=self.fonts["small"])
        style.configure("Mono.TLabel", background=c["panel"], foreground=c["text_dim"],
                        font=self.fonts["mono_small"])

        style.configure("TButton", background=c["panel_alt"], foreground=c["text"],
                        bordercolor=c["border"], darkcolor=c["panel_alt"],
                        lightcolor=c["panel_alt"], relief="flat", padding=(12, 6),
                        anchor="center")
        style.map("TButton",
                  background=[("pressed", c["border"]), ("active", c["hover"]), ("disabled", c["panel"])],
                  foreground=[("disabled", c["text_faint"])])

        style.configure("Accent.TButton", background=c["accent"], foreground=c["on_accent"],
                        bordercolor=c["accent"], darkcolor=c["accent"], lightcolor=c["accent"],
                        relief="flat", padding=(14, 6), font=self.fonts["ui_bold"])
        style.map("Accent.TButton",
                  background=[("pressed", c["accent_hover"]), ("active", c["accent_hover"]),
                              ("disabled", c["panel_alt"])],
                  foreground=[("disabled", c["text_faint"])])

        style.configure("Ghost.TButton", background=c["panel"], foreground=c["text_dim"],
                        bordercolor=c["panel"], darkcolor=c["panel"], lightcolor=c["panel"],
                        relief="flat", padding=(8, 4))
        style.map("Ghost.TButton",
                  background=[("pressed", c["border"]), ("active", c["hover"])],
                  foreground=[("active", c["text"]), ("disabled", c["text_faint"])])

        style.configure("Danger.TButton", background=c["error"], foreground="#ffffff",
                        bordercolor=c["error"], darkcolor=c["error"], lightcolor=c["error"],
                        relief="flat", padding=(12, 6))
        style.map("Danger.TButton", background=[("active", _shift(c["error"], -14))])

        style.configure("TEntry", fieldbackground=c["panel_alt"], foreground=c["text"],
                        bordercolor=c["border"], lightcolor=c["border"], darkcolor=c["border"],
                        insertcolor=c["text"], padding=5, relief="flat")
        style.map("TEntry",
                  bordercolor=[("focus", c["accent"])],
                  lightcolor=[("focus", c["accent"])],
                  darkcolor=[("focus", c["accent"])],
                  fieldbackground=[("readonly", c["panel"]), ("disabled", c["panel"])],
                  foreground=[("disabled", c["text_faint"])])

        style.configure("TCombobox", fieldbackground=c["panel_alt"], background=c["panel_alt"],
                        foreground=c["text"], bordercolor=c["border"], lightcolor=c["border"],
                        darkcolor=c["border"], arrowcolor=c["text_dim"], padding=4, relief="flat")
        style.map("TCombobox",
                  fieldbackground=[("readonly", c["panel_alt"]), ("disabled", c["panel"])],
                  bordercolor=[("focus", c["accent"])],
                  arrowcolor=[("active", c["text"])],
                  foreground=[("disabled", c["text_faint"])])

        style.configure("TSpinbox", fieldbackground=c["panel_alt"], foreground=c["text"],
                        bordercolor=c["border"], lightcolor=c["border"], darkcolor=c["border"],
                        arrowcolor=c["text_dim"], padding=4, relief="flat", insertcolor=c["text"])

        style.configure("TCheckbutton", background=c["panel"], foreground=c["text"],
                        indicatorcolor=c["panel_alt"], indicatorbackground=c["panel_alt"],
                        bordercolor=c["border"], focuscolor=c["panel"], padding=3)
        style.map("TCheckbutton",
                  indicatorcolor=[("selected", c["accent"]), ("pressed", c["accent_hover"])],
                  background=[("active", c["panel"])],
                  foreground=[("disabled", c["text_faint"])])
        style.configure("Alt.TCheckbutton", background=c["panel_alt"], foreground=c["text"],
                        indicatorcolor=c["panel"], focuscolor=c["panel_alt"])
        style.map("Alt.TCheckbutton", indicatorcolor=[("selected", c["accent"])],
                  background=[("active", c["panel_alt"])])

        style.configure("TRadiobutton", background=c["panel"], foreground=c["text"],
                        indicatorcolor=c["panel_alt"], focuscolor=c["panel"], padding=3)
        style.map("TRadiobutton", indicatorcolor=[("selected", c["accent"])],
                  background=[("active", c["panel"])])

        style.configure("TSeparator", background=c["border"])
        style.configure("TPanedwindow", background=c["bg"])
        style.configure("Sash", sashthickness=6, gripcount=0)
        style.configure("TSizegrip", background=c["panel"])

        for orient in ("Vertical", "Horizontal"):
            style.configure(f"{orient}.TScrollbar", background=c["border"], troughcolor=c["panel"],
                            bordercolor=c["panel"], arrowcolor=c["panel"], relief="flat",
                            darkcolor=c["panel"], lightcolor=c["panel"], arrowsize=1, width=11)
            style.map(f"{orient}.TScrollbar",
                      background=[("active", c["text_faint"]), ("pressed", c["accent"])])
            try:
                style.layout(f"{orient}.TScrollbar", [
                    (f"{orient}.Scrollbar.trough", {
                        "sticky": "ns" if orient == "Vertical" else "ew",
                        "children": [(f"{orient}.Scrollbar.thumb",
                                      {"expand": "1", "sticky": "nswe"})]})])
            except tk.TclError:
                pass

        style.configure("Treeview", background=c["panel"], fieldbackground=c["panel"],
                        foreground=c["text"], bordercolor=c["panel"], relief="flat",
                        rowheight=int(self.fonts["ui"].metrics("linespace") * 1.65),
                        font=self.fonts["ui"])
        style.map("Treeview",
                  background=[("selected", c["accent_soft"])],
                  foreground=[("selected", c["text"])])
        style.configure("Treeview.Heading", background=c["panel_alt"], foreground=c["text_dim"],
                        relief="flat", font=self.fonts["small_bold"], padding=(6, 4))
        style.map("Treeview.Heading", background=[("active", c["hover"])])
        style.layout("Plain.Treeview", [("Treeview.treearea", {"sticky": "nswe"})])
        try:  # Tk 8.6.11+ lets us tighten the indentation
            style.configure("Treeview", indent=15)
            style.configure("Plain.Treeview", indent=15)
        except tk.TclError:
            pass
        style.configure("Plain.Treeview", background=c["panel"], fieldbackground=c["panel"],
                        borderwidth=0, relief="flat")
        style.map("Plain.Treeview",
                  background=[("selected", c["accent_soft"])],
                  foreground=[("selected", c["text"])])

        style.configure("TNotebook", background=c["bg"], bordercolor=c["border"], tabmargins=(0, 0, 0, 0))
        style.configure("TNotebook.Tab", background=c["panel_alt"], foreground=c["text_dim"],
                        padding=(14, 7), bordercolor=c["border"], font=self.fonts["ui"])
        style.map("TNotebook.Tab",
                  background=[("selected", c["panel"]), ("active", c["hover"])],
                  foreground=[("selected", c["text"])])

        style.configure("TProgressbar", background=c["accent"], troughcolor=c["panel_alt"],
                        bordercolor=c["panel_alt"], lightcolor=c["accent"], darkcolor=c["accent"])
        style.configure("TScale", background=c["panel"], troughcolor=c["panel_alt"])
        style.configure("TLabelframe", background=c["panel"], bordercolor=c["border"],
                        lightcolor=c["border"], darkcolor=c["border"])
        style.configure("TLabelframe.Label", background=c["panel"], foreground=c["text_dim"],
                        font=self.fonts["small_bold"])


def _clamp(value: float) -> int:
    return max(0, min(255, int(round(value))))


def _rgb(color: str):
    color = color.lstrip("#")
    if len(color) == 3:
        color = "".join(ch * 2 for ch in color)
    return tuple(int(color[i:i + 2], 16) for i in (0, 2, 4))


def _hex(rgb) -> str:
    return "#%02x%02x%02x" % tuple(_clamp(v) for v in rgb)


def _shift(color: str, amount: int) -> str:
    """Lighten (positive) or darken (negative) a colour by ``amount``/255."""
    return _hex(tuple(v + amount for v in _rgb(color)))


def _mix(a: str, b: str, ratio: float) -> str:
    ra, rb = _rgb(a), _rgb(b)
    return _hex(tuple(ra[i] * ratio + rb[i] * (1 - ratio) for i in range(3)))


def mix(a: str, b: str, ratio: float) -> str:
    return _mix(a, b, ratio)


def shift(color: str, amount: int) -> str:
    return _shift(color, amount)


def readable_on(background: str) -> str:
    r, g, b = _rgb(background)
    luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return "#10131a" if luminance > 0.6 else "#ffffff"
