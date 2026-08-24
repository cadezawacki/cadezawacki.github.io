"""Persisted user preferences and the recent-file list."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

APP_NAME = "RibbonForge"

DEFAULTS: Dict[str, Any] = {
    "theme": "dark",
    "accent": "excel",
    "editor_font": "Consolas",
    "editor_font_size": 11,
    "ui_font_size": 10,
    "indent": "  ",
    "wrap_attributes": True,
    "wrap_width": 100,
    "validate_as_you_type": True,
    "backup_on_save": True,
    "show_preview": True,
    "show_properties": True,
    "show_problems": True,
    "preview_zoom": 1.0,
    "recent": [],
    "geometry": "",
    "sash_tree": 300,
    "sash_props": 340,
    "sash_problems": 190,
    "callback_module": "RibbonCallbacks",
    "callback_pointer_recovery": False,
    "strict_imagemso": False,
    "confirm_overwrite_office": True,
}

MAX_RECENT = 12


def config_dir() -> str:
    base = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME")
    if not base:
        base = os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, APP_NAME)


def config_path() -> str:
    return os.path.join(config_dir(), "settings.json")


class Settings:
    def __init__(self) -> None:
        self._data: Dict[str, Any] = dict(DEFAULTS)
        self.load()

    # ------------------------------------------------------------------ io
    def load(self) -> None:
        try:
            with open(config_path(), "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                for key, value in stored.items():
                    if key in DEFAULTS and isinstance(value, type(DEFAULTS[key])):
                        self._data[key] = value
                    elif key in DEFAULTS and isinstance(DEFAULTS[key], float):
                        try:
                            self._data[key] = float(value)
                        except (TypeError, ValueError):
                            pass
        except (OSError, ValueError):
            pass

    def save(self) -> None:
        try:
            os.makedirs(config_dir(), exist_ok=True)
            with open(config_path(), "w", encoding="utf-8") as handle:
                json.dump(self._data, handle, indent=2)
        except OSError:
            pass

    # --------------------------------------------------------------- access
    def __getitem__(self, key: str) -> Any:
        return self._data.get(key, DEFAULTS.get(key))

    def __setitem__(self, key: str, value: Any) -> None:
        self._data[key] = value

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, DEFAULTS.get(key, default))

    def set(self, key: str, value: Any) -> None:
        self._data[key] = value

    def as_dict(self) -> Dict[str, Any]:
        return dict(self._data)

    # ---------------------------------------------------------------- recent
    @property
    def recent(self) -> List[str]:
        return [p for p in self._data.get("recent", []) if isinstance(p, str)]

    def push_recent(self, path: str) -> None:
        if not path:
            return
        path = os.path.abspath(path)
        items = [p for p in self.recent if os.path.normcase(p) != os.path.normcase(path)]
        items.insert(0, path)
        self._data["recent"] = items[:MAX_RECENT]

    def drop_recent(self, path: str) -> None:
        self._data["recent"] = [
            p for p in self.recent if os.path.normcase(p) != os.path.normcase(path)
        ]

    def clear_recent(self) -> None:
        self._data["recent"] = []
