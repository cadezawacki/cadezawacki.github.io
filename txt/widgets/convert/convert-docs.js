/* File Converter — document conversions (loaded on first document job).
 *
 * Pure functions over the third-party libraries, which the panel loads from
 * its own cache and passes in (so this file never touches the network and can
 * be exercised in node):
 *   mammoth  DOCX -> HTML / raw text            (BSD-2)
 *   turndown HTML -> Markdown                   (MIT)
 *   marked   Markdown -> HTML, and its lexer drives Markdown -> DOCX (MIT)
 *   docx     builds .docx files                 (MIT)
 *   XLSX     SheetJS CE: XLSX/XLS/ODS/CSV/TSV/JSON in and out (Apache-2.0)
 *   PDFLib   pdf-lib: images -> PDF             (MIT)
 * Registers window.__cadeConvertDocs.
 */
(function (root) {
  'use strict';

  // ---- small helpers -----------------------------------------------------------
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0', '#39': '\'' };
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, function (m, e) {
      var k = e.toLowerCase();
      if (ENT[k] != null) return ENT[k];
      if (k.charAt(0) === '#') {
        var n = k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        if (n > 0 && n < 0x110000) { try { return String.fromCodePoint(n); } catch (x) {} }
      }
      return m;
    });
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // A complete, readable standalone page around converted HTML.
  function htmlPage(title, body) {
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + escHtml(title || 'Document') + '</title>\n<style>\n' +
      'body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1c1917}\n' +
      'img{max-width:100%;height:auto}table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid #d6d3d1;padding:4px 8px;vertical-align:top}\n' +
      'th{background:#f5f5f4}pre{background:#f5f5f4;padding:.75em;overflow:auto;border-radius:6px}code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:.9em}\n' +
      'blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #d6d3d1;color:#57534e}\n' +
      '@media (prefers-color-scheme:dark){body{background:#111110;color:#e7e5e3}th,pre{background:#222120}td,th{border-color:#444}}\n' +
      '</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  }

  // ---- HTML -> text ------------------------------------------------------------
  var BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL|CAPTION|DETAILS|SUMMARY)$/;
  // Plain text that keeps the document's block structure (no layout needed,
  // so it works on a DOMParser document that was never rendered).
  function htmlToText(doc) {
    var out = [], tail = '';
    function push(s) { if (!s) return; out.push(s); tail = (tail + s).slice(-2); }
    function nl(n) {
      if (!out.length) return;
      var have = tail === '\n\n' ? 2 : tail.slice(-1) === '\n' ? 1 : 0;
      for (var i = have; i < n; i++) push('\n');
    }
    function walk(node, pre) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          var t = pre ? c.data : c.data.replace(/[ \t\r\n\f]+/g, ' ');
          if (!pre && (!tail || tail.slice(-1) === '\n' || tail.slice(-1) === ' ')) t = t.replace(/^ /, '');
          push(t);
          continue;
        }
        if (c.nodeType !== 1) continue;
        var tag = c.nodeName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') continue;
        if (tag === 'BR') { push('\n'); continue; }
        var block = BLOCK.test(tag);
        if (block) nl(/^(P|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR)$/.test(tag) ? 2 : 1);
        if (tag === 'LI') push(c.parentNode && /OL/i.test(c.parentNode.nodeName) ? (Array.prototype.indexOf.call(c.parentNode.children, c) + 1) + '. ' : '\u2022 ');
        if ((tag === 'TD' || tag === 'TH') && c.previousElementSibling) push('\t');
        if (tag === 'IMG') { var alt = c.getAttribute('alt'); if (alt) push('[' + alt + ']'); continue; }
        if (tag === 'HR') { push('\u2014\u2014\u2014'); nl(2); continue; }
        walk(c, pre || tag === 'PRE');
        if (block) nl(/^(P|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE)$/.test(tag) ? 2 : 1);
      }
    }
    walk(doc.body || doc.documentElement || doc, false);
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '') + '\n';
  }

  // ---- HTML -> Markdown (turndown + GFM-style tables) ---------------------------
  function turndownService(TurndownService) {
    var td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', hr: '---' });
    td.remove(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript']);
    // Embedded images would put megabytes of base64 into the text — keep the alt.
    td.addRule('cadeImg', {
      filter: function (node) {
        if (node.nodeName !== 'IMG') return false;
        var src = node.getAttribute('src') || '';
        return !src || /^data:/i.test(src);
      },
      replacement: function (content, node) {
        var alt = (node.getAttribute('alt') || '').trim();
        return alt ? '[image: ' + alt + ']' : '';
      },
    });
    td.addRule('cadeStrike', { filter: ['del', 's', 'strike'], replacement: function (c) { return c ? '~~' + c + '~~' : ''; } });
    td.addRule('cadeTable', {
      filter: 'table',
      replacement: function (content, node) {
        var rows = [];
        var trs = node.querySelectorAll('tr');
        for (var i = 0; i < trs.length; i++) {
          var tr = trs[i], owner = tr.parentNode;
          while (owner && owner.nodeName !== 'TABLE') owner = owner.parentNode;
          if (owner !== node) continue; // nested table: flattened into its cell
          var cells = [];
          for (var c = tr.firstElementChild; c; c = c.nextElementSibling) {
            if (c.nodeName !== 'TD' && c.nodeName !== 'TH') continue;
            // (pipes are escaped once, by rowsToMarkdown)
            var md = td.turndown(c.innerHTML || '').replace(/\n+/g, ' ').trim();
            // A header row Word made bold is already a header — drop the **.
            if (!rows.length && /^\*\*[^*]+\*\*$/.test(md)) md = md.slice(2, -2);
            cells.push(md);
            var span = parseInt(c.getAttribute('colspan') || '1', 10);
            for (var s = 1; s < span && s < 50; s++) cells.push('');
          }
          if (cells.length) rows.push(cells);
        }
        if (!rows.length) return '';
        return '\n\n' + rowsToMarkdown(rows) + '\n\n';
      },
    });
    return td;
  }
  function htmlToMarkdown(lib, html) {
    var md = turndownService(lib.TurndownService).turndown(html || '');
    return md.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // rows: array of arrays (first row = header). GitHub-flavoured pipe table.
  function rowsToMarkdown(rows) {
    var w = 0;
    rows.forEach(function (r) { if (r.length > w) w = r.length; });
    if (!w) return '';
    var cell = function (v) {
      return String(v == null ? '' : v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
    };
    var line = function (r) {
      var a = [];
      for (var i = 0; i < w; i++) a.push(cell(r[i]) || ' ');
      return '| ' + a.join(' | ') + ' |';
    };
    var out = [line(rows[0])];
    var sep = [];
    for (var i = 0; i < w; i++) sep.push('---');
    out.push('| ' + sep.join(' | ') + ' |');
    for (var j = 1; j < rows.length; j++) out.push(line(rows[j]));
    return out.join('\n');
  }

  // ---- DOCX -> HTML / Markdown / text (mammoth) -------------------------------
  function docxToHtml(lib, arrayBuffer, title) {
    return lib.mammoth.convertToHtml({ arrayBuffer: arrayBuffer }).then(function (r) {
      return { text: htmlPage(title, r.value), warnings: (r.messages || []).length };
    });
  }
  function docxToMarkdown(lib, arrayBuffer) {
    // Images are dropped to an alt-text marker (see cadeImg) — skip encoding them.
    var opts = { convertImage: lib.mammoth.images.imgElement(function (image) { return Promise.resolve({ src: '', alt: image.altText || 'image' }); }) };
    return lib.mammoth.convertToHtml({ arrayBuffer: arrayBuffer }, opts).then(function (r) {
      return { text: htmlToMarkdown(lib, r.value), warnings: (r.messages || []).length };
    });
  }
  function docxToText(lib, arrayBuffer) {
    return lib.mammoth.extractRawText({ arrayBuffer: arrayBuffer }).then(function (r) {
      return { text: String(r.value || '').replace(/\n{3,}/g, '\n\n').trim() + '\n', warnings: 0 };
    });
  }

  // ---- Markdown -> HTML (marked) -------------------------------------------------
  function mdToHtml(lib, md, title) {
    var body = lib.marked.parse(String(md || ''), { gfm: true, async: false });
    return htmlPage(title, body);
  }
  function textToHtml(text, title) {
    var paras = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    var body = paras.map(function (p) { return p.trim() ? '<p>' + escHtml(p).replace(/\n/g, '<br>\n') + '</p>' : ''; }).join('\n');
    return htmlPage(title, body);
  }

  // ---- Markdown -> DOCX (marked lexer -> docx objects) ---------------------------
  function mdToDocx(lib, md, title) {
    var D = lib.docx, marked = lib.marked;
    var tokens = marked.lexer(String(md || '').replace(/\r\n?/g, '\n'), { gfm: true });
    var listInstance = 0;
    var H = [null, D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6];
    var MONO = 'Courier New';

    function run(text, st) {
      var o = { text: decodeEntities(text) };
      if (st.bold) o.bold = true;
      if (st.italics) o.italics = true;
      if (st.strike) o.strike = true;
      if (st.code) { o.font = MONO; o.shading = { type: D.ShadingType.CLEAR, color: 'auto', fill: 'F2F2F2' }; }
      if (st.link) o.style = 'Hyperlink';
      return new D.TextRun(o);
    }
    function merge(st, k) { var n = {}; for (var x in st) n[x] = st[x]; n[k] = true; return n; }
    function inline(toks, st) {
      var out = [];
      (toks || []).forEach(function (t) {
        switch (t.type) {
          case 'text':
          case 'escape':
            if (t.tokens && t.tokens.length) out = out.concat(inline(t.tokens, st));
            else if (t.text) out.push(run(t.text, st));
            break;
          case 'strong': out = out.concat(inline(t.tokens, merge(st, 'bold'))); break;
          case 'em': out = out.concat(inline(t.tokens, merge(st, 'italics'))); break;
          case 'del': out = out.concat(inline(t.tokens, merge(st, 'strike'))); break;
          case 'codespan': out.push(run(t.text, merge(st, 'code'))); break;
          case 'br': out.push(new D.TextRun({ text: '', break: 1 })); break;
          case 'checkbox': out.push(run(t.checked ? '\u2611 ' : '\u2610 ', st)); break;
          case 'image': out.push(run('[image' + (t.text ? ': ' + t.text : '') + ']', merge(st, 'italics'))); break;
          case 'html': {
            var plain = String(t.text || '').replace(/<[^>]*>/g, '');
            if (plain) out.push(run(plain, st));
            break;
          }
          case 'link': {
            var kids = inline(t.tokens, merge(st, 'link'));
            if (/^(https?:|mailto:)/i.test(t.href || '') && !st.link) out.push(new D.ExternalHyperlink({ link: t.href, children: kids }));
            else out = out.concat(kids);
            break;
          }
          default:
            if (t.tokens) out = out.concat(inline(t.tokens, st));
            else if (t.text) out.push(run(t.text, st));
        }
      });
      return out;
    }
    function para(children, ctx, extra) {
      var o = { children: children };
      if (ctx.quote) {
        o.indent = { left: 360 * ctx.quote };
        o.border = { left: { style: D.BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 } };
      } else if (ctx.indent) {
        o.indent = { left: ctx.indent };
      }
      for (var k in extra) o[k] = extra[k];
      return new D.Paragraph(o);
    }
    function list(tok, ctx, depth, out) {
      var inst = ++listInstance;
      tok.items.forEach(function (item) {
        var first = true;
        (item.tokens || []).forEach(function (b) {
          if (b.type === 'list') { list(b, ctx, depth + 1, out); return; }
          if (b.type === 'text' || b.type === 'paragraph') {
            var kids = inline(b.tokens || [{ type: 'text', text: b.text }], {});
            if (first) {
              var marker = tok.ordered
                ? { numbering: { reference: 'cade-ol', level: Math.min(depth, 8), instance: inst } }
                : { bullet: { level: Math.min(depth, 8) } };
              out.push(para(kids, {}, marker));
              first = false;
            } else {
              out.push(para(kids, { indent: 720 * (depth + 1) }));
            }
            return;
          }
          if (b.type === 'space') return;
          blocks([b], { indent: 720 * (depth + 1), quote: ctx.quote }, out);
        });
      });
    }
    function blocks(toks, ctx, out) {
      toks.forEach(function (t) {
        switch (t.type) {
          case 'heading':
            out.push(para(inline(t.tokens, {}), ctx, { heading: H[Math.min(6, Math.max(1, t.depth))] }));
            break;
          case 'paragraph':
          case 'text':
            out.push(para(inline(t.tokens || [{ type: 'text', text: t.text }], {}), ctx));
            break;
          case 'list': list(t, ctx, 0, out); break;
          case 'blockquote': blocks(t.tokens || [], { quote: (ctx.quote || 0) + 1 }, out); break;
          case 'code': {
            var lines = String(t.text || '').split('\n');
            lines.forEach(function (ln) {
              out.push(para([new D.TextRun({ text: ln || ' ', font: MONO, size: 20 })], ctx, {
                shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: 'F2F2F2' }, spacing: { before: 0, after: 0 },
              }));
            });
            out.push(new D.Paragraph({ children: [] }));
            break;
          }
          case 'hr':
            out.push(new D.Paragraph({ children: [], border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } } }));
            break;
          case 'table': {
            var mkRow = function (cells, head) {
              return new D.TableRow({
                tableHeader: !!head,
                children: cells.map(function (c) {
                  return new D.TableCell({ children: [new D.Paragraph({ children: inline(c.tokens, head ? { bold: true } : {}) })] });
                }),
              });
            };
            var rows = [mkRow(t.header, true)].concat((t.rows || []).map(function (r) { return mkRow(r, false); }));
            out.push(new D.Table({ rows: rows, width: { size: 100, type: D.WidthType.PERCENTAGE } }));
            out.push(new D.Paragraph({ children: [] }));
            break;
          }
          case 'html': {
            var plain = decodeEntities(String(t.text || '').replace(/<[^>]*>/g, '')).trim();
            if (plain) out.push(para([new D.TextRun(plain)], ctx));
            break;
          }
          default: break; // space, def
        }
      });
      return out;
    }

    var children = blocks(tokens, {}, []);
    if (!children.length) children.push(new D.Paragraph({ children: [] }));
    var levels = [];
    var fmts = [D.LevelFormat.DECIMAL, D.LevelFormat.LOWER_LETTER, D.LevelFormat.LOWER_ROMAN];
    for (var l = 0; l < 9; l++) {
      levels.push({
        level: l, format: fmts[l % 3], text: '%' + (l + 1) + '.', alignment: D.AlignmentType.START,
        style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } },
      });
    }
    return new D.Document({
      creator: 'Cade.txt', title: title || 'Document',
      numbering: { config: [{ reference: 'cade-ol', levels: levels }] },
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      sections: [{ children: children }],
    });
  }
  function textToDocx(lib, text, title) {
    var D = lib.docx;
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var children = lines.map(function (ln) { return new D.Paragraph({ children: ln ? [new D.TextRun(ln)] : [] }); });
    return new D.Document({ creator: 'Cade.txt', title: title || 'Document', sections: [{ children: children }] });
  }

  // ---- spreadsheets (SheetJS) ------------------------------------------------------
  // src: {fmt, bytes?: ArrayBuffer, text?: string}
  function sheetRead(XLSX, src) {
    var fmt = src.fmt;
    if (fmt === 'json') {
      var data = JSON.parse(String(src.text || '').replace(/^\ufeff/, ''));
      var wb = XLSX.utils.book_new();
      var add = function (name, v) {
        var ws;
        if (Array.isArray(v)) {
          if (!v.length) ws = XLSX.utils.aoa_to_sheet([[]]);
          else if (v.every(Array.isArray)) ws = XLSX.utils.aoa_to_sheet(v);
          else if (v.every(function (x) { return x && typeof x === 'object'; })) ws = XLSX.utils.json_to_sheet(v.map(function (x) { return flatten(x); }));
          else ws = XLSX.utils.aoa_to_sheet(v.map(function (x) { return [x]; }));
        } else if (v && typeof v === 'object') {
          ws = XLSX.utils.json_to_sheet([flatten(v)]);
        } else {
          ws = XLSX.utils.aoa_to_sheet([[v]]);
        }
        XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name, wb));
      };
      if (data && !Array.isArray(data) && typeof data === 'object' && Object.keys(data).length &&
        Object.keys(data).every(function (k) { return Array.isArray(data[k]); })) {
        Object.keys(data).forEach(function (k) { add(k, data[k]); });
      } else {
        add('Sheet1', data);
      }
      return wb;
    }
    if (fmt === 'csv' || fmt === 'tsv') {
      var text = String(src.text || '').replace(/^\ufeff/, '');
      return XLSX.read(text, fmt === 'tsv' ? { type: 'string', FS: '\t' } : { type: 'string' });
    }
    return XLSX.read(new Uint8Array(src.bytes), { type: 'array', cellDates: true });
  }
  // Nested objects become dotted columns; arrays become JSON text.
  function flatten(o, pre, acc) {
    acc = acc || {};
    Object.keys(o).forEach(function (k) {
      var v = o[k], key = pre ? pre + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) flatten(v, key, acc);
      else acc[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    });
    return acc;
  }
  function safeSheetName(name, wb) {
    var n = String(name || 'Sheet').replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Sheet';
    var base = n, i = 2;
    while (wb.SheetNames.indexOf(n) !== -1) n = base.slice(0, 28) + ' ' + (i++);
    return n;
  }
  var SHEET_MIME = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', md: 'text/markdown', html: 'text/html',
  };
  // -> [{name, mime, data: string|Uint8Array, text?: true}]
  function sheetWrite(XLSX, wb, target, base) {
    var names = wb.SheetNames.filter(function (n) { return wb.Sheets[n]; });
    if (!names.length) throw new Error('No sheets found');
    var multi = names.length > 1;
    var mime = SHEET_MIME[target];
    var slug = function (n) { return n.replace(/[\\\/:*?"<>|]+/g, ' ').trim() || 'Sheet'; };
    if (target === 'xlsx' || target === 'ods') {
      var u8 = XLSX.write(wb, { bookType: target, type: 'array', compression: true });
      return [{ name: base + '.' + target, mime: mime, data: new Uint8Array(u8) }];
    }
    if (target === 'csv' || target === 'tsv') {
      return names.map(function (n) {
        var s = XLSX.utils.sheet_to_csv(wb.Sheets[n], target === 'tsv' ? { FS: '\t', blankrows: false } : { blankrows: false });
        return { name: base + (multi ? '-' + slug(n) : '') + '.' + target, mime: mime, data: s, text: true };
      });
    }
    if (target === 'json') {
      var obj;
      if (multi) { obj = {}; names.forEach(function (n) { obj[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null }); }); }
      else obj = XLSX.utils.sheet_to_json(wb.Sheets[names[0]], { defval: null });
      return [{ name: base + '.json', mime: mime, data: JSON.stringify(obj, null, 2) + '\n', text: true }];
    }
    if (target === 'md') {
      var parts = names.map(function (n) {
        var rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false, blankrows: false });
        return (multi ? '## ' + n + '\n\n' : '') + (rows.length ? rowsToMarkdown(rows) : '_(empty)_');
      });
      return [{ name: base + '.md', mime: mime, data: parts.join('\n\n') + '\n', text: true }];
    }
    if (target === 'html') {
      var body = names.map(function (n) {
        var h = XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' });
        return (multi ? '<h2>' + escHtml(n) + '</h2>\n' : '') + h;
      }).join('\n');
      return [{ name: base + '.html', mime: mime, data: htmlPage(base, body), text: true }];
    }
    throw new Error('Unsupported spreadsheet target: ' + target);
  }

  // ---- images -> PDF (pdf-lib) -----------------------------------------------------
  // imgs: [{bytes: Uint8Array, type:'jpeg'|'png', width, height}] -> Uint8Array.
  // One page per image at 96 dpi, so a screenshot prints at its natural size.
  function imagesToPdf(PDFLib, imgs, title) {
    return PDFLib.PDFDocument.create().then(function (pdf) {
      pdf.setTitle(title || 'Images');
      pdf.setCreator('Cade.txt File Converter');
      pdf.setProducer('pdf-lib');
      var chain = Promise.resolve();
      imgs.forEach(function (im) {
        chain = chain.then(function () {
          return im.type === 'png' ? pdf.embedPng(im.bytes) : pdf.embedJpg(im.bytes);
        }).then(function (emb) {
          var w = im.width * 0.75, h = im.height * 0.75;
          var k = Math.min(1, 14400 / Math.max(w, h)); // PDF's 200-inch page limit
          w *= k; h *= k;
          var page = pdf.addPage([w, h]);
          page.drawImage(emb, { x: 0, y: 0, width: w, height: h });
        });
      });
      return chain.then(function () { return pdf.save(); });
    });
  }

  root.__cadeConvertDocs = {
    decodeEntities: decodeEntities, htmlPage: htmlPage, htmlToText: htmlToText, htmlToMarkdown: htmlToMarkdown,
    rowsToMarkdown: rowsToMarkdown, docxToHtml: docxToHtml, docxToMarkdown: docxToMarkdown, docxToText: docxToText,
    mdToHtml: mdToHtml, textToHtml: textToHtml, mdToDocx: mdToDocx, textToDocx: textToDocx,
    sheetRead: sheetRead, sheetWrite: sheetWrite, imagesToPdf: imagesToPdf, flatten: flatten,
  };
})(typeof window !== 'undefined' ? window : this);
