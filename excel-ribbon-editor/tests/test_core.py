"""Headless tests for everything that does not need a display."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from ribbonforge.core import callbacks, msodata, schema, templates, validator
from ribbonforge.core.document import RibbonDocument
from ribbonforge.core.ooxml import (NAMESPACE_FOR, V2007, V2010, OfficePackage,
                                    PackageError)
from ribbonforge.core.xmldoc import XmlDocument, build

import make_sample

SAMPLE_XML = '''<?xml version="1.0" encoding="UTF-8"?>
<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui" onLoad="RibbonOnLoad">
  <!-- a comment -->
  <ribbon startFromScratch="false">
    <tabs>
      <tab id="t1" label="Tools" insertAfterMso="TabHome">
        <group id="g1" label="Actions">
          <button id="b1" label="Go" imageMso="FileSave" size="large" onAction="OnGo"/>
          <toggleButton id="tb1" label="Watch" getPressed="GetWatch" onAction="OnWatch"/>
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
'''


class XmlDocumentTests(unittest.TestCase):
    def test_round_trip(self):
        doc = XmlDocument.parse(SAMPLE_XML)
        self.assertIsNone(doc.error)
        again = XmlDocument.parse(doc.serialize())
        self.assertIsNone(again.error)
        self.assertEqual(len(list(doc.root.iter_elements())),
                         len(list(again.root.iter_elements())))

    def test_comments_survive(self):
        doc = XmlDocument.parse(SAMPLE_XML)
        self.assertIn("<!-- a comment -->", doc.serialize())

    def test_attribute_order_is_preserved(self):
        doc = XmlDocument.parse(SAMPLE_XML)
        button = doc.root.find_all("button")[0]
        self.assertEqual(list(button.attrs), ["id", "label", "imageMso", "size", "onAction"])

    def test_positions(self):
        doc = XmlDocument.parse(SAMPLE_XML)
        button = doc.root.find_all("button")[0]
        line, column = button.position()
        self.assertEqual(SAMPLE_XML.splitlines()[line - 1][column:column + 7], "<button")
        line, column = button.attr_position("imageMso")
        self.assertEqual(SAMPLE_XML.splitlines()[line - 1][column:column + 8], "imageMso")

    def test_offsets_survive_non_ascii(self):
        doc = XmlDocument.parse('<customUI xmlns="x">\n  <ribbon label="café ünïcode"/>\n</customUI>')
        ribbon = doc.root.find("ribbon")
        line, column = ribbon.position()
        self.assertEqual((line, column), (2, 2))

    def test_path_key_round_trip(self):
        doc = XmlDocument.parse(SAMPLE_XML)
        key = doc.root.find_all("toggleButton")[0].path_key()
        again = XmlDocument.parse(doc.serialize())
        self.assertEqual(again.find_path(key).get("id"), "tb1")

    def test_syntax_error_reports_position(self):
        doc = XmlDocument.parse("<a>\n  <b>\n</a>")
        self.assertIsNotNone(doc.error)
        self.assertEqual(doc.error.line, 3)

    def test_node_at_offset(self):
        doc = XmlDocument.parse(SAMPLE_XML)
        offset = SAMPLE_XML.index("<button") + 3
        self.assertEqual(doc.node_at_offset(offset).local, "button")

    def test_escaping(self):
        node = build("button", {"label": 'A & B <c> "quoted"'})
        doc = XmlDocument()
        doc.root = node
        again = XmlDocument.parse(doc.serialize())
        self.assertIsNone(again.error)
        self.assertEqual(again.root.get("label"), 'A & B <c> "quoted"')

    def test_prefixed_names_round_trip(self):
        doc = XmlDocument.parse(
            '<mso:customUI xmlns:mso="urn:x"><mso:ribbon/></mso:customUI>')
        self.assertIsNone(doc.error)
        self.assertEqual(doc.root.tag, "mso:customUI")
        self.assertEqual(doc.root.local, "customUI")
        self.assertIn("<mso:ribbon/>", doc.serialize())


class UidAdoptionTests(unittest.TestCase):
    def test_uids_survive_a_formatting_only_edit(self):
        from ribbonforge.core.document import RibbonDocument
        document = RibbonDocument.new_xml("2010", "starter")
        part = document.first_part()
        button = part.tree.root.find_all("button")[0]
        uid = button.uid
        part.set_text(part.text.replace("\n", "\n "))  # whitespace only
        self.assertTrue(part.parse_ok)
        again = part.tree.root.find_all("button")[0]
        self.assertEqual(again.uid, uid)

    def test_uids_change_when_the_tree_changes(self):
        from ribbonforge.core.document import RibbonDocument
        document = RibbonDocument.new_xml("2010", "starter")
        part = document.first_part()
        part.set_text(part.text.replace('label="Run"', 'label="Sprint"'))
        self.assertEqual(part.tree.root.find_all("button")[0].get("label"), "Sprint")


class SchemaTests(unittest.TestCase):
    def test_context_sensitive_resolution(self):
        self.assertEqual(schema.key_for_chain(
            ["customUI", "ribbon", "tabs", "tab", "group", "button"]), "button")
        self.assertEqual(schema.key_for_chain(
            ["customUI", "backstage", "tab", "firstColumn", "group", "topItems", "button"]),
            "backstage:button")

    def test_button_is_not_valid_in_a_button(self):
        doc = XmlDocument.parse(SAMPLE_XML)
        button = doc.root.find_all("button")[0]
        self.assertEqual(schema.allowed_children(button), [])

    def test_group_children_include_the_usual_controls(self):
        names = {e.name for e in [schema.SCHEMA[k] for k in schema.SCHEMA["group"].children]}
        for expected in ("button", "gallery", "menu", "splitButton", "dialogBoxLauncher"):
            self.assertIn(expected, names)

    def test_every_child_key_resolves(self):
        for key, elem in schema.SCHEMA.items():
            for child in elem.children:
                self.assertIn(child, schema.SCHEMA, f"{key} -> {child}")

    def test_make_node_scaffolds(self):
        node = schema.make_node("tab", __import__("ribbonforge.core.xmldoc",
                                                  fromlist=["build"]))
        self.assertEqual(node.local, "tab")
        self.assertEqual(node.elements[0].local, "group")


class ValidatorTests(unittest.TestCase):
    def check(self, xml, variant=V2010, **kwargs):
        return validator.validate(XmlDocument.parse(xml), variant, **kwargs)

    def test_clean_document_has_no_errors(self):
        report = self.check(SAMPLE_XML)
        self.assertEqual(report.counts()[0], 0, [i.message for i in report.issues])

    def test_namespace_mismatch(self):
        xml = SAMPLE_XML.replace(NAMESPACE_FOR[V2010], NAMESPACE_FOR[V2007])
        codes = {i.code for i in self.check(xml).issues}
        self.assertIn("ns-mismatch", codes)

    def test_duplicate_ids(self):
        xml = SAMPLE_XML.replace('id="tb1"', 'id="b1"')
        self.assertIn("duplicate-id", {i.code for i in self.check(xml).issues})

    def test_unknown_attribute_and_bad_enum(self):
        xml = SAMPLE_XML.replace('size="large"', 'size="huge" wibble="1"')
        codes = {i.code for i in self.check(xml).issues}
        self.assertIn("bad-enum", codes)
        self.assertIn("bad-attribute", codes)

    def test_element_not_allowed_here(self):
        xml = SAMPLE_XML.replace("</group>", "<tab id='x'/></group>")
        self.assertIn("bad-child", {i.code for i in self.check(xml).issues})

    def test_missing_image_reference(self):
        xml = SAMPLE_XML.replace('imageMso="FileSave"', 'image="logo"')
        report = self.check(xml, available_images=["other"])
        self.assertIn("missing-image", {i.code for i in report.issues})
        report = self.check(xml, available_images=["logo"])
        self.assertNotIn("missing-image", {i.code for i in report.issues})

    def test_backstage_rejected_in_2007_part(self):
        xml = SAMPLE_XML.replace("</ribbon>", "</ribbon><backstage/>")
        xml = xml.replace(NAMESPACE_FOR[V2010], NAMESPACE_FOR[V2007])
        codes = [i.code for i in self.check(xml, V2007).issues]
        self.assertIn("dialect", codes)

    def test_splitbutton_shape(self):
        xml = SAMPLE_XML.replace(
            "</group>", '<splitButton id="s1"><button id="s2" label="x"/></splitButton></group>')
        self.assertIn("splitbutton-shape", {i.code for i in self.check(xml).issues})

    def test_bad_callback_name(self):
        xml = SAMPLE_XML.replace('onAction="OnGo"', 'onAction="9 nope"')
        self.assertIn("bad-callback", {i.code for i in self.check(xml).issues})

    def test_dynamic_menu_needs_content(self):
        xml = SAMPLE_XML.replace("</group>", '<dynamicMenu id="dm" label="M"/></group>')
        self.assertIn("no-content", {i.code for i in self.check(xml).issues})

    def test_syntax_error_is_reported_as_an_issue(self):
        report = self.check("<customUI><ribbon></customUI>")
        self.assertEqual(report.issues[0].code, "xml-syntax")

    def test_autofix_duplicate_id(self):
        doc = XmlDocument.parse(SAMPLE_XML.replace('id="tb1"', 'id="b1"'))
        report = validator.validate(doc, V2010)
        issue = next(i for i in report.issues if i.code == "duplicate-id")
        self.assertTrue(validator.can_fix(issue))
        self.assertTrue(validator.apply_fix(doc, issue, V2010))
        self.assertEqual(validator.validate(doc, V2010).counts()[0], 0)

    def test_autofix_namespace(self):
        doc = XmlDocument.parse(SAMPLE_XML.replace(NAMESPACE_FOR[V2010], NAMESPACE_FOR[V2007]))
        report = validator.validate(doc, V2010)
        issue = next(i for i in report.issues if i.code == "ns-mismatch")
        validator.apply_fix(doc, issue, V2010)
        self.assertEqual(doc.root.get("xmlns"), NAMESPACE_FOR[V2010])
        self.assertEqual(list(doc.root.attrs)[0], "xmlns")

    def test_every_template_validates(self):
        for template in templates.TEMPLATES:
            for variant in (V2007, V2010):
                if template.key in ("backstage", "contextmenu") and variant == V2007:
                    continue
                report = self.check(templates.render(template.key, variant), variant)
                self.assertEqual(report.counts()[0], 0,
                                 f"{template.key}/{variant}: "
                                 f"{[i.message for i in report.errors]}")


class CallbackTests(unittest.TestCase):
    def test_signatures_match_the_control(self):
        doc = XmlDocument.parse(SAMPLE_XML)
        found = {c.name: c for c in callbacks.collect(doc)}
        self.assertEqual(found["OnGo"].parameters, "control As IRibbonControl")
        self.assertEqual(found["OnWatch"].parameters,
                         "control As IRibbonControl, pressed As Boolean")
        self.assertIn("ByRef returnedVal", found["GetWatch"].parameters)

    def test_gallery_and_dropdown_signatures(self):
        xml = SAMPLE_XML.replace("</group>", '''
          <gallery id="ga" label="G" getItemCount="Count" onAction="OnPick"/>
          <dropDown id="dd" label="D" getItemCount="Count" onAction="OnChoose"/>
          <editBox id="eb" label="E" onChange="OnEdit"/></group>''')
        found = {c.name: c for c in callbacks.collect(XmlDocument.parse(xml))}
        self.assertIn("selectedIndex As Integer", found["OnPick"].parameters)
        self.assertIn("selectedIndex As Integer", found["OnChoose"].parameters)
        self.assertEqual(found["OnEdit"].parameters,
                         "control As IRibbonControl, text As String")
        self.assertIn("index As Integer", callbacks.signature_for("gallery", "getItemLabel")[0])

    def test_conflicting_signatures_are_flagged(self):
        xml = SAMPLE_XML.replace('onAction="OnWatch"', 'onAction="OnGo"')
        conflicts = [c for c in callbacks.collect(XmlDocument.parse(xml)) if c.conflict]
        self.assertEqual(len(conflicts), 1)

    def test_module_generation(self):
        module = callbacks.generate_module(XmlDocument.parse(SAMPLE_XML))
        self.assertIn('Attribute VB_Name = "RibbonCallbacks"', module)
        self.assertIn("Public Sub RibbonOnLoad(ribbon As IRibbonUI)", module)
        self.assertIn("Public Sub OnGo(control As IRibbonControl)", module)
        self.assertIn("Public Sub OnWatch(control As IRibbonControl, pressed As Boolean)", module)
        self.assertNotIn("Sub Sub", module)

    def test_pointer_recovery_block(self):
        module = callbacks.generate_module(XmlDocument.parse(SAMPLE_XML),
                                           include_pointer_recovery=True)
        self.assertIn("#If VBA7 Then", module)
        self.assertIn("CacheRibbonPointer", module)

    def test_tag_dispatch(self):
        xml = SAMPLE_XML.replace(
            "</group>",
            '<button id="x1" label="A" onAction="OnQuick" tag="one"/>'
            '<button id="x2" label="B" onAction="OnQuick" tag="two"/></group>')
        module = callbacks.generate_module(XmlDocument.parse(xml))
        self.assertIn("Select Case control.Tag", module)
        self.assertIn('Case "one"', module)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ribbonforge-")
        self.path = make_sample.build(os.path.join(self.tmp, "book.xlsm"))
        self.plain = make_sample.build(os.path.join(self.tmp, "plain.xlsm"), with_ribbon=False)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_open_and_read(self):
        package = OfficePackage.open(self.path)
        self.assertIn(V2010, package.parts)
        part = package.parts[V2010]
        self.assertIn("<customUI", part.xml)
        self.assertEqual([i.rel_id for i in part.images], ["logo"])

    def test_rejects_non_package(self):
        junk = os.path.join(self.tmp, "not.xlsm")
        with open(junk, "wb") as handle:
            handle.write(b"this is not a zip")
        with self.assertRaises(PackageError):
            OfficePackage.open(junk)

    def test_rejects_legacy_binary(self):
        legacy = os.path.join(self.tmp, "old.xls")
        shutil.copy(self.path, legacy)
        with self.assertRaises(PackageError) as ctx:
            OfficePackage.open(legacy)
        self.assertIn(".xlsm", str(ctx.exception))

    def test_add_part_to_a_plain_workbook(self):
        package = OfficePackage.open(self.plain)
        self.assertEqual(package.parts, {})
        package.create_part(V2010)
        package.save()
        reopened = OfficePackage.open(self.plain)
        self.assertIn(V2010, reopened.parts)
        with zipfile.ZipFile(self.plain) as zf:
            rels = zf.read("_rels/.rels").decode()
        self.assertIn("2007/relationships/ui/extensibility", rels)

    def test_other_parts_are_copied_byte_for_byte(self):
        before = zipfile.ZipFile(self.path).read("xl/workbook.xml")
        package = OfficePackage.open(self.path)
        package.set_part_xml(V2010, package.parts[V2010].xml.replace("Reporting", "Renamed"))
        package.save()
        with zipfile.ZipFile(self.path) as zf:
            self.assertEqual(zf.read("xl/workbook.xml"), before)
            self.assertIn("Renamed", zf.read("customUI/customUI14.xml").decode())

    def test_image_lifecycle(self):
        package = OfficePackage.open(self.path)
        data = make_sample.make_png(16)
        image = package.add_image(V2010, data, "extra.png")
        self.assertEqual(image.rel_id, "rId1")
        package.rename_image(V2010, "rId1", "extraLogo")
        package.save()

        reopened = OfficePackage.open(self.path)
        ids = [i.rel_id for i in reopened.parts[V2010].images]
        self.assertEqual(sorted(ids), ["extraLogo", "logo"])
        with zipfile.ZipFile(self.path) as zf:
            self.assertIn('Extension="png"', zf.read("[Content_Types].xml").decode())

        reopened.remove_image(V2010, "extraLogo")
        reopened.save()
        with zipfile.ZipFile(self.path) as zf:
            self.assertNotIn("customUI/images/extra.png", zf.namelist())

    def test_image_name_collisions(self):
        package = OfficePackage.open(self.path)
        first = package.add_image(V2010, b"1", "logo.png")
        second = package.add_image(V2010, b"2", "logo.png")
        self.assertNotEqual(first.part_name, second.part_name)

    def test_rejects_unknown_image_type(self):
        package = OfficePackage.open(self.path)
        with self.assertRaises(PackageError):
            package.add_image(V2010, b"x", "bad.exe")

    def test_delete_part(self):
        package = OfficePackage.open(self.path)
        package.delete_part(V2010)
        package.save()
        with zipfile.ZipFile(self.path) as zf:
            names = zf.namelist()
            self.assertNotIn("customUI/customUI14.xml", names)
            self.assertNotIn("customUI/images/logo.png", names)
            self.assertNotIn("ui/extensibility", zf.read("_rels/.rels").decode())
            self.assertIn("xl/workbook.xml", names)

    def test_save_as_leaves_the_original_alone(self):
        target = os.path.join(self.tmp, "copy.xlsm")
        package = OfficePackage.open(self.path)
        package.set_part_xml(V2010, package.parts[V2010].xml.replace("Reporting", "Copy"))
        package.save(target)
        self.assertIn("Reporting", zipfile.ZipFile(self.path).read(
            "customUI/customUI14.xml").decode())
        self.assertIn("Copy", zipfile.ZipFile(target).read(
            "customUI/customUI14.xml").decode())

    def test_backup_is_written(self):
        package = OfficePackage.open(self.path)
        package.save(make_backup=True)
        self.assertTrue(os.path.exists(self.path + ".bak"))


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ribbonforge-")
        self.path = make_sample.build(os.path.join(self.tmp, "book.xlsm"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_open_edit_save(self):
        document = RibbonDocument.open_package(self.path)
        self.assertFalse(document.dirty)
        part = document.first_part()
        part.set_text(part.text.replace("Reporting", "Renamed"))
        self.assertTrue(document.dirty)
        document.save()
        self.assertFalse(document.dirty)
        self.assertIn("Renamed", RibbonDocument.open_package(self.path).first_part().text)

    def test_broken_xml_keeps_the_last_good_tree(self):
        document = RibbonDocument.open_package(self.path)
        part = document.first_part()
        good = len(list(part.tree.root.iter_elements()))
        part.set_text("<customUI><ribbon")
        self.assertFalse(part.parse_ok)
        self.assertEqual(len(list(part.tree.root.iter_elements())), good)
        self.assertEqual(part.report.issues[0].code, "xml-syntax")

    def test_add_and_remove_parts(self):
        document = RibbonDocument.open_package(self.path)
        document.add_part(V2007, "starter")
        self.assertEqual(document.variants(), [V2007, V2010])
        document.save()
        self.assertEqual(RibbonDocument.open_package(self.path).variants(), [V2007, V2010])
        document.remove_part(V2007)
        document.save()
        self.assertEqual(RibbonDocument.open_package(self.path).variants(), [V2010])

    def test_loose_xml_file(self):
        path = os.path.join(self.tmp, "customUI14.xml")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(SAMPLE_XML)
        document = RibbonDocument.open_xml(path)
        self.assertEqual(document.variants(), [V2010])
        document.first_part().set_text(SAMPLE_XML.replace("Tools", "Kit"))
        document.save()
        with open(path, encoding="utf-8") as handle:
            self.assertIn("Kit", handle.read())

    def test_new_from_template(self):
        document = RibbonDocument.new_xml(V2010, "toolbelt")
        self.assertTrue(document.dirty)
        self.assertEqual(document.first_part().report.counts()[0], 0)


class IconPackTests(unittest.TestCase):
    def test_full_index_ships_with_the_app(self):
        from ribbonforge.core import msoicons
        index = msoicons.load_index()
        self.assertGreater(len(index), 3000)
        self.assertIn("GridSettings", index)
        self.assertIn("FileSave", index)
        rows = list(index.values())
        self.assertEqual(len(rows), len(set(rows)), "sprite rows must be unique")

    def test_every_catalogue_name_is_authoritative(self):
        from ribbonforge.core import msodata, msoicons
        full = set(msoicons.load_index())
        # user-imported ids are legitimately outside the authoritative list
        bad = [name for name, cat in msodata.FLAT_IMAGE_MSO
               if name not in full and cat not in ("Imported", "Custom")]
        self.assertEqual(bad, [])

    def test_every_template_icon_is_authoritative(self):
        import re
        from ribbonforge.core import msoicons, templates
        full = set(msoicons.load_index())
        for template in templates.TEMPLATES:
            for name in re.findall(r'imageMso="([A-Za-z0-9]+)"', template.body):
                self.assertIn(name, full, f"{template.key} uses unknown icon {name}")
        for snippet in templates.SNIPPETS.values():
            for name in re.findall(r'imageMso="([A-Za-z0-9]+)"', snippet):
                self.assertIn(name, full, f"snippet uses unknown icon {name}")

    def test_gridsettings_validates_cleanly(self):
        xml = SAMPLE_XML.replace('imageMso="FileSave"', 'imageMso="GridSettings"')
        report = validator.validate(XmlDocument.parse(xml), V2010)
        self.assertNotIn("unknown-imagemso", {i.code for i in report.issues})


class VbaXRayTests(unittest.TestCase):
    def test_synthetic_project_parses(self):
        import make_vba
        from ribbonforge.core import vbaproject
        project = vbaproject.parse(make_vba.build_vba_project())
        self.assertEqual(project.project_name, "RibbonForgeDemo")
        self.assertIsNotNone(project.find("OnBuildReport"))
        self.assertEqual(project.find("GetVerbose").arg_count, 2)
        self.assertEqual(project.module("Sheet1").kind, "document")
        self.assertEqual(project.find("HelperTotal").kind, "Function")

    def test_decompress_round_trips(self):
        import make_vba
        from ribbonforge.core import vbaproject
        for compress in (make_vba.compress_raw, make_vba.compress_with_copytokens):
            for payload in (b"x", b"Sub A()\r\nEnd Sub\r\n" * 60, bytes(range(256)) * 4):
                data = payload[:4096]
                out = vbaproject.decompress(compress(data))
                self.assertEqual(out[:len(data)], data, compress.__name__)

    def test_validator_flags_missing_and_wrong_module(self):
        import make_vba
        from ribbonforge.core import vbaproject
        project = vbaproject.parse(make_vba.build_vba_project())
        xml = SAMPLE_XML.replace('onAction="OnGo"', 'onAction="OnBuildReport"') \
                        .replace('onAction="OnWatch"', 'onAction="Worksheet_Change"')
        report = validator.validate(XmlDocument.parse(xml), V2010, vba=project)
        codes = {i.code for i in report.issues}
        self.assertIn("vba-wrong-module", codes)     # Worksheet_Change is in Sheet1
        self.assertIn("vba-missing", codes)          # GetWatch does not exist
        messages = " ".join(i.message for i in report.issues)
        self.assertNotIn("'OnBuildReport'", messages)  # exists -> no complaint

    def test_validator_flags_signature_mismatch(self):
        import make_vba
        from ribbonforge.core import vbaproject
        project = vbaproject.parse(make_vba.build_vba_project())
        # HelperTotal takes 2 args; onAction on a plain button expects 1
        xml = SAMPLE_XML.replace('onAction="OnGo"', 'onAction="HelperTotal"')
        report = validator.validate(XmlDocument.parse(xml), V2010, vba=project)
        self.assertIn("vba-signature", {i.code for i in report.issues})

    def test_document_exposes_vba(self):
        import make_sample, tempfile, os, shutil
        tmp = tempfile.mkdtemp(prefix="ribbonforge-")
        try:
            path = make_sample.build(os.path.join(tmp, "book.xlsm"), with_vba=True)
            document = RibbonDocument.open_package(path)
            self.assertIsNotNone(document.vba)
            self.assertIn("onbuildreport", document.vba.procedure_names())
            report = document.first_part().validate()
            self.assertIn("vba-missing", {i.code for i in report.issues})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ExcelBridgeTests(unittest.TestCase):
    """The bridge plumbing, exercised end-to-end through a fake PowerShell."""

    def setUp(self):
        import sys
        self.fake = os.path.join(HERE, "fakebin", "fakepowershell.py")
        os.environ["RIBBONFORGE_POWERSHELL"] = sys.executable
        self._orig_run = None

    def tearDown(self):
        os.environ.pop("RIBBONFORGE_POWERSHELL", None)

    def _patch_argv(self):
        # powershell_exe() returns python; prepend the fake script by wrapping _run's args
        from ribbonforge.core import excelbridge
        original = excelbridge.subprocess.run

        def wrapper(cmd, **kwargs):
            return original([cmd[0], self.fake] + cmd[1:], **kwargs)

        excelbridge.subprocess.run = wrapper
        self.addCleanup(lambda: setattr(excelbridge.subprocess, "run", original))

    def test_probe(self):
        from ribbonforge.core import excelbridge
        self._patch_argv()
        status = excelbridge.probe()
        self.assertTrue(status.available and status.excel_running and status.vbom_trusted)
        self.assertEqual(status.excel_version, "16.0")

    def test_test_in_excel(self):
        from ribbonforge.core import excelbridge
        self._patch_argv()
        result = excelbridge.test_in_excel("/tmp/book.xlsm")
        self.assertEqual(result["opened"], "book.xlsm")

    def test_inject_vba(self):
        from ribbonforge.core import excelbridge
        self._patch_argv()
        result = excelbridge.inject_vba("/tmp/book.xlsm", "/tmp/mod.bas", "RibbonCallbacks")
        self.assertEqual(result["module"], "RibbonCallbacks")

    def test_harvest_icons(self):
        import tempfile, shutil
        from ribbonforge.core import excelbridge
        self._patch_argv()
        out = tempfile.mkdtemp(prefix="rf-icons-")
        try:
            result = excelbridge.harvest_icons(["FileSave", "GridSettings"], out)
            self.assertEqual(result["saved"], 2)
            self.assertTrue(os.path.exists(os.path.join(out, "GridSettings.png")))
        finally:
            shutil.rmtree(out, ignore_errors=True)

    def test_unavailable_off_windows(self):
        from ribbonforge.core import excelbridge, winplatform
        os.environ.pop("RIBBONFORGE_POWERSHELL", None)
        if not winplatform.IS_WINDOWS:
            status = excelbridge.probe()
            self.assertFalse(status.available)


class CatalogueTests(unittest.TestCase):
    def test_catalogues_are_deduplicated(self):
        names = msodata.image_mso_names()
        self.assertEqual(len(names), len(set(names)))
        self.assertGreater(len(names), 300)

    def test_search(self):
        self.assertTrue(all("save" in n.lower() for n, _ in msodata.search_image_mso("save")))

    def test_user_catalogue_merge(self):
        tmp = tempfile.mkdtemp(prefix="ribbonforge-")
        try:
            path = os.path.join(tmp, "imagemso.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("# comment\nZzTestIcon, Custom\n")
            added = msodata.load_user_catalogue(path)
            self.assertEqual(added, 1)
            self.assertIn("ZzTestIcon", msodata.image_mso_names())
            self.assertEqual(msodata.load_user_catalogue(path), 0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
