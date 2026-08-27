"""Platform detection.

RibbonForge targets Windows; the X11-specific Tk event names
(``<Button-4>``/``<Button-5>`` wheel events) and Unix openers exist only so
the automated test suite can drive the app headless on a Linux CI box.  On
Windows none of them are ever bound.
"""

from __future__ import annotations

import sys

IS_WINDOWS = sys.platform.startswith("win")

# Wheel events differ per windowing system: Windows/macOS deliver
# <MouseWheel>, X11 delivers Button-4/5. Bind only what this platform uses.
WHEEL_SEQUENCES = ("<MouseWheel>",) if IS_WINDOWS else ("<MouseWheel>", "<Button-4>", "<Button-5>")
