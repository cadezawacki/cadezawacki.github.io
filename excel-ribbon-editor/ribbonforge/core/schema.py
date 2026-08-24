"""A context-aware schema for the Office CustomUI markup.

Everything intelligent in the editor is driven from this table: the
insert menus, the property grid, validation, autocomplete and the
callback generator.  Elements are keyed by *context* (``backstage:tab``
is not the same thing as ``tab``) because Office reuses local names in
different branches of the tree with different rules.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

NS_2006 = "http://schemas.microsoft.com/office/2006/01/customui"
NS_2009 = "http://schemas.microsoft.com/office/2009/07/customui"

# Attribute editor kinds ------------------------------------------------------
STRING = "string"
BOOL = "bool"
INT = "int"
ENUM = "enum"
CALLBACK = "callback"
IMAGE_MSO = "imageMso"
IMAGE = "image"
CONTROL_MSO = "idMso"
IDENT = "id"
QUALIFIED = "idQ"

# Property-grid groups (rendered in this order)
G_IDENTITY = "Identity"
G_TEXT = "Text"
G_IMAGE = "Image"
G_STATE = "State"
G_LAYOUT = "Layout"
G_POSITION = "Position"
G_CALLBACK = "Callbacks"
G_ADVANCED = "Advanced"

GROUP_ORDER = [G_IDENTITY, G_TEXT, G_IMAGE, G_STATE, G_LAYOUT, G_POSITION, G_CALLBACK, G_ADVANCED]


@dataclass(frozen=True)
class Attr:
    name: str
    kind: str = STRING
    doc: str = ""
    group: str = G_ADVANCED
    values: Tuple[str, ...] = ()
    max_len: Optional[int] = None
    min_value: Optional[int] = None
    max_value: Optional[int] = None
    dialect: str = "both"          # "both" | "2006" | "2009"
    callback_sig: str = ""          # key into callbacks.SIGNATURES

    @property
    def is_callback(self) -> bool:
        return self.kind == CALLBACK


@dataclass
class Elem:
    key: str
    name: str
    doc: str = ""
    attrs: Tuple[Attr, ...] = ()
    children: Tuple[str, ...] = ()
    glyph: str = "▢"
    dialect: str = "both"
    max_occurs: Optional[int] = None      # per parent
    requires_one_of: Tuple[Tuple[str, ...], ...] = ()
    exclusive: Tuple[Tuple[str, ...], ...] = ()
    category: str = "Control"

    def attr(self, name: str) -> Optional[Attr]:
        local = name.rsplit(":", 1)[-1]
        for a in self.attrs:
            if a.name == local:
                return a
        return None

    def attr_names(self) -> List[str]:
        return [a.name for a in self.attrs]

    def child_locals(self) -> List[str]:
        return [SCHEMA[k].name for k in self.children if k in SCHEMA]


def A(
    name: str,
    kind: str = STRING,
    doc: str = "",
    group: str = G_ADVANCED,
    values: Sequence[str] = (),
    max_len: Optional[int] = None,
    min_value: Optional[int] = None,
    max_value: Optional[int] = None,
    dialect: str = "both",
    sig: str = "",
) -> Attr:
    return Attr(
        name=name,
        kind=kind,
        doc=doc,
        group=group,
        values=tuple(values),
        max_len=max_len,
        min_value=min_value,
        max_value=max_value,
        dialect=dialect,
        callback_sig=sig or ("" if kind != CALLBACK else name),
    )


# ---------------------------------------------------------------- attribute kits
ID = A("id", IDENT, "Unique identifier for a control that you create. Cannot be combined with idMso or idQ.", G_IDENTITY)
IDQ = A("idQ", QUALIFIED, "Qualified identifier (ns:id) used to reference a control created by another add-in.", G_IDENTITY)
IDMSO = A("idMso", CONTROL_MSO, "Identifier of a control built into Office, e.g. FileSave.", G_IDENTITY)
TAG = A("tag", STRING, "Arbitrary string passed to your callbacks via control.Tag. Great for sharing one callback across many controls.", G_IDENTITY)

LABEL = A("label", STRING, "Text shown on the control.", G_TEXT, max_len=1024)
GET_LABEL = A("getLabel", CALLBACK, "Callback that returns the label at run time.", G_CALLBACK)
SCREENTIP = A("screentip", STRING, "Bold heading of the tooltip.", G_TEXT, max_len=1024)
GET_SCREENTIP = A("getScreentip", CALLBACK, "Callback that returns the screentip.", G_CALLBACK)
SUPERTIP = A("supertip", STRING, "Descriptive body text of the tooltip.", G_TEXT, max_len=1024)
GET_SUPERTIP = A("getSupertip", CALLBACK, "Callback that returns the supertip.", G_CALLBACK)
KEYTIP = A("keytip", STRING, "Access key shown when the user presses Alt (1-3 characters).", G_TEXT, max_len=3)
GET_KEYTIP = A("getKeytip", CALLBACK, "Callback that returns the keytip.", G_CALLBACK, dialect="2009")
DESCRIPTION = A("description", STRING, "Longer text shown when the parent menu uses itemSize='large'.", G_TEXT, max_len=4096)
GET_DESCRIPTION = A("getDescription", CALLBACK, "Callback that returns the description.", G_CALLBACK)

IMAGE_A = A("image", IMAGE, "Relationship id of a picture embedded in this custom UI part.", G_IMAGE)
IMAGEMSO_A = A("imageMso", IMAGE_MSO, "Identifier of a built-in Office icon, e.g. HappyFace.", G_IMAGE)
GET_IMAGE = A("getImage", CALLBACK, "Callback returning an IPictureDisp for the icon.", G_CALLBACK)

VISIBLE = A("visible", BOOL, "Whether the control is shown.", G_STATE, values=("true", "false"))
GET_VISIBLE = A("getVisible", CALLBACK, "Callback that returns the visibility.", G_CALLBACK)
ENABLED = A("enabled", BOOL, "Whether the control accepts input.", G_STATE, values=("true", "false"))
GET_ENABLED = A("getEnabled", CALLBACK, "Callback that returns the enabled state.", G_CALLBACK)

SIZE = A("size", ENUM, "Control size: 'large' shows a 32x32 icon with the label underneath.", G_LAYOUT, values=("normal", "large"))
GET_SIZE = A("getSize", CALLBACK, "Callback that returns the size.", G_CALLBACK)
SHOW_LABEL = A("showLabel", BOOL, "Show the label next to the icon.", G_LAYOUT, values=("true", "false"))
GET_SHOW_LABEL = A("getShowLabel", CALLBACK, "Callback that returns showLabel.", G_CALLBACK)
SHOW_IMAGE = A("showImage", BOOL, "Show the icon.", G_LAYOUT, values=("true", "false"))
GET_SHOW_IMAGE = A("getShowImage", CALLBACK, "Callback that returns showImage.", G_CALLBACK)

ON_ACTION = A("onAction", CALLBACK, "Callback invoked when the control is used.", G_CALLBACK)

INSERT = (
    A("insertAfterMso", CONTROL_MSO, "Place this item after the named built-in item.", G_POSITION),
    A("insertBeforeMso", CONTROL_MSO, "Place this item before the named built-in item.", G_POSITION),
    A("insertAfterQ", QUALIFIED, "Place this item after a qualified item from another add-in.", G_POSITION),
    A("insertBeforeQ", QUALIFIED, "Place this item before a qualified item from another add-in.", G_POSITION),
)

TIPS = (SCREENTIP, GET_SCREENTIP, SUPERTIP, GET_SUPERTIP, KEYTIP, GET_KEYTIP)
IMAGES = (IMAGE_A, IMAGEMSO_A, GET_IMAGE)
STATES = (ENABLED, GET_ENABLED, VISIBLE, GET_VISIBLE)

ITEM_CALLBACKS = (
    A("getItemCount", CALLBACK, "Callback returning how many items to display.", G_CALLBACK),
    A("getItemLabel", CALLBACK, "Callback returning the label of item <index>.", G_CALLBACK),
    A("getItemID", CALLBACK, "Callback returning the id of item <index>.", G_CALLBACK),
    A("getItemImage", CALLBACK, "Callback returning the picture of item <index>.", G_CALLBACK),
    A("getItemScreentip", CALLBACK, "Callback returning the screentip of item <index>.", G_CALLBACK),
    A("getItemSupertip", CALLBACK, "Callback returning the supertip of item <index>.", G_CALLBACK),
)

SELECTION_CALLBACKS = (
    A("getSelectedItemIndex", CALLBACK, "Callback returning the zero-based index to select.", G_CALLBACK),
    A("getSelectedItemID", CALLBACK, "Callback returning the id of the item to select.", G_CALLBACK),
)

EXCLUSIVE_IDS = (("id", "idQ", "idMso"),)

SCHEMA: Dict[str, Elem] = {}


def _add(elem: Elem) -> Elem:
    SCHEMA[elem.key] = elem
    return elem


# ------------------------------------------------------------------- root parts
_add(Elem(
    key="customUI",
    name="customUI",
    doc="Root element of a custom UI part. Use the 2006 namespace for Office 2007 "
        "(customUI.xml) and the 2009 namespace for Office 2010 and later (customUI14.xml).",
    attrs=(
        A("xmlns", STRING, "CustomUI namespace. 2006/01 = Office 2007, 2009/07 = Office 2010+.", G_IDENTITY,
          values=(NS_2006, NS_2009)),
        A("onLoad", CALLBACK, "Callback run once when Office loads the ribbon. Cache the IRibbonUI here so you can Invalidate later.", G_CALLBACK),
        A("loadImage", CALLBACK, "Central callback that turns every image= value into a picture.", G_CALLBACK),
    ),
    children=("commands", "ribbon", "contextMenus", "backstage"),
    glyph="❖", category="Structure",
))

_add(Elem(
    key="commands", name="commands",
    doc="Container for repurposed built-in commands.",
    children=("command",), glyph="⚙", category="Structure", max_occurs=1,
))

_add(Elem(
    key="command", name="command",
    doc="Repurposes a built-in command: disable it, or point it at your own macro.",
    attrs=(IDMSO, ON_ACTION, ENABLED, GET_ENABLED, IMAGE_A, IMAGEMSO_A, GET_IMAGE,
           LABEL, GET_LABEL, SCREENTIP, GET_SCREENTIP, SUPERTIP, GET_SUPERTIP,
           KEYTIP, GET_KEYTIP, DESCRIPTION, GET_DESCRIPTION),
    glyph="⚙", category="Structure",
    requires_one_of=(("idMso",),),
))

_add(Elem(
    key="ribbon", name="ribbon",
    doc="The ribbon itself. Set startFromScratch to hide every built-in tab.",
    attrs=(A("startFromScratch", BOOL, "true hides all built-in tabs and most of the Office menu.", G_LAYOUT, values=("true", "false")),),
    children=("officeMenu", "qat", "tabs", "contextualTabs"),
    glyph="▤", category="Structure", max_occurs=1,
))

_add(Elem(
    key="officeMenu", name="officeMenu",
    doc="Office 2007 round button menu. Ignored by Office 2010 and later.",
    children=("button", "checkBox", "control", "dynamicMenu", "gallery", "menu",
              "menuSeparator", "splitButton", "toggleButton"),
    glyph="●", dialect="2006", category="Structure", max_occurs=1,
))

_add(Elem(
    key="qat", name="qat",
    doc="Quick Access Toolbar. Only valid when ribbon startFromScratch='true'.",
    children=("sharedControls", "documentControls"),
    glyph="★", category="Structure", max_occurs=1,
))

_add(Elem(key="sharedControls", name="sharedControls",
          doc="QAT items shown for every document.",
          children=("button", "control", "separator"), glyph="★", max_occurs=1, category="Structure"))
_add(Elem(key="documentControls", name="documentControls",
          doc="QAT items shown only for this document.",
          children=("button", "control", "separator"), glyph="★", max_occurs=1, category="Structure"))

_add(Elem(key="tabs", name="tabs", doc="Container for ribbon tabs.",
          children=("tab",), glyph="▤", max_occurs=1, category="Structure"))

_add(Elem(
    key="tab", name="tab",
    doc="A ribbon tab. Use id for your own tab, or idMso (e.g. TabHome) to add groups to a built-in tab.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL, KEYTIP, GET_KEYTIP, VISIBLE, GET_VISIBLE) + INSERT,
    children=("group",), glyph="▭", category="Structure",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(key="contextualTabs", name="contextualTabs",
          doc="Container for contextual tab sets (e.g. Chart Tools).",
          children=("tabSet",), glyph="▭", max_occurs=1, category="Structure"))

_add(Elem(key="tabSet", name="tabSet",
          doc="A built-in contextual tab set you extend, e.g. TabSetChartTools.",
          attrs=(IDMSO, TAG, VISIBLE, GET_VISIBLE),
          children=("tab",), glyph="▭", category="Structure",
          requires_one_of=(("idMso",),)))

_add(Elem(
    key="group", name="group",
    doc="A labelled box of controls inside a tab.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL, SCREENTIP, GET_SCREENTIP, SUPERTIP, GET_SUPERTIP,
           KEYTIP, GET_KEYTIP, IMAGE_A, IMAGEMSO_A, GET_IMAGE, VISIBLE, GET_VISIBLE,
           A("autoScale", BOOL, "Allow Office to shrink the group when space is tight.", G_LAYOUT, values=("true", "false"), dialect="2009"),
           A("centerVertically", BOOL, "Centre the child controls vertically.", G_LAYOUT, values=("true", "false"), dialect="2009"),
           ) + INSERT,
    children=("box", "buttonGroup", "button", "checkBox", "comboBox", "control", "dropDown",
              "dynamicMenu", "editBox", "gallery", "labelControl", "menu", "separator",
              "splitButton", "toggleButton", "dialogBoxLauncher"),
    glyph="▦", category="Structure",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(key="dialogBoxLauncher", name="dialogBoxLauncher",
          doc="The small arrow in the bottom-right corner of a group. Contains exactly one button.",
          children=("button",), glyph="↗", max_occurs=1, category="Structure"))

# ------------------------------------------------------------------- controls
_add(Elem(
    key="button", name="button",
    doc="A push button.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + (DESCRIPTION, GET_DESCRIPTION,)
          + IMAGES + STATES + (SIZE, GET_SIZE, SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE, ON_ACTION) + INSERT,
    glyph="⬜", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="toggleButton", name="toggleButton",
    doc="A button that stays pressed. Your onAction receives the new state.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + (DESCRIPTION, GET_DESCRIPTION,)
          + IMAGES + STATES
          + (SIZE, GET_SIZE, SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE,
             A("getPressed", CALLBACK, "Callback returning True when the button should look pressed.", G_CALLBACK),
             ON_ACTION) + INSERT,
    glyph="▣", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="checkBox", name="checkBox",
    doc="A check box.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + (DESCRIPTION, GET_DESCRIPTION,) + STATES
          + (A("getPressed", CALLBACK, "Callback returning True when the box should be ticked.", G_CALLBACK), ON_ACTION) + INSERT,
    glyph="☑", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="editBox", name="editBox",
    doc="A single-line text box.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + IMAGES + STATES
          + (SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE,
             A("maxLength", INT, "Maximum number of characters (1-1024).", G_LAYOUT, min_value=1, max_value=1024),
             A("sizeString", STRING, "A string whose width sets the box width, e.g. 'WWWWWWWWWW'.", G_LAYOUT),
             A("getText", CALLBACK, "Callback returning the text to display.", G_CALLBACK),
             A("onChange", CALLBACK, "Callback invoked when the user commits new text.", G_CALLBACK)) + INSERT,
    glyph="▬", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="comboBox", name="comboBox",
    doc="A drop-down list that also accepts typed text.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + IMAGES + STATES
          + (SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE,
             A("showItemImage", BOOL, "Show icons next to the list items.", G_LAYOUT, values=("true", "false")),
             A("sizeString", STRING, "A string whose width sets the control width.", G_LAYOUT),
             A("maxLength", INT, "Maximum characters the user may type (1-1024).", G_LAYOUT, min_value=1, max_value=1024),
             A("invalidateContentOnDrop", BOOL, "Re-query the item callbacks every time the list opens.", G_LAYOUT, values=("true", "false")),
             A("getText", CALLBACK, "Callback returning the current text.", G_CALLBACK),
             A("onChange", CALLBACK, "Callback invoked when the user commits a value.", G_CALLBACK))
          + ITEM_CALLBACKS + INSERT,
    children=("item",), glyph="▽", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="dropDown", name="dropDown",
    doc="A drop-down list of items, optionally followed by buttons.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + IMAGES + STATES
          + (SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE,
             A("showItemImage", BOOL, "Show icons next to the items.", G_LAYOUT, values=("true", "false")),
             A("showItemLabel", BOOL, "Show item labels.", G_LAYOUT, values=("true", "false")),
             A("sizeString", STRING, "A string whose width sets the control width.", G_LAYOUT),
             A("invalidateContentOnDrop", BOOL, "Re-query the item callbacks every time the list opens.", G_LAYOUT, values=("true", "false")),
             ON_ACTION)
          + ITEM_CALLBACKS + SELECTION_CALLBACKS + INSERT,
    children=("item", "button"), glyph="▼", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="gallery", name="gallery",
    doc="A grid of items with optional buttons underneath.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + (DESCRIPTION, GET_DESCRIPTION) + IMAGES + STATES
          + (SIZE, GET_SIZE, SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE,
             A("columns", INT, "Number of columns in the grid (1-1024).", G_LAYOUT, min_value=1, max_value=1024),
             A("rows", INT, "Number of rows in the grid (1-1024).", G_LAYOUT, min_value=1, max_value=1024),
             A("itemHeight", INT, "Item height in pixels (1-4096).", G_LAYOUT, min_value=1, max_value=4096),
             A("itemWidth", INT, "Item width in pixels (1-4096).", G_LAYOUT, min_value=1, max_value=4096),
             A("getItemHeight", CALLBACK, "Callback returning the item height.", G_CALLBACK),
             A("getItemWidth", CALLBACK, "Callback returning the item width.", G_CALLBACK),
             A("showItemImage", BOOL, "Show item icons.", G_LAYOUT, values=("true", "false")),
             A("showItemLabel", BOOL, "Show item labels.", G_LAYOUT, values=("true", "false")),
             A("invalidateContentOnDrop", BOOL, "Re-query the item callbacks every time the gallery opens.", G_LAYOUT, values=("true", "false")),
             ON_ACTION)
          + ITEM_CALLBACKS + SELECTION_CALLBACKS + INSERT,
    children=("item", "button"), glyph="▦", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="item", name="item",
    doc="A static entry inside a comboBox, dropDown or gallery.",
    attrs=(ID, IDQ, LABEL, IMAGE_A, IMAGEMSO_A, SCREENTIP, SUPERTIP),
    glyph="•", category="Control",
    requires_one_of=(("id", "idQ"),),
))

_add(Elem(
    key="menu", name="menu",
    doc="A drop-down menu of controls.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + (DESCRIPTION, GET_DESCRIPTION) + IMAGES + STATES
          + (SIZE, GET_SIZE, SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE,
             A("itemSize", ENUM, "'large' gives every item a 32x32 icon and a description.", G_LAYOUT, values=("normal", "large"))) + INSERT,
    children=("button", "checkBox", "control", "dynamicMenu", "gallery", "menu",
              "menuSeparator", "splitButton", "toggleButton"),
    glyph="☰", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="dynamicMenu", name="dynamicMenu",
    doc="A menu whose XML contents are produced by a callback at drop time.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + (DESCRIPTION, GET_DESCRIPTION) + IMAGES + STATES
          + (SIZE, GET_SIZE, SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE,
             A("getContent", CALLBACK, "Callback returning a menu XML string. Required.", G_CALLBACK),
             A("invalidateContentOnDrop", BOOL, "Rebuild the menu every time it opens.", G_LAYOUT, values=("true", "false"))) + INSERT,
    glyph="☰", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="splitButton", name="splitButton",
    doc="A button plus a menu. Contains one button/toggleButton and one menu.",
    attrs=(ID, IDQ, IDMSO, TAG, KEYTIP, GET_KEYTIP) + STATES
          + (SIZE, GET_SIZE, SHOW_LABEL, GET_SHOW_LABEL) + INSERT,
    children=("button", "toggleButton", "menu"), glyph="◨", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="box", name="box",
    doc="An invisible layout box that stacks its children horizontally or vertically.",
    attrs=(ID, IDQ, VISIBLE, GET_VISIBLE,
           A("boxStyle", ENUM, "Direction the children flow in.", G_LAYOUT, values=("horizontal", "vertical"))) + INSERT,
    children=("box", "buttonGroup", "button", "checkBox", "comboBox", "control", "dropDown",
              "dynamicMenu", "editBox", "gallery", "labelControl", "menu", "splitButton", "toggleButton"),
    glyph="▧", category="Layout",
))

_add(Elem(
    key="buttonGroup", name="buttonGroup",
    doc="Groups adjacent buttons so they render as one segmented control.",
    attrs=(ID, IDQ, VISIBLE, GET_VISIBLE) + INSERT,
    children=("button", "control", "dynamicMenu", "gallery", "menu", "splitButton", "toggleButton"),
    glyph="▥", category="Layout",
))

_add(Elem(
    key="labelControl", name="labelControl",
    doc="A static piece of text.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + STATES + (SHOW_LABEL, GET_SHOW_LABEL) + INSERT,
    glyph="T", category="Control",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(key="separator", name="separator",
          doc="A vertical rule between controls in a group.",
          attrs=(ID, IDQ, VISIBLE, GET_VISIBLE) + INSERT,
          glyph="│", category="Layout"))

_add(Elem(key="menuSeparator", name="menuSeparator",
          doc="A horizontal rule inside a menu, optionally with a title.",
          attrs=(ID, IDQ, VISIBLE, GET_VISIBLE,
                 A("title", STRING, "Optional caption drawn on the separator.", G_TEXT),
                 A("getTitle", CALLBACK, "Callback returning the title.", G_CALLBACK)) + INSERT,
          glyph="─", category="Layout"))

_add(Elem(
    key="control", name="control",
    doc="A clone of a built-in Office control, so you can place it in your own group.",
    attrs=(IDMSO, IDQ, TAG, LABEL, GET_LABEL) + TIPS + (DESCRIPTION,) + IMAGES
          + (VISIBLE, GET_VISIBLE, ENABLED, GET_ENABLED, SIZE, GET_SIZE,
             SHOW_LABEL, GET_SHOW_LABEL, SHOW_IMAGE, GET_SHOW_IMAGE) + INSERT,
    glyph="◈", category="Control",
    requires_one_of=(("idMso", "idQ"),),
))

# ------------------------------------------------------------- context menus (14)
_add(Elem(key="contextMenus", name="contextMenus",
          doc="Office 2010+ right-click menu customisation.",
          children=("contextMenu",), glyph="☰", dialect="2009", max_occurs=1, category="Structure"))

_add(Elem(key="contextMenu", name="contextMenu",
          doc="One built-in context menu, e.g. ContextMenuCell.",
          attrs=(IDMSO,),
          children=("button", "checkBox", "control", "dynamicMenu", "gallery", "menu",
                    "menuSeparator", "splitButton", "toggleButton"),
          glyph="☰", dialect="2009", category="Structure",
          requires_one_of=(("idMso",),)))

# ---------------------------------------------------------------- backstage (14)
BS_COMMON = (ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL) + TIPS + STATES

_add(Elem(
    key="backstage", name="backstage",
    doc="The File tab (Backstage view). Office 2010 and later only.",
    attrs=(A("onShow", CALLBACK, "Callback run when Backstage opens.", G_CALLBACK),
           A("onHide", CALLBACK, "Callback run when Backstage closes.", G_CALLBACK)),
    children=("backstage:button", "backstage:tab"),
    glyph="◧", dialect="2009", max_occurs=1, category="Backstage",
))

_add(Elem(
    key="backstage:button", name="button",
    doc="A command placed directly on the Backstage navigation bar.",
    attrs=BS_COMMON + IMAGES + (ON_ACTION,
          A("isDefinitive", BOOL, "Close Backstage as soon as the button is clicked.", G_STATE, values=("true", "false")),) + INSERT,
    glyph="⬜", dialect="2009", category="Backstage",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(
    key="backstage:tab", name="tab",
    doc="A page of the Backstage view.",
    attrs=BS_COMMON + (
        A("columnWidthPercent", INT, "Width of the first column as a percentage (1-100).", G_LAYOUT, min_value=1, max_value=100),
        A("firstColumnMinWidth", INT, "Minimum width of column one, in pixels.", G_LAYOUT, min_value=0),
        A("firstColumnMaxWidth", INT, "Maximum width of column one, in pixels.", G_LAYOUT, min_value=0),
        A("secondColumnMinWidth", INT, "Minimum width of column two, in pixels.", G_LAYOUT, min_value=0),
        A("secondColumnMaxWidth", INT, "Maximum width of column two, in pixels.", G_LAYOUT, min_value=0),
        A("title", STRING, "Heading shown at the top of the page.", G_TEXT),
        A("getTitle", CALLBACK, "Callback returning the page heading.", G_CALLBACK),
        A("onShow", CALLBACK, "Callback run when this page is shown.", G_CALLBACK),
        A("onHide", CALLBACK, "Callback run when this page is hidden.", G_CALLBACK),
    ) + INSERT,
    children=("firstColumn", "secondColumn"),
    glyph="▭", dialect="2009", category="Backstage",
    requires_one_of=(("id", "idQ", "idMso"),), exclusive=EXCLUSIVE_IDS,
))

_add(Elem(key="firstColumn", name="firstColumn", doc="Left column of a Backstage page.",
          children=("backstage:group", "taskFormGroup"), glyph="▌", dialect="2009",
          max_occurs=1, category="Backstage"))
_add(Elem(key="secondColumn", name="secondColumn", doc="Right column of a Backstage page.",
          children=("backstage:group", "taskFormGroup"), glyph="▐", dialect="2009",
          max_occurs=1, category="Backstage"))

_add(Elem(
    key="backstage:group", name="group",
    doc="A titled block of Backstage controls.",
    attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL, VISIBLE, GET_VISIBLE, SHOW_LABEL, GET_SHOW_LABEL,
           A("style", ENUM, "Visual treatment of the block.", G_LAYOUT, values=("normal", "warning", "error")),
           A("getStyle", CALLBACK, "Callback returning the style.", G_CALLBACK),
           A("helperText", STRING, "Explanatory text under the group label.", G_TEXT),
           A("getHelperText", CALLBACK, "Callback returning the helper text.", G_CALLBACK)) + INSERT,
    children=("primaryItem", "topItems", "bottomItems"),
    glyph="▦", dialect="2009", category="Backstage",
))

_add(Elem(key="primaryItem", name="primaryItem", doc="The prominent control on the left of a Backstage group.",
          children=("backstage:button", "backstage:menu"), glyph="⭐", dialect="2009",
          max_occurs=1, category="Backstage"))
_add(Elem(key="topItems", name="topItems", doc="Controls above the group's helper text.",
          children=("layoutContainer", "backstage:button", "backstage:checkBox", "backstage:comboBox",
                    "backstage:dropDown", "backstage:editBox", "groupBox", "hyperlink", "imageControl",
                    "backstage:labelControl", "backstage:menu", "radioGroup"),
          glyph="⬆", dialect="2009", max_occurs=1, category="Backstage"))
_add(Elem(key="bottomItems", name="bottomItems", doc="Controls below the group's helper text.",
          children=("layoutContainer", "backstage:button", "backstage:checkBox", "backstage:comboBox",
                    "backstage:dropDown", "backstage:editBox", "groupBox", "hyperlink", "imageControl",
                    "backstage:labelControl", "backstage:menu", "radioGroup"),
          glyph="⬇", dialect="2009", max_occurs=1, category="Backstage"))

_add(Elem(key="layoutContainer", name="layoutContainer",
          doc="Lays out Backstage children horizontally or vertically.",
          attrs=(ID, IDQ, VISIBLE, GET_VISIBLE,
                 A("layoutChildren", ENUM, "Direction the children flow in.", G_LAYOUT, values=("horizontal", "vertical")),
                 A("align", ENUM, "Horizontal alignment of the container.", G_LAYOUT, values=("left", "right")),
                 A("expand", ENUM, "Let the container grow to fill the column.", G_LAYOUT, values=("horizontal", "vertical", "both", "none")),
                 ) + INSERT,
          children=("layoutContainer", "backstage:button", "backstage:checkBox", "backstage:comboBox",
                    "backstage:dropDown", "backstage:editBox", "groupBox", "hyperlink", "imageControl",
                    "backstage:labelControl", "backstage:menu", "radioGroup"),
          glyph="▧", dialect="2009", category="Backstage"))

_add(Elem(key="groupBox", name="groupBox", doc="A bordered sub-box inside a Backstage group.",
          attrs=(ID, IDQ, LABEL, GET_LABEL, VISIBLE, GET_VISIBLE, SHOW_LABEL, GET_SHOW_LABEL) + INSERT,
          children=("layoutContainer", "backstage:button", "backstage:checkBox", "backstage:comboBox",
                    "backstage:dropDown", "backstage:editBox", "groupBox", "hyperlink", "imageControl",
                    "backstage:labelControl", "backstage:menu", "radioGroup"),
          glyph="▢", dialect="2009", category="Backstage"))

_add(Elem(key="backstage:labelControl", name="labelControl", doc="Static Backstage text.",
          attrs=(ID, IDQ, TAG, LABEL, GET_LABEL, VISIBLE, GET_VISIBLE,
                 A("noWrap", BOOL, "Prevent the text from wrapping.", G_LAYOUT, values=("true", "false"))) + INSERT,
          glyph="T", dialect="2009", category="Backstage"))

_add(Elem(key="hyperlink", name="hyperlink", doc="A Backstage link.",
          attrs=(ID, IDQ, TAG, LABEL, GET_LABEL, VISIBLE, GET_VISIBLE, IMAGE_A, IMAGEMSO_A, GET_IMAGE,
                 A("target", STRING, "URL or path to open.", G_TEXT),
                 A("getTarget", CALLBACK, "Callback returning the target.", G_CALLBACK),
                 A("noWrap", BOOL, "Prevent the text from wrapping.", G_LAYOUT, values=("true", "false"))) + INSERT,
          glyph="⚭", dialect="2009", category="Backstage"))

_add(Elem(key="imageControl", name="imageControl", doc="A picture in the Backstage view.",
          attrs=(ID, IDQ, TAG, IMAGE_A, IMAGEMSO_A, GET_IMAGE, VISIBLE, GET_VISIBLE,
                 A("altText", STRING, "Accessible description of the picture.", G_TEXT),
                 A("getAltText", CALLBACK, "Callback returning the alt text.", G_CALLBACK)) + INSERT,
          glyph="▣", dialect="2009", category="Backstage"))

_add(Elem(key="radioGroup", name="radioGroup", doc="A set of mutually exclusive Backstage options.",
          attrs=(ID, IDQ, TAG, LABEL, GET_LABEL, VISIBLE, GET_VISIBLE, ENABLED, GET_ENABLED,
                 A("getSelectedItemIndex", CALLBACK, "Callback returning the selected index.", G_CALLBACK),
                 A("getItemCount", CALLBACK, "Callback returning the number of options.", G_CALLBACK),
                 A("getItemLabel", CALLBACK, "Callback returning an option label.", G_CALLBACK),
                 A("getItemID", CALLBACK, "Callback returning an option id.", G_CALLBACK),
                 ON_ACTION) + INSERT,
          children=("radioButton",), glyph="◉", dialect="2009", category="Backstage"))

_add(Elem(key="radioButton", name="radioButton", doc="One option inside a radioGroup.",
          attrs=(ID, IDQ, TAG, LABEL, GET_LABEL, VISIBLE, GET_VISIBLE, ENABLED, GET_ENABLED),
          glyph="○", dialect="2009", category="Backstage"))

for _bs_key, _bs_src in (
    ("backstage:checkBox", "checkBox"),
    ("backstage:comboBox", "comboBox"),
    ("backstage:dropDown", "dropDown"),
    ("backstage:editBox", "editBox"),
    ("backstage:menu", "menu"),
):
    _src = SCHEMA[_bs_src]
    _add(Elem(key=_bs_key, name=_src.name, doc=_src.doc + " (Backstage variant.)",
              attrs=_src.attrs,
              children=tuple("backstage:button" if c == "button" else c for c in _src.children),
              glyph=_src.glyph, dialect="2009", category="Backstage",
              requires_one_of=_src.requires_one_of, exclusive=_src.exclusive))

_add(Elem(key="taskFormGroup", name="taskFormGroup",
          doc="A Backstage group that hosts a list of tasks (like Print or Share).",
          attrs=(ID, IDQ, IDMSO, LABEL, GET_LABEL, VISIBLE, GET_VISIBLE, SHOW_LABEL, GET_SHOW_LABEL,
                 A("helperText", STRING, "Explanatory text.", G_TEXT)) + INSERT,
          children=("category", "task"), glyph="☷", dialect="2009", category="Backstage"))
_add(Elem(key="category", name="category", doc="A heading that groups related tasks.",
          attrs=(ID, IDQ, LABEL, GET_LABEL, VISIBLE, GET_VISIBLE,
                 A("helperText", STRING, "Explanatory text.", G_TEXT)) + INSERT,
          children=("task",), glyph="≡", dialect="2009", category="Backstage"))
_add(Elem(key="task", name="task", doc="One task entry in a taskFormGroup.",
          attrs=(ID, IDQ, IDMSO, TAG, LABEL, GET_LABEL, DESCRIPTION, GET_DESCRIPTION,
                 IMAGE_A, IMAGEMSO_A, GET_IMAGE, VISIBLE, GET_VISIBLE, ENABLED, GET_ENABLED,
                 A("isDefinitive", BOOL, "Close Backstage when the task is chosen.", G_STATE, values=("true", "false")),
                 ON_ACTION) + INSERT,
          children=("backstage:group", "taskFormGroup"), glyph="✒", dialect="2009", category="Backstage"))


# ------------------------------------------------------------------- resolution
_LOCAL_INDEX: Dict[str, List[str]] = {}
for _key, _elem in SCHEMA.items():
    _LOCAL_INDEX.setdefault(_elem.name, []).append(_key)

_PARENTS: Dict[str, List[str]] = {}
for _key, _elem in SCHEMA.items():
    for _child in _elem.children:
        _PARENTS.setdefault(_child, []).append(_key)


def get(key: str) -> Optional[Elem]:
    return SCHEMA.get(key)


def child_key(parent_key: Optional[str], local_name: str) -> Optional[str]:
    """Resolve a local element name against the parent's allowed children."""
    if parent_key is None:
        return "customUI" if local_name == "customUI" else None
    parent = SCHEMA.get(parent_key)
    if parent is None:
        return None
    for key in parent.children:
        elem = SCHEMA.get(key)
        if elem is not None and elem.name == local_name:
            return key
    return None


def key_for_chain(locals_chain: Sequence[str]) -> Optional[str]:
    """Resolve a chain of local names (root first) to a schema key."""
    key: Optional[str] = None
    for index, local in enumerate(locals_chain):
        key = child_key(key if index else None, local)
        if key is None:
            return None
    return key


def key_for_node(node) -> Optional[str]:
    chain: List[str] = []
    cursor = node
    while cursor is not None and getattr(cursor, "kind", "element") == "element":
        chain.append(cursor.local)
        cursor = cursor.parent
    chain.reverse()
    return key_for_chain(chain)


def elem_for_node(node) -> Optional[Elem]:
    key = key_for_node(node)
    return SCHEMA.get(key) if key else None


def allowed_children(node) -> List[Elem]:
    elem = elem_for_node(node)
    if elem is None:
        return []
    return [SCHEMA[k] for k in elem.children if k in SCHEMA]


def parents_of(key: str) -> List[str]:
    return _PARENTS.get(key, [])


def any_elem_named(local: str) -> Optional[Elem]:
    keys = _LOCAL_INDEX.get(local)
    return SCHEMA[keys[0]] if keys else None


def known_local_names() -> List[str]:
    return sorted(_LOCAL_INDEX)


# ------------------------------------------------------- scaffolding on insert
DEFAULT_ATTRS: Dict[str, Dict[str, str]] = {
    "tab": {"id": "customTab", "label": "New Tab"},
    "group": {"id": "customGroup", "label": "New Group"},
    "button": {"id": "customButton", "label": "Button", "imageMso": "HappyFace",
               "size": "large", "onAction": "OnButtonClick"},
    "toggleButton": {"id": "customToggle", "label": "Toggle", "imageMso": "TableDesign",
                     "size": "large", "onAction": "OnToggle", "getPressed": "GetToggled"},
    "checkBox": {"id": "customCheck", "label": "Check box", "onAction": "OnCheck", "getPressed": "GetChecked"},
    "editBox": {"id": "customEdit", "label": "Text", "onChange": "OnTextChange", "getText": "GetText", "sizeString": "WWWWWWWWWW"},
    "comboBox": {"id": "customCombo", "label": "Choose", "getItemCount": "GetItemCount",
                 "getItemLabel": "GetItemLabel", "onChange": "OnComboChange"},
    "dropDown": {"id": "customDropDown", "label": "Choose", "getItemCount": "GetItemCount",
                 "getItemLabel": "GetItemLabel", "onAction": "OnDropDownAction"},
    "gallery": {"id": "customGallery", "label": "Gallery", "columns": "3", "itemWidth": "48",
                "itemHeight": "48", "getItemCount": "GetItemCount", "getItemImage": "GetItemImage",
                "onAction": "OnGalleryAction"},
    "menu": {"id": "customMenu", "label": "Menu", "imageMso": "ListMacros", "size": "large"},
    "dynamicMenu": {"id": "customDynamicMenu", "label": "Dynamic", "imageMso": "ListMacros",
                    "size": "large", "getContent": "GetMenuContent"},
    "splitButton": {"id": "customSplit", "size": "large"},
    "box": {"id": "customBox", "boxStyle": "vertical"},
    "buttonGroup": {"id": "customButtonGroup"},
    "labelControl": {"id": "customLabel", "label": "Label"},
    "separator": {"id": "customSeparator"},
    "menuSeparator": {"id": "customMenuSeparator"},
    "item": {"id": "customItem", "label": "Item"},
    "control": {"idMso": "FileSave"},
    "command": {"idMso": "FileSave", "onAction": "OnRepurposedSave"},
    "tabSet": {"idMso": "TabSetChartTools"},
    "contextMenu": {"idMso": "ContextMenuCell"},
    "dialogBoxLauncher": {},
    "backstage:tab": {"id": "customBackstageTab", "label": "My Page"},
    "backstage:group": {"id": "customBackstageGroup", "label": "My Group"},
    "backstage:button": {"id": "customBackstageButton", "label": "Do It", "onAction": "OnBackstageAction"},
    "radioGroup": {"id": "customRadioGroup", "label": "Options", "onAction": "OnRadioAction"},
    "radioButton": {"id": "customRadioButton", "label": "Option"},
    "hyperlink": {"id": "customLink", "label": "Open the docs", "target": "https://learn.microsoft.com"},
    "imageControl": {"id": "customImage", "imageMso": "HappyFace"},
    "task": {"id": "customTask", "label": "Task", "imageMso": "HappyFace"},
    "category": {"id": "customCategory", "label": "Category"},
}

# Children automatically added so a new node is immediately meaningful.
SCAFFOLD: Dict[str, Tuple[str, ...]] = {
    "customUI": ("ribbon",),
    "ribbon": ("tabs",),
    "tabs": ("tab",),
    "tab": ("group",),
    "group": ("button",),
    "splitButton": ("button", "menu"),
    "dialogBoxLauncher": ("button",),
    "qat": ("sharedControls",),
    "contextualTabs": ("tabSet",),
    "tabSet": ("tab",),
    "commands": ("command",),
    "contextMenus": ("contextMenu",),
    "backstage": ("backstage:tab",),
    "backstage:tab": ("firstColumn",),
    "firstColumn": ("backstage:group",),
    "secondColumn": ("backstage:group",),
    "backstage:group": ("topItems",),
    "topItems": ("backstage:button",),
    "radioGroup": ("radioButton",),
    "taskFormGroup": ("task",),
}

# Controls offered in the "Insert control" palette, in a sensible order.
QUICK_INSERT = [
    "button", "toggleButton", "checkBox", "editBox", "comboBox", "dropDown",
    "gallery", "menu", "dynamicMenu", "splitButton", "labelControl",
    "separator", "menuSeparator", "box", "buttonGroup", "control", "item",
]


def make_node(key: str, xmldoc_module) -> "object":
    """Create a fully scaffolded node for the given schema key."""
    elem = SCHEMA.get(key)
    if elem is None:
        return None
    node = xmldoc_module.build(elem.name, dict(DEFAULT_ATTRS.get(key, {})))
    for child_key_name in SCAFFOLD.get(key, ()):  # noqa: F402 - shadow is intentional
        child = make_node(child_key_name, xmldoc_module)
        if child is not None:
            node.add(child)
    return node
