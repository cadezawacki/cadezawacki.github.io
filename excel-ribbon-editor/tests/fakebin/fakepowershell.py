#!/usr/bin/env python3
"""Stands in for powershell.exe in tests: inspects the generated script and
answers with the JSON the real bridge would produce."""
import json
import re
import sys


def main() -> int:
    args = sys.argv[1:]
    if "-File" not in args:
        print(json.dumps({"ok": False, "error": "no -File"}))
        return 0
    script = open(args[args.index("-File") + 1], encoding="utf-8-sig").read()

    if "AccessVBOM" in script:                      # probe
        print(json.dumps({"ok": True, "installed": True, "running": True,
                          "version": "16.0", "vbom": True}))
    elif "GetImageMso" in script:                   # harvest
        names_match = re.search(r"\$namesPath = '([^']+)'", script)
        out_match = re.search(r"\$outDir = '([^']+)'", script)
        names = [line.strip() for line in open(names_match.group(1), encoding="utf-8")
                 if line.strip()]
        import os
        os.makedirs(out_match.group(1), exist_ok=True)
        # 1x1 transparent PNG
        png = bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
            "1f15c4890000000d49444154789c6360000002000100e221bc330000000049454e44ae426082")
        for name in names:
            with open(os.path.join(out_match.group(1), name + ".png"), "wb") as fh:
                fh.write(png)
        print(json.dumps({"ok": True, "saved": len(names), "failed": 0}))
    elif "VBComponents.Import" in script:           # inject
        if "'RibbonCallbacks'" not in script:
            print(json.dumps({"ok": False, "error": "unexpected module name"}))
        else:
            print(json.dumps({"ok": True, "module": "RibbonCallbacks",
                              "workbook": "sample.xlsm", "closed": False}))
    elif "Workbooks.Open" in script:                # test in excel
        path_match = re.search(r"\$path = '([^']+)'", script)
        print(json.dumps({"ok": True, "opened": path_match.group(1).split("/")[-1],
                          "excel": "16.0"}))
    else:
        print(json.dumps({"ok": False, "error": "unrecognised script"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
