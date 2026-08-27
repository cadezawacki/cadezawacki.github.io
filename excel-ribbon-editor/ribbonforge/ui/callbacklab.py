"""The Callback Lab panel: interactive switches that stand in for the
workbook's callbacks, driving the live preview."""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Callable, Optional

from ..core import simulator
from .widgets import PanelHeader, ScrollFrame, ToolButton, Tooltip


class CallbackLab(tk.Frame):
    def __init__(self, master, theme,
                 on_change: Optional[Callable[[], None]] = None) -> None:
        super().__init__(master, background=theme.c("panel"))
        self.theme = theme
        self.on_change = on_change
        self.part = None
        self.simulation: Optional[simulator.Simulation] = None
        self._entries = []

        header = PanelHeader(self, theme, "Callback lab", "⚗")
        header.pack(fill="x")
        self.power = ToolButton(header.tools, theme, text="Off", compact=True, toggle=True,
                                tooltip="Simulate the ribbon's callbacks in the preview",
                                command=self._toggle)
        self.power.pack(side="left")
        ToolButton(header.tools, theme, glyph="↺", compact=True,
                   tooltip="Reset every simulated value",
                   command=self._reset).pack(side="left")

        self.intro = tk.Label(
            self, background=theme.c("panel_alt"), foreground=theme.c("text_dim"),
            font=theme.font("small"), justify="left", anchor="w", wraplength=300,
            padx=12, pady=8,
            text="Office asks your VBA for state at run time - getVisible, getEnabled, "
                 "getLabel, item counts. Flip the switches below and the preview responds "
                 "exactly as the live ribbon would.")
        self.intro.pack(fill="x")

        self.scroll = ScrollFrame(self, theme)
        self.scroll.pack(fill="both", expand=True)
        theme.subscribe(self._restyle)

    # ------------------------------------------------------------------- API
    def set_part(self, part) -> None:
        self.part = part
        if part is not None:
            if not hasattr(part, "simulation"):
                part.simulation = simulator.Simulation()
            self.simulation = part.simulation
            self.power.set_active(self.simulation.enabled)
            self.power.set_text("On" if self.simulation.enabled else "Off")
        else:
            self.simulation = None
        self.rebuild()

    def rebuild(self) -> None:
        for child in self.scroll.body.winfo_children():
            child.destroy()
        c = self.theme
        if self.part is None or self.simulation is None:
            return
        self._entries = simulator.discover(self.part.tree)
        if not self._entries:
            tk.Label(self.scroll.body, background=c.c("panel"), foreground=c.c("text_faint"),
                     font=c.font("small"), wraplength=280, justify="center",
                     text="No get* callbacks in this ribbon yet.\n\nAdd getVisible, "
                          "getEnabled or getPressed to a control and it appears here."
                     ).pack(pady=30, padx=16)
            return
        groups = {"bool": [], "text": [], "number": []}
        for entry in self._entries:
            groups.setdefault(entry.kind, []).append(entry)
        titles = {"bool": "SWITCHES", "text": "TEXT", "number": "NUMBERS"}
        for kind in ("bool", "number", "text"):
            entries = groups.get(kind) or []
            if not entries:
                continue
            tk.Label(self.scroll.body, text=titles[kind], background=c.c("panel"),
                     foreground=c.c("text_faint"), font=c.font("small_bold"), anchor="w"
                     ).pack(fill="x", padx=12, pady=(12, 3))
            for entry in entries:
                self._row(entry)

    def _row(self, entry: simulator.LabEntry) -> None:
        c = self.theme
        row = tk.Frame(self.scroll.body, background=c.c("panel"))
        row.pack(fill="x", padx=12, pady=2)
        name = tk.Label(row, text=entry.callback, background=c.c("panel"),
                        foreground=c.c("text"), font=c.font("ui"), anchor="w")
        name.pack(side="left")
        Tooltip(name, f"{entry.attribute} for: {', '.join(entry.controls[:6])}", c)

        current = self.simulation.get(entry.callback, entry.default)
        if entry.kind == simulator.BOOL:
            var = tk.BooleanVar(value=bool(current))
            widget = ttk.Checkbutton(row, variable=var,
                                     command=lambda e=entry, v=var: self._commit(e, v.get()))
            widget.pack(side="right")
        elif entry.kind == simulator.NUMBER:
            var = tk.IntVar(value=int(current) if str(current).lstrip("-").isdigit() else 0)
            widget = ttk.Spinbox(row, from_=0, to=999, width=5, textvariable=var,
                                 command=lambda e=entry, v=var: self._commit(e, v.get()))
            widget.bind("<KeyRelease>", lambda _e, e=entry, v=var: self._commit_safe(e, v))
            widget.pack(side="right")
        else:
            var = tk.StringVar(value=str(current))
            widget = ttk.Entry(row, textvariable=var, width=14)
            widget.bind("<KeyRelease>", lambda _e, e=entry, v=var: self._commit(e, v.get()))
            widget.pack(side="right")

    def _commit_safe(self, entry, var) -> None:
        try:
            self._commit(entry, var.get())
        except tk.TclError:
            pass

    def _commit(self, entry: simulator.LabEntry, value) -> None:
        if self.simulation is None:
            return
        self.simulation.set(entry.callback, value)
        if not self.simulation.enabled:
            self.simulation.enabled = True
            self.power.set_active(True)
            self.power.set_text("On")
        self._notify()

    def _toggle(self) -> None:
        if self.simulation is None:
            self.power.set_active(False)
            return
        self.simulation.enabled = self.power.active
        self.power.set_text("On" if self.simulation.enabled else "Off")
        self._notify()

    def _reset(self) -> None:
        if self.simulation is not None:
            self.simulation.reset()
        self.rebuild()
        self._notify()

    def _notify(self) -> None:
        if self.on_change is not None:
            self.on_change()

    def _restyle(self) -> None:
        try:
            self.configure(background=self.theme.c("panel"))
            self.intro.configure(background=self.theme.c("panel_alt"),
                                 foreground=self.theme.c("text_dim"))
            self.rebuild()
        except tk.TclError:
            pass
