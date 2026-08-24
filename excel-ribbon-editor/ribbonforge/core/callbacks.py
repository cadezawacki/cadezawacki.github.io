"""Turn the callback attributes in a ribbon document into ready-to-paste VBA."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from . import schema
from .xmldoc import Node, XmlDocument

# (parameters, returned-value type, body lines)
_STD = "control As IRibbonControl"
_RET = "ByRef returnedVal"

SIGNATURES: Dict[str, Tuple[str, str, str]] = {
    "onLoad":               ("ribbon As IRibbonUI", "", ""),
    "loadImage":            ("imageId As String, ByRef returnedVal", "IPictureDisp", ""),
    "onShow":               ("contextObject As Object", "", ""),
    "onHide":               ("contextObject As Object", "", ""),
    "getLabel":             (f"{_STD}, {_RET}", "String", '"Label"'),
    "getScreentip":         (f"{_STD}, {_RET}", "String", '"Screen tip"'),
    "getSupertip":          (f"{_STD}, {_RET}", "String", '"A longer explanation."'),
    "getDescription":       (f"{_STD}, {_RET}", "String", '"Description"'),
    "getKeytip":            (f"{_STD}, {_RET}", "String", '"Z"'),
    "getTitle":             (f"{_STD}, {_RET}", "String", '"Title"'),
    "getHelperText":        (f"{_STD}, {_RET}", "String", '"Helper text"'),
    "getTarget":            (f"{_STD}, {_RET}", "String", '"https://example.com"'),
    "getAltText":           (f"{_STD}, {_RET}", "String", '"Picture description"'),
    "getText":              (f"{_STD}, {_RET}", "String", '""'),
    "getVisible":           (f"{_STD}, {_RET}", "Boolean", "True"),
    "getEnabled":           (f"{_STD}, {_RET}", "Boolean", "True"),
    "getPressed":           (f"{_STD}, {_RET}", "Boolean", "False"),
    "getShowLabel":         (f"{_STD}, {_RET}", "Boolean", "True"),
    "getShowImage":         (f"{_STD}, {_RET}", "Boolean", "True"),
    "getSize":              (f"{_STD}, {_RET}", "RibbonControlSize", "msoRibbonControlSizeLarge"),
    "getStyle":             (f"{_STD}, {_RET}", "String", '"normal"'),
    "getImage":             (f"{_STD}, {_RET}", "IPictureDisp", ""),
    "getContent":           (f"{_STD}, {_RET}", "String (menu XML)", ""),
    "getItemCount":         (f"{_STD}, {_RET}", "Integer", "3"),
    "getItemLabel":         (f"{_STD}, index As Integer, {_RET}", "String", '"Item " & index + 1'),
    "getItemID":            (f"{_STD}, index As Integer, {_RET}", "String", '"item" & index'),
    "getItemScreentip":     (f"{_STD}, index As Integer, {_RET}", "String", '"Item " & index + 1'),
    "getItemSupertip":      (f"{_STD}, index As Integer, {_RET}", "String", '""'),
    "getItemImage":         (f"{_STD}, index As Integer, {_RET}", "IPictureDisp", ""),
    "getItemHeight":        (f"{_STD}, {_RET}", "Integer", "32"),
    "getItemWidth":         (f"{_STD}, {_RET}", "Integer", "32"),
    "getSelectedItemIndex": (f"{_STD}, {_RET}", "Integer", "0"),
    "getSelectedItemID":    (f"{_STD}, {_RET}", "String", '"item0"'),
    "onChange":             (f"{_STD}, text As String", "", ""),
}

# onAction changes shape depending on the control it sits on.
_ON_ACTION: Dict[str, Tuple[str, str]] = {
    "toggleButton": (f"{_STD}, pressed As Boolean", ""),
    "checkBox":     (f"{_STD}, pressed As Boolean", ""),
    "backstage:checkBox": (f"{_STD}, pressed As Boolean", ""),
    "gallery":      (f"{_STD}, selectedId As String, selectedIndex As Integer", ""),
    "dropDown":     (f"{_STD}, selectedId As String, selectedIndex As Integer", ""),
    "backstage:dropDown": (f"{_STD}, selectedId As String, selectedIndex As Integer", ""),
    "radioGroup":   (f"{_STD}, selectedId As String, selectedIndex As Integer", ""),
    "command":      (f"{_STD}, ByRef cancelDefault", ""),
}


@dataclass
class CallbackUse:
    node: Node
    attribute: str
    element_key: str

    @property
    def control_label(self) -> str:
        ident = self.node.get("id") or self.node.get("idMso") or self.node.get("idQ") or "?"
        label = self.node.get("label")
        return f'{self.node.local} "{label}" ({ident})' if label else f"{self.node.local} ({ident})"


@dataclass
class Callback:
    name: str
    attribute: str
    parameters: str
    returns: str
    uses: List[CallbackUse] = field(default_factory=list)
    conflict: bool = False

    @property
    def signature(self) -> str:
        return f"Sub {self.name}({self.parameters})"


def signature_for(element_key: str, attribute: str) -> Tuple[str, str, str]:
    if attribute == "onAction":
        params, _ = _ON_ACTION.get(element_key, (_STD, ""))
        return (params, "", "")
    return SIGNATURES.get(attribute, (f"{_STD}, {_RET}", "Variant", ""))


def collect(document: XmlDocument) -> List[Callback]:
    """Gather every callback referenced by the document, in document order."""
    found: Dict[str, Callback] = {}
    order: List[str] = []
    if document.root is None:
        return []

    for node in document.root.iter_elements():
        elem = schema.elem_for_node(node)
        if elem is None:
            continue
        for raw_name, value in node.attrs.items():
            local = raw_name.rsplit(":", 1)[-1]
            attr = elem.attr(local)
            if attr is None or attr.kind != schema.CALLBACK:
                continue
            name = value.strip()
            if not name:
                continue
            params, returns, _ = signature_for(elem.key, local)
            existing = found.get(name)
            if existing is None:
                callback = Callback(name=name, attribute=local, parameters=params, returns=returns)
                callback.uses.append(CallbackUse(node, local, elem.key))
                found[name] = callback
                order.append(name)
            else:
                existing.uses.append(CallbackUse(node, local, elem.key))
                if existing.parameters != params:
                    existing.conflict = True
    return [found[name] for name in order]


def _wrap_comment(text: str, width: int = 78) -> List[str]:
    words, lines, current = text.split(), [], "'"
    for word in words:
        if len(current) + len(word) + 1 > width:
            lines.append(current)
            current = "'"
        current += " " + word
    if current.strip("'").strip():
        lines.append(current)
    return lines


HEADER_POINTER = '''#If VBA7 Then
    Private Declare PtrSafe Sub CopyMemory Lib "kernel32" Alias "RtlMoveMemory" _
        (ByVal Destination As LongPtr, ByVal Source As LongPtr, ByVal Length As LongPtr)
    Private lRibbonPointer As LongPtr
#Else
    Private Declare Sub CopyMemory Lib "kernel32" Alias "RtlMoveMemory" _
        (ByVal Destination As Long, ByVal Source As Long, ByVal Length As Long)
    Private lRibbonPointer As Long
#End If

' The ribbon object is lost whenever VBA state is reset (an unhandled error,
' or editing code while the add-in is loaded). Caching the pointer lets us
' rebuild the reference instead of forcing the user to reopen the file.
Private Sub CacheRibbonPointer(ribbon As IRibbonUI)
    lRibbonPointer = ObjPtr(ribbon)
End Sub

Private Function RibbonObject() As IRibbonUI
    Dim result As IRibbonUI
    If Not gRibbon Is Nothing Then
        Set RibbonObject = gRibbon
    ElseIf lRibbonPointer <> 0 Then
        CopyMemory VarPtr(result), VarPtr(lRibbonPointer), LenB(lRibbonPointer)
        Set gRibbon = result
        Set RibbonObject = result
        ' Release the temporary reference created by CopyMemory.
        CopyMemory VarPtr(result), 0&, LenB(lRibbonPointer)
    End If
End Function
'''


def generate_module(
    document: XmlDocument,
    module_name: str = "RibbonCallbacks",
    include_header: bool = True,
    include_pointer_recovery: bool = False,
    include_usage_comments: bool = True,
    on_load_name: str = "",
    existing_names: Optional[List[str]] = None,
) -> str:
    callbacks = collect(document)
    skip = {name.lower() for name in (existing_names or [])}
    lines: List[str] = []

    lines.append(f'Attribute VB_Name = "{module_name}"')
    lines.append("Option Explicit")
    lines.append("")
    lines.extend(_wrap_comment(
        "Ribbon callbacks generated by RibbonForge. Import this file into the "
        "VBA editor (File > Import File) or paste it into a standard module. "
        "Every procedure below is referenced by the ribbon XML; deleting one "
        "makes the matching control fail silently."))
    lines.append("")

    if include_header:
        lines.append("'==============================================================")
        lines.append("' Ribbon plumbing")
        lines.append("'==============================================================")
        lines.append("Public gRibbon As IRibbonUI")
        lines.append("")
        if include_pointer_recovery:
            lines.append(HEADER_POINTER)
        loader = on_load_name or _root_callback(document, "onLoad") or "RibbonOnLoad"
        if loader.lower() not in skip:
            lines.append(f"Public Sub {loader}(ribbon As IRibbonUI)")
            lines.append("    Set gRibbon = ribbon")
            if include_pointer_recovery:
                lines.append("    CacheRibbonPointer ribbon")
            lines.append("End Sub")
            lines.append("")
        lines.append("' Re-ask Office for the state of one control, or of everything.")
        lines.append("Public Sub RefreshRibbon(Optional controlId As String = vbNullString)")
        if include_pointer_recovery:
            lines.append("    Dim ribbon As IRibbonUI")
            lines.append("    Set ribbon = RibbonObject()")
            lines.append("    If ribbon Is Nothing Then Exit Sub")
            lines.append("    If Len(controlId) = 0 Then")
            lines.append("        ribbon.Invalidate")
            lines.append("    Else")
            lines.append("        ribbon.InvalidateControl controlId")
            lines.append("    End If")
        else:
            lines.append("    If gRibbon Is Nothing Then Exit Sub")
            lines.append("    If Len(controlId) = 0 Then")
            lines.append("        gRibbon.Invalidate")
            lines.append("    Else")
            lines.append("        gRibbon.InvalidateControl controlId")
            lines.append("    End If")
        lines.append("End Sub")
        lines.append("")

    if not callbacks:
        lines.append("' No callbacks are referenced by this ribbon yet.")
        return "\n".join(lines) + "\n"

    lines.append("'==============================================================")
    lines.append(f"' Callbacks ({len(callbacks)})")
    lines.append("'==============================================================")
    lines.append("")

    for callback in callbacks:
        if callback.name.lower() in skip:
            continue
        if include_usage_comments:
            targets = ", ".join(sorted({use.control_label for use in callback.uses}))
            lines.extend(_wrap_comment(f"{callback.attribute} for {targets}"))
            if callback.conflict:
                lines.extend(_wrap_comment(
                    "WARNING: this name is used by controls that need different "
                    "signatures. Give them separate procedures, or the ribbon will "
                    "fail at run time."))
            if callback.returns:
                lines.append(f"' returnedVal expects: {callback.returns}")
        lines.append(f"Public Sub {callback.name}({callback.parameters})")
        lines.extend(_body_for(callback))
        lines.append("End Sub")
        lines.append("")

    return "\n".join(lines) + "\n"


def _body_for(callback: Callback) -> List[str]:
    attribute = callback.attribute
    _, returns, default = signature_for(callback.uses[0].element_key if callback.uses else "", attribute)
    if attribute in SIGNATURES:
        _, returns, default = SIGNATURES[attribute]

    if attribute == "onAction":
        key = callback.uses[0].element_key if callback.uses else "button"
        tags = sorted({use.node.get("tag") or "" for use in callback.uses})
        body: List[str] = []
        if len([t for t in tags if t]) > 1:
            body.append("    Select Case control.Tag")
            for tag in tags:
                if not tag:
                    continue
                body.append(f'        Case "{tag}"')
                body.append(f"            MsgBox \"TODO: handle {tag}\"")
            body.append("        Case Else")
            body.append('            MsgBox "Unhandled tag: " & control.Tag')
            body.append("    End Select")
            return body
        if key in ("toggleButton", "checkBox", "backstage:checkBox"):
            return ["    MsgBox control.ID & \" is now \" & pressed"]
        if key in ("gallery", "dropDown", "backstage:dropDown", "radioGroup"):
            return ["    MsgBox \"Selected \" & selectedId & \" (index \" & selectedIndex & \")\""]
        if key == "command":
            return ["    ' Set cancelDefault = False to let Office run its own command as well.",
                    "    cancelDefault = True",
                    "    MsgBox \"Intercepted \" & control.ID"]
        return [f"    MsgBox \"TODO: {callback.name}\""]

    if attribute == "onChange":
        return ["    MsgBox control.ID & \" changed to \" & text"]
    if attribute in ("onShow", "onHide"):
        return ["    ' contextObject is the document the Backstage view was opened for."]
    if attribute == "loadImage":
        return ["    ' imageId is the value of the image= attribute in the XML.",
                "    ' Set returnedVal = LoadPicture(ThisWorkbook.Path & \"\\\" & imageId & \".bmp\")"]
    if attribute in ("getImage", "getItemImage"):
        return ["    ' Return an IPictureDisp, e.g. from stdole.LoadPicture or a PictureConverter.",
                "    ' Set returnedVal = LoadPicture(\"C:\\icons\\my.bmp\")"]
    if attribute == "getContent":
        return ['    Dim xml As String',
                '    xml = "<menu xmlns=""http://schemas.microsoft.com/office/2009/07/customui"">"',
                '    xml = xml & "<button id=""dyn1"" label=""Built at run time"" onAction=""OnRun""/>"',
                '    xml = xml & "</menu>"',
                '    returnedVal = xml']
    if default:
        return [f"    returnedVal = {default}"]
    return ["    ' TODO"]


def _root_callback(document: XmlDocument, attribute: str) -> str:
    if document.root is None:
        return ""
    return (document.root.get(attribute) or "").strip()


def summary(document: XmlDocument) -> List[Tuple[str, str, int]]:
    """(name, kind, number of controls) - used by the callbacks panel."""
    return [(cb.name, cb.attribute, len(cb.uses)) for cb in collect(document)]
