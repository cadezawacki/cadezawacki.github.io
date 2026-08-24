@echo off
REM Launch RibbonForge with the Python 3.11 launcher, falling back to whatever
REM "python" resolves to. Pass a workbook path to open it straight away.
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
    start "" pyw -3.11 "%~dp0run_ribbon_editor.pyw" %*
) else (
    start "" pythonw "%~dp0run_ribbon_editor.pyw" %*
)
endlocal
