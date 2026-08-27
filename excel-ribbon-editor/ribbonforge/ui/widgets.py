"""Small custom widgets: flat tool buttons, search fields, scrolling frames,
tooltips, chips and toasts."""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from ..core.winplatform import WHEEL_SEQUENCES
from typing import Callable, Dict, Optional, Sequence, Tuple


class Tooltip:
    """A delayed tooltip that follows Windows conventions."""

    _active: Optional["Tooltip"] = None

    def __init__(self, widget: tk.Misc, text, theme, delay: int = 550, wrap: int = 380) -> None:
        self.widget = widget
        self._text = text
        self.theme = theme
        self.delay = delay
        self.wrap = wrap
        self._after: Optional[str] = None
        self._window: Optional[tk.Toplevel] = None
        widget.bind("<Enter>", self._schedule, add="+")
        widget.bind("<Leave>", self._hide, add="+")
        widget.bind("<ButtonPress>", self._hide, add="+")
        widget.bind("<Destroy>", self._hide, add="+")

    def set_text(self, text) -> None:
        self._text = text

    @property
    def text(self) -> str:
        value = self._text() if callable(self._text) else self._text
        return value or ""

    def _schedule(self, _event=None) -> None:
        self._cancel()
        if not self.text:
            return
        self._after = self.widget.after(self.delay, self._show)

    def _cancel(self) -> None:
        if self._after is not None:
            try:
                self.widget.after_cancel(self._after)
            except tk.TclError:
                pass
            self._after = None

    def _show(self) -> None:
        if self._window is not None or not self.text:
            return
        if Tooltip._active is not None:
            Tooltip._active._hide()
        try:
            x = self.widget.winfo_rootx() + 14
            y = self.widget.winfo_rooty() + self.widget.winfo_height() + 6
        except tk.TclError:
            return
        window = tk.Toplevel(self.widget)
        window.wm_overrideredirect(True)
        try:
            window.wm_attributes("-topmost", True)
        except tk.TclError:
            pass
        c = self.theme
        frame = tk.Frame(window, background=c.c("border"))
        frame.pack(fill="both", expand=True)
        label = tk.Label(frame, text=self.text, justify="left", wraplength=self.wrap,
                         background=c.c("elevated"), foreground=c.c("text"),
                         font=c.font("small"), padx=9, pady=6)
        label.pack(padx=1, pady=1)
        window.wm_geometry(f"+{x}+{y}")
        self._window = window
        Tooltip._active = self

    def _hide(self, _event=None) -> None:
        self._cancel()
        if self._window is not None:
            try:
                self._window.destroy()
            except tk.TclError:
                pass
            self._window = None
        if Tooltip._active is self:
            Tooltip._active = None


class ToolButton(tk.Frame):
    """Flat icon+label button used across toolbars and panel headers."""

    def __init__(self, master, theme, text: str = "", glyph: str = "",
                 command: Optional[Callable] = None, tooltip: str = "",
                 accent: bool = False, width: Optional[int] = None,
                 padx: int = 9, pady: int = 5, compact: bool = False,
                 toggle: bool = False, menu: bool = False, icon: str = "",
                 icon_size: int = 16, **kwargs) -> None:
        self.theme = theme
        self.accent = accent
        self.command = command
        self.toggle = toggle
        self.menu = menu
        self.icon = icon
        self.icon_size = icon_size
        self.icon_canvas: Optional[tk.Canvas] = None
        self._enabled = True
        self._active = False
        self._hover = False
        super().__init__(master, background=self._bg(), highlightthickness=0, bd=0, **kwargs)

        if icon:
            span = icon_size + 4
            self.icon_canvas = tk.Canvas(self, width=span, height=span, bd=0,
                                         highlightthickness=0, background=self._bg(),
                                         cursor="hand2", takefocus=0)
            self.icon_canvas.pack(side="left", padx=(padx, 0), pady=pady)

        content = glyph if not text else (f"{glyph}  {text}" if glyph else text)
        if menu and text:
            content += "  ⌄"
        self.label = tk.Label(self, text=content, background=self._bg(), foreground=self._fg(),
                              font=theme.font("ui" if not compact else "small"),
                              padx=6 if icon else padx, pady=pady, cursor="hand2")
        if width:
            self.label.configure(width=width)
        self.label.pack(side="left" if icon else "top", fill="both", expand=True)
        self._paint_icon()

        widgets = [self, self.label] + ([self.icon_canvas] if self.icon_canvas else [])
        for widget in widgets:
            widget.bind("<Enter>", self._on_enter)
            widget.bind("<Leave>", self._on_leave)
            widget.bind("<Button-1>", self._on_press)
            widget.bind("<ButtonRelease-1>", self._on_release)
        if tooltip:
            self.tip = Tooltip(self.label, tooltip, theme)
            if self.icon_canvas is not None:
                Tooltip(self.icon_canvas, tooltip, theme)
        theme.subscribe(self.restyle)

    def _paint_icon(self) -> None:
        if self.icon_canvas is None:
            return
        from .icons import GLYPHS
        painter = GLYPHS.get(self.icon)
        self.icon_canvas.delete("all")
        self.icon_canvas.configure(background=self._bg())
        if painter is None:
            return
        painter(self.icon_canvas, 2, 2, self.icon_size, self._fg(), self._bg(), ())

    # -------------------------------------------------------------- painting
    def _bg(self) -> str:
        c = self.theme
        if not self._enabled:
            return c.c("panel")
        if self.accent:
            return c.c("accent_hover") if self._hover else c.c("accent")
        if self._active:
            return c.c("accent_soft")
        return c.c("hover") if self._hover else c.c("panel")

    def _fg(self) -> str:
        c = self.theme
        if not self._enabled:
            return c.c("text_faint")
        if self.accent:
            return c.c("on_accent")
        if self._active:
            return c.c("accent")
        return c.c("text") if self._hover else c.c("text_dim")

    def restyle(self) -> None:
        try:
            self.configure(background=self._bg())
            self.label.configure(background=self._bg(), foreground=self._fg())
            self._paint_icon()
        except tk.TclError:
            pass

    # ---------------------------------------------------------------- events
    def _on_enter(self, _event=None) -> None:
        if not self._enabled:
            return
        self._hover = True
        self.restyle()

    def _on_leave(self, _event=None) -> None:
        self._hover = False
        self.restyle()

    def _on_press(self, _event=None) -> None:
        if not self._enabled:
            return
        self.label.configure(background=self.theme.c("border"))
        if self.icon_canvas is not None:
            self.icon_canvas.configure(background=self.theme.c("border"))

    def _on_release(self, event=None) -> None:
        if not self._enabled:
            return
        self.restyle()
        inside = (0 <= event.x <= self.label.winfo_width() and
                  0 <= event.y <= self.label.winfo_height()) if event else True
        if inside and self.command is not None:
            if self.toggle:
                self._active = not self._active
            self.command()

    # ----------------------------------------------------------------- state
    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled
        self.label.configure(cursor="hand2" if enabled else "arrow")
        self.restyle()

    def set_active(self, active: bool) -> None:
        self._active = active
        self.restyle()

    @property
    def active(self) -> bool:
        return self._active

    def set_text(self, text: str, glyph: str = "") -> None:
        content = f"{glyph}  {text}" if glyph else text
        self.label.configure(text=content)


class SegmentedControl(tk.Frame):
    """A row of mutually exclusive flat buttons (view switcher)."""

    def __init__(self, master, theme, options: Sequence[Tuple[str, str]],
                 command: Optional[Callable[[str], None]] = None, value: str = "") -> None:
        super().__init__(master, background=theme.c("panel_alt"), padx=2, pady=2)
        self.theme = theme
        self.command = command
        self.buttons: Dict[str, ToolButton] = {}
        self.value = value or (options[0][0] if options else "")
        for key, label in options:
            button = ToolButton(self, theme, text=label, compact=True, padx=11, pady=4,
                                command=lambda k=key: self.select(k))
            button.pack(side="left")
            self.buttons[key] = button
        self.select(self.value, notify=False)
        theme.subscribe(self.restyle)

    def select(self, key: str, notify: bool = True) -> None:
        if key not in self.buttons:
            return
        self.value = key
        for name, button in self.buttons.items():
            button.set_active(name == key)
        if notify and self.command is not None:
            self.command(key)

    def restyle(self) -> None:
        try:
            self.configure(background=self.theme.c("panel_alt"))
        except tk.TclError:
            pass


class SearchEntry(tk.Frame):
    """Rounded-ish search box with placeholder text and a clear button."""

    def __init__(self, master, theme, placeholder: str = "Search",
                 command: Optional[Callable[[str], None]] = None, width: int = 18) -> None:
        super().__init__(master, background=theme.c("panel_alt"), highlightthickness=1,
                         highlightbackground=theme.c("border"),
                         highlightcolor=theme.c("accent"), bd=0)
        self.theme = theme
        self.command = command
        self.placeholder = placeholder
        self.var = tk.StringVar()

        self.icon = tk.Label(self, text="⌕", background=theme.c("panel_alt"),
                             foreground=theme.c("text_faint"), font=theme.font("ui_bold"),
                             padx=6)
        self.icon.pack(side="left")
        self.entry = tk.Entry(self, textvariable=self.var, relief="flat", width=width,
                              background=theme.c("panel_alt"), foreground=theme.c("text"),
                              insertbackground=theme.c("text"), font=theme.font("ui"),
                              highlightthickness=0, bd=0)
        self.entry.pack(side="left", fill="both", expand=True, pady=4)
        self.clear_btn = tk.Label(self, text="✕", background=theme.c("panel_alt"),
                                  foreground=theme.c("text_faint"), font=theme.font("small"),
                                  padx=6, cursor="hand2")
        self.clear_btn.bind("<Button-1>", lambda _e: self.clear())
        self.var.trace_add("write", self._on_change)
        self.entry.bind("<FocusIn>", lambda _e: self._focus(True))
        self.entry.bind("<FocusOut>", lambda _e: self._focus(False))
        self.entry.bind("<Escape>", lambda _e: self.clear())
        self._show_placeholder()
        theme.subscribe(self.restyle)

    def _focus(self, focused: bool) -> None:
        self.configure(highlightbackground=self.theme.c("accent") if focused else self.theme.c("border"))
        if focused and self.entry.get() == self.placeholder and str(self.entry.cget("foreground")) == self.theme.c("text_faint"):
            self.var.set("")
            self.entry.configure(foreground=self.theme.c("text"))
        elif not focused and not self.var.get():
            self._show_placeholder()

    def _show_placeholder(self) -> None:
        if not self.var.get():
            self.entry.configure(foreground=self.theme.c("text_faint"))
            self.var.set(self.placeholder)

    def _on_change(self, *_args) -> None:
        value = self.var.get()
        real = "" if value == self.placeholder else value
        self.clear_btn.pack_forget()
        if real:
            self.clear_btn.pack(side="right")
        if self.command is not None:
            self.command(real)

    @property
    def value(self) -> str:
        text = self.var.get()
        return "" if text == self.placeholder else text

    def clear(self) -> None:
        self.var.set("")
        self.entry.focus_set()

    def restyle(self) -> None:
        c = self.theme
        try:
            self.configure(background=c.c("panel_alt"), highlightbackground=c.c("border"))
            for widget in (self.icon, self.clear_btn):
                widget.configure(background=c.c("panel_alt"), foreground=c.c("text_faint"))
            self.entry.configure(background=c.c("panel_alt"), foreground=c.c("text"),
                                 insertbackground=c.c("text"), font=c.font("ui"))
        except tk.TclError:
            pass


class ScrollFrame(tk.Frame):
    """Vertically scrolling container with a themed scrollbar."""

    def __init__(self, master, theme, background: str = "") -> None:
        super().__init__(master, background=background or theme.c("panel"))
        self.theme = theme
        self._bg = background or theme.c("panel")
        self.canvas = tk.Canvas(self, background=self._bg, highlightthickness=0, bd=0)
        self.scroll = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self._on_scroll)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.body = tk.Frame(self.canvas, background=self._bg)
        self._window = self.canvas.create_window((0, 0), window=self.body, anchor="nw")
        self.body.bind("<Configure>", self._on_body)
        self.canvas.bind("<Configure>", self._on_canvas)
        # Wheel events go to the widget under the pointer, which is almost
        # always a child row - so grab the wheel globally while the pointer
        # is anywhere over this frame.
        self.bind("<Enter>", self._grab_wheel)
        self.bind("<Leave>", self._release_wheel)
        self.bind("<Destroy>", self._release_wheel, add="+")
        theme.subscribe(self.restyle)

    def _grab_wheel(self, _event=None) -> None:
        for sequence in WHEEL_SEQUENCES:
            self.bind_all(sequence, self._on_wheel, add=False)

    def _release_wheel(self, _event=None) -> None:
        for sequence in WHEEL_SEQUENCES:
            try:
                self.unbind_all(sequence)
            except tk.TclError:
                pass

    def _on_wheel(self, event) -> str:
        if getattr(event, "num", None) == 4:
            delta = -1
        elif getattr(event, "num", None) == 5:
            delta = 1
        else:
            delta = -1 if event.delta > 0 else 1
        try:
            first, last = self.canvas.yview()
            if first <= 0.0 and last >= 1.0:
                return "break"
            self.canvas.yview_scroll(delta * 2, "units")
        except tk.TclError:
            pass
        return "break"

    def _on_scroll(self, first, last) -> None:
        if float(first) <= 0.0 and float(last) >= 1.0:
            self.scroll.pack_forget()
        else:
            self.scroll.pack(side="right", fill="y")
        self.scroll.set(first, last)

    def _on_body(self, _event=None) -> None:
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _on_canvas(self, event) -> None:
        self.canvas.itemconfigure(self._window, width=event.width)

    def scroll_to_top(self) -> None:
        self.canvas.yview_moveto(0.0)

    def restyle(self) -> None:
        try:
            self._bg = self.theme.c("panel")
            self.configure(background=self._bg)
            self.canvas.configure(background=self._bg)
            self.body.configure(background=self._bg)
        except tk.TclError:
            pass


def bind_mousewheel(widget: tk.Misc, target: tk.Misc) -> None:
    """Wire Windows/X11 wheel events to ``target``'s yview."""

    def on_wheel(event):
        if getattr(event, "num", None) == 4:
            delta = -1
        elif getattr(event, "num", None) == 5:
            delta = 1
        else:
            delta = -1 if event.delta > 0 else 1
        try:
            target.yview_scroll(delta * 2, "units")
        except tk.TclError:
            pass
        return "break"

    for sequence in WHEEL_SEQUENCES:
        widget.bind(sequence, on_wheel, add="+")


class Chip(tk.Label):
    """A small coloured count badge."""

    def __init__(self, master, theme, text: str = "", tone: str = "info") -> None:
        self.theme = theme
        self.tone = tone
        super().__init__(master, text=text, font=theme.font("tiny"), padx=6, pady=1)
        self.restyle()
        theme.subscribe(self.restyle)

    def set(self, text: str, tone: str = "") -> None:
        self.tone = tone or self.tone
        self.configure(text=text)
        self.restyle()

    def restyle(self) -> None:
        c = self.theme
        soft = {"error": "error_soft", "warn": "warn_soft", "info": "info_soft",
                "ok": "accent_soft", "muted": "panel_alt"}.get(self.tone, "info_soft")
        fore = {"muted": "text_dim"}.get(self.tone, self.tone if self.tone != "ok" else "accent")
        try:
            self.configure(background=c.c(soft), foreground=c.c(fore), font=c.font("tiny"))
        except tk.TclError:
            pass


class PanelHeader(tk.Frame):
    """Title strip used at the top of every dock panel."""

    def __init__(self, master, theme, title: str, glyph: str = "") -> None:
        super().__init__(master, background=theme.c("panel"))
        self.theme = theme
        text = f"{glyph}  {title}" if glyph else title
        self.label = tk.Label(self, text=text.upper(), background=theme.c("panel"),
                              foreground=theme.c("text_faint"), font=theme.font("small_bold"),
                              padx=10, pady=7, anchor="w")
        self.label.pack(side="left")
        self.tools = tk.Frame(self, background=theme.c("panel"))
        self.tools.pack(side="right", padx=(0, 4))
        theme.subscribe(self.restyle)

    def set_title(self, title: str, glyph: str = "") -> None:
        text = f"{glyph}  {title}" if glyph else title
        self.label.configure(text=text.upper())

    def restyle(self) -> None:
        try:
            c = self.theme
            self.configure(background=c.c("panel"))
            self.label.configure(background=c.c("panel"), foreground=c.c("text_faint"),
                                 font=c.font("small_bold"))
            self.tools.configure(background=c.c("panel"))
        except tk.TclError:
            pass


class Toast:
    """Transient message in the bottom-right corner of the main window."""

    def __init__(self, master: tk.Misc, theme) -> None:
        self.master = master
        self.theme = theme
        self._window: Optional[tk.Toplevel] = None
        self._after: Optional[str] = None

    def show(self, message: str, tone: str = "info", duration: int = 2600) -> None:
        self.hide()
        c = self.theme
        colours = {"info": c.c("accent"), "error": c.c("error"), "warn": c.c("warn"),
                   "ok": c.c("accent")}
        window = tk.Toplevel(self.master)
        window.wm_overrideredirect(True)
        try:
            window.wm_attributes("-topmost", True)
        except tk.TclError:
            pass
        outer = tk.Frame(window, background=c.c("border"))
        outer.pack(fill="both", expand=True)
        inner = tk.Frame(outer, background=c.c("elevated"))
        inner.pack(fill="both", expand=True, padx=1, pady=1)
        tk.Frame(inner, background=colours.get(tone, c.c("accent")), width=4).pack(side="left", fill="y")
        tk.Label(inner, text=message, background=c.c("elevated"), foreground=c.c("text"),
                 font=c.font("ui"), padx=14, pady=10, justify="left",
                 wraplength=420).pack(side="left")
        window.update_idletasks()
        try:
            x = self.master.winfo_rootx() + self.master.winfo_width() - window.winfo_width() - 26
            y = self.master.winfo_rooty() + self.master.winfo_height() - window.winfo_height() - 46
            window.wm_geometry(f"+{max(0, x)}+{max(0, y)}")
        except tk.TclError:
            pass
        self._window = window
        self._after = self.master.after(duration, self.hide)

    def hide(self) -> None:
        if self._after is not None:
            try:
                self.master.after_cancel(self._after)
            except tk.TclError:
                pass
            self._after = None
        if self._window is not None:
            try:
                self._window.destroy()
            except tk.TclError:
                pass
            self._window = None


class Separator(tk.Frame):
    def __init__(self, master, theme, orient: str = "horizontal", pad: int = 0) -> None:
        self.theme = theme
        if orient == "horizontal":
            super().__init__(master, background=theme.c("border"), height=1)
        else:
            super().__init__(master, background=theme.c("border"), width=1)
        theme.subscribe(self.restyle)

    def restyle(self) -> None:
        try:
            self.configure(background=self.theme.c("border"))
        except tk.TclError:
            pass


def make_menu(master: tk.Misc, theme) -> tk.Menu:
    return tk.Menu(master, tearoff=0, background=theme.c("elevated"),
                   foreground=theme.c("text"), activebackground=theme.c("accent"),
                   activeforeground=theme.c("on_accent"), bd=0, relief="flat",
                   activeborderwidth=0, font=theme.font("ui"))


def center_window(window: tk.Misc, parent: Optional[tk.Misc] = None,
                  width: int = 0, height: int = 0) -> None:
    window.update_idletasks()
    width = width or window.winfo_width()
    height = height or window.winfo_height()
    if parent is not None:
        try:
            x = parent.winfo_rootx() + (parent.winfo_width() - width) // 2
            y = parent.winfo_rooty() + (parent.winfo_height() - height) // 3
        except tk.TclError:
            x = y = 100
    else:
        x = (window.winfo_screenwidth() - width) // 2
        y = (window.winfo_screenheight() - height) // 3
    window.geometry(f"{int(width)}x{int(height)}+{max(0, int(x))}+{max(0, int(y))}")
