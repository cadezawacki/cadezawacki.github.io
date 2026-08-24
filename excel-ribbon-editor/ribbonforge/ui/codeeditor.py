"""A small XML code editor: gutter, syntax highlighting, tag-aware
autocomplete, find & replace, and inline problem markers."""

from __future__ import annotations

import bisect
import re
import tkinter as tk
from dataclasses import dataclass, field
from tkinter import ttk
from typing import Callable, Dict, List, Optional, Tuple

from .widgets import SearchEntry, ToolButton, bind_mousewheel

TOKEN_RE = re.compile(
    r"(?P<comment><!--.*?-->)"
    r"|(?P<cdata><!\[CDATA\[.*?\]\]>)"
    r"|(?P<decl><\?.*?\?>|<!DOCTYPE[^>]*>)"
    r"|(?P<tag></?[A-Za-z_][\w:.\-]*)"
    r"|(?P<string>\"[^\"]*\"|'[^']*')"
    r"|(?P<attr>[A-Za-z_][\w:.\-]*)(?=\s*=)"
    r"|(?P<punct>/?>)",
    re.DOTALL,
)

MAX_HIGHLIGHT = 400_000
INDENT_STEP = "  "


@dataclass
class CompletionContext:
    """Everything a completion provider needs to know about the caret."""

    kind: str                       # 'element' | 'attribute' | 'value' | 'none'
    stack: List[str] = field(default_factory=list)
    tag: str = ""
    attribute: str = ""
    prefix: str = ""
    used_attributes: List[str] = field(default_factory=list)


@dataclass
class Completion:
    label: str
    insert: str = ""
    detail: str = ""
    kind: str = ""

    def __post_init__(self) -> None:
        if not self.insert:
            self.insert = self.label


class CodeEditor(tk.Frame):
    def __init__(self, master, theme, on_change: Optional[Callable[[], None]] = None,
                 on_caret: Optional[Callable[[int, int], None]] = None,
                 completion_provider: Optional[Callable[[CompletionContext], List[Completion]]] = None,
                 on_node_focus: Optional[Callable[[int, int], None]] = None) -> None:
        super().__init__(master, background=theme.c("code_bg"))
        self.theme = theme
        self.on_change = on_change
        self.on_caret = on_caret
        self.completion_provider = completion_provider
        self.on_node_focus = on_node_focus

        self._suspend = False
        self._highlight_job: Optional[str] = None
        self._change_job: Optional[str] = None
        self._line_starts: List[int] = [0]
        self._issue_lines: Dict[int, str] = {}
        self._popup: Optional[tk.Toplevel] = None
        self._popup_list: Optional[tk.Listbox] = None
        self._completions: List[Completion] = []
        self._find_matches: List[Tuple[str, str]] = []
        self._find_index = -1

        body = tk.Frame(self, background=theme.c("code_bg"))
        body.pack(fill="both", expand=True)

        self.gutter = tk.Canvas(body, width=54, background=theme.c("gutter_bg"),
                                highlightthickness=0, bd=0, takefocus=0)
        self.gutter.pack(side="left", fill="y")

        self.vbar = ttk.Scrollbar(body, orient="vertical", command=self._yview)
        self.vbar.pack(side="right", fill="y")

        self.text = tk.Text(
            body, wrap="none", undo=True, autoseparators=True, maxundo=-1,
            background=theme.c("code_bg"), foreground=theme.c("text"),
            insertbackground=theme.c("accent"), insertwidth=2,
            selectbackground=theme.c("sel_bg"), selectforeground=theme.c("sel_fg"),
            font=theme.font("mono"), relief="flat", padx=10, pady=6,
            highlightthickness=0, bd=0, tabs=("1c",),
            yscrollcommand=self._on_yscroll, xscrollcommand=lambda *a: self.hbar.set(*a),
            spacing1=1, spacing3=1, width=40, height=6,
        )
        self.text.pack(side="left", fill="both", expand=True)

        self.hbar = ttk.Scrollbar(self, orient="horizontal", command=self.text.xview)
        self.hbar.pack(fill="x")

        self._configure_tags()
        self._bind_events()
        theme.subscribe(self.restyle)

    # ------------------------------------------------------------------ setup
    def _configure_tags(self) -> None:
        c = self.theme
        self.text.tag_configure("tag", foreground=c.c("syn_tag"))
        self.text.tag_configure("attr", foreground=c.c("syn_attr"))
        self.text.tag_configure("string", foreground=c.c("syn_value"))
        self.text.tag_configure("comment", foreground=c.c("syn_comment"), font=c.font("mono"))
        self.text.tag_configure("cdata", foreground=c.c("syn_comment"))
        self.text.tag_configure("decl", foreground=c.c("syn_decl"))
        self.text.tag_configure("punct", foreground=c.c("syn_punct"))
        self.text.tag_configure("current_line", background=c.c("code_current"))
        self.text.tag_configure("match", background=c.c("match"))
        self.text.tag_configure("find", background=c.c("find"), foreground=c.c("text"))
        self.text.tag_configure("find_current", background=c.c("accent"), foreground=c.c("on_accent"))
        self.text.tag_configure("sel_node", background=c.c("node_hl"))
        self.text.tag_configure("err", underline=True)
        self.text.tag_lower("current_line")
        self.text.tag_lower("sel_node")

    def _bind_events(self) -> None:
        text = self.text
        text.bind("<<Modified>>", self._on_modified)
        text.bind("<KeyRelease>", self._on_key_release)
        text.bind("<ButtonRelease-1>", self._on_click)
        text.bind("<Configure>", lambda _e: self._redraw_gutter())
        text.bind("<MouseWheel>", self._after_scroll, add="+")
        text.bind("<Button-4>", self._after_scroll, add="+")
        text.bind("<Button-5>", self._after_scroll, add="+")
        text.bind("<Return>", self._on_return)
        text.bind("<greater>", self._on_gt)
        text.bind("<quotedbl>", self._on_quote)
        text.bind("<Tab>", self._on_tab)
        text.bind("<Shift-Tab>", self._on_shift_tab)
        text.bind("<ISO_Left_Tab>", self._on_shift_tab)
        text.bind("<Control-slash>", self._toggle_comment)
        text.bind("<Control-d>", self._duplicate_line)
        text.bind("<Control-l>", lambda _e: (self.select_line(), "break"))
        text.bind("<Alt-Up>", lambda e: self._move_line(-1))
        text.bind("<Alt-Down>", lambda e: self._move_line(1))
        text.bind("<Control-space>", self._request_completion)
        text.bind("<less>", self._maybe_complete_element)
        text.bind("<Escape>", lambda _e: self._close_popup())
        text.bind("<Control-f>", lambda _e: (self.show_find(), "break"))
        text.bind("<Control-h>", lambda _e: (self.show_find(replace=True), "break"))
        text.bind("<F3>", lambda _e: (self.find_next(), "break"))
        text.bind("<Control-g>", lambda _e: (self.prompt_goto(), "break"))
        self.gutter.bind("<Button-1>", self._on_gutter_click)
        bind_mousewheel(self.gutter, self.text)

    # ------------------------------------------------------------- scrolling
    def _yview(self, *args) -> None:
        self.text.yview(*args)
        self._redraw_gutter()

    def _on_yscroll(self, first, last) -> None:
        self.vbar.set(first, last)
        self._redraw_gutter()

    def _after_scroll(self, _event=None):
        self.after_idle(self._redraw_gutter)

    # ------------------------------------------------------------------ text
    def get_text(self) -> str:
        return self.text.get("1.0", "end-1c")

    def set_text(self, value: str, keep_view: bool = False, mark_undo: bool = True) -> None:
        view = self.text.yview()[0]
        cursor = self.text.index("insert")
        self._suspend = True
        # Group the delete+insert into a single undo step, otherwise Tk's
        # automatic separators make Ctrl+Z leave the document empty.
        self.text.configure(autoseparators=False)
        if mark_undo:
            self.text.edit_separator()
        self.text.delete("1.0", "end")
        self.text.insert("1.0", value)
        if mark_undo:
            self.text.edit_separator()
        else:
            self.text.edit_reset()
        self.text.configure(autoseparators=True)
        self._suspend = False
        self.text.edit_modified(False)
        if keep_view:
            try:
                self.text.mark_set("insert", cursor)
                self.text.yview_moveto(view)
            except tk.TclError:
                pass
        self.highlight()
        self._redraw_gutter()

    def focus_editor(self) -> None:
        self.text.focus_set()

    # --------------------------------------------------------------- events
    def _on_modified(self, _event=None) -> None:
        if not self.text.edit_modified():
            return
        self.text.edit_modified(False)
        if self._suspend:
            return
        self._schedule_highlight()
        if self.on_change is not None:
            if self._change_job is not None:
                try:
                    self.after_cancel(self._change_job)
                except tk.TclError:
                    pass
            self._change_job = self.after(220, self._emit_change)

    def _emit_change(self) -> None:
        self._change_job = None
        if self.on_change is not None:
            self.on_change()

    def _on_key_release(self, event) -> None:
        if event.keysym in ("Up", "Down", "Left", "Right", "Home", "End", "Prior", "Next",
                            "BackSpace", "Delete"):
            self._close_popup() if event.keysym in ("Left", "Right", "Home", "End") else None
        self._update_caret()
        self._redraw_gutter()
        if self._popup is not None and event.keysym not in ("Up", "Down", "Return", "Tab", "Escape"):
            self._refresh_popup()

    def _on_click(self, _event=None) -> None:
        self._close_popup()
        self._update_caret()
        if self.on_node_focus is not None:
            line, column = self._caret()
            self.on_node_focus(line, column)

    def _caret(self) -> Tuple[int, int]:
        index = self.text.index("insert")
        line, column = index.split(".")
        return int(line), int(column)

    def _update_caret(self) -> None:
        self.text.tag_remove("current_line", "1.0", "end")
        self.text.tag_add("current_line", "insert linestart", "insert lineend+1c")
        self._highlight_matching_tag()
        if self.on_caret is not None:
            line, column = self._caret()
            self.on_caret(line, column)

    # ------------------------------------------------------------ highlight
    def _schedule_highlight(self) -> None:
        if self._highlight_job is not None:
            try:
                self.after_cancel(self._highlight_job)
            except tk.TclError:
                pass
        self._highlight_job = self.after(90, self.highlight)

    def highlight(self) -> None:
        self._highlight_job = None
        source = self.get_text()
        self._index_lines(source)
        for tag in ("tag", "attr", "string", "comment", "cdata", "decl", "punct"):
            self.text.tag_remove(tag, "1.0", "end")
        if len(source) > MAX_HIGHLIGHT:
            return
        for match in TOKEN_RE.finditer(source):
            kind = match.lastgroup
            if kind is None:
                continue
            start = self._offset_to_index(match.start())
            end = self._offset_to_index(match.end())
            self.text.tag_add(kind, start, end)
        self._update_caret()

    def _index_lines(self, source: str) -> None:
        starts = [0]
        position = source.find("\n")
        while position != -1:
            starts.append(position + 1)
            position = source.find("\n", position + 1)
        self._line_starts = starts

    def _offset_to_index(self, offset: int) -> str:
        line = bisect.bisect_right(self._line_starts, offset) - 1
        return f"{line + 1}.{offset - self._line_starts[line]}"

    def _highlight_matching_tag(self) -> None:
        self.text.tag_remove("match", "1.0", "end")
        source = self.get_text()
        offset = self._index_to_offset(self.text.index("insert"))
        start = source.rfind("<", 0, offset + 1)
        if start == -1:
            return
        end = source.find(">", start)
        if end == -1 or end < offset - 1:
            return
        match = re.match(r"<(/?)([A-Za-z_][\w:.\-]*)", source[start:end + 1])
        if not match:
            return
        closing, name = match.group(1), match.group(2)
        partner = self._find_partner(source, start, end, name, bool(closing))
        if partner is None:
            return
        own = (start, start + 1 + len(match.group(1)) + len(name))
        other_start = partner[0]
        other_name = re.match(r"<(/?)([A-Za-z_][\w:.\-]*)", source[other_start:other_start + 64])
        other = (other_start, other_start + 1 +
                 (len(other_name.group(1)) + len(other_name.group(2)) if other_name else len(name)))
        for a, b in (own, other):
            self.text.tag_add("match", self._offset_to_index(a), self._offset_to_index(b))

    def _find_partner(self, source: str, start: int, end: int, name: str, closing: bool):
        if source[end - 1] == "/":
            return None
        depth = 0
        pattern = re.compile(r"<(/?)" + re.escape(name) + r"(?=[\s/>])")
        if not closing:
            for match in pattern.finditer(source, end):
                if match.group(1):
                    if depth == 0:
                        stop = source.find(">", match.start())
                        return (match.start(), stop + 1 if stop != -1 else match.end())
                    depth -= 1
                else:
                    tag_end = source.find(">", match.start())
                    if tag_end != -1 and source[tag_end - 1] != "/":
                        depth += 1
        else:
            positions = [m for m in pattern.finditer(source, 0, start)]
            for match in reversed(positions):
                if match.group(1):
                    depth += 1
                else:
                    tag_end = source.find(">", match.start())
                    if tag_end != -1 and source[tag_end - 1] == "/":
                        continue
                    if depth == 0:
                        return (match.start(), (tag_end + 1) if tag_end != -1 else match.end())
                    depth -= 1
        return None

    def _index_to_offset(self, index: str) -> int:
        line, column = (int(part) for part in self.text.index(index).split("."))
        if line - 1 < len(self._line_starts):
            return self._line_starts[line - 1] + column
        return len(self.get_text())

    # --------------------------------------------------------------- gutter
    def set_issue_lines(self, lines: Dict[int, str]) -> None:
        self._issue_lines = dict(lines)
        self._redraw_gutter()

    def _redraw_gutter(self) -> None:
        canvas = self.gutter
        canvas.delete("all")
        c = self.theme
        canvas.configure(background=c.c("gutter_bg"))
        try:
            first = self.text.index("@0,0")
            height = self.text.winfo_height()
            last = self.text.index(f"@0,{height}")
        except tk.TclError:
            return
        current = int(self.text.index("insert").split(".")[0])
        line = int(first.split(".")[0])
        end = int(last.split(".")[0])
        width = canvas.winfo_width()
        font = c.font("mono_small")
        while line <= end:
            info = self.text.dlineinfo(f"{line}.0")
            if info is None:
                line += 1
                continue
            y = info[1] + info[3] // 2
            severity = self._issue_lines.get(line)
            if severity:
                colour = {"error": c.c("error"), "warning": c.c("warn")}.get(severity, c.c("info"))
                canvas.create_oval(5, y - 3, 11, y + 3, fill=colour, outline=colour,
                                   tags=(f"issue{line}",))
            canvas.create_text(width - 10, y, text=str(line), anchor="e", font=font,
                               fill=c.c("gutter_active") if line == current else c.c("gutter_fg"))
            line += 1
        canvas.create_line(width - 1, 0, width - 1, canvas.winfo_height(), fill=c.c("border_soft"))

    def _on_gutter_click(self, event) -> None:
        index = self.text.index(f"@0,{event.y}")
        self.text.mark_set("insert", index)
        self.select_line()
        self.text.focus_set()

    # ------------------------------------------------------------ navigation
    def goto(self, line: int, column: int = 0, select_to: Optional[Tuple[int, int]] = None) -> None:
        index = f"{max(1, line)}.{max(0, column)}"
        self.text.mark_set("insert", index)
        self.text.see(index)
        self.text.tag_remove("sel", "1.0", "end")
        if select_to is not None:
            self.text.tag_add("sel", index, f"{select_to[0]}.{select_to[1]}")
        self._update_caret()
        self._redraw_gutter()

    def highlight_range(self, start: Tuple[int, int], end: Tuple[int, int]) -> None:
        self.text.tag_remove("sel_node", "1.0", "end")
        self.text.tag_add("sel_node", f"{start[0]}.{start[1]}", f"{end[0]}.{end[1]}")
        self.text.see(f"{start[0]}.{start[1]}")

    def clear_node_highlight(self) -> None:
        self.text.tag_remove("sel_node", "1.0", "end")

    def select_line(self) -> None:
        self.text.tag_remove("sel", "1.0", "end")
        self.text.tag_add("sel", "insert linestart", "insert lineend+1c")

    def prompt_goto(self) -> None:
        from tkinter import simpledialog
        line = simpledialog.askinteger("Go to line", "Line number:", parent=self)
        if line:
            self.goto(line, 0)
            self.text.focus_set()

    # ----------------------------------------------------------- editing aids
    def _current_indent(self) -> str:
        line = self.text.get("insert linestart", "insert")
        return re.match(r"[ \t]*", line).group(0)

    def _on_return(self, _event=None):
        self._close_popup()
        before = self.text.get("insert linestart", "insert").rstrip()
        after = self.text.get("insert", "insert lineend").lstrip()
        indent = self._current_indent()
        opens = bool(re.search(r"<[A-Za-z_][\w:.\-]*(\s[^<>]*)?>$", before)) and not before.endswith("/>")
        closes_next = after.startswith("</")
        self.text.edit_separator()
        if opens and closes_next:
            self.text.insert("insert", "\n" + indent + INDENT_STEP + "\n" + indent)
            self.text.mark_set("insert", "insert -1 lines lineend")
        elif opens:
            self.text.insert("insert", "\n" + indent + INDENT_STEP)
        else:
            self.text.insert("insert", "\n" + indent)
        self.text.see("insert")
        return "break"

    def _on_gt(self, _event=None):
        """Auto-insert the closing tag when a start tag is completed."""
        self.text.insert("insert", ">")
        before = self.text.get("insert linestart", "insert")
        match = re.search(r"<([A-Za-z_][\w:.\-]*)(?:\s[^<>]*)?>$", before)
        if match and not before.endswith("/>") and not before.rstrip().startswith("</"):
            name = match.group(1)
            following = self.text.get("insert", "insert lineend")
            if not following.strip().startswith("</"):
                position = self.text.index("insert")
                self.text.insert("insert", f"</{name}>")
                self.text.mark_set("insert", position)
        self._schedule_highlight()
        return "break"

    def _on_quote(self, _event=None):
        following = self.text.get("insert", "insert +1c")
        if following == '"':
            self.text.mark_set("insert", "insert +1c")
            return "break"
        before = self.text.get("insert linestart", "insert")
        if before.endswith("="):
            self.text.insert("insert", '""')
            self.text.mark_set("insert", "insert -1c")
            self.after(1, self._request_completion)
            return "break"
        return None

    def _on_tab(self, _event=None):
        if self._popup is not None:
            self._accept_completion()
            return "break"
        if self.text.tag_ranges("sel"):
            self._indent_selection(INDENT_STEP)
            return "break"
        self.text.insert("insert", INDENT_STEP)
        return "break"

    def _on_shift_tab(self, _event=None):
        self._indent_selection("", outdent=True)
        return "break"

    def _indent_selection(self, prefix: str, outdent: bool = False) -> None:
        ranges = self.text.tag_ranges("sel")
        if not ranges:
            if outdent:
                line = self.text.get("insert linestart", "insert lineend")
                if line.startswith(INDENT_STEP):
                    self.text.delete("insert linestart", f"insert linestart +{len(INDENT_STEP)}c")
            return
        start = int(str(ranges[0]).split(".")[0])
        end = int(str(ranges[1]).split(".")[0])
        self.text.edit_separator()
        for line in range(start, end + 1):
            if outdent:
                content = self.text.get(f"{line}.0", f"{line}.end")
                strip = len(content) - len(content.lstrip(" "))
                remove = min(len(INDENT_STEP), strip)
                if remove:
                    self.text.delete(f"{line}.0", f"{line}.{remove}")
            else:
                self.text.insert(f"{line}.0", prefix)
        self.text.tag_add("sel", f"{start}.0", f"{end}.end")

    def _toggle_comment(self, _event=None):
        ranges = self.text.tag_ranges("sel")
        if ranges:
            start = int(str(ranges[0]).split(".")[0])
            end = int(str(ranges[1]).split(".")[0])
        else:
            start = end = int(self.text.index("insert").split(".")[0])
        block = "\n".join(self.text.get(f"{n}.0", f"{n}.end") for n in range(start, end + 1))
        self.text.edit_separator()
        stripped = block.strip()
        if stripped.startswith("<!--") and stripped.endswith("-->"):
            new = block.replace("<!--", "", 1)
            index = new.rfind("-->")
            new = new[:index] + new[index + 3:]
            new = "\n".join(line.rstrip() for line in new.splitlines())
        else:
            indent = re.match(r"[ \t]*", block).group(0)
            new = f"{indent}<!--\n{block}\n{indent}-->"
        self.text.delete(f"{start}.0", f"{end}.end")
        self.text.insert(f"{start}.0", new)
        return "break"

    def _duplicate_line(self, _event=None):
        line = self.text.get("insert linestart", "insert lineend")
        self.text.edit_separator()
        self.text.insert("insert lineend", "\n" + line)
        return "break"

    def _move_line(self, delta: int):
        line = int(self.text.index("insert").split(".")[0])
        target = line + delta
        total = int(self.text.index("end-1c").split(".")[0])
        if target < 1 or target > total:
            return "break"
        column = int(self.text.index("insert").split(".")[1])
        current = self.text.get(f"{line}.0", f"{line}.end")
        other = self.text.get(f"{target}.0", f"{target}.end")
        self.text.edit_separator()
        self.text.delete(f"{line}.0", f"{line}.end")
        self.text.insert(f"{line}.0", other)
        self.text.delete(f"{target}.0", f"{target}.end")
        self.text.insert(f"{target}.0", current)
        self.text.mark_set("insert", f"{target}.{column}")
        self.text.see("insert")
        return "break"

    # ------------------------------------------------------------ completion
    def context_at_caret(self) -> CompletionContext:
        source = self.get_text()
        offset = self._index_to_offset(self.text.index("insert"))
        head = source[:offset]

        open_bracket = head.rfind("<")
        close_bracket = head.rfind(">")
        inside_tag = open_bracket > close_bracket

        stack: List[str] = []
        for match in re.finditer(r"<(/?)([A-Za-z_][\w:.\-]*)([^<>]*?)(/?)>", source[:max(0, close_bracket + 1)]):
            closing, name, _body, selfclose = match.groups()
            if closing:
                if stack and stack[-1] == name:
                    stack.pop()
            elif not selfclose:
                stack.append(name)

        if not inside_tag:
            prefix = ""
            if head.endswith("<"):
                prefix = ""
            else:
                trailing = re.search(r"<([A-Za-z_][\w:.\-]*)$", head)
                if trailing:
                    prefix = trailing.group(1)
                else:
                    return CompletionContext("element", stack, prefix="")
            return CompletionContext("element", stack, prefix=prefix)

        fragment = head[open_bracket:]
        name_match = re.match(r"<(/?)([A-Za-z_][\w:.\-]*)", fragment)
        tag_name = name_match.group(2) if name_match else ""
        used = re.findall(r"([A-Za-z_][\w:.\-]*)\s*=", fragment)

        quotes = fragment.count('"')
        if quotes % 2 == 1:
            attr_match = re.search(r"([A-Za-z_][\w:.\-]*)\s*=\s*\"([^\"]*)$", fragment)
            if attr_match:
                return CompletionContext("value", stack, tag_name, attr_match.group(1),
                                         attr_match.group(2), used)
        word = re.search(r"([A-Za-z_][\w:.\-]*)$", fragment)
        prefix = word.group(1) if word and fragment[-1] not in " \t\n" else ""
        if prefix == tag_name and fragment.strip("<").rstrip() == tag_name:
            return CompletionContext("element", stack, prefix=prefix)
        return CompletionContext("attribute", stack, tag_name, prefix=prefix, used_attributes=used)

    def _maybe_complete_element(self, _event=None):
        self.text.insert("insert", "<")
        self.after(1, self._request_completion)
        return "break"

    def _request_completion(self, _event=None):
        if self.completion_provider is None:
            return "break"
        context = self.context_at_caret()
        items = self.completion_provider(context) or []
        prefix = context.prefix.lower()
        if prefix:
            items = [i for i in items if i.label.lower().startswith(prefix)] or \
                    [i for i in items if prefix in i.label.lower()]
        if not items:
            self._close_popup()
            return "break"
        self._completions = items[:400]
        self._show_popup()
        return "break"

    def _refresh_popup(self) -> None:
        if self.completion_provider is None:
            return
        context = self.context_at_caret()
        if context.kind == "none":
            self._close_popup()
            return
        items = self.completion_provider(context) or []
        prefix = context.prefix.lower()
        if prefix:
            items = [i for i in items if i.label.lower().startswith(prefix)] or \
                    [i for i in items if prefix in i.label.lower()]
        if not items:
            self._close_popup()
            return
        self._completions = items[:400]
        if self._popup_list is not None:
            self._popup_list.delete(0, "end")
            for item in self._completions:
                self._popup_list.insert("end", self._format_item(item))
            self._popup_list.selection_clear(0, "end")
            self._popup_list.selection_set(0)
            self._popup_list.configure(height=min(10, len(self._completions)))

    def _format_item(self, item: Completion) -> str:
        return f" {item.label}" + (f"   {item.detail}" if item.detail else "")

    def _show_popup(self) -> None:
        self._close_popup()
        try:
            box = self.text.bbox("insert")
        except tk.TclError:
            box = None
        if box is None:
            return
        x = self.text.winfo_rootx() + box[0]
        y = self.text.winfo_rooty() + box[1] + box[3] + 3
        c = self.theme
        popup = tk.Toplevel(self)
        popup.wm_overrideredirect(True)
        try:
            popup.wm_attributes("-topmost", True)
        except tk.TclError:
            pass
        frame = tk.Frame(popup, background=c.c("border"))
        frame.pack(fill="both", expand=True)
        listbox = tk.Listbox(
            frame, background=c.c("elevated"), foreground=c.c("text"),
            selectbackground=c.c("accent"), selectforeground=c.c("on_accent"),
            font=c.font("mono_small"), relief="flat", highlightthickness=0,
            activestyle="none", height=min(10, len(self._completions)),
            width=max(28, min(60, max((len(self._format_item(i)) for i in self._completions), default=28) + 2)),
        )
        listbox.pack(padx=1, pady=1, fill="both", expand=True)
        for item in self._completions:
            listbox.insert("end", self._format_item(item))
        listbox.selection_set(0)
        listbox.bind("<Double-Button-1>", lambda _e: self._accept_completion())
        listbox.bind("<Return>", lambda _e: self._accept_completion())
        popup.wm_geometry(f"+{x}+{y}")
        self._popup = popup
        self._popup_list = listbox
        self.text.bind("<Down>", self._popup_down)
        self.text.bind("<Up>", self._popup_up)
        self.text.bind("<Return>", self._popup_return)

    def _popup_down(self, _event=None):
        return self._popup_move(1)

    def _popup_up(self, _event=None):
        return self._popup_move(-1)

    def _popup_move(self, delta: int):
        if self._popup_list is None:
            return None
        size = self._popup_list.size()
        if not size:
            return "break"
        current = self._popup_list.curselection()
        index = (current[0] if current else 0) + delta
        index = max(0, min(size - 1, index))
        self._popup_list.selection_clear(0, "end")
        self._popup_list.selection_set(index)
        self._popup_list.see(index)
        return "break"

    def _popup_return(self, _event=None):
        if self._popup is None:
            return None
        self._accept_completion()
        return "break"

    def _accept_completion(self) -> None:
        if self._popup_list is None or not self._completions:
            self._close_popup()
            return
        selection = self._popup_list.curselection()
        item = self._completions[selection[0] if selection else 0]
        context = self.context_at_caret()
        self.text.edit_separator()
        if context.prefix:
            self.text.delete(f"insert -{len(context.prefix)}c", "insert")
        insert = item.insert
        cursor_offset = insert.find("$0")
        if cursor_offset >= 0:
            insert = insert.replace("$0", "", 1)
        self.text.insert("insert", insert)
        if cursor_offset >= 0:
            self.text.mark_set("insert", f"insert -{len(insert) - cursor_offset}c")
        self._close_popup()
        self._schedule_highlight()

    def _close_popup(self) -> None:
        if self._popup is not None:
            try:
                self._popup.destroy()
            except tk.TclError:
                pass
        self._popup = None
        self._popup_list = None
        self.text.unbind("<Down>")
        self.text.unbind("<Up>")
        self.text.bind("<Return>", self._on_return)

    # ------------------------------------------------------------ find bar
    def show_find(self, replace: bool = False) -> None:
        if getattr(self, "find_bar", None) is None:
            self._build_find_bar()
        self.find_bar.pack(fill="x", before=self.hbar)
        self.replace_row.pack_forget()
        if replace:
            self.replace_row.pack(fill="x")
        selection = ""
        if self.text.tag_ranges("sel"):
            selection = self.text.get("sel.first", "sel.last")
        if selection and "\n" not in selection:
            self.find_entry.var.set(selection)
        self.find_entry.entry.focus_set()
        self.find_entry.entry.select_range(0, "end")
        self._run_find()

    def hide_find(self) -> None:
        if getattr(self, "find_bar", None) is not None:
            self.find_bar.pack_forget()
        self.text.tag_remove("find", "1.0", "end")
        self.text.tag_remove("find_current", "1.0", "end")
        self.text.focus_set()

    def _build_find_bar(self) -> None:
        c = self.theme
        self.find_bar = tk.Frame(self, background=c.c("panel_alt"))
        row = tk.Frame(self.find_bar, background=c.c("panel_alt"))
        row.pack(fill="x", padx=6, pady=(5, 2))
        self.find_entry = SearchEntry(row, c, placeholder="Find", command=lambda _v: self._run_find(), width=26)
        self.find_entry.pack(side="left")
        self.count_label = tk.Label(row, text="", background=c.c("panel_alt"),
                                    foreground=c.c("text_faint"), font=c.font("small"), padx=8)
        self.count_label.pack(side="left")
        ToolButton(row, c, glyph="⌃", tooltip="Previous match (Shift+F3)", compact=True,
                   command=lambda: self.find_next(-1)).pack(side="left")
        ToolButton(row, c, glyph="⌄", tooltip="Next match (F3)", compact=True,
                   command=lambda: self.find_next(1)).pack(side="left")
        self.case_var = tk.BooleanVar(value=False)
        self.regex_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(row, text="Aa", variable=self.case_var, style="Alt.TCheckbutton",
                        command=self._run_find).pack(side="left", padx=(8, 2))
        ttk.Checkbutton(row, text=".*", variable=self.regex_var, style="Alt.TCheckbutton",
                        command=self._run_find).pack(side="left")
        ToolButton(row, c, glyph="✕", tooltip="Close (Esc)", compact=True,
                   command=self.hide_find).pack(side="right")

        self.replace_row = tk.Frame(self.find_bar, background=c.c("panel_alt"))
        self.replace_entry = SearchEntry(self.replace_row, c, placeholder="Replace with", width=26)
        self.replace_entry.pack(side="left", padx=(6, 0), pady=(0, 6))
        ToolButton(self.replace_row, c, text="Replace", compact=True,
                   command=self._replace_current).pack(side="left", padx=4)
        ToolButton(self.replace_row, c, text="Replace all", compact=True,
                   command=self._replace_all).pack(side="left")
        self.find_entry.entry.bind("<Return>", lambda _e: self.find_next(1))
        self.find_entry.entry.bind("<Shift-Return>", lambda _e: self.find_next(-1))
        self.find_entry.entry.bind("<Escape>", lambda _e: self.hide_find())
        self.replace_entry.entry.bind("<Escape>", lambda _e: self.hide_find())

    def _pattern(self) -> Optional[re.Pattern]:
        needle = self.find_entry.value
        if not needle:
            return None
        flags = 0 if self.case_var.get() else re.IGNORECASE
        try:
            return re.compile(needle if self.regex_var.get() else re.escape(needle), flags)
        except re.error:
            return None

    def _run_find(self) -> None:
        self.text.tag_remove("find", "1.0", "end")
        self.text.tag_remove("find_current", "1.0", "end")
        self._find_matches = []
        pattern = self._pattern()
        if pattern is None:
            self.count_label.configure(text="")
            return
        source = self.get_text()
        self._index_lines(source)
        for match in pattern.finditer(source):
            if match.start() == match.end():
                continue
            start = self._offset_to_index(match.start())
            end = self._offset_to_index(match.end())
            self._find_matches.append((start, end))
            self.text.tag_add("find", start, end)
        self.count_label.configure(
            text=f"{len(self._find_matches)} match{'es' if len(self._find_matches) != 1 else ''}")
        self._find_index = -1
        if self._find_matches:
            self.find_next(1)

    def find_next(self, direction: int = 1) -> None:
        if not self._find_matches:
            self._run_find()
            if not self._find_matches:
                return
        self.text.tag_remove("find_current", "1.0", "end")
        self._find_index = (self._find_index + direction) % len(self._find_matches)
        start, end = self._find_matches[self._find_index]
        self.text.tag_add("find_current", start, end)
        self.text.mark_set("insert", start)
        self.text.see(start)
        self.count_label.configure(text=f"{self._find_index + 1} of {len(self._find_matches)}")

    def _replace_current(self) -> None:
        if not self._find_matches or self._find_index < 0:
            return
        start, end = self._find_matches[self._find_index]
        self.text.edit_separator()
        self.text.delete(start, end)
        self.text.insert(start, self.replace_entry.value)
        self._run_find()

    def _replace_all(self) -> None:
        pattern = self._pattern()
        if pattern is None:
            return
        source = self.get_text()
        replacement = self.replace_entry.value
        updated, count = pattern.subn(lambda _m: replacement, source)
        if count:
            self.text.edit_separator()
            self.set_text(updated, keep_view=True)
            if self.on_change is not None:
                self.on_change()
        self.count_label.configure(text=f"Replaced {count}")

    # ---------------------------------------------------------------- theme
    def restyle(self) -> None:
        c = self.theme
        try:
            self.configure(background=c.c("code_bg"))
            self.text.configure(background=c.c("code_bg"), foreground=c.c("text"),
                                insertbackground=c.c("accent"), selectbackground=c.c("sel_bg"),
                                selectforeground=c.c("sel_fg"), font=c.font("mono"))
            self.gutter.configure(background=c.c("gutter_bg"))
            self._configure_tags()
            self._redraw_gutter()
        except tk.TclError:
            pass
