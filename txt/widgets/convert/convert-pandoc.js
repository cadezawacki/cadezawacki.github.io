/* File Converter — pandoc document formats (pure; no DOM, no network).
 *
 * The table of pandoc readers/writers the converter offers, how an input file
 * maps to a reader (extension / MIME / a sniff of its first bytes), the
 * pandoc options for each reader -> writer job, output names, and the
 * JSON-AST clean-up that turns pandoc's Markdown into tidy note text.
 *
 * pandoc itself (pandoc.wasm, GPL-2.0-or-later, ~58 MB, from unpkg) only ever
 * runs inside convert-pandoc-worker.js, which imports this file too. The
 * panel (convert.js) loads it when it opens. Node tests require() it.
 * Registers self.__cadeConvertPandoc (window or worker global).
 */
(function (root) {
  'use strict';

  // ---- readers ------------------------------------------------------------------
  // key: our format id (= convert.js `sn.fmt` where the two overlap).
  // r: pandoc reader, bin: read as a file (zip based), label: shown on the card.
  var READERS = {
    md: { r: 'gfm', label: 'Markdown' },
    note: { r: 'gfm+hard_line_breaks', label: 'Markdown note' },
    html: { r: 'html', label: 'HTML page' },
    docx: { r: 'docx', bin: true, label: 'Word document' },
    odt: { r: 'odt', bin: true, label: 'OpenDocument text' },
    epub: { r: 'epub', bin: true, label: 'EPUB book' },
    pptx: { r: 'pptx', bin: true, label: 'PowerPoint deck' },
    rtf: { r: 'rtf', label: 'Rich Text (RTF)' },
    latex: { r: 'latex', label: 'LaTeX' },
    rst: { r: 'rst', label: 'reStructuredText' },
    org: { r: 'org', label: 'Org mode' },
    mediawiki: { r: 'mediawiki', label: 'MediaWiki' },
    textile: { r: 'textile', label: 'Textile' },
    asciidoc: { r: 'asciidoc', label: 'AsciiDoc' },
    ipynb: { r: 'ipynb', label: 'Jupyter notebook' },
    typst: { r: 'typst', label: 'Typst' },
    docbook: { r: 'docbook', label: 'DocBook' },
    fb2: { r: 'fb2', label: 'FictionBook' },
    opml: { r: 'opml', label: 'OPML outline' },
    csv: { r: 'csv', label: 'CSV table' },
    tsv: { r: 'tsv', label: 'TSV table' },
  };
  // Extensions for the formats convert.js doesn't know itself.
  var EXT = {
    rst: 'rst', rest: 'rst', org: 'org', wiki: 'mediawiki', mediawiki: 'mediawiki', mw: 'mediawiki',
    textile: 'textile', adoc: 'asciidoc', asciidoc: 'asciidoc', asc: 'asciidoc',
    tex: 'latex', latex: 'latex', ltx: 'latex', ipynb: 'ipynb', typ: 'typst',
    dbk: 'docbook', docbook: 'docbook', fb2: 'fb2', opml: 'opml',
  };
  var MIME = {
    'text/x-rst': 'rst', 'text/prs.fallenstein.rst': 'rst', 'text/org': 'org', 'text/x-org': 'org',
    'text/x-tex': 'latex', 'application/x-tex': 'latex', 'application/x-latex': 'latex', 'text/x-latex': 'latex',
    'application/x-ipynb+json': 'ipynb', 'text/x-textile': 'textile', 'text/asciidoc': 'asciidoc', 'text/x-asciidoc': 'asciidoc',
    'application/docbook+xml': 'docbook', 'text/x-opml': 'opml', 'text/x-opml+xml': 'opml', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
    'application/vnd.oasis.opendocument.text': 'odt', 'application/epub+zip': 'epub',
  };

  // ---- writers ------------------------------------------------------------------
  // w: pandoc writer, bin: written to a file (zip), embeds: images travel along,
  // sa: standalone, wrap: 'none' for line-oriented formats.
  var WRITERS = [
    { key: 'md', w: 'gfm-tex_math_gfm', label: 'Markdown', ext: 'md', mime: 'text/markdown', wrap: 'none' },
    { key: 'docx', w: 'docx', label: 'Word (DOCX)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bin: true, embeds: true },
    { key: 'odt', w: 'odt', label: 'ODT (OpenDocument)', ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', bin: true, embeds: true },
    { key: 'html', w: 'html5', label: 'HTML page (standalone)', ext: 'html', mime: 'text/html', sa: true, embeds: true },
    { key: 'epub', w: 'epub3', label: 'EPUB book', ext: 'epub', mime: 'application/epub+zip', bin: true, embeds: true },
    { key: 'pptx', w: 'pptx', label: 'PowerPoint (PPTX)', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bin: true, embeds: true },
    { key: 'rtf', w: 'rtf', label: 'Rich Text (RTF)', ext: 'rtf', mime: 'application/rtf', sa: true },
    { key: 'latex', w: 'latex', label: 'LaTeX', ext: 'tex', mime: 'application/x-tex', sa: true },
    { key: 'typst', w: 'typst', label: 'Typst', ext: 'typ', mime: 'text/plain', sa: true },
    { key: 'rst', w: 'rst', label: 'reStructuredText', ext: 'rst', mime: 'text/x-rst', wrap: 'none' },
    { key: 'org', w: 'org', label: 'Org mode', ext: 'org', mime: 'text/org', wrap: 'none' },
    { key: 'asciidoc', w: 'asciidoc', label: 'AsciiDoc', ext: 'adoc', mime: 'text/asciidoc', wrap: 'none' },
    { key: 'mediawiki', w: 'mediawiki', label: 'MediaWiki', ext: 'wiki', mime: 'text/plain', wrap: 'none' },
    { key: 'ipynb', w: 'ipynb', label: 'Jupyter notebook', ext: 'ipynb', mime: 'application/x-ipynb+json' },
    { key: 'txt', w: 'plain', label: 'Plain text', ext: 'txt', mime: 'text/plain', wrap: 'none' },
  ];
  var W = {};
  WRITERS.forEach(function (w) { W[w.key] = w; });
  // A reader never offers a writer of its own format.
  var SAME = { md: 'md', note: 'md', docx: 'docx', odt: 'odt', html: 'html', epub: 'epub', pptx: 'pptx', rtf: 'rtf', latex: 'latex', typst: 'typst', rst: 'rst', org: 'org', asciidoc: 'asciidoc', mediawiki: 'mediawiki', ipynb: 'ipynb' };

  function extOf(name) {
    var m = /\.([a-z0-9]{1,9})$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  // Content hints for text files whose name says nothing useful.
  function sniffText(s) {
    s = String(s || '').replace(/^﻿/, '');
    var t = s.replace(/^\s+/, '');
    if (/^\{\\rtf/.test(t)) return 'rtf';
    if (/\\documentclass\b|\\begin\{document\}/.test(s)) return 'latex';
    if (/^\{\s*"(cells|metadata|nbformat(_minor)?)"\s*:/.test(t) && /"cells"\s*:/.test(s)) return 'ipynb';
    if (/^#\+(title|author|options|startup):/im.test(s)) return 'org';
    if (/^<\?xml[^>]*>\s*(<!DOCTYPE\s+(article|book)|<(article|book)\b[^>]*docbook)/i.test(t)) return 'docbook';
    if (/^<\?xml[^>]*>\s*<opml\b/i.test(t) || /^<opml\b/i.test(t)) return 'opml';
    if (/^<\?xml[^>]*>\s*<FictionBook\b/i.test(t)) return 'fb2';
    return '';
  }
  // -> reader key or ''. fmt: convert.js's sniffed format (wins for binary
  // containers it identified), name/mime: as given, head: first ~2 KB as text.
  function detect(fmt, name, mime, head) {
    if (fmt && READERS[fmt] && READERS[fmt].bin) return fmt;
    if (fmt === 'rtf' || fmt === 'html' || fmt === 'csv' || fmt === 'tsv') return fmt;
    if (fmt && /^(png|jpeg|gif|webp|bmp|ico|tiff|svg|avif|heic|jxl|jp2|psd|mp4|mov|3gp|webm|mkv|avi|flv|wmv|ts|mpg|ogv|m4a|mp3|aac|wav|aiff|flac|ogg|opus|wma|amr|caf|au|pdf|xlsx|xls|ods|zip|gz|7z|rar|ole|doc|ppt|odp|midi|bin)$/.test(fmt)) return '';
    var e = EXT[extOf(name)];
    if (e) return e;
    var m = MIME[String(mime || '').split(';')[0].trim().toLowerCase()];
    if (m) return m;
    var s = head != null ? sniffText(head) : '';
    if (s) return s;
    if (fmt === 'md') return 'md';
    return '';
  }
  function writersFor(reader) {
    if (!READERS[reader]) return [];
    return WRITERS.filter(function (w) { return w.key !== SAME[reader]; }).map(function (w) { return w.key; });
  }
  function baseName(name) {
    var b = String(name || 'document').replace(/\.[a-z0-9]{1,9}$/i, '');
    return b.replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';
  }
  function outName(base, writer) { return base + '.' + (W[writer] ? W[writer].ext : 'txt'); }
  function inputName(reader, name) {
    var ext = { md: 'md', note: 'md', docx: 'docx', odt: 'odt', epub: 'epub', pptx: 'pptx' }[reader] || 'txt';
    return 'input.' + ext;
  }

  // -> the plan the worker runs: { passes:[{options, stdin|inputFile}], md, outFile, ... }
  // o: { reader, writer, title }.
  // Markdown output goes through pandoc's JSON AST (cleaned by cleanAst) so
  // the result has no <div>/<span> wrappers or attribute noise.
  function plan(o) {
    var R = READERS[o.reader], Wr = W[o.writer];
    if (!R || !Wr) throw new Error('No pandoc route from ' + o.reader + ' to ' + o.writer);
    var title = String(o.title || 'Document');
    var input = R.bin ? inputName(o.reader) : '';
    var first = { from: R.r };
    if (input) first['input-files'] = [input];
    var p = { reader: o.reader, writer: o.writer, input: input, binIn: !!R.bin, md: o.writer === 'md', passes: [] };
    // gfm reads front matter; a note that merely starts with --- lines that
    // aren't YAML would fail, so the worker retries once without it.
    if (/^gfm/.test(R.r)) p.retryFrom = R.r + '-yaml_metadata_block';
    if (p.md) {
      first.to = 'json';
      if (R.bin || o.reader === 'html' || o.reader === 'ipynb') first['extract-media'] = 'media';
      p.passes.push(first);
      p.passes.push({ from: 'json', to: Wr.w, wrap: 'none' });
      return p;
    }
    var one = first;
    one.to = Wr.w;
    if (Wr.wrap) one.wrap = Wr.wrap;
    if (Wr.sa) one.standalone = true;
    if (o.writer === 'html') {
      one['embed-resources'] = true;
      one.variables = { pagetitle: title, lang: 'en' };
    }
    if (o.writer === 'epub') one.metadata = { title: title };
    if (Wr.bin) { one['output-file'] = 'output.' + Wr.ext; p.outFile = one['output-file']; }
    p.passes.push(one);
    return p;
  }

  // ---- JSON AST clean-up (Markdown output) ------------------------------------------
  // Unwraps Div / Span (section and cell wrappers, anchors), turns Figures
  // into their image (+ caption when it says more than the alt text), drops
  // attributes on images/links/code (they force raw HTML in gfm), and
  // replaces every image whose bytes we have (extracted media / data: URIs)
  // with a placeholder word ⟦img N⟧ so the panel can put the real image there.
  // media: { 'media/x.png': true } of files pandoc extracted.
  // -> { ast, images: [{ n, target, alt }] }
  var NOATTR = ['', [], []];
  function inlinesText(xs) {
    var s = '';
    (xs || []).forEach(function (x) {
      if (!x) return;
      if (x.t === 'Str') s += x.c;
      else if (x.t === 'Space' || x.t === 'SoftBreak' || x.t === 'LineBreak') s += ' ';
      else if (x.t === 'Code' || x.t === 'Math') s += x.c[1];
      else if (Array.isArray(x.c)) {
        var kids = x.t === 'Link' || x.t === 'Image' || x.t === 'Span' ? x.c[1] : x.t === 'Quoted' || x.t === 'Cite' ? x.c[1] : x.c;
        if (Array.isArray(kids) && kids.length && kids[0] && kids[0].t) s += inlinesText(kids);
      }
    });
    return s.replace(/\s+/g, ' ').trim();
  }
  function blocksText(bs) {
    return (bs || []).map(function (b) { return b && (b.t === 'Plain' || b.t === 'Para') ? inlinesText(b.c) : ''; }).join(' ').trim();
  }
  function cleanAst(ast, media) {
    media = media || {};
    var images = [];
    function isOurs(target) { return /^data:image\//i.test(target) || media[target] === true; }
    function inl(xs) {
      var out = [];
      (xs || []).forEach(function (x) {
        if (!x || !x.t) { out.push(x); return; }
        switch (x.t) {
          case 'Span': out = out.concat(inl(x.c[1])); return;
          case 'Image': {
            var alt = inlinesText(x.c[1]), target = x.c[2][0];
            if (isOurs(target)) {
              var n = images.length + 1;
              images.push({ n: n, target: target, alt: alt });
              out.push({ t: 'Str', c: '⟦img ' + n + '⟧' });
              return;
            }
            out.push({ t: 'Image', c: [NOATTR, inl(x.c[1]), x.c[2]] });
            return;
          }
          case 'Link': {
            var kids = inl(x.c[1]), href = x.c[2][0];
            // In-document anchors (#ch001.xhtml_x) mean nothing in a note.
            if (/^#/.test(href)) { out = out.concat(kids); return; }
            out.push({ t: 'Link', c: [NOATTR, kids, x.c[2]] });
            return;
          }
          case 'Code': out.push({ t: 'Code', c: [NOATTR, x.c[1]] }); return;
          case 'Emph': case 'Strong': case 'Strikeout': case 'Superscript': case 'Subscript': case 'SmallCaps': case 'Underline':
            out.push({ t: x.t, c: inl(x.c) }); return;
          case 'Quoted': out.push({ t: 'Quoted', c: [x.c[0], inl(x.c[1])] }); return;
          case 'Cite': out.push({ t: 'Cite', c: [x.c[0], inl(x.c[1])] }); return;
          case 'Note': out.push({ t: 'Note', c: blk(x.c) }); return;
          default: out.push(x);
        }
      });
      return out;
    }
    function cells(rows) {
      // Table rows: [attr, [cell]] ; cell: [attr, align, rowspan, colspan, blocks]
      return (rows || []).map(function (r) {
        return [r[0], r[1].map(function (c) { return [c[0], c[1], c[2], c[3], blk(c[4])]; })];
      });
    }
    function blk(bs) {
      var out = [];
      (bs || []).forEach(function (b) {
        if (!b || !b.t) { out.push(b); return; }
        switch (b.t) {
          case 'Div': out = out.concat(blk(b.c[1])); return;
          case 'Figure': {
            var body = blk(b.c[2]);
            var cap = blk(b.c[1][1] || []);
            var capText = blocksText(cap), alt = '';
            // The image's alt text usually repeats the caption.
            (b.c[2] || []).forEach(function (x) {
              if (x && (x.t === 'Plain' || x.t === 'Para')) x.c.forEach(function (i) { if (i && i.t === 'Image') alt = inlinesText(i.c[1]); });
            });
            out = out.concat(body);
            if (capText && capText !== alt) out = out.concat(cap.map(function (c) { return c.t === 'Plain' ? { t: 'Para', c: c.c } : c; }));
            return;
          }
          case 'Header': out.push({ t: 'Header', c: [b.c[0], NOATTR, inl(b.c[2])] }); return;
          case 'Para': case 'Plain': {
            var xs = inl(b.c);
            if (xs.length) out.push({ t: b.t, c: xs });
            return;
          }
          case 'LineBlock': out.push({ t: 'LineBlock', c: b.c.map(inl) }); return;
          case 'CodeBlock': {
            var cls = (b.c[0][1] || []).filter(function (c) { return c !== 'sourceCode'; }).slice(0, 1);
            out.push({ t: 'CodeBlock', c: [['', cls, []], b.c[1]] });
            return;
          }
          case 'BlockQuote': out.push({ t: 'BlockQuote', c: blk(b.c) }); return;
          case 'BulletList': out.push({ t: 'BulletList', c: b.c.map(blk) }); return;
          case 'OrderedList': out.push({ t: 'OrderedList', c: [b.c[0], b.c[1].map(blk)] }); return;
          case 'DefinitionList':
            out.push({ t: 'DefinitionList', c: b.c.map(function (d) { return [inl(d[0]), d[1].map(blk)]; }) });
            return;
          case 'Table': {
            // [attr, caption, colspecs, head, bodies, foot]
            var c = b.c;
            var head = [c[3][0], cells(c[3][1])];
            var bodies = c[4].map(function (bd) { return [bd[0], bd[1], cells(bd[2]), cells(bd[3])]; });
            var foot = [c[5][0], cells(c[5][1])];
            out.push({ t: 'Table', c: [NOATTR, [c[1][0], blk(c[1][1])], c[2], head, bodies, foot] });
            return;
          }
          default: out.push(b);
        }
      });
      return out;
    }
    var res = { 'pandoc-api-version': ast['pandoc-api-version'], meta: {}, blocks: blk(ast.blocks || []) };
    // A document title (EPUB/DOCX metadata) becomes the first heading when
    // the body doesn't already start with it.
    var t = ast.meta && ast.meta.title;
    var titleText = t ? (t.t === 'MetaInlines' ? inlinesText(t.c) : t.t === 'MetaString' ? t.c : '') : '';
    var first = res.blocks[0];
    if (titleText && !(first && first.t === 'Header' && inlinesText(first.c[2]) === titleText)) {
      res.blocks.unshift({ t: 'Header', c: [1, NOATTR, t.t === 'MetaInlines' ? inl(t.c) : [{ t: 'Str', c: titleText }]] });
    }
    return { ast: res, images: images };
  }

  // Markdown with ⟦img N⟧ placeholders -> final text.
  //   mode 'alt'   : "[image: alt]" (downloads / copies: the files aren't there)
  //   mode 'lines' : each placeholder alone on its own line, for the panel to
  //                  replace with the app's own image tokens on import. Inside
  //                  a table row or list item that would break the structure,
  //                  so those keep the alt text (reported in `dropped`).
  // -> { text, kept: [n], dropped: [n] }
  function placeImages(md, images, mode) {
    var byN = {}, kept = [], dropped = [];
    (images || []).forEach(function (im) { byN[im.n] = im; });
    var alt = function (n) {
      var im = byN[n], a = im && im.alt ? im.alt.replace(/([\\\[\]*_`])/g, '\\$1') : '';
      return '*[image' + (a ? ': ' + a : '') + ']*';
    };
    // images with keep:false (no bytes / not a web image) always get alt text.
    var keepable = function (n) { return !!byN[n] && byN[n].keep !== false; };
    var lines = String(md).split('\n').map(function (line) {
      if (line.indexOf('⟦img ') === -1) return line;
      var alone = /^\s*⟦img (\d+)⟧\s*$/.exec(line);
      if (mode === 'lines' && alone && keepable(alone[1])) { kept.push(+alone[1]); return '⟦img ' + alone[1] + '⟧'; }
      var structural = /^\s*(\||[-*+] |\d+[.)] |>)/.test(line);
      // Mid-paragraph (lines mode): break the line around each image.
      return line.replace(/[ \t]*⟦img (\d+)⟧[ \t]*/g, function (m, n) {
        if (mode !== 'lines' || structural || !keepable(n)) {
          dropped.push(+n);
          return m.replace(/⟦img \d+⟧/, alt(n));
        }
        kept.push(+n);
        return '\n⟦img ' + n + '⟧\n';
      }).replace(/^\n+|\n+$/g, '');
    });
    return { text: lines.join('\n'), kept: kept, dropped: dropped };
  }

  // ---- a note as pandoc input ---------------------------------------------------------
  // App image tokens ![img:j#hash] / legacy inline ![img:j:base64] become real
  // Markdown images pointing at files the panel supplies (only for writers
  // that embed images; elsewhere they'd be dangling paths, so they become
  // "[image]"). File pills ![file:name#hash|s123] become "[file: name]".
  var IMG_RE = /!\[img:(?:([jwa])([:#]))?([A-Za-z0-9+\/=]+)(?:\|w(\d{2,4}))?\]/g;
  var FILE_RE = /!\[file:([^\]#]*)#([A-Za-z0-9_-]+)(?:\|s\d+)?\]/g;
  var IMG_EXT = { j: 'jpg', w: 'webp', a: 'avif' };
  function noteInput(text, embed) {
    var images = [];
    var out = String(text || '').replace(IMG_RE, function (m, code, sep, data) {
      if (!embed) return '*[image]*';
      code = code || 'j';
      var ref = sep === '#';
      var key = ref ? data : 'inline' + (images.length + 1);
      var path = 'note-img/' + key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) + '.' + (IMG_EXT[code] || 'jpg');
      images.push({ path: path, code: code, hash: ref ? data : '', b64: ref ? '' : data });
      return '![](' + path + ')';
    }).replace(FILE_RE, function (m, name) {
      return '[file: ' + String(name).replace(/([\\\[\]*_`])/g, '\\$1') + ']';
    });
    return { text: out, images: images };
  }

  // ---- messages -------------------------------------------------------------------------
  // Only warnings worth showing (pandoc also reports INFO: loaded resources, lang...).
  function warningsOf(list) {
    return (list || []).filter(function (w) { return w && w.verbosity === 'WARNING'; })
      .map(function (w) { return String(w.pretty || w.message || w.type || '').split('\n')[0]; })
      .filter(function (s, i, a) { return s && a.indexOf(s) === i; });
  }
  function errorText(stderr) {
    var s = String(stderr || '').replace(/^\s*(ERROR|\[ERROR\])\s*:?\s*/i, '').trim();
    if (!s) return 'pandoc couldn’t convert this file';
    if (/Unknown (input|output) format/i.test(s)) return 'This pandoc build can’t do that format';
    if (/Couldn't (parse|unpack)|Failed to unpack|not enough bytes|Did not find end of central directory/i.test(s)) return 'This file looks damaged or isn’t really that format (' + s.split('\n')[0].slice(0, 120) + ')';
    return s.split('\n').slice(0, 3).join(' ').slice(0, 300);
  }

  var api = {
    READERS: READERS, WRITERS: WRITERS, W: W, EXT: EXT, MIME: MIME,
    detect: detect, sniffText: sniffText, writersFor: writersFor, plan: plan, outName: outName, baseName: baseName,
    cleanAst: cleanAst, placeImages: placeImages, noteInput: noteInput, warningsOf: warningsOf, errorText: errorText,
    inlinesText: inlinesText,
  };
  root.__cadeConvertPandoc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
