"""Ready-made CustomUI fragments used by the New / Insert snippet menus."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from .ooxml import NAMESPACE_FOR


@dataclass(frozen=True)
class Template:
    key: str
    title: str
    summary: str
    category: str
    body: str          # inner XML, {ns} placeholder free
    glyph: str = "▤"


def starter_xml(variant: str, body: str = "", on_load: bool = True) -> str:
    ns = NAMESPACE_FOR[variant]
    attrs = f'xmlns="{ns}"'
    if on_load:
        attrs += ' onLoad="RibbonOnLoad"'
    inner = body.strip("\n") or _DEFAULT_BODY
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f"<customUI {attrs}>\n{inner}\n</customUI>\n"
    )


_DEFAULT_BODY = """  <ribbon>
    <tabs>
      <tab id="rfTab" label="My Tools" insertBeforeMso="TabView">
        <group id="rfGroup" label="Actions">
          <button id="rfButtonRun" label="Run"
                  imageMso="MacroPlay" size="large"
                  screentip="Run the macro"
                  supertip="Executes the main routine of this workbook."
                  onAction="OnRun"/>
          <button id="rfButtonRefresh" label="Refresh"
                  imageMso="RefreshAll" size="large"
                  onAction="OnRefresh"/>
        </group>
      </tab>
    </tabs>
  </ribbon>"""


TEMPLATES: List[Template] = [
    Template(
        key="blank",
        title="Empty custom UI",
        summary="Just the customUI root element - start from a clean sheet.",
        category="Starters",
        glyph="▢",
        body="  <ribbon>\n    <tabs>\n    </tabs>\n  </ribbon>",
    ),
    Template(
        key="starter",
        title="Custom tab with two buttons",
        summary="The classic starting point: your own tab, one group, two large buttons.",
        category="Starters",
        glyph="▤",
        body=_DEFAULT_BODY,
    ),
    Template(
        key="toolbelt",
        title="Full toolbelt tab",
        summary="Every common control type in one tab - buttons, toggle, menu, gallery, combo, edit box.",
        category="Starters",
        glyph="✦",
        body="""  <ribbon>
    <tabs>
      <tab id="rfToolbelt" label="Toolbelt" insertBeforeMso="TabView">
        <group id="rfGrpMain" label="Main">
          <button id="rfRun" label="Run" imageMso="MacroPlay" size="large" onAction="OnRun"/>
          <toggleButton id="rfWatch" label="Watch" imageMso="WatchWindow" size="large"
                        getPressed="GetWatching" onAction="OnWatch"/>
          <separator id="rfSep1"/>
          <buttonGroup id="rfQuick">
            <button id="rfCopy" label="Copy" imageMso="Copy" onAction="OnQuick" tag="copy"/>
            <button id="rfPaste" label="Paste" imageMso="Paste" onAction="OnQuick" tag="paste"/>
            <button id="rfClear" label="Clear" imageMso="ClearFormats" onAction="OnQuick" tag="clear"/>
          </buttonGroup>
        </group>
        <group id="rfGrpChoose" label="Choose">
          <box id="rfBox" boxStyle="vertical">
            <comboBox id="rfCombo" label="Scope" sizeString="WWWWWWWWWW"
                      getItemCount="GetItemCount" getItemLabel="GetItemLabel"
                      getText="GetComboText" onChange="OnComboChange"/>
            <dropDown id="rfDrop" label="Mode"
                      getItemCount="GetItemCount" getItemLabel="GetItemLabel"
                      getSelectedItemIndex="GetSelectedIndex" onAction="OnDropDown"/>
            <editBox id="rfEdit" label="Filter" sizeString="WWWWWWWWWW"
                     getText="GetFilterText" onChange="OnFilterChange"/>
          </box>
          <checkBox id="rfCheck" label="Verbose logging"
                    getPressed="GetVerbose" onAction="OnVerbose"/>
        </group>
        <group id="rfGrpMore" label="More">
          <menu id="rfMenu" label="Reports" imageMso="CreateReport" size="large" itemSize="large">
            <button id="rfRepDaily" label="Daily" imageMso="CalendarInsert"
                    description="Build the daily summary sheet." onAction="OnReport" tag="daily"/>
            <button id="rfRepWeekly" label="Weekly" imageMso="DateAndTimeInsert"
                    description="Build the weekly roll-up." onAction="OnReport" tag="weekly"/>
            <menuSeparator id="rfMenuSep" title="Advanced"/>
            <button id="rfRepCustom" label="Custom..." imageMso="CreateReportInDesignView"
                    description="Choose your own date range." onAction="OnReport" tag="custom"/>
          </menu>
          <splitButton id="rfSplit" size="large">
            <button id="rfSplitMain" label="Export" imageMso="ExportExcel" onAction="OnExport"/>
            <menu id="rfSplitMenu">
              <button id="rfExportCsv" label="As CSV" imageMso="ExportTextFile" onAction="OnExport" tag="csv"/>
              <button id="rfExportPdf" label="As PDF" imageMso="FileSaveAsPdfOrXps" onAction="OnExport" tag="pdf"/>
            </menu>
          </splitButton>
          <gallery id="rfGallery" label="Palette" imageMso="ThemeColorsGallery" size="large"
                   columns="4" itemWidth="32" itemHeight="32"
                   getItemCount="GetItemCount" getItemImage="GetItemImage"
                   getItemLabel="GetItemLabel" onAction="OnGallery"/>
          <dialogBoxLauncher>
            <button id="rfLauncher" screentip="Settings" onAction="OnSettings"/>
          </dialogBoxLauncher>
        </group>
      </tab>
    </tabs>
  </ribbon>""",
    ),
    Template(
        key="extend-home",
        title="Add a group to the Home tab",
        summary="Leaves Excel's ribbon intact and slots your group in after Editing.",
        category="Starters",
        glyph="＋",
        body="""  <ribbon>
    <tabs>
      <tab idMso="TabHome">
        <group id="rfHomeExtras" label="My Extras" insertAfterMso="GroupEditingExcel">
          <button id="rfHomeRun" label="Run" imageMso="MacroPlay" size="large" onAction="OnRun"/>
        </group>
      </tab>
    </tabs>
  </ribbon>""",
    ),
    Template(
        key="scratch",
        title="Kiosk mode (start from scratch)",
        summary="Hides every built-in tab and shows only your own - handy for locked-down tools.",
        category="Starters",
        glyph="▣",
        body="""  <ribbon startFromScratch="true">
    <qat>
      <sharedControls>
        <control idMso="FileSave" visible="true"/>
        <control idMso="Undo" visible="true"/>
      </sharedControls>
    </qat>
    <tabs>
      <tab id="rfOnlyTab" label="Workbook">
        <group id="rfOnlyGroup" label="Actions">
          <button id="rfOnlyRun" label="Run" imageMso="MacroPlay" size="large" onAction="OnRun"/>
          <button id="rfOnlyClose" label="Close" imageMso="FileClose" size="large" onAction="OnClose"/>
        </group>
      </tab>
    </tabs>
  </ribbon>""",
    ),
    Template(
        key="contextual",
        title="Extend a contextual tab set",
        summary="Adds a group to Chart Tools, shown only when a chart is selected.",
        category="Fragments",
        glyph="▭",
        body="""  <ribbon>
    <contextualTabs>
      <tabSet idMso="TabSetChartTools">
        <tab idMso="TabChartToolsDesign">
          <group id="rfChartExtras" label="My Chart Tools">
            <button id="rfChartTidy" label="Tidy up" imageMso="ChartTypeColumnInsertGallery"
                    size="large" onAction="OnTidyChart"/>
          </group>
        </tab>
      </tabSet>
    </contextualTabs>
  </ribbon>""",
    ),
    Template(
        key="repurpose",
        title="Repurpose built-in commands",
        summary="Intercept Save and Print, or disable them outright.",
        category="Fragments",
        glyph="⚙",
        body="""  <commands>
    <command idMso="FileSave" onAction="OnSaveIntercept"/>
    <command idMso="FilePrintQuick" enabled="false"/>
    <command idMso="Paste" onAction="OnPasteIntercept"/>
  </commands>
  <ribbon>
    <tabs/>
  </ribbon>""",
    ),
    Template(
        key="contextmenu",
        title="Right-click menu items (2010+)",
        summary="Adds your own commands to the cell context menu.",
        category="Fragments",
        glyph="☰",
        body="""  <contextMenus>
    <contextMenu idMso="ContextMenuCell">
      <menuSeparator id="rfCtxSep" insertBeforeMso="Cut"/>
      <button id="rfCtxAction" label="Send to my tool"
              imageMso="Forward" insertBeforeMso="Cut" onAction="OnContextAction"/>
      <menu id="rfCtxMenu" label="My tools" insertBeforeMso="Cut" imageMso="ListMacros">
        <button id="rfCtxA" label="Clean up" onAction="OnContextAction" tag="clean"/>
        <button id="rfCtxB" label="Validate" onAction="OnContextAction" tag="validate"/>
      </menu>
    </contextMenu>
  </contextMenus>
  <ribbon>
    <tabs/>
  </ribbon>""",
    ),
    Template(
        key="backstage",
        title="Backstage page (2010+)",
        summary="A File-tab page with a two-column layout, buttons and a link.",
        category="Fragments",
        glyph="◧",
        body="""  <backstage>
    <tab id="rfBackstageTab" label="My Tool" columnWidthPercent="40"
         insertAfterMso="TabInfo" title="My Tool">
      <firstColumn>
        <group id="rfBsGroup" label="Actions" helperText="Everything this workbook can do.">
          <primaryItem>
            <button id="rfBsRun" label="Run the process" imageMso="MacroPlay"
                    isDefinitive="true" onAction="OnRun"/>
          </primaryItem>
          <topItems>
            <labelControl id="rfBsNote" label="Last run: never"/>
            <hyperlink id="rfBsHelp" label="Open the handbook"
                       target="https://example.com/handbook"/>
          </topItems>
        </group>
      </firstColumn>
      <secondColumn>
        <group id="rfBsOptions" label="Options">
          <topItems>
            <checkBox id="rfBsVerbose" label="Verbose logging"
                      getPressed="GetVerbose" onAction="OnVerbose"/>
            <editBox id="rfBsPath" label="Output folder"
                     getText="GetOutputPath" onChange="OnOutputPath"/>
          </topItems>
        </group>
      </secondColumn>
    </tab>
  </backstage>
  <ribbon>
    <tabs/>
  </ribbon>""",
    ),
    Template(
        key="qat",
        title="Quick Access Toolbar",
        summary="Document-specific QAT buttons (requires startFromScratch).",
        category="Fragments",
        glyph="★",
        body="""  <ribbon startFromScratch="true">
    <qat>
      <sharedControls>
        <button idMso="FileSave" visible="true"/>
        <control idMso="Undo" visible="true"/>
      </sharedControls>
      <documentControls>
        <button id="rfQatRun" label="Run" imageMso="MacroPlay" onAction="OnRun"/>
      </documentControls>
    </qat>
    <tabs/>
  </ribbon>""",
    ),
    Template(
        key="dynamic",
        title="Dynamic menu",
        summary="A menu whose contents your VBA builds at drop time.",
        category="Fragments",
        glyph="☰",
        body="""  <ribbon>
    <tabs>
      <tab id="rfDynTab" label="Dynamic">
        <group id="rfDynGroup" label="Built at run time">
          <dynamicMenu id="rfDynMenu" label="Recent files" imageMso="RecentFileList"
                       size="large" getContent="GetRecentFilesMenu"
                       invalidateContentOnDrop="true"/>
        </group>
      </tab>
    </tabs>
  </ribbon>""",
    ),
]


SNIPPETS: Dict[str, str] = {
    "Tab": '<tab id="newTab" label="New Tab" insertBeforeMso="TabView">\n'
           '  <group id="newGroup" label="New Group">\n'
           '  </group>\n'
           '</tab>',
    "Group": '<group id="newGroup" label="New Group">\n</group>',
    "Large button": '<button id="newButton" label="Button" imageMso="HappyFace" size="large" onAction="OnAction"/>',
    "Small button": '<button id="newButton" label="Button" imageMso="HappyFace" onAction="OnAction"/>',
    "Toggle button": '<toggleButton id="newToggle" label="Toggle" imageMso="TableDesign" size="large"\n'
                     '              getPressed="GetPressed" onAction="OnToggle"/>',
    "Check box": '<checkBox id="newCheck" label="Enabled" getPressed="GetPressed" onAction="OnCheck"/>',
    "Edit box": '<editBox id="newEdit" label="Value" sizeString="WWWWWWWWWW"\n'
                '         getText="GetText" onChange="OnChange"/>',
    "Combo box": '<comboBox id="newCombo" label="Choose" sizeString="WWWWWWWWWW"\n'
                 '          getItemCount="GetItemCount" getItemLabel="GetItemLabel"\n'
                 '          onChange="OnChange"/>',
    "Drop-down": '<dropDown id="newDropDown" label="Choose"\n'
                 '          getItemCount="GetItemCount" getItemLabel="GetItemLabel"\n'
                 '          getSelectedItemIndex="GetSelectedIndex" onAction="OnAction"/>',
    "Gallery": '<gallery id="newGallery" label="Gallery" size="large" columns="3"\n'
               '         itemWidth="48" itemHeight="48"\n'
               '         getItemCount="GetItemCount" getItemImage="GetItemImage"\n'
               '         onAction="OnAction"/>',
    "Menu": '<menu id="newMenu" label="Menu" imageMso="ListMacros" size="large">\n'
            '  <button id="newMenuItem" label="Item" onAction="OnAction"/>\n'
            '</menu>',
    "Split button": '<splitButton id="newSplit" size="large">\n'
                    '  <button id="newSplitMain" label="Main" imageMso="HappyFace" onAction="OnAction"/>\n'
                    '  <menu id="newSplitMenu">\n'
                    '    <button id="newSplitItem" label="Item" onAction="OnAction"/>\n'
                    '  </menu>\n'
                    '</splitButton>',
    "Button group": '<buttonGroup id="newButtonGroup">\n'
                    '  <button id="newBtnA" label="A" imageMso="Bold" onAction="OnAction"/>\n'
                    '  <button id="newBtnB" label="B" imageMso="Italic" onAction="OnAction"/>\n'
                    '</buttonGroup>',
    "Vertical box": '<box id="newBox" boxStyle="vertical">\n</box>',
    "Separator": '<separator id="newSeparator"/>',
    "Dialog box launcher": '<dialogBoxLauncher>\n'
                           '  <button id="newLauncher" screentip="Settings" onAction="OnSettings"/>\n'
                           '</dialogBoxLauncher>',
    "Built-in control clone": '<control idMso="FileSave" label="Save now" size="large"/>',
    "Repurpose a command": '<command idMso="FileSave" onAction="OnSaveIntercept"/>',
}


def by_category() -> Dict[str, List[Template]]:
    grouped: Dict[str, List[Template]] = {}
    for template in TEMPLATES:
        grouped.setdefault(template.category, []).append(template)
    return grouped


def get(key: str) -> Template:
    for template in TEMPLATES:
        if template.key == key:
            return template
    return TEMPLATES[0]


def render(key: str, variant: str) -> str:
    template = get(key)
    return starter_xml(variant, template.body, on_load=key != "blank")
