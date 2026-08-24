"""Curated catalogues of built-in Office identifiers.

Office ships roughly 8,000 ``imageMso`` icons and tens of thousands of
control ids; nobody memorises them.  These lists cover the ones people
actually reach for in Excel, grouped so the icon browser can present
them sensibly.

The gallery is *extensible*: drop a plain-text file named
``imagemso.txt`` (one id per line, ``# comment`` lines ignored, optional
``id, Category`` pairs) next to the application or in
``%APPDATA%/RibbonForge`` and the extra ids are merged in at start-up.
"""

from __future__ import annotations

import os
from typing import Dict, List, Tuple

IMAGE_MSO: Dict[str, Tuple[str, ...]] = {
    "File": (
        "FileNew", "FileNewDefault", "FileOpen", "FileClose", "FileSave", "FileSaveAs",
        "FileSaveAsExcelXlsx", "FileSaveAsExcelXlsm", "FileSaveAsPdfOrXps", "FileSaveAsWebPage",
        "FilePrint", "FilePrintQuick", "FilePrintPreview", "FileProperties",
        "FileSendAsAttachment", "FileSendMenu", "FileCheckIn", "FileCheckOut",
        "FileCompatibilityChecker", "FileDocumentInspect", "FileDocumentEncrypt",
        "FilePermissionRestrictMenu", "FilePrepareMenu", "FilePublishMenu",
        "FileOpenRecentFile", "FileExit", "FileManageMenu", "FileStartWorkflow",
        "FileCreateDocumentWorkspace", "FileVersions", "FileImport", "FileExport",
    ),
    "Clipboard": (
        "Cut", "Copy", "Paste", "PasteMenu", "PasteSpecialDialog", "PasteFormatting",
        "PasteValues", "PasteAsHyperlink", "PasteTextOnly", "FormatPainter",
        "ClipboardShowPane", "ClearAll", "ClearFormats", "ClearContents", "ClearComments",
        "ClearHyperlinks", "Undo", "Redo", "Repeat", "Delete", "Copy2", "Duplicate",
    ),
    "Font & Text": (
        "Bold", "Italic", "Underline", "UnderlineGallery", "Strikethrough", "Superscript",
        "Subscript", "FontDialog", "FontColorPicker", "FontColorMoreColorsDialog",
        "FontSizeIncreaseWord", "FontSizeDecreaseWord", "GrowFont", "ShrinkFont",
        "TextHighlightColorPicker", "ChangeCase", "ClearFormatting", "TextEffectGallery",
        "TextBoxInsert", "TextDirectionGallery", "SpellingAndGrammar", "Thesaurus",
        "Research", "Translate", "TranslateToolTipMenu", "Language",
    ),
    "Alignment": (
        "AlignLeft", "AlignCenter", "AlignRight", "AlignJustify", "AlignTop", "AlignMiddle",
        "AlignBottom", "AlignLeftToRight", "AlignRightToLeft", "WrapText",
        "IndentIncreaseExcel", "IndentDecreaseExcel", "OrientationGallery",
        "MergeCenterAcrossCells", "CellsMerge", "AlignDistributeHorizontal",
        "AlignDistributeVertical", "AlignJustifyLow", "ParagraphDialog",
    ),
    "Numbers": (
        "NumberFormatGallery", "NumberFormatDialog", "NumberFormatPercent",
        "NumberFormatComma", "NumberFormatAccounting", "NumberFormatCurrencyMenu",
        "DecimalsIncrease", "DecimalsDecrease", "NumberFormatCurrencyOther",
        "NumberFormatGeneral", "NumberFormatDateShort", "NumberFormatDateLong",
        "NumberFormatTime", "NumberFormatFraction", "NumberFormatScientific",
    ),
    "Styles & Format": (
        "CellStylesGallery", "CellStyleNew", "ConditionalFormattingMenu",
        "ConditionalFormattingNewRule", "ConditionalFormattingClearRulesMenu",
        "FormatAsTableGallery", "CellsFormatMenu", "CellFillColorPicker",
        "BordersGallery", "BordersAll", "BordersMoreBordersDialog", "BorderDrawGrid",
        "BorderErase", "CellsFormatStyleDialog", "ThemeColorsGallery", "ThemeFontsGallery",
        "ThemeEffectsGallery", "ThemesGallery", "ShapeStylesGallery", "ShapeFillColorPicker",
        "ShapeOutlineColorPicker", "ShapeEffectsMenu", "PictureStylesGallery",
    ),
    "Cells & Sheets": (
        "CellsInsert", "CellsInsertDialog", "CellsDelete", "CellsFormatSheetMenu",
        "SheetInsert", "SheetDelete", "SheetRename", "SheetMoveOrCopy", "SheetProtect",
        "SheetRowHeight", "SheetColumnWidth", "SheetRowsHide", "SheetColumnsHide",
        "SheetRowsUnhide", "SheetColumnsUnhide", "FreezePanesGallery", "SplitVertical",
        "WindowSplit", "HeaderFooterInsert", "ViewGridlinesExcel", "ViewHeadingsExcel",
        "ViewFormulas", "ViewNormalViewExcel", "ViewPageBreakPreviewView",
        "PageSetupDialog", "PrintTitles", "PrintAreaMenu", "PageOrientationGallery",
        "PageMarginsGallery", "PageSizeGallery", "ScaleToFitDialog",
    ),
    "Data": (
        "AutoSum", "FillDown", "FillRight", "FillSeriesMenu", "SortAscendingExcel",
        "SortDescendingExcel", "SortDialog", "SortCustomExcel", "FilterBySelection",
        "FilterExcel", "FilterAdvancedExcel", "FilterClearAllFilters", "FilterReapply",
        "TextToColumnsWizard", "RemoveDuplicates", "DataValidation", "DataValidationMenu",
        "WhatIfAnalysisMenu", "GoalSeek", "Consolidate", "GroupData", "UngroupData",
        "Subtotals", "OutlineShowDetail", "OutlineHideDetail", "RefreshAll",
        "DataConnections", "QueryTable", "ImportTextFile", "ImportFromAccess",
        "ImportFromWeb", "ImportOtherSources", "ExportExcel",
    ),
    "Formulas": (
        "FunctionWizard", "FunctionsFinancialInsertGallery", "FunctionsLogicalInsertGallery",
        "FunctionsTextInsertGallery", "FunctionsDateTimeInsertGallery",
        "FunctionsLookupAndReferenceInsertGallery", "FunctionsMathInsertGallery",
        "FunctionsMoreInsertGallery", "AutoSumMenu", "NameDefine", "NameManager",
        "UseInFormulaMenu", "CreateFromSelection", "FormulaEvaluate", "TracePrecedents",
        "TraceDependents", "RemoveAllArrows", "ErrorChecking", "WatchWindow",
        "CalculateNow", "CalculateSheet", "CalculationOptionsMenu", "ShowFormulas",
    ),
    "Insert & Objects": (
        "PivotTableInsertMenu", "PivotTableInsert", "PivotChartInsert", "TableExcel",
        "PictureInsertFromFile", "ClipArtInsert", "ShapesInsertGallery", "SmartArtInsert",
        "ChartInsert", "ChartTypeColumnInsert", "ChartTypeLineInsert", "ChartTypePieInsert",
        "ChartTypeBarInsert", "ChartTypeAreaInsert", "ChartTypeScatterInsert",
        "ChartTypeOtherInsert", "HyperlinkInsert", "SymbolInsert", "ObjectInsert",
        "SignatureLineInsert", "WordArtInsert", "EquationInsert", "ScreenshotInsert",
        "SparklineLineInsert", "SparklineColumnInsert", "SlicerInsert",
    ),
    "Review & Comments": (
        "ReviewNewComment", "ReviewDeleteComment", "ReviewPreviousComment",
        "ReviewNextComment", "ReviewShowComment", "ReviewShowAllComments",
        "ReviewProtectSheet", "ReviewProtectWorkbook", "ReviewShareWorkbook",
        "ReviewTrackChangesMenu", "ReviewAcceptChange", "ReviewRejectChange",
        "ReviewProtectDocument", "ReviewCompareMenu",
    ),
    "View & Window": (
        "ZoomDialog", "Zoom100", "ZoomToSelection", "ZoomIn", "ZoomOut",
        "WindowNew", "WindowArrangeAllDialog", "WindowSwitchWindowsMenuExcel",
        "WindowFreezePanesGallery", "WindowHide", "WindowUnhide", "WindowSideBySide",
        "ViewFullScreenView", "ViewCustomViews", "ViewRulerExcel", "ViewMessageBar",
        "MacroPlay", "MacroRecord", "MacroSecurity", "MacrosMenu", "VisualBasic",
    ),
    "Developer": (
        "VisualBasic", "MacroPlay", "MacroRecord", "MacroSecurity", "UseRelativeReferences",
        "ControlInsertGallery", "ControlProperties", "ControlDesignMode", "ViewCode",
        "RunDialog", "AddInsDialog", "ComAddInsDialog", "XmlSource", "XmlMapProperties",
        "XmlExpansionPacks", "XmlRefreshData", "XmlImport", "XmlExport",
    ),
    "Symbols & Fun": (
        "HappyFace", "Info", "Help", "Bullet", "Star", "Flag", "Heart", "Lightning",
        "Lightbulb", "Warning", "Cancel", "Ok", "Refresh", "Repeat", "Search",
        "Calculator", "Calendar", "CalendarToday", "Clock", "Home", "Mail", "Phone",
        "Lock", "Unlock", "ListMacros", "TableDesign", "ReportDesign",
        "ReportModifyDesign", "ExportTextFile", "ExportExcel",
        "Camera", "CameraTool", "Airplane", "Bell", "Gear", "Key", "Pin",
        "AcceptTask", "AcceptInvitation", "DeclineInvitation", "Cancel2",
        "TagMarkComplete", "TaskComplete", "TrafficLightsGallery",
    ),
    "Arrows & Nav": (
        "ArrowStyleGallery", "ArrowMoreArrows", "GoToNextArrow", "GoToPreviousArrow",
        "GoToFirstRecord", "GoToLastRecord", "GoToNextRecord", "GoToPreviousRecord",
        "Forward", "Back", "Upload", "Download", "PreviousPage", "NextPage",
        "BringForward", "BringToFront", "SendBackward", "SendToBack",
        "ObjectRotateGallery", "ObjectFlipHorizontal", "ObjectFlipVertical",
        "GroupShapes", "UngroupShapes", "ObjectAlignMenu", "SelectionPane",
    ),
    "Communication": (
        "Mail", "MailMerge", "FileSendAsAttachment", "NewMailMessage", "ReplyAll",
        "Reply", "Forward", "MeetingRequest", "AddressBook", "ContactCard",
        "AssignTask", "SendUpdate", "Print", "PrintDialog",
    ),
}

# ------------------------------------------------------------------ control ids
CONTROL_IDMSO: Dict[str, Tuple[str, ...]] = {
    "Excel tabs": (
        "TabHome", "TabInsert", "TabPageLayoutExcel", "TabFormulas", "TabData",
        "TabReview", "TabView", "TabDeveloper", "TabAddIns", "TabPrintPreview",
        "TabFormat", "TabBackgroundRemoval",
    ),
    "Contextual tab sets": (
        "TabSetChartTools", "TabSetPivotTableTools", "TabSetPivotChartTools",
        "TabSetDrawingTools", "TabSetPictureTools", "TabSetTableToolsExcel",
        "TabSetSmartArtTools", "TabSetSparklineTools", "TabSetSlicerTools",
        "TabSetHeaderAndFooterTools", "TabSetInkTools", "TabSetPrintPreview",
    ),
    "Home tab groups": (
        "GroupClipboard", "GroupFont", "GroupAlignment", "GroupNumber", "GroupStyles",
        "GroupCells", "GroupEditingExcel",
    ),
    "Insert tab groups": (
        "GroupInsertTablesExcel", "GroupInsertIllustrations", "GroupInsertChartsExcel",
        "GroupInsertLinks", "GroupInsertText", "GroupSparklines", "GroupFilters",
    ),
    "Page Layout groups": (
        "GroupThemesExcel", "GroupPageSetup", "GroupScaleToFit", "GroupSheetOptions",
        "GroupArrange",
    ),
    "Formulas groups": (
        "GroupFunctionLibrary", "GroupDefinedNames", "GroupFormulaAuditing",
        "GroupCalculation",
    ),
    "Data groups": (
        "GroupGetExternalData", "GroupConnections", "GroupSortFilter", "GroupDataTools",
        "GroupOutline",
    ),
    "Review / View groups": (
        "GroupProofing", "GroupComments", "GroupChangesExcel", "GroupWorkbookViews",
        "GroupShowHide", "GroupZoom", "GroupWindow", "GroupMacros",
    ),
    "Developer groups": ("GroupCode", "GroupControls", "GroupXml", "GroupModify"),
    "Common commands": (
        "FileSave", "FileSaveAs", "FileOpen", "FileClose", "FileNew", "FilePrint",
        "FilePrintQuick", "FilePrintPreview", "FileSendAsAttachment", "Cut", "Copy",
        "Paste", "PasteSpecialDialog", "Undo", "Redo", "Bold", "Italic", "Underline",
        "AutoSum", "SortAscendingExcel", "SortDescendingExcel", "FilterExcel",
        "RefreshAll", "CalculateNow", "MacroPlay", "VisualBasic", "ZoomDialog",
    ),
    "Context menus": (
        "ContextMenuCell", "ContextMenuRow", "ContextMenuColumn", "ContextMenuPly",
        "ContextMenuWorkbookTabs", "ContextMenuShape", "ContextMenuPicture",
        "ContextMenuChart", "ContextMenuHyperlink", "ContextMenuPivotTable",
        "ContextMenuListRange", "ContextMenuTextBox", "ContextMenuButton",
    ),
    "Office menu / QAT": (
        "FileNewDefault", "FileOpenRecentFile", "FileSaveAsMenu", "FilePrintMenu",
        "FilePrepareMenu", "FileSendMenu", "FilePublishMenu", "FileCloseOrCloseAll",
        "ApplicationOptionsDialog", "FileExit",
    ),
}

FLAT_IMAGE_MSO: List[Tuple[str, str]] = [
    (name, category) for category, names in IMAGE_MSO.items() for name in names
]

FLAT_CONTROL_IDMSO: List[Tuple[str, str]] = [
    (name, category) for category, names in CONTROL_IDMSO.items() for name in names
]


def _dedupe(pairs: List[Tuple[str, str]]) -> List[Tuple[str, str]]:
    seen = set()
    out: List[Tuple[str, str]] = []
    for name, category in pairs:
        if name in seen:
            continue
        seen.add(name)
        out.append((name, category))
    return out


FLAT_IMAGE_MSO = _dedupe(FLAT_IMAGE_MSO)
FLAT_CONTROL_IDMSO = _dedupe(FLAT_CONTROL_IDMSO)


def load_user_catalogue(*paths: str) -> int:
    """Merge extra imageMso ids from plain-text files. Returns how many were added."""
    added = 0
    known = {name for name, _ in FLAT_IMAGE_MSO}
    for path in paths:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                lines = handle.read().splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "," in line:
                name, _, category = line.partition(",")
                name, category = name.strip(), category.strip() or "Imported"
            elif "\t" in line:
                name, _, category = line.partition("\t")
                name, category = name.strip(), category.strip() or "Imported"
            else:
                name, category = line, "Imported"
            if not name or name in known:
                continue
            known.add(name)
            FLAT_IMAGE_MSO.append((name, category))
            IMAGE_MSO.setdefault(category, tuple())
            IMAGE_MSO[category] = IMAGE_MSO[category] + (name,)
            added += 1
    return added


def image_mso_names() -> List[str]:
    return [name for name, _ in FLAT_IMAGE_MSO]


def control_idmso_names() -> List[str]:
    return [name for name, _ in FLAT_CONTROL_IDMSO]


def search_image_mso(query: str, category: str = "") -> List[Tuple[str, str]]:
    query = (query or "").strip().lower()
    result = []
    for name, cat in FLAT_IMAGE_MSO:
        if category and cat != category:
            continue
        if not query or query in name.lower():
            result.append((name, cat))
    return result
