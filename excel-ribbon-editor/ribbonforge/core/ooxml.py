"""Read and write the CustomUI parts of an Open XML package.

An .xlsm (or .docm, .pptm, .xlam ...) file is a ZIP package.  A ribbon
customisation lives in one or two extra parts:

    customUI/customUI.xml     -> Office 2007      (2006/01 namespace)
    customUI/customUI14.xml   -> Office 2010+     (2009/07 namespace)

each pointed at from ``_rels/.rels`` with its own relationship type, and
each able to own pictures under ``customUI/images/`` through its own
``customUI/_rels/<part>.rels``.

Everything else in the package is copied through byte-for-byte, so the
workbook keeps working exactly as before.
"""

from __future__ import annotations

import os
import posixpath
import re
import shutil
import zipfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from xml.etree import ElementTree as ET

REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"

V2007 = "2007"
V2010 = "2010"

PART_PATHS = {V2007: "customUI/customUI.xml", V2010: "customUI/customUI14.xml"}
REL_TYPES = {
    V2007: "http://schemas.microsoft.com/office/2006/relationships/ui/extensibility",
    V2010: "http://schemas.microsoft.com/office/2007/relationships/ui/extensibility",
}
PART_LABEL = {V2007: "customUI.xml", V2010: "customUI14.xml"}
NAMESPACE_FOR = {
    V2007: "http://schemas.microsoft.com/office/2006/01/customui",
    V2010: "http://schemas.microsoft.com/office/2009/07/customui",
}

IMAGE_CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "ico": "image/x-icon",
    "emf": "image/x-emf",
    "wmf": "image/x-wmf",
}

SUPPORTED_EXTENSIONS = (
    ".xlsm", ".xlsx", ".xlsb", ".xltm", ".xltx", ".xlam",
    ".docm", ".docx", ".dotm", ".dotx",
    ".pptm", ".pptx", ".potm", ".potx", ".ppam", ".ppsm", ".ppsx",
    ".vsdm", ".vsdx", ".accdb",
)

OPEN_FILTER = [
    ("Office documents", "*.xlsm *.xlsx *.xlsb *.xltm *.xltx *.xlam *.docm *.docx "
                         "*.dotm *.dotx *.pptm *.pptx *.potm *.potx *.ppam"),
    ("Excel macro-enabled", "*.xlsm *.xlam *.xltm *.xlsb"),
    ("Ribbon XML", "*.xml"),
    ("All files", "*.*"),
]


class PackageError(Exception):
    """Raised when a file cannot be opened or written as an Open XML package."""


@dataclass
class ImageResource:
    rel_id: str
    part_name: str          # e.g. customUI/images/logo.png
    target: str             # e.g. images/logo.png
    data: bytes = b""

    @property
    def file_name(self) -> str:
        return posixpath.basename(self.part_name)

    @property
    def extension(self) -> str:
        return self.file_name.rsplit(".", 1)[-1].lower() if "." in self.file_name else ""

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass
class UIPart:
    variant: str
    part_name: str
    xml: str = ""
    images: List[ImageResource] = field(default_factory=list)

    @property
    def label(self) -> str:
        return PART_LABEL[self.variant]

    @property
    def namespace(self) -> str:
        return NAMESPACE_FOR[self.variant]

    def image_ids(self) -> List[str]:
        return [img.rel_id for img in self.images]

    def image(self, rel_id: str) -> Optional[ImageResource]:
        for img in self.images:
            if img.rel_id == rel_id:
                return img
        return None


def _indent(elem: ET.Element, level: int = 0) -> None:
    pad = "\n" + "  " * level
    if len(elem):
        if not (elem.text or "").strip():
            elem.text = pad + "  "
        for child in elem:
            _indent(child, level + 1)
            if not (child.tail or "").strip():
                child.tail = pad + "  "
        if not (elem[-1].tail or "").strip():
            elem[-1].tail = pad
    if level and not (elem.tail or "").strip():
        elem.tail = pad


def _tostring(root: ET.Element) -> bytes:
    _indent(root)
    body = ET.tostring(root, encoding="utf-8", xml_declaration=False)
    return b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + body


class OfficePackage:
    """An Open XML package opened for ribbon editing."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.parts: Dict[str, UIPart] = {}
        self._overrides: Dict[str, bytes] = {}
        self._deleted: set = set()
        self._names: List[str] = []
        self._dirty = False

    # --------------------------------------------------------------- opening
    @classmethod
    def open(cls, path: str) -> "OfficePackage":
        if not os.path.isfile(path):
            raise PackageError(f"File not found:\n{path}")
        if path.lower().endswith(".xls") or path.lower().endswith(".doc") or path.lower().endswith(".ppt"):
            raise PackageError(
                "Legacy binary Office files (.xls / .doc / .ppt) cannot carry a ribbon "
                "customisation.\n\nSave the file as .xlsm (macro-enabled workbook) first."
            )
        if not zipfile.is_zipfile(path):
            raise PackageError(
                "This file is not an Open XML package.\n\n"
                "Ribbon customisation requires a modern Office format such as "
                ".xlsm, .xlsx, .xlam, .docm or .pptm."
            )
        pkg = cls(path)
        try:
            with zipfile.ZipFile(path, "r") as zf:
                bad = zf.testzip()
                if bad:
                    raise PackageError(f"The package is damaged (bad entry: {bad}).")
                pkg._names = zf.namelist()
                pkg._load_parts(zf)
        except zipfile.BadZipFile as exc:  # pragma: no cover - defensive
            raise PackageError(f"Could not read the package:\n{exc}") from exc
        return pkg

    def _read(self, name: str, zf: Optional[zipfile.ZipFile] = None) -> Optional[bytes]:
        if name in self._deleted:
            return None
        if name in self._overrides:
            return self._overrides[name]
        try:
            if zf is not None:
                return zf.read(name)
            with zipfile.ZipFile(self.path, "r") as handle:
                return handle.read(name)
        except (KeyError, OSError, zipfile.BadZipFile):
            return None

    def exists(self, name: str) -> bool:
        if name in self._deleted:
            return False
        return name in self._overrides or name in self._names

    def _load_parts(self, zf: zipfile.ZipFile) -> None:
        rels = self._read("_rels/.rels", zf)
        declared: Dict[str, str] = {}
        if rels:
            try:
                root = ET.fromstring(rels)
                for rel in root.findall(f"{{{REL_NS}}}Relationship"):
                    rtype = rel.get("Type", "")
                    for variant, expected in REL_TYPES.items():
                        if rtype == expected:
                            target = (rel.get("Target") or "").lstrip("/")
                            declared[variant] = target
            except ET.ParseError:
                pass

        for variant, default_path in PART_PATHS.items():
            part_name = declared.get(variant, default_path)
            if part_name not in self._names:
                # Tolerate packages whose relationship is missing or points elsewhere.
                part_name = default_path if default_path in self._names else part_name
            if part_name not in self._names:
                continue
            raw = self._read(part_name, zf) or b""
            part = UIPart(variant=variant, part_name=part_name, xml=_decode(raw))
            part.images = self._load_images(part_name, zf)
            self.parts[variant] = part

    def _rels_name(self, part_name: str) -> str:
        folder = posixpath.dirname(part_name)
        base = posixpath.basename(part_name)
        return posixpath.join(folder, "_rels", base + ".rels") if folder else f"_rels/{base}.rels"

    def _load_images(self, part_name: str, zf: Optional[zipfile.ZipFile] = None) -> List[ImageResource]:
        rels_name = self._rels_name(part_name)
        raw = self._read(rels_name, zf)
        images: List[ImageResource] = []
        if not raw:
            return images
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            return images
        base = posixpath.dirname(part_name)
        for rel in root.findall(f"{{{REL_NS}}}Relationship"):
            if rel.get("Type") != IMAGE_REL:
                continue
            target = (rel.get("Target") or "").replace("\\", "/")
            full = target[1:] if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
            data = self._read(full, zf) or b""
            images.append(ImageResource(rel_id=rel.get("Id", ""), part_name=full, target=target, data=data))
        return images

    # ------------------------------------------------------------ part edits
    @property
    def dirty(self) -> bool:
        return self._dirty

    def mark_clean(self) -> None:
        self._dirty = False

    def part(self, variant: str) -> Optional[UIPart]:
        return self.parts.get(variant)

    def set_part_xml(self, variant: str, xml: str) -> None:
        part = self.parts.get(variant)
        if part is None:
            return
        if part.xml != xml:
            part.xml = xml
            self._dirty = True

    def create_part(self, variant: str, xml: Optional[str] = None) -> UIPart:
        if variant in self.parts:
            return self.parts[variant]
        from . import templates  # local import keeps module import order simple

        part_name = PART_PATHS[variant]
        body = xml if xml is not None else templates.starter_xml(variant)
        part = UIPart(variant=variant, part_name=part_name, xml=body)
        self.parts[variant] = part
        self._dirty = True
        return part

    def delete_part(self, variant: str) -> None:
        part = self.parts.pop(variant, None)
        if part is None:
            return
        self._deleted.add(part.part_name)
        self._overrides.pop(part.part_name, None)
        rels = self._rels_name(part.part_name)
        self._deleted.add(rels)
        self._overrides.pop(rels, None)
        for image in part.images:
            if not self._image_shared(image.part_name, exclude=variant):
                self._deleted.add(image.part_name)
                self._overrides.pop(image.part_name, None)
        self._dirty = True

    def _image_shared(self, part_name: str, exclude: str) -> bool:
        for variant, part in self.parts.items():
            if variant == exclude:
                continue
            for image in part.images:
                if image.part_name == part_name:
                    return True
        return False

    # ----------------------------------------------------------- image edits
    def _next_rel_id(self, part: UIPart) -> str:
        used = {img.rel_id for img in part.images}
        index = 1
        while f"rId{index}" in used:
            index += 1
        return f"rId{index}"

    def _unique_image_name(self, base_name: str) -> str:
        stem, dot, ext = base_name.rpartition(".")
        if not dot:
            stem, ext = base_name, "png"
        stem = re.sub(r"[^A-Za-z0-9_.\-]", "_", stem) or "image"
        ext = re.sub(r"[^A-Za-z0-9]", "", ext).lower() or "png"
        taken = set()
        for part in self.parts.values():
            taken.update(posixpath.basename(img.part_name).lower() for img in part.images)
        taken.update(posixpath.basename(n).lower() for n in self._names if n.startswith("customUI/images/"))
        candidate = f"{stem}.{ext}"
        counter = 1
        while candidate.lower() in taken:
            candidate = f"{stem}{counter}.{ext}"
            counter += 1
        return candidate

    def add_image(self, variant: str, data: bytes, file_name: str, rel_id: str = "") -> ImageResource:
        part = self.parts.get(variant)
        if part is None:
            raise PackageError(f"There is no {PART_LABEL[variant]} part to attach the image to.")
        name = self._unique_image_name(file_name)
        ext = name.rsplit(".", 1)[-1].lower()
        if ext not in IMAGE_CONTENT_TYPES:
            raise PackageError(
                f"'{ext}' is not a picture format Office understands here.\n"
                f"Use one of: {', '.join(sorted(IMAGE_CONTENT_TYPES))}."
            )
        rel = rel_id.strip() or self._next_rel_id(part)
        if any(img.rel_id == rel for img in part.images):
            raise PackageError(f"The id '{rel}' is already used in {part.label}.")
        image = ImageResource(rel_id=rel, part_name=f"customUI/images/{name}",
                              target=f"images/{name}", data=data)
        part.images.append(image)
        self._overrides[image.part_name] = data
        self._deleted.discard(image.part_name)
        self._dirty = True
        return image

    def remove_image(self, variant: str, rel_id: str) -> None:
        part = self.parts.get(variant)
        if part is None:
            return
        image = part.image(rel_id)
        if image is None:
            return
        part.images.remove(image)
        if not self._image_shared(image.part_name, exclude=variant):
            self._deleted.add(image.part_name)
            self._overrides.pop(image.part_name, None)
        self._dirty = True

    def rename_image(self, variant: str, rel_id: str, new_id: str) -> None:
        part = self.parts.get(variant)
        if part is None:
            return
        new_id = new_id.strip()
        if not new_id:
            raise PackageError("The image id cannot be empty.")
        if not re.match(r"^[A-Za-z_][\w.\-]*$", new_id):
            raise PackageError("An image id must start with a letter and contain no spaces.")
        if any(img.rel_id == new_id for img in part.images if img.rel_id != rel_id):
            raise PackageError(f"The id '{new_id}' is already used in {part.label}.")
        image = part.image(rel_id)
        if image is None:
            return
        image.rel_id = new_id
        self._dirty = True

    def export_image(self, variant: str, rel_id: str, destination: str) -> None:
        part = self.parts.get(variant)
        image = part.image(rel_id) if part else None
        if image is None:
            raise PackageError("That picture is no longer in the package.")
        with open(destination, "wb") as handle:
            handle.write(image.data)

    # ------------------------------------------------------------------ save
    def _build_root_rels(self) -> bytes:
        raw = self._read("_rels/.rels")
        if raw:
            try:
                root = ET.fromstring(raw)
            except ET.ParseError:
                root = ET.Element(f"{{{REL_NS}}}Relationships")
        else:
            root = ET.Element(f"{{{REL_NS}}}Relationships")

        used = {rel.get("Id", "") for rel in root}
        wanted = {v: REL_TYPES[v] for v in self.parts}

        for rel in list(root):
            rtype = rel.get("Type", "")
            for variant, expected in REL_TYPES.items():
                if rtype == expected and variant not in self.parts:
                    root.remove(rel)

        for variant, part in self.parts.items():
            existing = None
            for rel in root:
                if rel.get("Type") == wanted[variant]:
                    existing = rel
                    break
            if existing is None:
                index = 1
                while f"customUIRel{index}" in used:
                    index += 1
                rid = f"customUIRel{index}"
                used.add(rid)
                existing = ET.SubElement(root, f"{{{REL_NS}}}Relationship")
                existing.set("Id", rid)
                existing.set("Type", wanted[variant])
            existing.set("Target", part.part_name)
        ET.register_namespace("", REL_NS)
        return _tostring(root)

    def _build_part_rels(self, part: UIPart) -> Optional[bytes]:
        if not part.images:
            return None
        raw = self._read(self._rels_name(part.part_name))
        root = None
        if raw:
            try:
                root = ET.fromstring(raw)
            except ET.ParseError:
                root = None
        if root is None:
            root = ET.Element(f"{{{REL_NS}}}Relationships")
        else:
            for rel in list(root):
                if rel.get("Type") == IMAGE_REL:
                    root.remove(rel)
        for image in part.images:
            rel = ET.SubElement(root, f"{{{REL_NS}}}Relationship")
            rel.set("Id", image.rel_id)
            rel.set("Type", IMAGE_REL)
            rel.set("Target", image.target)
        ET.register_namespace("", REL_NS)
        return _tostring(root)

    def _build_content_types(self) -> Optional[bytes]:
        raw = self._read("[Content_Types].xml")
        if not raw:
            return None
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            return None
        have = {
            (d.get("Extension") or "").lower()
            for d in root.findall(f"{{{CT_NS}}}Default")
        }
        needed = set()
        for part in self.parts.values():
            for image in part.images:
                if image.extension:
                    needed.add(image.extension)
        needed.add("xml")
        changed = False
        for ext in sorted(needed):
            if ext in have:
                continue
            content_type = IMAGE_CONTENT_TYPES.get(ext, "application/xml" if ext == "xml" else None)
            if content_type is None:
                continue
            default = ET.Element(f"{{{CT_NS}}}Default")
            default.set("Extension", ext)
            default.set("ContentType", content_type)
            root.insert(0, default)
            changed = True
        if not changed:
            return None
        ET.register_namespace("", CT_NS)
        return _tostring(root)

    def save(self, target: Optional[str] = None, make_backup: bool = True) -> str:
        target = target or self.path
        overrides = dict(self._overrides)
        deleted = set(self._deleted)

        for part in self.parts.values():
            overrides[part.part_name] = part.xml.encode("utf-8")
            rels = self._build_part_rels(part)
            rels_name = self._rels_name(part.part_name)
            if rels is None:
                deleted.add(rels_name)
            else:
                overrides[rels_name] = rels
            for image in part.images:
                overrides.setdefault(image.part_name, image.data)

        overrides["_rels/.rels"] = self._build_root_rels()
        content_types = self._build_content_types()
        if content_types is not None:
            overrides["[Content_Types].xml"] = content_types
        if "[Content_Types].xml" not in overrides and not self.exists("[Content_Types].xml"):
            raise PackageError(
                "The original file is no longer readable, so the package cannot be "
                "rebuilt safely.\n\nUse File > Export this part as XML to rescue your work.")

        directory = os.path.dirname(os.path.abspath(target)) or "."
        if not os.path.isdir(directory):
            raise PackageError(f"The folder does not exist:\n{directory}")
        tmp = os.path.join(directory, f".~rf-{os.path.basename(target)}.tmp")

        try:
            with zipfile.ZipFile(self.path, "r") if os.path.isfile(self.path) else _NullZip() as source:
                with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
                    written = set()
                    ordered = ["[Content_Types].xml"] + [
                        n for n in getattr(source, "namelist", list)() if n != "[Content_Types].xml"
                    ]
                    for name in ordered:
                        if name in deleted or name in written:
                            continue
                        if name in overrides:
                            data = overrides[name]
                        else:
                            try:
                                data = source.read(name)
                            except (KeyError, AttributeError):
                                continue
                        info = _info_for(source, name)
                        out.writestr(info, data)
                        written.add(name)
                    for name, data in overrides.items():
                        if name in written or name in deleted:
                            continue
                        out.writestr(_new_info(name), data)
                        written.add(name)
        except OSError as exc:
            _silent_remove(tmp)
            raise PackageError(f"Could not write the package:\n{exc}") from exc
        except Exception:
            _silent_remove(tmp)
            raise

        if make_backup and os.path.isfile(target):
            backup = target + ".bak"
            try:
                shutil.copy2(target, backup)
            except OSError:
                pass

        try:
            os.replace(tmp, target)
        except OSError as exc:
            _silent_remove(tmp)
            raise PackageError(
                f"Could not replace the file. Is it open in Office?\n\n{exc}"
            ) from exc

        self.path = target
        self._overrides.clear()
        self._deleted.clear()
        try:
            with zipfile.ZipFile(self.path, "r") as zf:
                self._names = zf.namelist()
        except (OSError, zipfile.BadZipFile):
            pass
        self._dirty = False
        return target


class _NullZip:
    """Stand-in when the source package no longer exists (Save As to a new file)."""

    def namelist(self) -> List[str]:
        return []

    def read(self, name: str) -> bytes:
        raise KeyError(name)

    def getinfo(self, name: str):
        raise KeyError(name)

    def __enter__(self) -> "_NullZip":
        return self

    def __exit__(self, *exc) -> bool:
        return False


def _info_for(source, name: str) -> zipfile.ZipInfo:
    try:
        original = source.getinfo(name)
        info = zipfile.ZipInfo(name, date_time=original.date_time)
        info.compress_type = original.compress_type
        info.external_attr = original.external_attr
        info.internal_attr = original.internal_attr
        info.create_system = original.create_system
        return info
    except (KeyError, AttributeError):
        return _new_info(name)


def _new_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o600 << 16
    return info


def _silent_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "cp1252"):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return raw.decode("utf-8", "replace")


def sniff_variant(xml: str) -> str:
    """Guess which customUI dialect a loose XML file belongs to."""
    return V2007 if NAMESPACE_FOR[V2007] in xml else V2010
