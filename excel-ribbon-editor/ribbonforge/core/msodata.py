"""Curated catalogues of built-in Office identifiers.

Office ships thousands of ``imageMso`` icons and tens of thousands of
control ids; nobody memorises them.  The complete identifier list (3,244
names, from the published reference) is folded in at import time; on top
of it a curated set - every name verified against that list - is grouped
into categories so the icon browser stays navigable.

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
        "FileNew", "FileNewDefault", "FileOpen", "FileClose",
        "FileSave", "FileSaveAs", "FileSaveAsExcelXlsx", "FileSaveAsPdfOrXps",
        "FileSaveAsWebPage", "FilePrint", "FilePrintQuick", "FilePrintPreview",
        "FileProperties", "FileSendAsAttachment", "FileSendMenu", "FileCheckIn",
        "FileCheckOut", "FileCompatibilityChecker", "FileDocumentInspect", "FileDocumentEncrypt",
        "FilePermissionRestrictMenu", "FilePrepareMenu", "RecentFileList", "FileExit",
        "FileStartWorkflow", "FileCreateDocumentWorkspace", "ExportTextFile", "ExportExcel",
        "ImportExcel", "ImportTextFile", "ImportAccess", "ImportSharePointList",
    ),
    "Clipboard": (
        "Cut", "Copy", "Paste", "PasteMenu",
        "PasteSpecialDialog", "PasteFormatting", "PasteAsHyperlink", "FormatPainter",
        "ClearAll", "ClearFormats", "Undo", "Redo",
        "Delete", "SelectAll",
    ),
    "Font & Text": (
        "Bold", "Italic", "Underline", "UnderlineGallery",
        "Strikethrough", "Superscript", "Subscript", "FontDialog",
        "FontColorPicker", "FontSizeIncrease", "FontSizeDecrease", "TextHighlightColorPicker",
        "ChangeCaseGallery", "ClearFormatting", "TextBoxInsert", "TextDirectionGallery",
        "Spelling", "SpellingAndGrammar", "Thesaurus", "SetLanguage",
        "WordCount",
    ),
    "Alignment": (
        "AlignLeft", "AlignCenter", "AlignRight", "AlignJustify",
        "AlignTopExcel", "AlignMiddleExcel", "AlignBottomExcel", "WrapText",
        "IndentIncreaseExcel", "IndentDecreaseExcel", "OrientationMenu", "MergeCenterMenu",
        "MergeCenter", "MergeCells", "UnmergeCells", "ObjectsGroupMenu",
        "TextAlignGallery",
    ),
    "Numbers": (
        "NumberFormatGallery", "FormatCellsNumberDialog", "PercentStyle", "CommaStyle",
        "AccountingFormat", "AccountingFormatMenu", "DecimalsIncrease", "DecimalsDecrease",
        "FormatNumberDefault", "PercentSign", "CommaSign", "DollarSign",
    ),
    "Styles & Format": (
        "CellStylesGallery", "ConditionalFormattingMenu", "ConditionalFormattingColorScalesGallery", "ConditionalFormattingDataBarsGallery",
        "ConditionalFormattingIconSetsGallery", "ConditionalFormattingHighlightCellsMenu", "FormatAsTableGallery", "CellFillColorPicker",
        "BordersGallery", "BordersAll", "BorderDrawGrid", "BorderErase",
        "ThemeColorsGallery", "ThemeFontsGallery", "ThemeEffectsGallery", "ThemesGallery",
        "ShapeFillColorPicker", "ShapeOutlineColorPicker", "PictureStylesGallery", "TableStylesGallery",
        "FormatPainter", "GridSettings",
    ),
    "Cells & Sheets": (
        "CellsInsertDialog", "CellsInsertSmart", "CellsDelete", "CellsDeleteSmart",
        "SheetInsert", "SheetDelete", "SheetProtect", "RowHeight",
        "ColumnWidth", "FreezePanes", "ViewFreezePanesGallery", "WindowSplit",
        "HeaderFooterInsert", "ViewNormalViewExcel", "ViewPageBreakPreviewView", "ViewPageLayoutView",
        "PageSetupDialog", "PrintTitles", "PrintAreaMenu", "PageOrientationGallery",
        "PageMarginsGallery", "PageSizeGallery",
    ),
    "Data": (
        "AutoSum", "AutoSumMenu", "FillDown", "FillRight",
        "FillUp", "FillLeft", "FillMenu", "SortAscendingExcel",
        "SortDescendingExcel", "SortDialog", "SortCustomExcel", "SortFilterMenu",
        "Filter", "AdvancedFilterDialog", "FilterReapply", "RemoveDuplicates",
        "DataValidation", "DataValidationMenu", "WhatIfAnalysisMenu", "Consolidate",
        "OutlineShowDetail", "OutlineHideDetail", "RefreshAll", "DataRefreshAll",
        "Connections", "GetExternalDataFromAccess", "GetExternalDataFromWeb", "GetExternalDataFromText",
    ),
    "Formulas": (
        "FunctionWizard", "FunctionsFinancialInsertGallery", "FunctionsLogicalInsertGallery", "FunctionsTextInsertGallery",
        "FunctionsDateTimeInsertGallery", "FunctionsMathTrigInsertGallery", "FunctionsRecentlyUsedtInsertGallery", "NameDefine",
        "NameDefineMenu", "NameManager", "NameUseInFormula", "NameCreateFromSelection",
        "FormulaEvaluate", "TracePrecedents", "TraceDependents", "TraceRemoveAllArrows",
        "ErrorChecking", "WatchWindow", "CalculateNow", "CalculateSheet",
        "CalculationOptionsMenu", "ShowFormulas",
    ),
    "Insert & Objects": (
        "PivotTableInsertMenu", "PivotTableInsert", "PivotChartInsert", "TableInsert",
        "PictureInsertFromFile", "ClipArtInsert", "ShapesInsertGallery", "SmartArtInsert",
        "ChartInsert", "ChartTypeColumnInsertGallery", "ChartTypeLineInsertGallery", "ChartTypePieInsertGallery",
        "ChartTypeBarInsertGallery", "ChartTypeAreaInsertGallery", "ChartTypeXYScatterInsertGallery", "ChartTypeOtherInsertGallery",
        "ChartTypeAllInsertDialog", "HyperlinkInsert", "SymbolInsertGallery", "SymbolsDialog",
        "SignatureLineInsert", "WordArtInsertGallery", "EquationInsertNew", "OleObjectctInsert",
        "TextBoxInsertExcel", "CalendarInsert", "DrawingInsert",
    ),
    "Review & Comments": (
        "ReviewNewComment", "ReviewDeleteComment", "ReviewPreviousComment", "ReviewNextComment",
        "ReviewShowAllComments", "ReviewEditComment", "ReviewShareWorkbook", "ReviewTrackChangesMenu",
        "ReviewHighlightChanges", "ProtectDocument",
    ),
    "View & Window": (
        "ZoomDialog", "Zoom100", "ZoomToSelection", "ZoomIn",
        "ZoomOut", "WindowNew", "WindowsArrangeAll", "WindowSwitchWindowsMenuExcel",
        "WindowHide", "WindowUnhide", "ViewSideBySide", "ViewFullScreenView",
        "ViewCustomViews", "ViewRulerExcel", "ViewDocumentMap", "WindowSplit",
    ),
    "Developer": (
        "VisualBasic", "MacroPlay", "MacroRecord", "MacroSecurity",
        "ListMacros", "MacroRelativeReferences", "ControlsGallery", "ControlProperties",
        "DesignMode", "ViewCode", "AddInsMenu", "ComAddInsDialog",
        "XmlSource", "XmlMapProperties", "XmlExpansionPacksExcel", "XmlImport",
        "XmlExport", "DocumentPanelTemplate", "ControlToolboxOutlook",
    ),
    "Symbols & Shapes": (
        "HappyFace", "TraceError", "Info", "Help",
        "Risks", "Piggy", "Lock", "MeetingsWorkspace",
        "BlackAndWhiteAutomatic", "DollarSign", "MagicEightBall", "Magnifier",
        "PickUpStyle", "Repeat", "RecurrenceEdit", "Camera",
        "SadFace", "AcceptTask",
    ),
    "Arrows & Nav": (
        "Forward", "UpArrow2", "DownArrow2", "LeftArrow2",
        "RightArrow2", "GoToNewRecord", "ObjectBringToFront", "ObjectSendToBack",
        "ObjectRotateGallery", "ObjectFlipHorizontal", "ObjectFlipVertical", "ObjectsGroup",
        "ObjectsUngroup", "SelectionPane",
    ),
    "Mail & Tasks": (
        "NewMailMessage", "ReplyAll", "Reply", "ForwardAsAttachment",
        "MeetingRequest", "AddressBook", "CheckNames", "AttachFile",
        "AttachItem", "MailMergeRecipientsEditList", "AssignTask", "SendStatusReport",
        "NewTask", "ShowTaskPage", "OpenAttachedCalendar",
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


def _merge_full_catalogue() -> None:
    """Fold the complete 3,244-name imageMso index into the catalogue.

    Curated names keep their hand-picked categories; everything else lands
    in "More icons" so the browser stays navigable while search and
    validation see the whole set.
    """
    try:
        from . import msoicons
        full = msoicons.all_names()
    except Exception:
        return
    known = {name for name, _ in FLAT_IMAGE_MSO}
    extra = tuple(name for name in full if name not in known)
    if not extra:
        return
    IMAGE_MSO["More icons"] = extra
    FLAT_IMAGE_MSO.extend((name, "More icons") for name in extra)


_merge_full_catalogue()


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
