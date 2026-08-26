"""Headless GUI smoke test: builds the window, drives the main flows and
saves screenshots. Run under xvfb-run."""
from __future__ import annotations
import os, sys, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

OUT = os.environ.get("SHOT_DIR", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)

from ribbonforge.app import RibbonForgeApp
from ribbonforge.core.ooxml import V2007, V2010

failures = []


def shot(app, name, settle=6):
    for _ in range(settle):
        app.update_idletasks(); app.update()
    try:
        from PIL import ImageGrab
        img = ImageGrab.grab(xdisplay=os.environ.get("DISPLAY"))
        img.save(os.path.join(OUT, f"{name}.png"))
        print(f"  shot {name}.png {img.size}")
    except Exception as exc:
        print(f"  (screenshot failed: {exc})")


def wait_for(app, condition, timeout=6.0):
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        app.update_idletasks(); app.update()
        if condition():
            return True
        time.sleep(0.02)
    return False


def step(name, fn, app):
    print(f"[step] {name}")
    try:
        fn()
        for _ in range(4):
            app.update_idletasks(); app.update()
    except Exception:
        failures.append((name, traceback.format_exc()))
        print(f"  FAILED: {name}")
        traceback.print_exc()


def main():
    sample = sys.argv[1]
    app = RibbonForgeApp([sample])
    app.geometry("1600x980+0+0")
    assert wait_for(app, lambda: app.part is not None), "the sample never finished loading"
    shot(app, "01-main-dark")

    part = app.part
    assert part is not None, "sample did not load"
    print("  loaded:", app.document.name, app.document.variants(), part.report.counts())

    # select a node in the tree
    def select_button():
        node = part.tree.root.find_all("button")[0]
        app.structure.select_uid(node.uid)
    step("select a control", select_button, app)
    shot(app, "02-selected")

    step("edit a property", lambda: app.properties._set_value(
        app.properties.node, "label", "Build report NOW"), app)

    def properties_scrolls():
        app.properties._show_all.set(True)
        app.properties._render()
        for _ in range(8):
            app.update_idletasks(); app.update()
        canvas = app.properties.scroll.canvas
        first, last = canvas.yview()
        assert last < 1.0, "properties content should overflow with every attribute shown"
        canvas.yview_moveto(0.5)
        app.update_idletasks()
        assert canvas.yview()[0] > 0.2, "properties canvas did not scroll"
        canvas.yview_moveto(0.0)
        app.properties._show_all.set(False)
        app.properties._render()
    step("properties panel scrolls", properties_scrolls, app)
    assert "Build report NOW" in app.editor.get_text(), "property edit did not reach the editor"

    before = len(part.tree.root.find_all("toggleButton"))
    step("insert a control", lambda: app.structure.insert_child("toggleButton"), app)
    after = len(app.part.tree.root.find_all("toggleButton"))
    assert after == before + 1, f"insert produced {after - before} toggleButtons"
    assert "<button" in app.editor.get_text()
    assert app.part.report.counts()[0] == 0, [i.message for i in app.part.report.issues]
    step("duplicate", app.structure.duplicate_selected, app)
    step("move up", lambda: app.structure.move_selected(-1), app)
    assert app.preview.document is app.part.tree, "the preview is showing a stale tree"
    labels = [n.get("label") for n in app.preview._node_map.values() if n.get("label")]
    assert "Build report NOW" in labels, f"preview did not pick up the edit: {labels}"
    assert "Toggle" in labels, f"preview missing the inserted control: {labels}"
    shot(app, "03-after-edits")

    step("reformat", app.format_document, app)
    assert app.part.parse_ok, "reformat broke the document"
    step("validate", app.validate_now, app)

    # break the XML and check recovery
    def break_xml():
        app.editor.set_text(app.editor.get_text().replace("</group>", "</groupp>", 1))
        app.on_editor_change()
    step("introduce a syntax error", break_xml, app)
    assert not app.part.parse_ok, "syntax error was not detected"
    assert app.part.tree.root is not None, "structure view lost its last good tree"
    shot(app, "04-syntax-error")
    step("undo the error", lambda: app._editor_edit("undo"), app)
    assert len(app.editor.get_text()) > 500, "undo emptied the document"
    assert app.part.parse_ok, "undo did not restore well-formed XML"
    assert "</groupp>" not in app.editor.get_text(), "undo did not remove the bad edit"

    # drag and drop: move the second group's first control into the first group
    def drag_control():
        tree = app.structure
        groups = app.part.tree.root.find_all("group")
        source = groups[1].elements[0]
        target = groups[0]
        tree._drag_item = tree._by_uid[source.uid]
        tree._drop_marker = (tree._by_uid[target.uid], "into")
        assert tree._can_drop(tree._drag_item, tree._by_uid[target.uid], "into")
        tree._drag_release(type("E", (), {"x": 0, "y": 0})())
    step("drag a control into another group", drag_control, app)
    assert app.part.parse_ok
    moved = app.part.tree.root.find_all("group")[0]
    assert any(c.local == "box" for c in moved.elements), "drag and drop did not reparent"

    def reject_bad_drag():
        tree = app.structure
        button = app.part.tree.root.find_all("button")[0]
        tab = app.part.tree.root.find_all("tab")[0]
        assert not tree._can_drop(tree._by_uid[button.uid], tree._by_uid[tab.uid], "into"), \
            "a button should not be droppable straight into a tab"
    step("drag and drop respects the schema", reject_bad_drag, app)

    def view_modes():
        for mode in ("xml", "preview", "design", "both"):
            app.view_switch.select(mode)
            for _ in range(3):
                app.update_idletasks(); app.update()
            panes = [str(p) for p in app.centre_panes.panes()]
            if mode in ("both", "preview", "design"):
                assert str(app.design_row) in panes, (mode, panes)
            else:
                assert str(app.design_row) not in panes, (mode, panes)
            if mode in ("both", "xml"):
                assert str(app.editor.master) in panes, (mode, panes)
            else:
                assert str(app.editor.master) not in panes, (mode, panes)
            assert (mode == "design") == app.drag_controller.enabled
        # panes must stay in preview / editor / problems order, and be visible
        panes = [str(p) for p in app.centre_panes.panes()]
        assert panes == [str(app.design_row), str(app.editor.master), str(app.problems)], panes
        for _ in range(20):
            app.update_idletasks(); app.update()
        assert app.preview.winfo_height() > 100, f"preview collapsed: {app.preview.winfo_height()}"
        assert app.editor.winfo_height() > 100, f"editor collapsed: {app.editor.winfo_height()}"
        assert app.problems.winfo_height() < 90, f"problems too tall: {app.problems.winfo_height()}"
    step("view modes", view_modes, app)

    def undo_via_keyboard():
        before = app.editor.get_text()
        app.editor.text.insert("1.0", "<!-- typed -->\n")
        app.on_editor_change()
        app._editor_edit("undo")
        assert app.editor.get_text().strip() == before.strip(), "keyboard undo did not restore"
    step("undo a manual edit", undo_via_keyboard, app)

    # ---- design mode: palette drop + preview drag
    def design_mode():
        app.view_switch.select("design")
        for _ in range(10):
            app.update_idletasks(); app.update()
        assert app.palette.winfo_ismapped(), "palette not shown in design mode"
        assert app.drag_controller.enabled, "preview drag not enabled"
    step("enter design mode", design_mode, app)
    shot(app, "17-design-mode")

    def palette_drop():
        groups = [g for g in app.part.tree.root.find_all("group")
                  if "backstage" not in [a.local for a in g.ancestors()]]
        target = groups[0]
        before = len(target.find_all("gallery"))
        app.designer_insert("gallery", target)
        for _ in range(4):
            app.update_idletasks(); app.update()
        groups2 = [g for g in app.part.tree.root.find_all("group")
                   if "backstage" not in [a.local for a in g.ancestors()]]
        assert len(groups2[0].find_all("gallery")) == before + 1, "palette drop failed"
        assert app.part.report.counts()[0] == 0, [i.message for i in app.part.report.issues]
    step("drop a gallery from the palette", palette_drop, app)

    def designer_move_test():
        groups = [g for g in app.part.tree.root.find_all("group")
                  if "backstage" not in [a.local for a in g.ancestors()]]
        src_group, dst_group = groups[0], groups[1]
        control = src_group.find_all("gallery")[0]
        app.designer_move(control, dst_group)
        for _ in range(4):
            app.update_idletasks(); app.update()
        groups2 = [g for g in app.part.tree.root.find_all("group")
                   if "backstage" not in [a.local for a in g.ancestors()]]
        assert groups2[1].find_all("gallery"), "designer move failed"
    step("move a control between groups", designer_move_test, app)
    shot(app, "18-design-after-drop")

    def quest_progress():
        app.palette.mark_quest("tab"); app.palette.mark_quest("group")
        app.palette.mark_quest("button")
        assert sum(1 for v in app.palette.quests.values() if v) >= 3
    step("quest checklist", quest_progress, app)

    def drop_target_resolution():
        class FakeEvent:
            pass
        # target resolution falls back to a legal home even off-canvas
        target = app.palette._fallback_target("button", app.part.tree)
        assert target is not None and target.local == "group", target
        target = app.palette._fallback_target("tab", app.part.tree)
        assert target is not None and target.local == "tabs", target
    step("drop target fallbacks", drop_target_resolution, app)

    step("leave design mode", lambda: app.view_switch.select("both"), app)

    step("switch to preview-only", lambda: app.view_switch.select("preview"), app)
    shot(app, "05-preview-only")
    step("back to both", lambda: app.view_switch.select("both"), app)

    step("preview: backstage", lambda: app.preview.set_mode("backstage"), app)
    shot(app, "06-backstage")
    step("preview: context menus", lambda: app.preview.set_mode("contextMenus"), app)
    shot(app, "07-contextmenus")
    step("preview: ribbon", lambda: app.preview.set_mode("ribbon"), app)

    step("light theme", lambda: app.set_theme("light"), app)
    shot(app, "08-light")
    step("dark theme", lambda: app.set_theme("dark"), app)

    # dialogs
    def open_icon_gallery():
        from ribbonforge.ui.dialogs import IconGallery
        from ribbonforge.core import msoicons
        dialog = IconGallery(app, app.theme, "FileSave")
        dialog.deiconify(); dialog.lift()
        for _ in range(8):
            app.update_idletasks(); app.update()
        assert len(dialog._items) > 3000, f"catalogue too small: {len(dialog._items)}"
        if msoicons.is_installed():
            assert dialog.icons.pack.has("GridSettings"), "GridSettings missing from pack"
            assert dialog.icons.pack.icon("FileSave", 32) is not None, "real icon failed to load"
        dialog.search.var.set("GridSettings")
        for _ in range(6):
            app.update_idletasks(); app.update()
        assert dialog._items and dialog._items[0][0] == "GridSettings", dialog._items[:3]
        dialog.search.var.set("chart")
        for _ in range(6):
            app.update_idletasks(); app.update()
        shot(app, "09-icons")
        dialog.destroy()
    step("icon gallery", open_icon_gallery, app)

    def open_callbacks():
        from ribbonforge.ui.dialogs import CallbackDialog
        dialog = CallbackDialog(app, app.theme, app.part.tree, app.settings)
        dialog.deiconify(); dialog.lift()
        for _ in range(8):
            app.update_idletasks(); app.update()
        text = dialog.text.get("1.0", "end-1c")
        assert "Sub OnBuildReport" in text, "callback generation missed a control"
        shot(app, "10-callbacks")
        dialog.destroy()
    step("callback generator", open_callbacks, app)

    def open_templates():
        from ribbonforge.ui.dialogs import TemplateGallery
        dialog = TemplateGallery(app, app.theme, "customUI14.xml")
        dialog.deiconify(); dialog.lift()
        for _ in range(8):
            app.update_idletasks(); app.update()
        shot(app, "11-templates")
        dialog.destroy()
    step("template gallery", open_templates, app)

    def open_palette():
        from ribbonforge.ui.dialogs import CommandPalette
        palette = CommandPalette(app, app.theme, [("Validate the ribbon", "F5", lambda: None),
                                                  ("Reformat the XML", "Ctrl+Shift+F", lambda: None),
                                                  ("Generate VBA callbacks", "F9", lambda: None)])
        for _ in range(6):
            app.update_idletasks(); app.update()
        shot(app, "12-palette")
        palette.destroy()
    step("command palette", open_palette, app)

    def open_images():
        from ribbonforge.ui.dialogs import ImageManager
        dialog = ImageManager(app, app.theme, app.document.package, app.part, lambda: None)
        dialog.deiconify(); dialog.lift()
        for _ in range(6):
            app.update_idletasks(); app.update()
        dialog.tree.selection_set("logo")
        for _ in range(4):
            app.update_idletasks(); app.update()
        shot(app, "13-images")
        dialog.destroy()
    step("image manager", open_images, app)

    # completions
    def completions():
        from ribbonforge.ui.codeeditor import CompletionContext
        ctx = CompletionContext("element", ["customUI", "ribbon", "tabs", "tab", "group"])
        items = app.provide_completions(ctx)
        names = [i.label for i in items]
        assert "button" in names and "gallery" in names, names[:10]
        ctx = CompletionContext("attribute", ["customUI", "ribbon", "tabs", "tab"], "group")
        assert "label" in [i.label for i in app.provide_completions(ctx)]
        ctx = CompletionContext("value", ["customUI", "ribbon", "tabs", "tab", "group"],
                                "button", "size")
        assert [i.label for i in app.provide_completions(ctx)] == ["normal", "large"]
        ctx = CompletionContext("value", ["customUI", "ribbon", "tabs", "tab", "group"],
                                "button", "imageMso")
        assert len(app.provide_completions(ctx)) > 100
        print("  completions ok")
    step("completion provider", completions, app)

    # add a 2007 part, then remove it
    step("add customUI.xml", lambda: app.document.add_part(V2007, "starter"), app)
    step("refresh explorer", app.refresh_explorer, app)
    step("activate 2007 part", lambda: app.activate(app.document, app.document.parts[V2007]), app)
    shot(app, "14-two-parts")
    step("back to 2010", lambda: app.activate(app.document, app.document.parts[V2010]), app)

    # save
    target = os.path.join(os.environ.get("SHOT_DIR", "/tmp"), "saved.xlsm")
    step("save as", lambda: app._write(app.document, target), app)
    assert os.path.exists(target), "save produced no file"

    step("new document from template", lambda: app.documents.append(
        __import__("ribbonforge.core.document", fromlist=["RibbonDocument"]).RibbonDocument.new_xml(
            V2010, "toolbelt")), app)
    step("activate new", lambda: app.activate(app.documents[-1], app.documents[-1].first_part()), app)
    shot(app, "15-toolbelt")

    step("problems panel population", lambda: app.problems.set_report(
        app.part.report, app.part), app)

    step("close all", lambda: [app.documents.clear(), app.refresh_explorer(),
                               app._show_welcome()], app)
    shot(app, "16-welcome")

    app.destroy()
    if failures:
        print(f"\n{len(failures)} FAILURES")
        for name, tb in failures:
            print("=" * 60); print(name); print(tb)
        return 1
    print("\nAll GUI steps passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
