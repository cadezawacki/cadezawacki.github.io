"""Position-aware XML document model.

The editor needs three things that ``xml.etree`` will not give us:

* exact source offsets for every element and attribute (so validation
  findings and tree selections can jump to the right character),
* verbatim prefixes / namespace declarations (``mso:tab`` must round-trip
  as ``mso:tab``, not as ``{...}tab``),
* comments and processing instructions preserved across a re-serialise.

So we drive ``pyexpat`` directly and build our own tiny tree.
"""

from __future__ import annotations

import re
from typing import Iterator, List, Optional, Tuple
from xml.parsers import expat

__all__ = [
    "Node",
    "XmlDocument",
    "ParseError",
    "escape_text",
    "escape_attr",
    "ELEMENT",
    "COMMENT",
    "TEXT",
    "PI",
]

ELEMENT = "element"
COMMENT = "comment"
TEXT = "text"
PI = "pi"


def escape_text(value: str) -> str:
    return (
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )


def escape_attr(value: str) -> str:
    return (
        escape_text(value)
        .replace('"', "&quot;")
        .replace("\n", "&#10;")
        .replace("\r", "&#13;")
        .replace("\t", "&#9;")
    )


class ParseError(Exception):
    """A syntax error with a 1-based line and 0-based column."""

    def __init__(self, message: str, line: int, column: int) -> None:
        super().__init__(message)
        self.message = message
        self.line = line
        self.column = column

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.message} (line {self.line}, column {self.column + 1})"


class Node:
    """One element, comment, text run or processing instruction."""

    _uid_seq = 0

    def __init__(
        self,
        kind: str = ELEMENT,
        tag: str = "",
        text: str = "",
        parent: "Optional[Node]" = None,
    ) -> None:
        Node._uid_seq += 1
        self.uid: int = Node._uid_seq
        self.kind: str = kind
        self.tag: str = tag
        self.text: str = text
        self.attrs: "dict[str, str]" = {}
        self.children: "List[Node]" = []
        self.parent: Optional[Node] = parent
        # Byte offsets into the UTF-8 encoded source (-1 when synthesised).
        self.start: int = -1
        self.end: int = -1
        self.start_tag_end: int = -1
        self.doc: "Optional[XmlDocument]" = None

    # ------------------------------------------------------------------ names
    @property
    def local(self) -> str:
        return self.tag.rsplit(":", 1)[-1]

    @property
    def prefix(self) -> str:
        return self.tag.rsplit(":", 1)[0] if ":" in self.tag else ""

    # ------------------------------------------------------------- attributes
    def get(self, name: str, default: Optional[str] = None) -> Optional[str]:
        if name in self.attrs:
            return self.attrs[name]
        # Tolerate prefixed spellings such as ``mso:label``.
        for key, value in self.attrs.items():
            if key.rsplit(":", 1)[-1] == name:
                return value
        return default

    def has(self, name: str) -> bool:
        return self.get(name) is not None

    def real_key(self, name: str) -> str:
        """Return the attribute key as actually spelled in this element."""
        if name in self.attrs:
            return name
        for key in self.attrs:
            if key.rsplit(":", 1)[-1] == name:
                return key
        return name

    def set(self, name: str, value: Optional[str]) -> None:
        key = self.real_key(name)
        if value is None or value == "":
            self.attrs.pop(key, None)
        else:
            self.attrs[key] = value

    def unset(self, name: str) -> None:
        self.attrs.pop(self.real_key(name), None)

    def rename_attr(self, old: str, new: str) -> None:
        if old not in self.attrs:
            return
        items = [(new if k == old else k, v) for k, v in self.attrs.items()]
        self.attrs = dict(items)

    # ----------------------------------------------------------------- family
    @property
    def elements(self) -> "List[Node]":
        return [c for c in self.children if c.kind == ELEMENT]

    def add(self, child: "Node", index: Optional[int] = None) -> "Node":
        child.parent = self
        child.doc = self.doc
        if index is None or index >= len(self.children):
            self.children.append(child)
        else:
            self.children.insert(max(0, index), child)
        return child

    def remove(self, child: "Node") -> None:
        if child in self.children:
            self.children.remove(child)
            child.parent = None

    def index_of(self, child: "Node") -> int:
        try:
            return self.children.index(child)
        except ValueError:
            return -1

    def element_index(self) -> int:
        if self.parent is None:
            return 0
        return self.parent.elements.index(self) if self in self.parent.elements else 0

    def ancestors(self) -> "Iterator[Node]":
        node = self.parent
        while node is not None:
            yield node
            node = node.parent

    def walk(self) -> "Iterator[Node]":
        yield self
        for child in list(self.children):
            yield from child.walk()

    def iter_elements(self) -> "Iterator[Node]":
        for node in self.walk():
            if node.kind == ELEMENT:
                yield node

    def find(self, local: str) -> "Optional[Node]":
        for child in self.elements:
            if child.local == local:
                return child
        return None

    def find_all(self, local: str) -> "List[Node]":
        return [n for n in self.iter_elements() if n.local == local]

    def depth(self) -> int:
        return sum(1 for _ in self.ancestors())

    def path_key(self) -> Tuple:
        """Stable-ish identity used to re-select a node after a reparse."""
        parts: List[Tuple[str, str, int]] = []
        node: Optional[Node] = self
        while node is not None and node.parent is not None:
            siblings = [s for s in node.parent.elements if s.local == node.local]
            idx = siblings.index(node) if node in siblings else 0
            ident = node.get("id") or node.get("idMso") or node.get("idQ") or ""
            parts.append((node.local, ident, idx))
            node = node.parent
        parts.reverse()
        return tuple(parts)

    def clone(self) -> "Node":
        copy = Node(self.kind, self.tag, self.text)
        copy.attrs = dict(self.attrs)
        copy.doc = self.doc
        for child in self.children:
            copy.add(child.clone())
        return copy

    # --------------------------------------------------------------- position
    def position(self) -> Tuple[int, int]:
        if self.doc is None or self.start < 0:
            return (1, 0)
        return self.doc.offset_to_pos(self.start)

    def end_position(self) -> Tuple[int, int]:
        if self.doc is None or self.end < 0:
            return self.position()
        return self.doc.offset_to_pos(self.end)

    def attr_position(self, name: str) -> Tuple[int, int]:
        """Best-effort source position of an attribute name."""
        if self.doc is None or self.start < 0 or self.start_tag_end < 0:
            return self.position()
        key = self.real_key(name)
        chunk = self.doc.raw[self.start : self.start_tag_end]
        match = re.search(
            r"(?<![\w:.\-])" + re.escape(key.encode("utf-8").decode("latin-1")) + r"\s*=",
            chunk.decode("utf-8", "replace"),
        )
        if not match:
            return self.position()
        prefix = chunk.decode("utf-8", "replace")[: match.start()]
        return self.doc.offset_to_pos(self.start + len(prefix.encode("utf-8")))

    # ------------------------------------------------------------------ label
    def display_label(self) -> str:
        if self.kind == COMMENT:
            snippet = " ".join(self.text.split())
            return ("<!-- " + snippet[:44] + (" ..." if len(snippet) > 44 else "") + " -->")
        if self.kind == TEXT:
            return " ".join(self.text.split())[:60]
        if self.kind == PI:
            return f"<?{self.text[:50]}?>"
        return self.tag

    def descriptor(self) -> str:
        """Short right-hand description shown in the structure tree."""
        if self.kind != ELEMENT:
            return ""
        for key in ("label", "id", "idMso", "idQ", "getLabel", "image", "imageMso"):
            value = self.get(key)
            if value:
                if key in ("label", "getLabel"):
                    return value
                return value
        return ""

    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return f"<Node {self.kind} {self.tag} attrs={len(self.attrs)} kids={len(self.children)}>"


class XmlDocument:
    """A parsed (or partially parsed) XML document."""

    def __init__(self) -> None:
        self.root: Optional[Node] = None
        self.prolog: List[Node] = []
        self.epilog: List[Node] = []
        self.declaration: str = ""
        self.error: Optional[ParseError] = None
        self.source: str = ""
        self.raw: bytes = b""
        self._line_starts: List[int] = [0]

    # ------------------------------------------------------------------ parse
    @classmethod
    def parse(cls, text: str) -> "XmlDocument":
        doc = cls()
        doc.source = text
        doc.raw = text.encode("utf-8")
        doc._index_lines()

        parser = expat.ParserCreate()
        parser.ordered_attributes = True
        parser.buffer_text = True
        parser.specified_attributes = True

        stack: List[Node] = []
        pending_text: List[Tuple[int, str]] = []
        in_cdata = [False]

        def flush_text() -> None:
            if not pending_text:
                return
            offset, data = pending_text[0][0], "".join(t for _, t in pending_text)
            pending_text.clear()
            if not data.strip():
                return
            if not stack:
                return
            node = Node(TEXT, text=data)
            node.doc = doc
            node.start = offset
            node.end = offset + len(data.encode("utf-8"))
            stack[-1].add(node)

        def on_start(name: str, attr_list: List[str]) -> None:
            flush_text()
            node = Node(ELEMENT, tag=name)
            node.doc = doc
            node.start = parser.CurrentByteIndex
            for i in range(0, len(attr_list), 2):
                node.attrs[attr_list[i]] = attr_list[i + 1]
            node.start_tag_end = doc._scan_gt(node.start)
            if stack:
                stack[-1].add(node)
            elif doc.root is None:
                doc.root = node
            stack.append(node)

        def on_end(_name: str) -> None:
            flush_text()
            if not stack:
                return
            node = stack.pop()
            here = parser.CurrentByteIndex
            node.end = doc._scan_gt(max(here, node.start))

        def on_text(data: str) -> None:
            if in_cdata[0]:
                pending_text.append((parser.CurrentByteIndex, data))
            else:
                pending_text.append((parser.CurrentByteIndex, data))

        def on_comment(data: str) -> None:
            flush_text()
            node = Node(COMMENT, text=data)
            node.doc = doc
            node.start = parser.CurrentByteIndex
            node.end = node.start + len(("<!--" + data + "-->").encode("utf-8"))
            if stack:
                stack[-1].add(node)
            elif doc.root is None:
                doc.prolog.append(node)
            else:
                doc.epilog.append(node)

        def on_pi(target: str, data: str) -> None:
            flush_text()
            node = Node(PI, text=f"{target} {data}".strip())
            node.doc = doc
            node.start = parser.CurrentByteIndex
            node.end = doc._scan_gt(node.start)
            if stack:
                stack[-1].add(node)
            elif doc.root is None:
                doc.prolog.append(node)
            else:
                doc.epilog.append(node)

        def on_decl(version: str, encoding: Optional[str], standalone: int) -> None:
            bits = [f'version="{version or "1.0"}"']
            if encoding:
                bits.append(f'encoding="{encoding}"')
            if standalone >= 0:
                bits.append(f'standalone="{"yes" if standalone else "no"}"')
            doc.declaration = "<?xml " + " ".join(bits) + "?>"

        parser.StartElementHandler = on_start
        parser.EndElementHandler = on_end
        parser.CharacterDataHandler = on_text
        parser.CommentHandler = on_comment
        parser.ProcessingInstructionHandler = on_pi
        parser.XmlDeclHandler = on_decl
        parser.StartCdataSectionHandler = lambda: in_cdata.__setitem__(0, True)
        parser.EndCdataSectionHandler = lambda: in_cdata.__setitem__(0, False)

        try:
            parser.Parse(doc.raw, True)
        except expat.ExpatError as exc:
            doc.error = ParseError(
                expat.ErrorString(exc.code),
                getattr(exc, "lineno", 1),
                max(0, getattr(exc, "offset", 0)),
            )
        return doc

    # ------------------------------------------------------------- positions
    def _index_lines(self) -> None:
        starts = [0]
        raw = self.raw
        idx = raw.find(b"\n")
        while idx != -1:
            starts.append(idx + 1)
            idx = raw.find(b"\n", idx + 1)
        self._line_starts = starts

    def _scan_gt(self, offset: int) -> int:
        idx = self.raw.find(b">", max(0, offset))
        return (idx + 1) if idx != -1 else len(self.raw)

    def offset_to_pos(self, offset: int) -> Tuple[int, int]:
        """Byte offset -> (1-based line, 0-based character column)."""
        offset = max(0, min(offset, len(self.raw)))
        lo, hi = 0, len(self._line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self._line_starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        line_start = self._line_starts[lo]
        column = len(self.raw[line_start:offset].decode("utf-8", "replace"))
        return (lo + 1, column)

    def pos_to_offset(self, line: int, column: int) -> int:
        idx = max(0, min(line - 1, len(self._line_starts) - 1))
        start = self._line_starts[idx]
        end = self._line_starts[idx + 1] if idx + 1 < len(self._line_starts) else len(self.raw)
        text = self.raw[start:end].decode("utf-8", "replace")
        return start + len(text[:column].encode("utf-8"))

    def node_at_offset(self, offset: int) -> Optional[Node]:
        best: Optional[Node] = None
        if self.root is None:
            return None
        for node in self.root.walk():
            if node.kind != ELEMENT or node.start < 0:
                continue
            if node.start <= offset <= max(node.end, node.start_tag_end):
                if best is None or node.depth() >= best.depth():
                    best = node
        return best

    def find_uid(self, uid: int) -> Optional[Node]:
        if self.root is None:
            return None
        for node in self.root.walk():
            if node.uid == uid:
                return node
        return None

    def find_path(self, key: Tuple) -> Optional[Node]:
        node = self.root
        if node is None or not key:
            return node
        for local, ident, idx in key:
            candidates = [c for c in node.elements if c.local == local]
            match = None
            if ident:
                for cand in candidates:
                    if (cand.get("id") or cand.get("idMso") or cand.get("idQ") or "") == ident:
                        match = cand
                        break
            if match is None and idx < len(candidates):
                match = candidates[idx]
            if match is None:
                return node
            node = match
        return node

    # -------------------------------------------------------------- serialise
    def serialize(
        self,
        indent: str = "  ",
        wrap_attrs: bool = True,
        wrap_width: int = 100,
        declaration: bool = True,
    ) -> str:
        out: List[str] = []
        if declaration:
            out.append(self.declaration or '<?xml version="1.0" encoding="UTF-8"?>')
        for node in self.prolog:
            out.append(_render(node, 0, indent, wrap_attrs, wrap_width))
        if self.root is not None:
            out.append(_render(self.root, 0, indent, wrap_attrs, wrap_width))
        for node in self.epilog:
            out.append(_render(node, 0, indent, wrap_attrs, wrap_width))
        return "\n".join(part for part in out if part is not None) + "\n"


def _render_attrs(node: Node) -> List[str]:
    return [f'{key}="{escape_attr(value)}"' for key, value in node.attrs.items()]


def _render(node: Node, level: int, indent: str, wrap: bool, width: int) -> str:
    pad = indent * level
    if node.kind == COMMENT:
        body = node.text
        if "\n" in body:
            lines = body.splitlines()
            inner = ("\n" + pad).join(line.strip() for line in lines)
            return f"{pad}<!--{inner}-->"
        return f"{pad}<!--{body}-->"
    if node.kind == PI:
        return f"{pad}<?{node.text}?>"
    if node.kind == TEXT:
        return pad + escape_text(node.text.strip())

    attrs = _render_attrs(node)
    open_line = f"{pad}<{node.tag}"
    if attrs:
        single = open_line + " " + " ".join(attrs)
        if wrap and len(single) > width and len(attrs) > 1:
            align = " " * (len(pad) + len(node.tag) + 2)
            joined = ("\n" + align).join(attrs)
            head = f"{open_line} {joined}"
        else:
            head = single
    else:
        head = open_line

    kids = [c for c in node.children if c.kind != TEXT or c.text.strip()]
    if not kids:
        return head + "/>"

    only_text = all(c.kind == TEXT for c in kids)
    if only_text:
        body = "".join(escape_text(c.text.strip()) for c in kids)
        return f"{head}>{body}</{node.tag}>"

    lines = [head + ">"]
    for child in kids:
        lines.append(_render(child, level + 1, indent, wrap, width))
    lines.append(f"{pad}</{node.tag}>")
    return "\n".join(lines)


def tree_signature(document: "XmlDocument") -> int:
    """Structural hash of a document - equal hashes mean same shape and content."""
    if document is None or document.root is None:
        return 0
    parts: List[str] = []
    for node in document.root.walk():
        parts.append(node.kind)
        parts.append(node.tag)
        if node.kind == ELEMENT:
            for key, value in node.attrs.items():
                parts.append(key)
                parts.append(value)
        elif node.text:
            parts.append(node.text)
    return hash(tuple(parts))


def adopt_uids(old_root: Node, new_root: Node) -> None:
    """Copy node identities from an equal-shaped old tree onto a new parse.

    After an edit that only moves whitespace or reflows attributes, the
    reparsed tree is structurally identical - carrying the uids across keeps
    every uid-keyed map (structure tree, preview hit boxes, issue anchors)
    valid without a rebuild.
    """
    old_nodes = list(old_root.walk())
    new_nodes = list(new_root.walk())
    if len(old_nodes) != len(new_nodes):
        return
    for old, new in zip(old_nodes, new_nodes):
        if old.kind == new.kind and old.tag == new.tag:
            new.uid = old.uid


def build(tag: str, attrs: Optional[dict] = None, children: Optional[List[Node]] = None) -> Node:
    """Convenience constructor used by templates and the insert menu."""
    node = Node(ELEMENT, tag=tag)
    if attrs:
        for key, value in attrs.items():
            if value is not None:
                node.attrs[key] = str(value)
    for child in children or []:
        node.add(child)
    return node
