"""VBA X-Ray: read the macros inside a workbook without opening Excel.

An .xlsm keeps its VBA in ``xl/vbaProject.bin`` - an OLE2 / Compound File
Binary (MS-CFB) whose streams hold the module sources in the MS-OVBA
run-length compression.  Both formats are documented and simple enough to
read with the standard library, which means RibbonForge can tell you - the
moment a workbook opens - exactly which ribbon callbacks already exist in
its VBA and which are still missing.

Read-only by design: writing vbaProject.bin safely needs Excel itself
(see excelbridge), but reading it needs nothing at all.
"""

from __future__ import annotations

import io
import re
import struct
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE
FATSECT = 0xFFFFFFFD
DIFSECT = 0xFFFFFFFC

_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

_PROC_RE = re.compile(
    r"^[ \t]*(?:Public[ \t]+|Private[ \t]+|Friend[ \t]+)?(?:Static[ \t]+)?"
    r"(Sub|Function|Property[ \t]+(?:Get|Let|Set))[ \t]+([A-Za-z_][A-Za-z0-9_]*)"
    r"[ \t]*(\(([^)]*)\))?",
    re.IGNORECASE,
)


class VbaError(Exception):
    """The container could not be read; the workbook itself is untouched."""


@dataclass
class Procedure:
    name: str
    kind: str                  # Sub / Function / Property Get ...
    module: str
    line: int
    parameters: str = ""

    @property
    def arg_count(self) -> int:
        params = self.parameters.strip()
        if not params:
            return 0
        depth = 0
        count = 1
        for ch in params:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                count += 1
        return count


@dataclass
class Module:
    name: str
    kind: str                  # "standard" | "class" | "document"
    source: str = ""
    procedures: List[Procedure] = field(default_factory=list)

    @property
    def line_count(self) -> int:
        return self.source.count("\n") + 1 if self.source else 0


@dataclass
class VbaProject:
    modules: List[Module] = field(default_factory=list)
    project_name: str = ""

    def module(self, name: str) -> Optional[Module]:
        lowered = name.lower()
        for module in self.modules:
            if module.name.lower() == lowered:
                return module
        return None

    def procedures(self) -> List[Procedure]:
        return [proc for module in self.modules for proc in module.procedures]

    def procedure_names(self) -> "set[str]":
        return {proc.name.lower() for proc in self.procedures()}

    def find(self, name: str) -> Optional[Procedure]:
        lowered = name.lower()
        for proc in self.procedures():
            if proc.name.lower() == lowered:
                return proc
        return None


# ============================================================= CFB container
class _Cfb:
    """Minimal MS-CFB reader: FAT, mini-FAT, directory, stream extraction."""

    def __init__(self, data: bytes) -> None:
        if len(data) < 512 or not data.startswith(_SIGNATURE):
            raise VbaError("Not an OLE compound file.")
        (self.sector_shift,) = struct.unpack_from("<H", data, 30)
        (self.mini_shift,) = struct.unpack_from("<H", data, 32)
        if self.sector_shift not in (9, 12) or self.mini_shift != 6:
            raise VbaError("Unsupported compound-file sector size.")
        self.sector_size = 1 << self.sector_shift
        self.mini_size = 1 << self.mini_shift
        (self.dir_start,) = struct.unpack_from("<I", data, 48)
        (self.mini_cutoff,) = struct.unpack_from("<I", data, 56)
        (self.minifat_start,) = struct.unpack_from("<I", data, 60)
        (self.minifat_count,) = struct.unpack_from("<I", data, 64)
        (self.difat_start,) = struct.unpack_from("<I", data, 68)
        (self.difat_count,) = struct.unpack_from("<I", data, 72)
        self.data = data

        # ---- FAT via the DIFAT
        fat_sectors: List[int] = []
        for i in range(109):
            (sector,) = struct.unpack_from("<I", data, 76 + i * 4)
            if sector not in (FREESECT, ENDOFCHAIN):
                fat_sectors.append(sector)
        difat_sector = self.difat_start
        seen = set()
        while difat_sector not in (ENDOFCHAIN, FREESECT) and difat_sector not in seen:
            seen.add(difat_sector)
            block = self._sector(difat_sector)
            entries = struct.unpack(f"<{self.sector_size // 4}I", block)
            for sector in entries[:-1]:
                if sector not in (FREESECT, ENDOFCHAIN):
                    fat_sectors.append(sector)
            difat_sector = entries[-1]
        fat: List[int] = []
        for sector in fat_sectors:
            fat.extend(struct.unpack(f"<{self.sector_size // 4}I", self._sector(sector)))
        self.fat = fat

        # ---- directory
        self.entries = self._read_directory()

        # ---- mini FAT + mini stream
        self.minifat: List[int] = []
        sector = self.minifat_start
        guard = 0
        while sector not in (ENDOFCHAIN, FREESECT) and guard < 1_000_000:
            self.minifat.extend(struct.unpack(f"<{self.sector_size // 4}I", self._sector(sector)))
            sector = self.fat[sector] if sector < len(self.fat) else ENDOFCHAIN
            guard += 1
        root = self.entries[0] if self.entries else None
        self.mini_stream = self._chain_data(root[2], root[3]) if root else b""

    def _sector(self, index: int) -> bytes:
        offset = 512 + index * self.sector_size
        chunk = self.data[offset:offset + self.sector_size]
        return chunk.ljust(self.sector_size, b"\x00")

    def _chain_data(self, start: int, size: int) -> bytes:
        out = io.BytesIO()
        sector = start
        guard = 0
        while sector not in (ENDOFCHAIN, FREESECT) and guard < 1_000_000:
            out.write(self._sector(sector))
            sector = self.fat[sector] if sector < len(self.fat) else ENDOFCHAIN
            guard += 1
        return out.getvalue()[:size]

    def _mini_chain_data(self, start: int, size: int) -> bytes:
        out = io.BytesIO()
        sector = start
        guard = 0
        while sector not in (ENDOFCHAIN, FREESECT) and guard < 1_000_000:
            offset = sector * self.mini_size
            out.write(self.mini_stream[offset:offset + self.mini_size])
            sector = self.minifat[sector] if sector < len(self.minifat) else ENDOFCHAIN
            guard += 1
        return out.getvalue()[:size]

    def _read_directory(self) -> List[Tuple[str, int, int, int, Tuple[int, ...]]]:
        raw = self._chain_data_nolimit(self.dir_start)
        entries = []
        for offset in range(0, len(raw) - 127, 128):
            (name_len,) = struct.unpack_from("<H", raw, offset + 64)
            if name_len < 2 or name_len > 64:
                entries.append(("", 0, 0, 0, ()))
                continue
            name = raw[offset:offset + name_len - 2].decode("utf-16-le", "replace")
            object_type = raw[offset + 66]
            (start,) = struct.unpack_from("<I", raw, offset + 116)
            (size,) = struct.unpack_from("<Q", raw, offset + 120)
            children = struct.unpack_from("<3I", raw, offset + 68)  # left, right, child
            entries.append((name, object_type, start, int(size), children))
        return entries

    def _chain_data_nolimit(self, start: int) -> bytes:
        out = io.BytesIO()
        sector = start
        guard = 0
        while sector not in (ENDOFCHAIN, FREESECT) and guard < 1_000_000:
            out.write(self._sector(sector))
            sector = self.fat[sector] if sector < len(self.fat) else ENDOFCHAIN
            guard += 1
        return out.getvalue()

    # -------------------------------------------------------------- lookups
    def streams(self) -> Dict[str, bytes]:
        """Flat map of stream name (case-folded, path ignored) -> bytes.

        VBA projects nest streams under a ``VBA`` storage; names are unique
        enough within a project for a flat view to be unambiguous, and it
        spares us walking the red-black directory tree.
        """
        result: Dict[str, bytes] = {}
        for name, object_type, start, size, _children in self.entries:
            if object_type != 2 or not name:  # 2 = stream
                continue
            if size >= self.mini_cutoff:
                data = self._chain_data(start, size)
            else:
                data = self._mini_chain_data(start, size)
            result.setdefault(name.lower(), data)
        return result


# ========================================================= OVBA decompression
def decompress(container: bytes) -> bytes:
    """MS-OVBA 2.4.1 'compressed container' -> raw bytes."""
    if not container or container[0] != 0x01:
        raise VbaError("Not a compressed container.")
    out = bytearray()
    position = 1
    while position < len(container):
        if position + 2 > len(container):
            break
        (header,) = struct.unpack_from("<H", container, position)
        if (header & 0x7000) != 0x3000:
            break        # signature bits must be 0b011 - anything else is padding
        position += 2
        chunk_len = (header & 0x0FFF) + 1
        compressed = bool(header & 0x8000)
        chunk_end = min(position + chunk_len + 1, len(container)) if compressed \
            else min(position + 4096, len(container))
        if not compressed:
            out.extend(container[position:position + 4096])
            position += 4096
            continue
        chunk_start = len(out)
        end = position + chunk_len + 1
        while position < end and position < len(container):
            flags = container[position]
            position += 1
            for bit in range(8):
                if position >= end or position >= len(container):
                    break
                if not (flags >> bit) & 1:
                    out.append(container[position])
                    position += 1
                    continue
                (token,) = struct.unpack_from("<H", container, position)
                position += 2
                # MS-OVBA 2.4.1.3.19.1: the offset/length split moves as the
                # chunk decompresses - offset needs enough bits to reach back
                # to the start of the chunk, length gets the rest.
                difference = len(out) - chunk_start
                offset_bit_count = 4
                while (1 << offset_bit_count) < difference:
                    offset_bit_count += 1
                length_bits = 16 - offset_bit_count
                length = (token & ((1 << length_bits) - 1)) + 3
                offset = (token >> length_bits) + 1
                for _ in range(length):
                    if offset > len(out):
                        raise VbaError("Corrupt compressed container.")
                    out.append(out[-offset])
        _ = chunk_end
    return bytes(out)


# =============================================================== dir records
def _parse_dir(dir_stream: bytes) -> List[Tuple[str, str, int]]:
    """(module name, stream name, text offset) triples from the dir stream."""
    modules: List[Tuple[str, str, int]] = []
    position = 0
    name = stream = ""
    offset = -1
    module_type = "standard"

    def flush() -> None:
        nonlocal name, stream, offset, module_type
        if name and offset >= 0:
            modules.append((name, stream or name, offset))
        name = stream = ""
        offset = -1
        module_type = "standard"

    while position + 6 <= len(dir_stream):
        (record_id,) = struct.unpack_from("<H", dir_stream, position)
        (size,) = struct.unpack_from("<I", dir_stream, position + 2)
        if record_id == 0x0009:
            # PROJECTVERSION: the size field is a reserved constant (4) but
            # the record body is really 6 bytes - a documented quirk.
            size = 6
        body = dir_stream[position + 6:position + 6 + size]
        position += 6 + size
        if record_id == 0x0019:            # MODULENAME - starts a module record
            flush()
            name = body.decode("cp1252", "replace")
        elif record_id == 0x0047:          # MODULENAMEUNICODE
            name = body.decode("utf-16-le", "replace") or name
        elif record_id == 0x001A:          # MODULESTREAMNAME
            stream = body.decode("cp1252", "replace")
        elif record_id == 0x0031:          # MODULEOFFSET
            if len(body) >= 4:
                (offset,) = struct.unpack_from("<I", body, 0)
        elif record_id == 0x0010:          # terminator
            flush()
            break
    flush()
    return modules


# ================================================================= public API
def parse(data: bytes) -> VbaProject:
    """Parse a vbaProject.bin. Raises VbaError when unreadable."""
    cfb = _Cfb(data)
    streams = cfb.streams()

    project = VbaProject()
    project_stream = streams.get("project", b"")
    doc_modules: "set[str]" = set()
    class_modules: "set[str]" = set()
    if project_stream:
        text = project_stream.decode("cp1252", "replace").strip("\x00")
        for line in text.splitlines():
            line = line.strip()
            if line.lower().startswith("name="):
                project.project_name = line.split("=", 1)[1].strip('"')
            elif line.lower().startswith("document="):
                doc_modules.add(line.split("=", 1)[1].split("/")[0].lower())
            elif line.lower().startswith("class="):
                class_modules.add(line.split("=", 1)[1].lower())

    dir_raw = streams.get("dir")
    if dir_raw is None:
        raise VbaError("No dir stream - this does not look like a VBA project.")
    entries = _parse_dir(decompress(dir_raw))

    for module_name, stream_name, text_offset in entries:
        raw = streams.get(stream_name.lower())
        if raw is None or text_offset > len(raw):
            continue
        try:
            source_bytes = decompress(raw[text_offset:])
        except VbaError:
            continue
        source = source_bytes.decode("cp1252", "replace")
        lowered = module_name.lower()
        kind = "document" if lowered in doc_modules else (
            "class" if lowered in class_modules else "standard")
        module = Module(name=module_name, kind=kind, source=source)
        module.procedures = _extract_procedures(module)
        project.modules.append(module)
    return project


def _extract_procedures(module: Module) -> List[Procedure]:
    procedures: List[Procedure] = []
    for line_number, line in enumerate(module.source.splitlines(), start=1):
        match = _PROC_RE.match(line)
        if not match:
            continue
        kind = " ".join(match.group(1).split()).title()
        procedures.append(Procedure(
            name=match.group(2), kind=kind, module=module.name,
            line=line_number, parameters=match.group(4) or ""))
    return procedures


def from_package(package) -> Optional[VbaProject]:
    """Read the VBA project out of an OfficePackage, or None if there is none."""
    for name in ("xl/vbaProject.bin", "word/vbaProject.bin", "ppt/vbaProject.bin"):
        data = package._read(name)
        if data:
            try:
                return parse(data)
            except VbaError:
                return None
    return None
