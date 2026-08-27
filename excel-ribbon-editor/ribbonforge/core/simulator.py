"""Callback Lab: simulate what the workbook's callbacks would return.

Office asks your VBA for state (``getVisible``, ``getEnabled``,
``getLabel``, ``getItemCount`` ...) at run time - which is why a dynamic
ribbon is normally impossible to see without opening Excel.  The lab keeps a
value per callback *name* and the preview consults it, so flipping a switch
here shows exactly what your users would see when that callback returns the
same thing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from . import schema
from .xmldoc import Node, XmlDocument

BOOL = "bool"
TEXT = "text"
NUMBER = "number"

# getter attribute -> (control kind, sensible default)
GETTER_KINDS: Dict[str, Tuple[str, object]] = {
    "getVisible": (BOOL, True),
    "getEnabled": (BOOL, True),
    "getPressed": (BOOL, False),
    "getShowLabel": (BOOL, True),
    "getShowImage": (BOOL, True),
    "getLabel": (TEXT, ""),
    "getScreentip": (TEXT, ""),
    "getSupertip": (TEXT, ""),
    "getDescription": (TEXT, ""),
    "getText": (TEXT, ""),
    "getTitle": (TEXT, ""),
    "getKeytip": (TEXT, ""),
    "getSize": (BOOL, True),               # True = large
    "getItemCount": (NUMBER, 3),
    "getSelectedItemIndex": (NUMBER, 0),
    "getItemHeight": (NUMBER, 32),
    "getItemWidth": (NUMBER, 32),
    "getItemLabel": (TEXT, "Item {n}"),
}

_SIMULATABLE = set(GETTER_KINDS)


@dataclass
class LabEntry:
    callback: str            # VBA procedure name
    attribute: str           # e.g. getVisible
    kind: str                # BOOL / TEXT / NUMBER
    default: object
    controls: List[str] = field(default_factory=list)

    @property
    def title(self) -> str:
        return self.callback


class Simulation:
    """Values keyed by callback name, shared by every control that uses it -
    exactly how Office shares one callback across many controls."""

    def __init__(self) -> None:
        self.values: Dict[str, object] = {}
        self.enabled = False

    def reset(self) -> None:
        self.values.clear()

    def set(self, callback: str, value: object) -> None:
        self.values[callback] = value

    def get(self, callback: str, default: object = None) -> object:
        return self.values.get(callback, default)

    # ------------------------------------------------------------- resolvers
    def resolve_bool(self, node: Node, static_attr: str, getter_attr: str,
                     default: bool) -> bool:
        getter = node.get(getter_attr)
        if self.enabled and getter and getter in self.values:
            return bool(self.values[getter])
        static = node.get(static_attr)
        if static is not None:
            return static.lower() not in ("false", "0")
        if self.enabled and getter:
            kind_default = GETTER_KINDS.get(getter_attr, (BOOL, default))[1]
            return bool(kind_default)
        return default

    def resolve_text(self, node: Node, static_attr: str, getter_attr: str) -> Optional[str]:
        getter = node.get(getter_attr)
        if self.enabled and getter and getter in self.values:
            value = str(self.values[getter])
            if value:
                return value
        static = node.get(static_attr)
        if static:
            return static
        if getter:
            return None if not self.enabled else f"({getter})"
        return None

    def resolve_number(self, node: Node, getter_attr: str, default: int) -> int:
        getter = node.get(getter_attr)
        if self.enabled and getter and getter in self.values:
            try:
                return max(0, int(self.values[getter]))
            except (TypeError, ValueError):
                return default
        return default

    def item_labels(self, node: Node, count: int) -> List[str]:
        getter = node.get("getItemLabel")
        template = "Item {n}"
        if self.enabled and getter and getter in self.values:
            template = str(self.values[getter]) or template
        return [template.replace("{n}", str(i + 1)) for i in range(count)]


def discover(document: XmlDocument) -> List[LabEntry]:
    """Every simulatable callback in the document, one entry per name."""
    found: Dict[str, LabEntry] = {}
    order: List[str] = []
    if document.root is None:
        return []
    for node in document.root.iter_elements():
        elem = schema.elem_for_node(node)
        if elem is None:
            continue
        for raw_name, value in node.attrs.items():
            local = raw_name.rsplit(":", 1)[-1]
            if local not in _SIMULATABLE:
                continue
            attr = elem.attr(local)
            if attr is None or attr.kind != schema.CALLBACK or not value.strip():
                continue
            name = value.strip()
            kind, default = GETTER_KINDS[local]
            entry = found.get(name)
            if entry is None:
                entry = LabEntry(callback=name, attribute=local, kind=kind, default=default)
                found[name] = entry
                order.append(name)
            label = node.get("label") or node.get("id") or node.local
            if label not in entry.controls:
                entry.controls.append(label)
    return [found[name] for name in order]
