"""Excel Live Bridge: drive a running Excel through COM, with no dependencies.

Every Windows box with Office also has PowerShell, and PowerShell speaks COM
natively.  RibbonForge builds a small script per action, runs it hidden, and
reads a single JSON object back.  That unlocks things an external editor
normally cannot do:

* **Test in Excel** - save, then close and reopen the workbook inside the
  running Excel so the ribbon you just designed appears in seconds.
* **Inject the callbacks** - import the generated .bas module directly into
  the workbook's VBA project (requires the user's own "Trust access to the
  VBA project object model" setting, which is detected and explained).
* **Harvest icons** - ask Office itself for any ``imageMso`` at 32 px via
  ``CommandBars.GetImageMso`` and cache the PNGs, alpha channel intact.

Everything degrades cleanly: on non-Windows machines, or without Office,
``probe()`` simply reports what is missing and the UI says so.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from .settings import config_dir
from .winplatform import IS_WINDOWS

TIMEOUT_QUICK = 30
TIMEOUT_LONG = 600


class BridgeError(Exception):
    """A bridge action failed; the message is already user-readable."""


@dataclass
class BridgeStatus:
    available: bool
    excel_installed: bool = False
    excel_running: bool = False
    vbom_trusted: bool = False
    excel_version: str = ""
    detail: str = ""


def powershell_exe() -> Optional[str]:
    """The PowerShell to use, or None when the bridge cannot run."""
    override = os.environ.get("RIBBONFORGE_POWERSHELL")
    if override:
        return override
    if not IS_WINDOWS:
        return None
    root = os.environ.get("SystemRoot", r"C:\Windows")
    candidate = os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return candidate if os.path.isfile(candidate) else "powershell.exe"


def _run(script: str, timeout: int = TIMEOUT_QUICK) -> Dict:
    exe = powershell_exe()
    if exe is None:
        raise BridgeError("The Excel bridge needs Windows with PowerShell available.")
    creation = 0
    if IS_WINDOWS:
        creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False,
                                     encoding="utf-8-sig") as handle:
        handle.write(script)
        script_path = handle.name
    try:
        completed = subprocess.run(
            [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-STA", "-File", script_path],
            capture_output=True, text=True, timeout=timeout, creationflags=creation)
    except FileNotFoundError as exc:
        raise BridgeError(f"PowerShell was not found ({exe}).") from exc
    except subprocess.TimeoutExpired as exc:
        raise BridgeError("Excel did not answer in time - is a dialog box open in it?") from exc
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    stdout = (completed.stdout or "").strip()
    start = stdout.find("{")
    end = stdout.rfind("}")
    if start == -1 or end <= start:
        detail = stdout or (completed.stderr or "").strip() or "no output"
        raise BridgeError(f"The bridge script produced no result:\n{detail[:500]}")
    try:
        result = json.loads(stdout[start:end + 1])
    except ValueError as exc:
        raise BridgeError(f"Could not read the bridge result:\n{stdout[:500]}") from exc
    if not result.get("ok"):
        raise BridgeError(result.get("error") or "The bridge action failed.")
    return result


_COMMON = r'''
$ErrorActionPreference = "Stop"
function Out-Result($obj) { $obj | ConvertTo-Json -Compress -Depth 5 | Write-Output }
function Get-Excel([bool]$createIfMissing) {
    try { return [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application") }
    catch { }
    if ($createIfMissing) { return New-Object -ComObject Excel.Application }
    return $null
}
'''


# ------------------------------------------------------------------- actions
def probe() -> BridgeStatus:
    """What can the bridge do on this machine right now?"""
    if powershell_exe() is None:
        return BridgeStatus(False, detail="Available on Windows with Office installed.")
    script = _COMMON + r'''
$installed = $false; $running = $false; $version = ""; $trusted = $false
try {
    $key = Get-ItemProperty -Path "Registry::HKEY_CLASSES_ROOT\Excel.Application\CurVer" -ErrorAction Stop
    $installed = $true
} catch { }
try {
    $app = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
    $running = $true; $installed = $true; $version = [string]$app.Version
} catch { }
if ($installed -and -not $version) {
    try { $version = ($key."(default)" -replace "Excel.Application\.", "") + ".0" } catch { }
}
if ($version) {
    try {
        $sec = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Office\$version\Excel\Security" -ErrorAction Stop
        if ($sec.AccessVBOM -eq 1) { $trusted = $true }
    } catch { }
}
Out-Result @{ ok = $true; installed = $installed; running = $running;
              version = $version; vbom = $trusted }
'''
    try:
        result = _run(script, TIMEOUT_QUICK)
    except BridgeError as exc:
        return BridgeStatus(False, detail=str(exc))
    return BridgeStatus(
        available=bool(result.get("installed")),
        excel_installed=bool(result.get("installed")),
        excel_running=bool(result.get("running")),
        vbom_trusted=bool(result.get("vbom")),
        excel_version=str(result.get("version") or ""),
        detail="" if result.get("installed") else "Excel does not appear to be installed.",
    )


def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def test_in_excel(path: str) -> Dict:
    """(Re)open the workbook in Excel so the freshly saved ribbon loads."""
    script = _COMMON + f'''
$path = {_ps_quote(os.path.abspath(path))}
$name = [System.IO.Path]::GetFileName($path)
$app = Get-Excel $true
$app.Visible = $true
foreach ($wb in @($app.Workbooks)) {{
    if ($wb.Name -ieq $name) {{ $wb.Close($false) ; break }}
}}
$wb = $app.Workbooks.Open($path)
$app.WindowState = -4137        # xlMaximized
try {{ $app.ActivateMicrosoftApp(0) | Out-Null }} catch {{ }}
Out-Result @{{ ok = $true; opened = $wb.Name; excel = [string]$app.Version }}
'''
    return _run(script, TIMEOUT_LONG)


def inject_vba(path: str, bas_path: str, module_name: str) -> Dict:
    """Import (replacing) a .bas module into the workbook's VBA project."""
    script = _COMMON + f'''
$path = {_ps_quote(os.path.abspath(path))}
$bas = {_ps_quote(os.path.abspath(bas_path))}
$module = {_ps_quote(module_name)}
$name = [System.IO.Path]::GetFileName($path)
$app = Get-Excel $true
$started = $false
$wb = $null
foreach ($candidate in @($app.Workbooks)) {{
    if ($candidate.Name -ieq $name) {{ $wb = $candidate; break }}
}}
if ($wb -eq $null) {{ $wb = $app.Workbooks.Open($path); $started = $true }}
try {{
    $project = $wb.VBProject
}} catch {{
    Out-Result @{{ ok = $false; error = "Excel blocked access to the VBA project. Enable File > Options > Trust Center > Trust Center Settings > Macro Settings > 'Trust access to the VBA project object model', then try again." }}
    exit 0
}}
foreach ($component in @($project.VBComponents)) {{
    if ($component.Name -ieq $module) {{ $project.VBComponents.Remove($component); break }}
}}
$imported = $project.VBComponents.Import($bas)
$wb.Save()
Out-Result @{{ ok = $true; module = $imported.Name; workbook = $wb.Name;
               closed = $false }}
'''
    return _run(script, TIMEOUT_LONG)


def harvest_icons(names: List[str], out_dir: str, size: int = 32) -> Dict:
    """Ask Office for real imageMso artwork and cache PNGs (alpha preserved)."""
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                     encoding="utf-8") as handle:
        handle.write("\n".join(names))
        names_path = handle.name
    script = _COMMON + f'''
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class MsoIcon {{
    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int c, ref BITMAP b);
    [DllImport("gdi32.dll")] static extern int GetBitmapBits(IntPtr h, int c, byte[] b);
    [StructLayout(LayoutKind.Sequential)]
    struct BITMAP {{ public int bmType, bmWidth, bmHeight, bmWidthBytes;
                     public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }}
    public static Bitmap FromHandle(IntPtr hbitmap) {{
        BITMAP bm = new BITMAP();
        GetObject(hbitmap, Marshal.SizeOf(typeof(BITMAP)), ref bm);
        if (bm.bmBitsPixel != 32) return Image.FromHbitmap(hbitmap);
        int bytes = bm.bmWidthBytes * bm.bmHeight;
        byte[] buffer = new byte[bytes];
        GetBitmapBits(hbitmap, bytes, buffer);
        Bitmap result = new Bitmap(bm.bmWidth, bm.bmHeight, PixelFormat.Format32bppArgb);
        BitmapData data = result.LockBits(new Rectangle(0, 0, bm.bmWidth, bm.bmHeight),
                                          ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        Marshal.Copy(buffer, 0, data.Scan0, bytes);
        result.UnlockBits(data);
        return result;
    }}
}}
"@
$namesPath = {_ps_quote(names_path)}
$outDir = {_ps_quote(os.path.abspath(out_dir))}
$size = {int(size)}
$app = Get-Excel $true
$startedHidden = -not $app.Visible
$saved = 0; $failed = 0
foreach ($name in Get-Content $namesPath) {{
    $name = $name.Trim()
    if (-not $name) {{ continue }}
    try {{
        $picture = $app.CommandBars.GetImageMso($name, $size, $size)
        $bitmap = [MsoIcon]::FromHandle([IntPtr]$picture.Handle)
        $bitmap.Save((Join-Path $outDir ($name + ".png")),
                     [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
        $saved++
    }} catch {{ $failed++ }}
}}
if ($startedHidden) {{ try {{ $app.Quit() }} catch {{ }} }}
Out-Result @{{ ok = $true; saved = $saved; failed = $failed }}
'''
    try:
        return _run(script, TIMEOUT_LONG)
    finally:
        try:
            os.unlink(names_path)
        except OSError:
            pass


def harvest_dir() -> str:
    return os.path.join(config_dir(), "msoicons32")


def run_async(action: Callable[[], Dict], done: Callable[[Optional[Dict], Optional[str]], None],
              widget) -> None:
    """Run a bridge action on a worker thread, delivering to the Tk thread."""
    import threading

    def worker() -> None:
        try:
            result = action()
            error = None
        except BridgeError as exc:
            result, error = None, str(exc)
        except Exception as exc:  # pragma: no cover - defensive
            result, error = None, f"{type(exc).__name__}: {exc}"
        try:
            widget.after(0, lambda: done(result, error))
        except Exception:
            pass

    threading.Thread(target=worker, daemon=True).start()
