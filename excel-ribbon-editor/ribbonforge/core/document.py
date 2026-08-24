"""Session model: open documents, their custom UI parts and edit state."""

from __future__ import annotations

import os
from typing import Dict, List, Optional

from . import templates, validator
from .ooxml import (NAMESPACE_FOR, PART_LABEL, V2007, V2010, ImageResource,
                    OfficePackage, PackageError, sniff_variant)
from .xmldoc import XmlDocument

KIND_PACKAGE = "package"
KIND_XML = "xml"


class PartState:
    """One customUI part plus everything the editor tracks about it."""

    def __init__(self, owner: "RibbonDocument", variant: str, text: str) -> None:
        self.owner = owner
        self.variant = variant
        self.text = text
        self.document = XmlDocument.parse(text)
        self.last_good: XmlDocument = self.document if self.document.error is None else XmlDocument.parse("<customUI/>")
        self.report = validator.Report()
        self.dirty = False
        self.selected_path: tuple = ()
        self.expanded: set = set()
        self.caret = "1.0"
        self.scroll = 0.0

    # ------------------------------------------------------------------ text
    def set_text(self, text: str, mark_dirty: bool = True) -> None:
        if text == self.text:
            return
        self.text = text
        if mark_dirty:
            self.dirty = True
            self.owner.touch()
        self.reparse()

    def reparse(self) -> None:
        self.document = XmlDocument.parse(self.text)
        if self.document.error is None and self.document.root is not None:
            self.last_good = self.document
        self.validate()

    def validate(self, strict_imagemso: bool = False) -> validator.Report:
        self.report = validator.validate(
            self.document, self.variant,
            available_images=self.image_ids(),
            strict_imagemso=strict_imagemso,
        )
        return self.report

    @property
    def tree(self) -> XmlDocument:
        """The best tree we have: the current one, or the last that parsed.

        A half-typed document often still yields a partial tree, which would
        make the structure view flicker down to a single node, so anything
        that did not parse cleanly falls back to the last good version.
        """
        if self.document.error is None and self.document.root is not None:
            return self.document
        return self.last_good

    @property
    def parse_ok(self) -> bool:
        return self.document.error is None and self.document.root is not None

    # ---------------------------------------------------------------- images
    def images(self) -> List[ImageResource]:
        if self.owner.package is None:
            return []
        part = self.owner.package.part(self.variant)
        return list(part.images) if part else []

    def image_ids(self) -> List[str]:
        return [img.rel_id for img in self.images()]

    # ----------------------------------------------------------------- names
    @property
    def label(self) -> str:
        if self.owner.kind == KIND_XML:
            return os.path.basename(self.owner.path) if self.owner.path else "Untitled.xml"
        return PART_LABEL[self.variant]

    @property
    def office_hint(self) -> str:
        return "Office 2007" if self.variant == V2007 else "Office 2010 and later"

    @property
    def namespace(self) -> str:
        return NAMESPACE_FOR[self.variant]

    def flush(self) -> None:
        """Push the editor text back into the package part."""
        if self.owner.package is not None:
            self.owner.package.set_part_xml(self.variant, self.text)


class RibbonDocument:
    """A workbook (or a loose XML file) being edited."""

    _untitled_counter = 0

    def __init__(self, kind: str, path: str = "", package: Optional[OfficePackage] = None) -> None:
        self.kind = kind
        self.path = path
        self.package = package
        self.parts: Dict[str, PartState] = {}
        self._dirty = False
        if not path:
            RibbonDocument._untitled_counter += 1
            self._untitled = f"Untitled {RibbonDocument._untitled_counter}"
        else:
            self._untitled = ""

    # ------------------------------------------------------------- factories
    @classmethod
    def open_package(cls, path: str) -> "RibbonDocument":
        package = OfficePackage.open(path)
        doc = cls(KIND_PACKAGE, path, package)
        for variant in (V2007, V2010):
            part = package.part(variant)
            if part is not None:
                doc.parts[variant] = PartState(doc, variant, part.xml)
        for state in doc.parts.values():
            state.validate()
        return doc

    @classmethod
    def open_xml(cls, path: str) -> "RibbonDocument":
        with open(path, "rb") as handle:
            raw = handle.read()
        text = _decode(raw)
        variant = sniff_variant(text)
        doc = cls(KIND_XML, path)
        doc.parts[variant] = PartState(doc, variant, text)
        doc.parts[variant].validate()
        return doc

    @classmethod
    def new_xml(cls, variant: str = V2010, template_key: str = "starter") -> "RibbonDocument":
        doc = cls(KIND_XML, "")
        text = templates.render(template_key, variant)
        doc.parts[variant] = PartState(doc, variant, text)
        doc.parts[variant].validate()
        doc._dirty = True
        return doc

    # ------------------------------------------------------------------ meta
    @property
    def name(self) -> str:
        if self.path:
            return os.path.basename(self.path)
        return self._untitled

    @property
    def folder(self) -> str:
        return os.path.dirname(self.path) if self.path else ""

    @property
    def dirty(self) -> bool:
        return self._dirty or any(p.dirty for p in self.parts.values())

    def touch(self) -> None:
        self._dirty = True

    def mark_clean(self) -> None:
        self._dirty = False
        for part in self.parts.values():
            part.dirty = False
        if self.package is not None:
            self.package.mark_clean()

    def variants(self) -> List[str]:
        return [v for v in (V2007, V2010) if v in self.parts]

    def part(self, variant: str) -> Optional[PartState]:
        return self.parts.get(variant)

    def first_part(self) -> Optional[PartState]:
        for variant in (V2010, V2007):
            if variant in self.parts:
                return self.parts[variant]
        return None

    # ----------------------------------------------------------- part edits
    def add_part(self, variant: str, template_key: str = "starter") -> PartState:
        if variant in self.parts:
            return self.parts[variant]
        if self.kind == KIND_PACKAGE and self.package is not None:
            text = templates.render(template_key, variant)
            self.package.create_part(variant, text)
            state = PartState(self, variant, text)
        else:
            state = PartState(self, variant, templates.render(template_key, variant))
        state.dirty = True
        state.validate()
        self.parts[variant] = state
        self.touch()
        return state

    def remove_part(self, variant: str) -> None:
        if variant not in self.parts:
            return
        del self.parts[variant]
        if self.package is not None:
            self.package.delete_part(variant)
        self.touch()

    # ------------------------------------------------------------------ save
    def save(self, target: Optional[str] = None, make_backup: bool = True) -> str:
        if self.kind == KIND_PACKAGE and self.package is not None:
            for part in self.parts.values():
                part.flush()
            written = self.package.save(target, make_backup=make_backup)
            self.path = written
            self.mark_clean()
            return written

        target = target or self.path
        if not target:
            raise PackageError("Choose a file name first.")
        part = self.first_part()
        if part is None:
            raise PackageError("There is nothing to save.")
        if make_backup and os.path.isfile(target):
            try:
                import shutil
                shutil.copy2(target, target + ".bak")
            except OSError:
                pass
        with open(target, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(part.text)
        self.path = target
        self.mark_clean()
        return target

    def total_issues(self):
        errors = warnings = 0
        for part in self.parts.values():
            e, w, _ = part.report.counts()
            errors += e
            warnings += w
        return errors, warnings


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "cp1252"):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return raw.decode("utf-8", "replace")
