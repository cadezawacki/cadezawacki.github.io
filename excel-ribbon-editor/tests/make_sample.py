"""Build a small but structurally valid .xlsm used by the test suite."""
from __future__ import annotations
import os, struct, sys, zipfile, zlib

HERE = os.path.dirname(os.path.abspath(__file__))

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>'''

ROOT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''

WORKBOOK = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'''

WB_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>'''

SHEET = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'''

CUSTOMUI14 = '''<?xml version="1.0" encoding="UTF-8"?>
<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui" onLoad="RibbonOnLoad">
  <ribbon>
    <tabs>
      <tab id="rfDemoTab" label="Reporting" insertBeforeMso="TabView">
        <group id="rfDemoRun" label="Run">
          <button id="rfDemoBuild" label="Build report" imageMso="MacroPlay" size="large"
                  screentip="Build the monthly report"
                  supertip="Reads the data sheet and writes a formatted summary."
                  onAction="OnBuildReport"/>
          <button id="rfDemoRefresh" label="Refresh data" imageMso="RefreshAll" size="large"
                  onAction="OnRefreshData"/>
          <separator id="rfDemoSep"/>
          <buttonGroup id="rfDemoQuick">
            <button id="rfDemoCopy" label="Copy" imageMso="Copy" onAction="OnQuick" tag="copy"/>
            <button id="rfDemoPaste" label="Paste" imageMso="Paste" onAction="OnQuick" tag="paste"/>
          </buttonGroup>
        </group>
        <group id="rfDemoOptions" label="Options">
          <box id="rfDemoBox" boxStyle="vertical">
            <checkBox id="rfDemoVerbose" label="Verbose log" getPressed="GetVerbose" onAction="OnVerbose"/>
            <comboBox id="rfDemoScope" label="Scope" sizeString="WWWWWWWWWW"
                      getItemCount="GetScopeCount" getItemLabel="GetScopeLabel" onChange="OnScope"/>
            <editBox id="rfDemoFilter" label="Filter" sizeString="WWWWWWWWWW" onChange="OnFilter"/>
          </box>
          <menu id="rfDemoMenu" label="Export" imageMso="ExportExcel" size="large" itemSize="large">
            <button id="rfDemoCsv" label="As CSV" imageMso="ExportTextFile"
                    description="Comma separated, one row per record." onAction="OnExport" tag="csv"/>
            <button id="rfDemoPdf" label="As PDF" imageMso="FileSaveAsPdfOrXps"
                    description="Printable summary." onAction="OnExport" tag="pdf"/>
          </menu>
          <dialogBoxLauncher>
            <button id="rfDemoSettings" screentip="Report settings" onAction="OnSettings"/>
          </dialogBoxLauncher>
        </group>
      </tab>
    </tabs>
  </ribbon>
  <contextMenus>
    <contextMenu idMso="ContextMenuCell">
      <menuSeparator id="rfCtxSep" insertBeforeMso="Cut"/>
      <button id="rfCtxSend" label="Send to report" imageMso="Forward"
              insertBeforeMso="Cut" onAction="OnSendToReport"/>
    </contextMenu>
  </contextMenus>
  <backstage>
    <tab id="rfBsTab" label="Reporting" columnWidthPercent="45" title="Reporting">
      <firstColumn>
        <group id="rfBsGroup" label="Actions" helperText="What this workbook can do.">
          <primaryItem>
            <button id="rfBsRun" label="Build the report" imageMso="MacroPlay"
                    isDefinitive="true" onAction="OnBuildReport"/>
          </primaryItem>
          <topItems>
            <labelControl id="rfBsNote" label="Last run: never"/>
            <hyperlink id="rfBsHelp" label="Open the handbook" target="https://example.com"/>
          </topItems>
        </group>
      </firstColumn>
    </tab>
  </backstage>
</customUI>'''

CUSTOMUI_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="logo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="images/logo.png"/>
</Relationships>'''


def make_png(size=32, rgba=(47, 162, 106, 255)) -> bytes:
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))
    raw = b""
    for y in range(size):
        raw += b"\x00"
        for x in range(size):
            edge = x < 2 or y < 2 or x > size - 3 or y > size - 3
            raw += bytes((255, 255, 255, 255) if edge else rgba)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def build(path: str, with_ribbon: bool = True) -> str:
    entries = {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": ROOT_RELS,
        "xl/workbook.xml": WORKBOOK,
        "xl/_rels/workbook.xml.rels": WB_RELS,
        "xl/worksheets/sheet1.xml": SHEET,
    }
    if with_ribbon:
        rels = ROOT_RELS.replace(
            "</Relationships>",
            '<Relationship Id="customUIRel1" '
            'Type="http://schemas.microsoft.com/office/2007/relationships/ui/extensibility" '
            'Target="customUI/customUI14.xml"/></Relationships>')
        entries["_rels/.rels"] = rels
        entries["customUI/customUI14.xml"] = CUSTOMUI14
        entries["customUI/_rels/customUI14.xml.rels"] = CUSTOMUI_RELS
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in entries.items():
            zf.writestr(name, body)
        if with_ribbon:
            zf.writestr("customUI/images/logo.png", make_png())
    return path


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "sample.xlsm")
    build(out)
    build(out.replace(".xlsm", "_plain.xlsm"), with_ribbon=False)
    print("wrote", out)
