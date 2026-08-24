"""Double-click launcher for Windows (no console window).

Keeping this next to the package means the editor can be started without
installing anything: right-click > Open with > Python, or just double-click
if .pyw is associated with pythonw.exe.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ribbonforge.app import main  # noqa: E402  (path set up first)

if __name__ == "__main__":
    sys.exit(main())
