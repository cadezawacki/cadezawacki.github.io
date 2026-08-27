"""Build a synthetic-but-valid vbaProject.bin for the test suite.

Implements just enough of MS-CFB (regular FAT streams only - the reader
also handles the mini-FAT that real files use) and the MS-OVBA compression
(raw chunks plus hand-rolled copy tokens) to produce a container the
production parser must read correctly.
"""
from __future__ import annotations

import struct
from typing import Dict, List, Tuple

SECTOR = 512
ENDOFCHAIN = 0xFFFFFFFE
FREESECT = 0xFFFFFFFF
FATSECT = 0xFFFFFFFD


# ------------------------------------------------------------- OVBA compress
def compress_raw(data: bytes) -> bytes:
    """Compressed container using only uncompressed (raw) 4096-byte chunks."""
    out = bytearray(b"\x01")
    for start in range(0, max(1, len(data)), 4096):
        chunk = data[start:start + 4096]
        padded = chunk.ljust(4096, b"\x00")
        header = 0x3000 | 0x0FFF          # flag=0 (raw), signature 0b011, len field
        out += struct.pack("<H", header)
        out += padded
    return bytes(out)


def compress_with_copytokens(data: bytes) -> bytes:
    """A single compressed chunk that greedily emits copy tokens.

    Not optimal, but spec-exact - exercising the shifting offset/length
    split in the reader.
    """
    assert len(data) <= 4096
    body = bytearray()
    flags_pos = None
    flag_bit = 8
    position = 0
    while position < len(data):
        if flag_bit == 8:
            flags_pos = len(body)
            body.append(0)
            flag_bit = 0
        # find longest match behind us
        best_len, best_off = 0, 0
        difference = position
        if difference:
            offset_bit_count = 4
            while (1 << offset_bit_count) < difference:
                offset_bit_count += 1
            length_bits = 16 - offset_bit_count
            max_len = (1 << length_bits) - 1 + 3
            max_off = 1 << offset_bit_count
            for off in range(1, min(difference, max_off) + 1):
                match = 0
                while (match < max_len and position + match < len(data)
                       and data[position + match] == data[position + match - off]):
                    match += 1
                if match > best_len:
                    best_len, best_off = match, off
        if best_len >= 3:
            token = ((best_off - 1) << length_bits) | (best_len - 3)
            body += struct.pack("<H", token)
            body[flags_pos] |= (1 << flag_bit)
            position += best_len
        else:
            body.append(data[position])
            position += 1
        flag_bit += 1
    header = 0xB000 | (len(body) - 1)     # flag=1 (compressed), sig 0b011
    return b"\x01" + struct.pack("<H", header) + bytes(body)


# ------------------------------------------------------------------ dir stream
def build_dir_stream(modules: List[Tuple[str, str, int]]) -> bytes:
    def record(rid: int, body: bytes) -> bytes:
        return struct.pack("<HI", rid, len(body)) + body

    out = bytearray()
    out += record(0x0001, struct.pack("<I", 0x409))        # SYSKIND-ish filler
    for name, stream, offset in modules:
        out += record(0x0019, name.encode("cp1252"))       # MODULENAME
        out += record(0x0047, name.encode("utf-16-le"))    # MODULENAMEUNICODE
        out += record(0x001A, stream.encode("cp1252"))     # MODULESTREAMNAME
        out += record(0x0031, struct.pack("<I", offset))   # MODULEOFFSET
        out += record(0x002B, b"")                          # MODULETERM
    out += record(0x0010, b"")                              # terminator
    return bytes(out)


# ------------------------------------------------------------------ CFB writer
def build_cfb(streams: Dict[str, bytes]) -> bytes:
    """Write streams into a compound file using regular FAT sectors only.

    Streams are padded so their declared size stays >= 4096 (the mini-stream
    cutoff), keeping the writer simple; the production reader handles real
    files' mini-FAT independently.
    """
    payloads = {}
    for name, data in streams.items():
        padded_len = max(4096, len(data))
        payloads[name] = (data, padded_len)

    # sector layout: [FAT sectors][directory][stream sectors...]
    sectors: List[bytes] = []

    def add_stream(data: bytes, declared: int) -> Tuple[int, int]:
        blob = data.ljust(declared, b"\x00")
        start = len(sectors)
        for off in range(0, len(blob), SECTOR):
            sectors.append(blob[off:off + SECTOR].ljust(SECTOR, b"\x00"))
        return start, declared

    # directory entries: root + one per stream (flat under root via child chain)
    names = list(payloads)
    dir_entries = 1 + len(names)
    dir_sector_count = (dir_entries * 128 + SECTOR - 1) // SECTOR

    # reserve: we lay FAT first, then dir, then data - compute FAT size iteratively
    total_data_sectors = sum((max(4096, len(d)) + SECTOR - 1) // SECTOR for d, _p in
                             ((payloads[n][0], None) for n in names))
    approx_total = 1 + dir_sector_count + total_data_sectors + 4
    fat_sector_count = 1
    while fat_sector_count * (SECTOR // 4) < approx_total + fat_sector_count:
        fat_sector_count += 1

    for _ in range(fat_sector_count):
        sectors.append(b"")                    # placeholder for FAT
    dir_start = len(sectors)
    for _ in range(dir_sector_count):
        sectors.append(b"")                    # placeholder for directory

    locations = {}
    for name in names:
        data, declared = payloads[name]
        locations[name] = add_stream(data, declared)

    # ---- FAT
    fat = [FREESECT] * (fat_sector_count * (SECTOR // 4))
    for i in range(fat_sector_count):
        fat[i] = FATSECT
    def chain(start: int, count: int) -> None:
        for i in range(count):
            fat[start + i] = start + i + 1
        fat[start + count - 1] = ENDOFCHAIN
    chain(dir_start, dir_sector_count)
    for name in names:
        start, declared = locations[name]
        chain(start, (declared + SECTOR - 1) // SECTOR)
    for i in range(fat_sector_count):
        blob = struct.pack(f"<{SECTOR // 4}I", *fat[i * (SECTOR // 4):(i + 1) * (SECTOR // 4)])
        sectors[i] = blob

    # ---- directory
    def entry(name: str, otype: int, start: int, size: int,
              left=FREESECT, right=FREESECT, child=FREESECT) -> bytes:
        encoded = name.encode("utf-16-le") + b"\x00\x00"
        raw = bytearray(128)
        raw[0:len(encoded)] = encoded
        struct.pack_into("<H", raw, 64, len(encoded))
        raw[66] = otype
        raw[67] = 1                                    # black
        struct.pack_into("<3I", raw, 68, left, right, child)
        struct.pack_into("<I", raw, 116, start)
        struct.pack_into("<Q", raw, 120, size)
        return bytes(raw)

    entries = [entry("Root Entry", 5, ENDOFCHAIN, 0, child=1)]
    for index, name in enumerate(names):
        start, declared = locations[name]
        sibling = index + 2 if index + 1 < len(names) else FREESECT
        # declare the padded size so every stream stays on the regular FAT
        entries.append(entry(name, 2, start, declared, right=sibling))
    dir_blob = b"".join(entries).ljust(dir_sector_count * SECTOR, b"\x00")
    for i in range(dir_sector_count):
        sectors[dir_start + i] = dir_blob[i * SECTOR:(i + 1) * SECTOR]

    # ---- header
    header = bytearray(512)
    header[0:8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
    struct.pack_into("<H", header, 24, 0x003E)         # minor version
    struct.pack_into("<H", header, 26, 3)              # major 3 = 512-byte sectors
    struct.pack_into("<H", header, 28, 0xFFFE)         # little-endian
    struct.pack_into("<H", header, 30, 9)              # sector shift
    struct.pack_into("<H", header, 32, 6)              # mini shift
    struct.pack_into("<I", header, 44, fat_sector_count)
    struct.pack_into("<I", header, 48, dir_start)
    struct.pack_into("<I", header, 56, 4096)           # mini cutoff
    struct.pack_into("<I", header, 60, ENDOFCHAIN)     # no mini FAT
    struct.pack_into("<I", header, 64, 0)
    struct.pack_into("<I", header, 68, ENDOFCHAIN)     # no DIFAT overflow
    struct.pack_into("<I", header, 72, 0)
    for i in range(109):
        struct.pack_into("<I", header, 76 + i * 4,
                         i if i < fat_sector_count else FREESECT)
    return bytes(header) + b"".join(sectors)


# ------------------------------------------------------------------- fixture
VBA_SOURCE = """Attribute VB_Name = "RibbonCallbacks"
Option Explicit

Public gRibbon As IRibbonUI

Public Sub RibbonOnLoad(ribbon As IRibbonUI)
    Set gRibbon = ribbon
End Sub

Public Sub OnBuildReport(control As IRibbonControl)
    MsgBox "building"
End Sub

Private Sub OnQuick(control As IRibbonControl)
    MsgBox control.Tag
End Sub

Public Function HelperTotal(a As Long, b As Long) As Long
    HelperTotal = a + b
End Function

Public Sub GetVerbose(control As IRibbonControl, ByRef returnedVal)
    returnedVal = True
End Sub
"""

SHEET_SOURCE = """Attribute VB_Name = "Sheet1"
Private Sub Worksheet_Change(ByVal Target As Range)
End Sub
"""


def build_vba_project(extra_modules=None) -> bytes:
    modules = {"RibbonCallbacks": VBA_SOURCE, "Sheet1": SHEET_SOURCE}
    modules.update(extra_modules or {})
    perf_cache = b"\x00" * 32                       # bytes before the source text
    streams: Dict[str, bytes] = {}
    dir_modules = []
    for name, source in modules.items():
        body = perf_cache + compress_raw(source.encode("cp1252"))
        streams[name] = body
        dir_modules.append((name, name, len(perf_cache)))
    streams["dir"] = compress_raw(build_dir_stream(dir_modules))
    streams["PROJECT"] = (
        'Name="RibbonForgeDemo"\r\n'
        'Module=RibbonCallbacks\r\n'
        'Document=Sheet1/&H00000000\r\n'
    ).encode("cp1252")
    return build_cfb(streams)


if __name__ == "__main__":
    import sys
    data = build_vba_project()
    with open(sys.argv[1] if len(sys.argv) > 1 else "vbaProject.bin", "wb") as fh:
        fh.write(data)
    print(f"wrote {len(data)} bytes")
