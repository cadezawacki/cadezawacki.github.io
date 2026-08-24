"""Console launcher - identical to the .pyw entry point but keeps a terminal
around so tracebacks stay visible."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ribbonforge.app import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
