"""Time Machine panel: browse ribbon snapshots, diff them, restore one."""

from __future__ import annotations

import difflib
import tkinter as tk
from tkinter import messagebox, ttk
from typing import Callable, Optional

from ..core import history
from .widgets import PanelHeader, ToolButton


class HistoryPanel(tk.Frame):
    def __init__(self, master, theme,
                 on_restore: Optional[Callable[[str], None]] = None) -> None:
        super().__init__(master, background=theme.c("panel"))
        self.theme = theme
        self.on_restore = on_restore
        self.part = None
        self._snaps = []

        header = PanelHeader(self, theme, "Time machine", "🕒")
        header.pack(fill="x")
        ToolButton(header.tools, theme, glyph="↻", compact=True,
                   tooltip="Refresh the snapshot list", command=self.rebuild).pack(side="left")

        self.intro = tk.Label(
            self, background=theme.c("panel_alt"), foreground=theme.c("text_dim"),
            font=theme.font("small"), justify="left", anchor="w", wraplength=300,
            padx=12, pady=8,
            text="Every save stores a snapshot of the ribbon XML. Pick one to see what "
                 "changed since; restore brings it back as an undoable edit.")
        self.intro.pack(fill="x")

        split = ttk.PanedWindow(self, orient="vertical")
        split.pack(fill="both", expand=True)

        top = tk.Frame(split, background=theme.c("panel"))
        self.listbox = tk.Listbox(
            top, background=theme.c("panel"), foreground=theme.c("text"),
            selectbackground=theme.c("accent_soft"), selectforeground=theme.c("text"),
            font=theme.font("ui"), relief="flat", highlightthickness=0,
            activestyle="none", height=6)
        scroll = ttk.Scrollbar(top, orient="vertical", command=self.listbox.yview)
        self.listbox.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.listbox.pack(side="left", fill="both", expand=True, padx=(6, 0))
        self.listbox.bind("<<ListboxSelect>>", lambda _e: self._show_diff())
        split.add(top, weight=1)

        bottom = tk.Frame(split, background=theme.c("panel"))
        self.diff = tk.Text(bottom, background=theme.c("code_bg"), foreground=theme.c("text_dim"),
                            font=theme.font("mono_small"), relief="flat", wrap="none",
                            state="disabled", height=8, padx=8, pady=6, highlightthickness=0)
        diff_scroll = ttk.Scrollbar(bottom, orient="vertical", command=self.diff.yview)
        self.diff.configure(yscrollcommand=diff_scroll.set)
        diff_scroll.pack(side="right", fill="y")
        self.diff.pack(side="left", fill="both", expand=True)
        split.add(bottom, weight=2)

        actions = tk.Frame(self, background=theme.c("panel"))
        actions.pack(fill="x", pady=6, padx=8)
        self.restore_button = ToolButton(actions, theme, text="Restore this version",
                                         accent=True, command=self._restore)
        self.restore_button.pack(side="left")
        self.status = tk.Label(actions, text="", background=theme.c("panel"),
                               foreground=theme.c("text_faint"), font=theme.font("small"))
        self.status.pack(side="left", padx=8)

        self._tags()
        theme.subscribe(self._restyle)

    def _tags(self) -> None:
        c = self.theme
        self.diff.tag_configure("add", foreground=c.c("ok"))
        self.diff.tag_configure("del", foreground=c.c("error"))
        self.diff.tag_configure("hunk", foreground=c.c("info"))

    # ------------------------------------------------------------------- API
    def set_part(self, part) -> None:
        self.part = part
        self.rebuild()

    def rebuild(self) -> None:
        self.listbox.delete(0, "end")
        self._snaps = []
        self._set_diff("")
        if self.part is None or not self.part.owner.path:
            self.status.configure(text="Snapshots start once the document has been saved.")
            return
        self._snaps = history.snapshots(self.part.owner.path, self.part.variant)
        if not self._snaps:
            self.status.configure(text="No snapshots yet - they appear on every save.")
            return
        self.status.configure(text=f"{len(self._snaps)} snapshots")
        for snap in self._snaps:
            self.listbox.insert("end", f"  {snap.when:<12}  {snap.stamp}")
        self.listbox.selection_set(0)
        self._show_diff()

    def _selected(self):
        selection = self.listbox.curselection()
        return self._snaps[selection[0]] if selection and self._snaps else None

    def _show_diff(self) -> None:
        snap = self._selected()
        if snap is None or self.part is None:
            return
        try:
            old = snap.read().splitlines()
        except OSError:
            self._set_diff("(snapshot unreadable)")
            return
        new = self.part.text.splitlines()
        diff = list(difflib.unified_diff(old, new, "snapshot", "current", lineterm=""))
        if len(diff) <= 2:
            self._set_diff("No difference from the current XML.")
            return
        self.diff.configure(state="normal")
        self.diff.delete("1.0", "end")
        for line in diff[2:]:
            tag = "add" if line.startswith("+") else (
                "del" if line.startswith("-") else (
                    "hunk" if line.startswith("@@") else ""))
            self.diff.insert("end", line + "\n", tag)
        self.diff.configure(state="disabled")

    def _set_diff(self, text: str) -> None:
        self.diff.configure(state="normal")
        self.diff.delete("1.0", "end")
        self.diff.insert("1.0", text)
        self.diff.configure(state="disabled")

    def _restore(self) -> None:
        snap = self._selected()
        if snap is None or self.on_restore is None:
            return
        try:
            xml = snap.read()
        except OSError as exc:
            messagebox.showerror("Could not restore", str(exc), parent=self)
            return
        self.on_restore(xml)
        self.rebuild()

    def _restyle(self) -> None:
        c = self.theme
        try:
            self.configure(background=c.c("panel"))
            self.intro.configure(background=c.c("panel_alt"), foreground=c.c("text_dim"))
            self.listbox.configure(background=c.c("panel"), foreground=c.c("text"),
                                   selectbackground=c.c("accent_soft"))
            self.diff.configure(background=c.c("code_bg"))
            self.status.configure(background=c.c("panel"), foreground=c.c("text_faint"))
            self._tags()
        except tk.TclError:
            pass
