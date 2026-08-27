"""Ribbon Time Machine: automatic snapshots of every part on every save."""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from typing import List, Optional

from .settings import config_dir

KEEP = 60


@dataclass
class Snapshot:
    path: str
    variant: str
    timestamp: float
    size: int

    @property
    def when(self) -> str:
        delta = time.time() - self.timestamp
        if delta < 90:
            return "just now"
        if delta < 3600:
            return f"{int(delta // 60)} min ago"
        if delta < 86400:
            return f"{int(delta // 3600)} h ago"
        if delta < 14 * 86400:
            return f"{int(delta // 86400)} d ago"
        return time.strftime("%d %b %Y", time.localtime(self.timestamp))

    @property
    def stamp(self) -> str:
        return time.strftime("%d %b %Y  %H:%M:%S", time.localtime(self.timestamp))

    def read(self) -> str:
        with open(self.path, "r", encoding="utf-8") as handle:
            return handle.read()


def _folder(document_path: str) -> str:
    digest = hashlib.sha1(os.path.normcase(os.path.abspath(document_path))
                          .encode("utf-8")).hexdigest()[:16]
    return os.path.join(config_dir(), "history", digest)


def record(document_path: str, variant: str, xml: str) -> Optional[str]:
    """Store one snapshot; returns its path (or None when unchanged/failed)."""
    if not document_path:
        return None
    folder = _folder(document_path)
    try:
        os.makedirs(folder, exist_ok=True)
        marker = os.path.join(folder, "source.json")
        if not os.path.exists(marker):
            with open(marker, "w", encoding="utf-8") as handle:
                json.dump({"path": os.path.abspath(document_path)}, handle)
        existing = snapshots(document_path, variant)
        if existing and existing[0].read() == xml:
            return existing[0].path                    # identical - skip
        name = f"{time.strftime('%Y%m%d-%H%M%S')}-{variant}.xml"
        target = os.path.join(folder, name)
        counter = 1
        while os.path.exists(target):
            target = os.path.join(folder, f"{name[:-4]}-{counter}.xml")
            counter += 1
        with open(target, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(xml)
        _prune(folder, variant)
        return target
    except OSError:
        return None


def _prune(folder: str, variant: str) -> None:
    entries = sorted(
        (name for name in os.listdir(folder)
         if name.endswith(f"-{variant}.xml") or f"-{variant}-" in name),
        reverse=True)
    for stale in entries[KEEP:]:
        try:
            os.remove(os.path.join(folder, stale))
        except OSError:
            pass


def snapshots(document_path: str, variant: str) -> List[Snapshot]:
    """Newest first."""
    folder = _folder(document_path)
    result: List[Snapshot] = []
    try:
        names = os.listdir(folder)
    except OSError:
        return result
    for name in names:
        if not name.endswith(".xml"):
            continue
        stem = name[:-4]
        parts = stem.split("-")
        if variant not in parts:
            continue
        full = os.path.join(folder, name)
        try:
            stat = os.stat(full)
        except OSError:
            continue
        result.append(Snapshot(full, variant, stat.st_mtime, stat.st_size))
    result.sort(key=lambda snap: snap.timestamp, reverse=True)
    return result
