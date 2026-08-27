"""Real Office icon artwork for the gallery and preview.

The app ships with the complete list of ``imageMso`` identifiers (3,244 of
them) but not with Microsoft's artwork.  The BERT project publishes a
reference sprite sheet of the real 16x16 icons; a one-click download in the
icon gallery fetches it (about 300 KB) into the user's settings folder, and
from then on every icon in the editor is the genuine article.

Everything here degrades gracefully: no pack, no Pillow, no network - the
vector stand-ins take over.
"""

from __future__ import annotations

import os
import ssl
import threading
import urllib.request
from typing import Callable, Dict, Optional

from .settings import config_dir

SPRITE_URL = "https://bert-toolkit.com/img/mso-composite-16.png"
SPRITE_SOURCE = "bert-toolkit.com"
CELL = 16
_MIN_BYTES = 50_000          # sanity floor - a 404 page is far smaller
_MAX_BYTES = 8_000_000

_INDEX: Optional[Dict[str, int]] = None
_index_lock = threading.Lock()


def _data_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "data", "imagemso_index.txt")


def load_index() -> Dict[str, int]:
    """name -> row number in the sprite strip (cached)."""
    global _INDEX
    with _index_lock:
        if _INDEX is not None:
            return _INDEX
        index: Dict[str, int] = {}
        try:
            with open(_data_path(), "r", encoding="utf-8") as handle:
                for line in handle:
                    parts = line.split()
                    if len(parts) == 2:
                        try:
                            index[parts[0]] = int(parts[1])
                        except ValueError:
                            continue
        except OSError:
            pass
        _INDEX = index
        return index


def all_names() -> list:
    return sorted(load_index())


def pack_dir() -> str:
    return os.path.join(config_dir(), "msoicons")


def sprite_path() -> str:
    return os.path.join(pack_dir(), "mso-composite-16.png")


def is_installed() -> bool:
    try:
        return os.path.getsize(sprite_path()) >= _MIN_BYTES
    except OSError:
        return False


def download(progress: Optional[Callable[[str], None]] = None) -> str:
    """Fetch the sprite sheet. Returns the cached path; raises OSError on failure."""
    if progress:
        progress(f"Downloading icon pack from {SPRITE_SOURCE} ...")
    request = urllib.request.Request(SPRITE_URL, headers={"User-Agent": "RibbonForge"})
    context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, timeout=60, context=context) as response:
            data = response.read(_MAX_BYTES + 1)
    except Exception as exc:  # URLError, ssl errors, timeouts
        raise OSError(f"Could not download the icon pack:\n{exc}") from exc
    if not (_MIN_BYTES <= len(data) <= _MAX_BYTES) or not data.startswith(b"\x89PNG"):
        raise OSError("The downloaded file does not look like the icon sprite sheet.")
    os.makedirs(pack_dir(), exist_ok=True)
    tmp = sprite_path() + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, sprite_path())
    if progress:
        progress("Icon pack installed.")
    return sprite_path()


def harvest_dir() -> str:
    """32 px PNGs harvested from the user's own Office via the Excel bridge."""
    return os.path.join(config_dir(), "msoicons32")


class IconPack:
    """Per-name Tk images: harvested 32 px art first, then the 16 px sprite."""

    def __init__(self) -> None:
        self.index = load_index()
        self._pil = None            # PIL.Image of the full strip
        self._strip = None          # tk.PhotoImage of the full strip (no-Pillow path)
        self._cache: Dict[tuple, object] = {}
        self._failed = False
        self._harvested: Optional[set] = None

    def _harvest_names(self) -> set:
        if self._harvested is None:
            try:
                self._harvested = {name[:-4] for name in os.listdir(harvest_dir())
                                   if name.endswith(".png")}
            except OSError:
                self._harvested = set()
        return self._harvested

    @property
    def available(self) -> bool:
        return (not self._failed and is_installed() and bool(self.index)) \
            or bool(self._harvest_names())

    def is_harvested(self, name: str) -> bool:
        return name in self._harvest_names()

    def has(self, name: str) -> bool:
        if name in self._harvest_names():
            return True
        return not self._failed and is_installed() and name in self.index

    def forget(self) -> None:
        self._pil = None
        self._strip = None
        self._cache.clear()
        self._failed = False
        self._harvested = None

    def _ensure_loaded(self) -> bool:
        if self._failed:
            return False
        if self._pil is not None or self._strip is not None:
            return True
        try:
            from PIL import Image  # type: ignore
            self._pil = Image.open(sprite_path()).convert("RGB")
            return True
        except ImportError:
            pass
        except Exception:
            self._failed = True
            return False
        try:
            import tkinter as tk
            self._strip = tk.PhotoImage(file=sprite_path())
            return True
        except Exception:
            self._failed = True
            return False

    def icon(self, name: str, size: int = 16):
        """A Tk image for ``name`` at roughly ``size`` px, or None."""
        size = 32 if size >= 24 else 16
        key = (name, size)
        if key in self._cache:
            return self._cache[key]
        harvested = self._load_harvested(name, size)
        if harvested is not None:
            self._cache[key] = harvested
            return harvested
        row = self.index.get(name)
        if row is None or not self._ensure_loaded():
            return None
        image = None
        try:
            if self._pil is not None:
                from PIL import Image, ImageTk  # type: ignore
                crop = self._pil.crop((0, row * CELL, CELL, (row + 1) * CELL))
                if size != CELL:
                    crop = crop.resize((size, size), Image.NEAREST)
                image = ImageTk.PhotoImage(crop)
            elif self._strip is not None:
                import tkinter as tk
                cell = tk.PhotoImage(width=CELL, height=CELL)
                cell.tk.call(cell, "copy", self._strip,
                             "-from", 0, row * CELL, CELL, (row + 1) * CELL,
                             "-to", 0, 0)
                image = cell.zoom(2, 2) if size != CELL else cell
        except Exception:
            self._failed = True
            return None
        if image is not None:
            self._cache[key] = image
        return image


    def _load_harvested(self, name: str, size: int):
        if name not in self._harvest_names():
            return None
        path = os.path.join(harvest_dir(), name + ".png")
        try:
            try:
                from PIL import Image, ImageTk  # type: ignore
                img = Image.open(path).convert("RGBA")
                if img.width != size:
                    img = img.resize((size, size),
                                     Image.LANCZOS if size < img.width else Image.NEAREST)
                return ImageTk.PhotoImage(img)
            except ImportError:
                import tkinter as tk
                photo = tk.PhotoImage(file=path)
                if photo.width() > size:
                    photo = photo.subsample(max(1, photo.width() // size))
                return photo
        except Exception:
            return None


_pack: Optional[IconPack] = None


def pack() -> IconPack:
    global _pack
    if _pack is None:
        _pack = IconPack()
    return _pack
