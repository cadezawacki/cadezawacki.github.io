"""Validation of a CustomUI document against the schema and against Office's
practical rules (the ones that make a ribbon silently fail to load)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set

from . import msodata, schema
from .ooxml import NAMESPACE_FOR, V2007, V2010
from .xmldoc import ELEMENT, TEXT, Node, XmlDocument

ERROR = "error"
WARNING = "warning"
INFO = "info"

SEVERITY_ORDER = {ERROR: 0, WARNING: 1, INFO: 2}

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_NCNAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-]*$")
_BOOLS = {"true", "false", "1", "0"}


@dataclass
class Issue:
    severity: str
    code: str
    message: str
    line: int = 1
    column: int = 0
    node_uid: int = 0
    attribute: str = ""
    hint: str = ""

    @property
    def location(self) -> str:
        return f"{self.line}:{self.column + 1}"

    def sort_key(self):
        return (SEVERITY_ORDER.get(self.severity, 3), self.line, self.column)


@dataclass
class Report:
    issues: List[Issue] = field(default_factory=list)

    @property
    def errors(self) -> List[Issue]:
        return [i for i in self.issues if i.severity == ERROR]

    @property
    def warnings(self) -> List[Issue]:
        return [i for i in self.issues if i.severity == WARNING]

    @property
    def infos(self) -> List[Issue]:
        return [i for i in self.issues if i.severity == INFO]

    def counts(self):
        return (len(self.errors), len(self.warnings), len(self.infos))

    def for_node(self, uid: int) -> List[Issue]:
        return [i for i in self.issues if i.node_uid == uid]

    def worst_for_node(self, uid: int) -> Optional[str]:
        found = [i.severity for i in self.issues if i.node_uid == uid]
        for severity in (ERROR, WARNING, INFO):
            if severity in found:
                return severity
        return None


class _Collector:
    def __init__(self) -> None:
        self.issues: List[Issue] = []

    def add(self, severity: str, code: str, message: str, node: Optional[Node] = None,
            attribute: str = "", hint: str = "") -> None:
        line, column = (1, 0)
        if node is not None:
            line, column = node.attr_position(attribute) if attribute else node.position()
        self.issues.append(Issue(severity, code, message, line, column,
                                 node.uid if node else 0, attribute, hint))


def validate(document: XmlDocument, variant: str = V2010,
             available_images: Optional[Sequence[str]] = None,
             strict_imagemso: bool = False, vba=None) -> Report:
    """Check a parsed document. ``variant`` is the part it will be saved into.

    ``vba`` is an optional :class:`~.vbaproject.VbaProject`; when present,
    every callback attribute is checked against the macros that actually
    exist in the workbook.
    """
    collector = _Collector()
    images: Set[str] = set(available_images or ())

    if document.error is not None:
        collector.issues.append(Issue(
            ERROR, "xml-syntax", f"XML syntax error: {document.error.message}",
            document.error.line, document.error.column,
            hint="The structure view keeps showing the last version that parsed.",
        ))
        return Report(sorted(collector.issues, key=Issue.sort_key))

    root = document.root
    if root is None:
        collector.add(ERROR, "no-root", "The part is empty - it needs a <customUI> root element.")
        return Report(collector.issues)

    if root.local != "customUI":
        collector.add(ERROR, "bad-root",
                      f"The root element must be <customUI>, not <{root.tag}>.", root)
        return Report(sorted(collector.issues, key=Issue.sort_key))

    _check_namespace(collector, root, variant)

    ids: Dict[str, Node] = {}
    _walk(collector, root, variant, images, ids, strict_imagemso)
    _check_cross_cutting(collector, root, variant)
    if vba is not None:
        _check_vba(collector, root, vba)

    return Report(sorted(collector.issues, key=Issue.sort_key))


def _check_namespace(collector: _Collector, root: Node, variant: str) -> None:
    ns = root.get("xmlns")
    if ns is None:
        # Excel's own exported customisation files (.exportedUI) declare the
        # namespace through a prefix, e.g. xmlns:mso="...". Accept any
        # declaration that binds a CustomUI namespace.
        for key, value in root.attrs.items():
            if key.startswith("xmlns:") and value in NAMESPACE_FOR.values():
                ns = value
                break
    expected = NAMESPACE_FOR[variant]
    other = NAMESPACE_FOR[V2007 if variant == V2010 else V2010]
    if not ns:
        collector.add(ERROR, "ns-missing",
                      "The <customUI> element has no xmlns attribute, so Office will ignore this part.",
                      root, hint=f'Add xmlns="{expected}"')
    elif ns == other:
        collector.add(ERROR, "ns-mismatch",
                      f"This part is {'customUI14.xml' if variant == V2010 else 'customUI.xml'} but the "
                      f"namespace is the {'2007' if ns == NAMESPACE_FOR[V2007] else '2010+'} one, so Office will ignore it.",
                      root, attribute="xmlns", hint=f'Use xmlns="{expected}"')
    elif ns != expected:
        collector.add(WARNING, "ns-unknown",
                      f"'{ns}' is not a CustomUI namespace Office recognises.",
                      root, attribute="xmlns", hint=f'Expected "{expected}"')


def _walk(collector: _Collector, node: Node, variant: str, images: Set[str],
          ids: Dict[str, Node], strict_imagemso: bool) -> None:
    elem = schema.elem_for_node(node)
    if elem is None:
        parent_elem = schema.elem_for_node(node.parent) if node.parent is not None else None
        if parent_elem is not None:
            allowed = ", ".join(sorted({schema.SCHEMA[k].name for k in parent_elem.children})) or "nothing"
            collector.add(ERROR, "bad-child",
                          f"<{node.tag}> is not allowed inside <{node.parent.tag}>.",
                          node, hint=f"Valid children here: {allowed}.")
        else:
            collector.add(ERROR, "unknown-element",
                          f"<{node.tag}> is not a CustomUI element.", node)
        return

    if elem.dialect == "2009" and variant == V2007:
        collector.add(ERROR, "dialect",
                      f"<{node.tag}> only works in customUI14.xml (Office 2010 and later).", node)
    if elem.dialect == "2006" and variant == V2010:
        collector.add(WARNING, "dialect",
                      f"<{node.tag}> is an Office 2007 feature and is ignored from customUI14.xml.", node)

    _check_attributes(collector, node, elem, variant, images, ids, strict_imagemso)
    _check_children(collector, node, elem)

    for child in node.children:
        if child.kind == ELEMENT:
            _walk(collector, child, variant, images, ids, strict_imagemso)
        elif child.kind == TEXT and child.text.strip():
            collector.add(WARNING, "text-content",
                          f"<{node.tag}> should not contain text; CustomUI carries everything in attributes.",
                          child)


def _check_attributes(collector: _Collector, node: Node, elem: schema.Elem, variant: str,
                      images: Set[str], ids: Dict[str, Node], strict_imagemso: bool) -> None:
    for raw_name, value in list(node.attrs.items()):
        local = raw_name.rsplit(":", 1)[-1]
        if raw_name == "xmlns" or raw_name.startswith("xmlns:"):
            continue
        attr = elem.attr(local)
        if attr is None:
            close = _closest(local, elem.attr_names())
            hint = f"Did you mean '{close}'?" if close else \
                   f"Valid attributes: {', '.join(elem.attr_names()[:10])}..."
            collector.add(ERROR, "bad-attribute",
                          f"<{node.tag}> has no attribute '{raw_name}'.", node, raw_name, hint)
            continue
        if attr.dialect == "2009" and variant == V2007:
            collector.add(WARNING, "attr-dialect",
                          f"'{local}' requires Office 2010 or later and is ignored here.", node, raw_name)
        _check_value(collector, node, attr, raw_name, value, images, strict_imagemso)

    # id / idQ / idMso are mutually exclusive
    for combo in elem.exclusive:
        present = [name for name in combo if node.has(name)]
        if len(present) > 1:
            collector.add(ERROR, "exclusive-attrs",
                          f"<{node.tag}> uses {' and '.join(present)} together; choose exactly one.",
                          node, present[1])

    for combo in elem.requires_one_of:
        if not any(node.has(name) for name in combo):
            names = " or ".join(combo)
            collector.add(ERROR, "missing-id",
                          f"<{node.tag}> needs {names}.", node,
                          hint="Office silently drops controls without an identifier.")

    # Duplicate identifiers
    for key in ("id", "idQ"):
        value = node.get(key)
        if not value:
            continue
        seen = ids.get(f"{key}:{value}")
        if seen is not None:
            first_line = seen.position()[0]
            collector.add(ERROR, "duplicate-id",
                          f"{key} '{value}' is already used on line {first_line}.",
                          node, key, hint="Every identifier in a part must be unique.")
        else:
            ids[f"{key}:{value}"] = node

    # A static value plus its getter
    for static, getter in (("label", "getLabel"), ("screentip", "getScreentip"),
                           ("supertip", "getSupertip"), ("visible", "getVisible"),
                           ("enabled", "getEnabled"), ("image", "getImage"),
                           ("imageMso", "getImage"), ("size", "getSize"),
                           ("keytip", "getKeytip"), ("description", "getDescription"),
                           ("title", "getTitle")):
        if node.has(static) and node.has(getter):
            collector.add(WARNING, "static-and-getter",
                          f"'{static}' and '{getter}' are both set; the callback wins and '{static}' is ignored.",
                          node, static)

    if node.has("image") and node.has("imageMso"):
        collector.add(WARNING, "two-images",
                      "'image' and 'imageMso' are both set; Office uses 'image'.", node, "imageMso")

    if node.has("insertAfterMso") and node.has("insertBeforeMso"):
        collector.add(WARNING, "two-inserts",
                      "'insertAfterMso' and 'insertBeforeMso' are both set; only one is honoured.",
                      node, "insertBeforeMso")

    if elem.key in ("tab", "group") and node.has("id") and not (node.has("label") or node.has("getLabel")):
        collector.add(WARNING, "no-label",
                      f"This {elem.name} has no label, so it appears blank in the ribbon.", node)

    if elem.key in ("button", "toggleButton", "checkBox") and node.has("id") \
            and not node.has("onAction") and not node.has("idMso"):
        collector.add(INFO, "no-action",
                      f"'{node.get('label') or node.get('id')}' has no onAction, so clicking it does nothing.",
                      node)

    if elem.key == "dynamicMenu" and not node.has("getContent"):
        collector.add(ERROR, "no-content",
                      "<dynamicMenu> needs getContent - without it the menu is always empty.", node)


def _check_value(collector: _Collector, node: Node, attr: schema.Attr, raw_name: str,
                 value: str, images: Set[str], strict_imagemso: bool) -> None:
    kind = attr.kind
    if value == "" and kind not in (schema.STRING,):
        collector.add(WARNING, "empty-value", f"'{raw_name}' is empty.", node, raw_name)
        return

    if kind == schema.BOOL or (attr.values and set(attr.values) == {"true", "false"}):
        if value.lower() not in _BOOLS:
            collector.add(ERROR, "bad-bool",
                          f"'{raw_name}' must be true or false, not '{value}'.", node, raw_name)
        return

    if kind == schema.ENUM and attr.values and value not in attr.values:
        collector.add(ERROR, "bad-enum",
                      f"'{raw_name}' must be one of: {', '.join(attr.values)} (got '{value}').",
                      node, raw_name)
        return

    if kind == schema.INT:
        try:
            number = int(value)
        except ValueError:
            collector.add(ERROR, "bad-int", f"'{raw_name}' must be a whole number, not '{value}'.",
                          node, raw_name)
            return
        if attr.min_value is not None and number < attr.min_value:
            collector.add(ERROR, "int-range",
                          f"'{raw_name}' must be at least {attr.min_value}.", node, raw_name)
        if attr.max_value is not None and number > attr.max_value:
            collector.add(ERROR, "int-range",
                          f"'{raw_name}' must be at most {attr.max_value}.", node, raw_name)
        return

    if kind == schema.CALLBACK:
        if not _IDENTIFIER.match(value):
            collector.add(ERROR, "bad-callback",
                          f"'{value}' is not a valid VBA procedure name.", node, raw_name,
                          hint="Letters, digits and underscores only, starting with a letter.")
        elif len(value) > 255:
            collector.add(WARNING, "long-callback", "VBA procedure names are limited to 255 characters.",
                          node, raw_name)
        return

    if kind == schema.IDENT:
        if not _NCNAME.match(value):
            collector.add(ERROR, "bad-id",
                          f"'{value}' is not a valid id - start with a letter and avoid spaces.",
                          node, raw_name)
        return

    if kind == schema.QUALIFIED:
        if ":" not in value:
            collector.add(WARNING, "bad-idq",
                          f"A qualified id normally looks like 'ns:name' (got '{value}').", node, raw_name)
        return

    if kind == schema.IMAGE:
        if images and value not in images:
            known = ", ".join(sorted(images)[:6]) or "none"
            collector.add(ERROR, "missing-image",
                          f"No picture with id '{value}' is embedded in this part.", node, raw_name,
                          hint=f"Embedded ids: {known}. Use Insert > Picture to add one.")
        return

    if kind == schema.IMAGE_MSO:
        if value not in set(msodata.image_mso_names()):
            severity = WARNING if strict_imagemso else INFO
            collector.add(severity, "unknown-imagemso",
                          f"'{value}' is not in the built-in icon catalogue.", node, raw_name,
                          hint="Office ships thousands of icons; the catalogue here is a curated subset, "
                               "so this may still be perfectly valid.")
        return

    if kind == schema.CONTROL_MSO:
        if not _NCNAME.match(value):
            collector.add(ERROR, "bad-idmso",
                          f"'{value}' is not a valid control identifier.", node, raw_name)
        return

    if attr.max_len is not None and len(value) > attr.max_len:
        collector.add(WARNING, "too-long",
                      f"'{raw_name}' is {len(value)} characters; Office allows {attr.max_len}.",
                      node, raw_name)
    if attr.name == "keytip" and len(value) > 3:
        collector.add(ERROR, "keytip-length", "A keytip may be at most 3 characters.", node, raw_name)


def _check_children(collector: _Collector, node: Node, elem: schema.Elem) -> None:
    counts: Dict[str, int] = {}
    for child in node.elements:
        counts[child.local] = counts.get(child.local, 0) + 1

    for local, count in counts.items():
        key = schema.child_key(elem.key, local)
        child_elem = schema.SCHEMA.get(key) if key else None
        if child_elem is not None and child_elem.max_occurs and count > child_elem.max_occurs:
            collector.add(ERROR, "too-many",
                          f"<{node.tag}> may contain only {child_elem.max_occurs} <{local}> element(s), found {count}.",
                          node)

    if elem.key == "splitButton":
        primaries = counts.get("button", 0) + counts.get("toggleButton", 0)
        menus = counts.get("menu", 0)
        if primaries != 1 or menus != 1:
            collector.add(ERROR, "splitbutton-shape",
                          "A <splitButton> must contain exactly one button (or toggleButton) and one menu.",
                          node,
                          hint=f"Found {primaries} button(s) and {menus} menu(s).")
    if elem.key == "dialogBoxLauncher":
        if counts.get("button", 0) != 1:
            collector.add(ERROR, "launcher-shape",
                          "A <dialogBoxLauncher> must contain exactly one <button>.", node)
    if elem.key in ("tab", "backstage:tab") and not node.elements:
        collector.add(INFO, "empty-tab", "This tab is empty, so Office will not display it.", node)
    if elem.key == "group" and not node.elements:
        collector.add(INFO, "empty-group", "This group has no controls.", node)
    if elem.key in ("comboBox", "dropDown", "gallery"):
        if not node.elements and not node.has("getItemCount"):
            collector.add(WARNING, "no-items",
                          f"<{node.tag}> has no <item> children and no getItemCount callback, so it will be empty.",
                          node)


def _check_vba(collector: _Collector, root: Node, vba) -> None:
    """Cross-check every callback attribute against the workbook's real VBA."""
    from . import callbacks as cbmod

    standard = {p.name.lower(): p for m in vba.modules if m.kind == "standard"
                for p in m.procedures}
    elsewhere = {p.name.lower(): p for m in vba.modules if m.kind != "standard"
                 for p in m.procedures}
    module_names = sorted({m.name for m in vba.modules if m.kind == "standard"}) or ["a standard module"]

    seen: Set[str] = set()
    for node in root.iter_elements():
        elem = schema.elem_for_node(node)
        if elem is None:
            continue
        for raw_name, value in node.attrs.items():
            local = raw_name.rsplit(":", 1)[-1]
            attr = elem.attr(local)
            if attr is None or attr.kind != schema.CALLBACK or not value.strip():
                continue
            name = value.strip()
            key = f"{name.lower()}|{local}"
            if key in seen:
                continue
            seen.add(key)
            proc = standard.get(name.lower())
            if proc is not None:
                params, _returns, _default = cbmod.signature_for(elem.key, local)
                expected = params.count(",") + 1 if params.strip() else 0
                if proc.arg_count != expected:
                    collector.add(WARNING, "vba-signature",
                                  f"'{name}' exists in {proc.module} but takes "
                                  f"{proc.arg_count} argument{'s' if proc.arg_count != 1 else ''}; "
                                  f"Office will call it with {expected}.",
                                  node, raw_name,
                                  hint=f"Expected: Sub {name}({params})")
                continue
            other = elsewhere.get(name.lower())
            if other is not None:
                collector.add(WARNING, "vba-wrong-module",
                              f"'{name}' lives in {other.module}, which Office cannot call "
                              f"from the ribbon.",
                              node, raw_name,
                              hint="Move it to a standard module such as "
                                   + module_names[0] + ".")
            else:
                collector.add(WARNING, "vba-missing",
                              f"'{name}' does not exist in this workbook's VBA yet.",
                              node, raw_name,
                              hint="Press F9 to generate it, or the control will do "
                                   "nothing in Excel.")


def _check_cross_cutting(collector: _Collector, root: Node, variant: str) -> None:
    ribbon = root.find("ribbon")
    qat = ribbon.find("qat") if ribbon is not None else None
    exported_ui = any(key.startswith("xmlns:") for key in root.attrs)
    if qat is not None and not exported_ui:
        # In a document part the QAT needs startFromScratch; in an
        # .exportedUI file (prefixed namespace) a bare <qat> is exactly how
        # Excel stores the user's own toolbar, so it is fine there.
        scratch = (ribbon.get("startFromScratch") or "false").lower()
        if scratch not in ("true", "1"):
            collector.add(WARNING, "qat-scratch",
                          "The Quick Access Toolbar section is only applied when "
                          "<ribbon startFromScratch=\"true\">.", qat)
    if ribbon is not None and root.find("commands") is not None:
        commands = root.find("commands")
        if commands is not None and root.children.index(commands) > root.children.index(ribbon):
            collector.add(WARNING, "order",
                          "<commands> should come before <ribbon> in the document.", commands)

    if not root.elements:
        collector.add(INFO, "empty-part", "This part contains no ribbon customisation yet.", root)


def _closest(word: str, options: Sequence[str]) -> str:
    """Cheap fuzzy match used for 'did you mean' hints."""
    best, best_score = "", 0.0
    lowered = word.lower()
    for option in options:
        other = option.lower()
        if other == lowered:
            return option
        common = len(set(lowered) & set(other))
        prefix = 0
        for a, b in zip(lowered, other):
            if a != b:
                break
            prefix += 1
        score = prefix * 2 + common - abs(len(other) - len(lowered)) * 0.5
        if score > best_score:
            best, best_score = option, score
    return best if best_score >= 4 else ""


# --------------------------------------------------------------------- fixes
FIXABLE = {"ns-mismatch", "ns-missing", "duplicate-id", "missing-id", "two-images",
           "two-inserts", "static-and-getter"}


def can_fix(issue: Issue) -> bool:
    return issue.code in FIXABLE


def apply_fix(document: XmlDocument, issue: Issue, variant: str) -> bool:
    """Apply a mechanical fix in place. Returns True when the tree changed."""
    node = document.find_uid(issue.node_uid) if issue.node_uid else document.root
    if issue.code in ("ns-mismatch", "ns-missing"):
        if document.root is None:
            return False
        attrs = dict(document.root.attrs)
        attrs.pop("xmlns", None)
        document.root.attrs = {"xmlns": NAMESPACE_FOR[variant], **attrs}
        return True
    if node is None:
        return False
    if issue.code == "duplicate-id":
        key = issue.attribute or "id"
        base = node.get(key) or "control"
        existing = {n.get(key) for n in document.root.iter_elements() if n.get(key)}
        index = 2
        while f"{base}{index}" in existing:
            index += 1
        node.set(key, f"{base}{index}")
        return True
    if issue.code == "missing-id":
        elem = schema.elem_for_node(node)
        base = (elem.name if elem else node.local) or "control"
        existing = {n.get("id") for n in document.root.iter_elements() if n.get("id")}
        index = 1
        candidate = f"{base}1"
        while candidate in existing:
            index += 1
            candidate = f"{base}{index}"
        node.set("id", candidate)
        return True
    if issue.code == "two-images":
        node.unset("imageMso")
        return True
    if issue.code == "two-inserts":
        node.unset("insertBeforeMso")
        return True
    if issue.code == "static-and-getter":
        node.unset(issue.attribute)
        return True
    return False
