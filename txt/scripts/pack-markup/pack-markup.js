/* Markup Pack — XML, SOAP, JSON, HTML and Markdown conversions + Validate XML.
   Script-pack module: registers 8 palette scripts, each a one-line call into
   the runner below, which loads the pure engine (markup-core.js, local) on
   first use — and marked (the Live Preview's pinned, checksummed copy, from its
   Cache Storage bucket when it is there) only for Markdown input.

   Input: the selection -> the ``` block at the cursor -> the whole note. The
   source type comes from the fence's language when there is one (xml, soap,
   json, html, md…), else it is sniffed. Output replaces the same range in one
   undoable step: a selection gets the plain result (and stays selected, so Live
   Preview can show it straight away); a ``` block becomes a block of the new
   language (Markdown output replaces the block with plain Markdown); the note is
   replaced as a whole. Errors name the editor line and column. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CORE_URL = Cade.asset('markup-core.js');
  var MARKED = { url: 'https://cdn.jsdelivr.net/npm/marked@18.0.11/lib/marked.umd.js', sha256: '69451c8541c9c1e7a4bf3ffc6f73c4d89633de92bfbe3e484dfe182ef8091f88' };

  function toast(m, t, d) { try { Cade.showToast(m, t || 'info', d || 3000); } catch (e) {} }
  function loadScript(src, text) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'), url = null;
      if (text != null) { try { url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' })); } catch (e) {} }
      s.src = url || src; s.async = false;
      s.onload = function () { if (url) URL.revokeObjectURL(url); res(); };
      s.onerror = function () { if (url) URL.revokeObjectURL(url); rej(new Error('Markup Pack: failed to load ' + src.split('/').pop())); };
      document.head.appendChild(s);
    });
  }
  var coreP = null;
  function core() {
    if (window.__cadeMarkup) return Promise.resolve(window.__cadeMarkup);
    if (!coreP) coreP = loadScript(CORE_URL).then(function () { if (!window.__cadeMarkup) throw new Error('Markup Pack failed to start'); return window.__cadeMarkup; }, function (e) { coreP = null; throw e; });
    return coreP;
  }
  // marked: the page's copy, else Live Preview's / the File Converter's cached file, else one checked download
  var mdInst = null;
  function hex(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function marked() {
    if (mdInst) return Promise.resolve(mdInst);
    var make = function () { mdInst = new window.marked.Marked({ gfm: true, breaks: true, async: false }); return mdInst; };
    if (window.marked && window.marked.Marked) return Promise.resolve(make());
    var cs = window.caches;
    var fromCache = function (name) { return cs ? cs.open(name).then(function (c) { return c.match(MARKED.url); }).then(function (r) { return r ? r.text() : null; }, function () { return null; }) : Promise.resolve(null); };
    return fromCache('cade-preview-v1').then(function (t) { return t || fromCache('cade-convert-v1'); }).then(function (t) {
      if (t) return t;
      return fetch(MARKED.url, { mode: 'cors', credentials: 'omit', cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        return (window.crypto && window.crypto.subtle ? window.crypto.subtle.digest('SHA-256', buf).then(hex) : Promise.resolve(MARKED.sha256)).then(function (h) {
          if (h !== MARKED.sha256) throw new Error('the Markdown parser failed its checksum');
          var text = new TextDecoder().decode(buf);
          if (cs) cs.open('cade-preview-v1').then(function (c) { return c.put(MARKED.url, new Response(text, { headers: { 'Content-Type': 'text/javascript' } })); }).catch(function () {});
          return text;
        });
      });
    }).then(function (text) { return loadScript(MARKED.url, text); }).then(function () {
      if (!window.marked || !window.marked.Marked) throw new Error('the Markdown parser failed to start');
      return make();
    }, function (e) { throw new Error('Markdown input needs the Markdown parser: ' + (/HTTP|fetch|network|load/i.test(e.message) ? 'one online load (offline?)' : e.message)); });
  }

  // ---- what to convert --------------------------------------------------------------------------
  var FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
  function fences(doc) {
    var out = [], open = null;
    for (var n = 1; n <= doc.lines; n++) {
      var m = FENCE_RE.exec(doc.line(n).text);
      if (!open) { if (m) open = { open: n, close: -1, marker: m[2], info: m[3].trim() }; }
      else if (m && m[2].charAt(0) === open.marker.charAt(0) && m[2].length >= open.marker.length && !m[3].trim()) { open.close = n; out.push(open); open = null; }
    }
    if (open) out.push(open);
    return out;
  }
  // -> { scope: 'selection' | 'fence' | 'note', from, to (the text), text, lang, blockFrom, blockTo }
  function detectRange() {
    var ed = Cade.editor, st = ed.state, sel = st.selection.main, doc = st.doc, fs = fences(doc), i, b;
    function inner(f) {
      var a = f.open + 1, z = f.close === -1 ? doc.lines : f.close - 1;
      if (a > z) { var p = doc.line(f.open).to; return { from: p, to: p }; }
      return { from: doc.line(a).from, to: doc.line(z).to };
    }
    function fence(f) {
      var r = inner(f);
      return { scope: 'fence', from: r.from, to: r.to, text: doc.sliceString(r.from, r.to), lang: f.info.split(/\s+/)[0].toLowerCase(),
        blockFrom: doc.line(f.open).from, blockTo: f.close === -1 ? doc.length : doc.line(f.close).to };
    }
    if (!sel.empty) {
      // a selection that is exactly a block's content counts as the block (so the result is re-fenced)
      var text = st.sliceDoc(sel.from, sel.to);
      for (i = 0; i < fs.length; i++) {
        b = fs[i];
        var r = inner(b);
        if (sel.from >= r.from && sel.to <= r.to && doc.sliceString(r.from, r.to).trim() === text.trim()) return fence(b);
      }
      return { scope: 'selection', from: sel.from, to: sel.to, text: text, lang: '' };
    }
    var line = doc.lineAt(sel.head).number;
    for (i = 0; i < fs.length; i++) {
      b = fs[i];
      if (line >= b.open && (b.close === -1 || line <= b.close)) return fence(b);
    }
    return { scope: 'note', from: 0, to: doc.length, text: doc.toString(), lang: '' };
  }
  var FENCE_TYPE = { xml: 'xml', soap: 'xml', wsdl: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', rss: 'xml', atom: 'xml', plist: 'xml', json: 'json', geojson: 'json', html: 'html', htm: 'html', xhtml: 'html', md: 'markdown', markdown: 'markdown' };
  function sourceType(R, C) {
    var f = FENCE_TYPE[R.lang], sn = C.sniff(R.text);
    if (f === 'xml') return sn.type === 'soap' ? 'soap' : 'xml';
    if (f) return f;
    return sn.type === 'text' ? 'markdown' : sn.type;
  }
  var LABEL = { xml: 'XML', soap: 'SOAP', json: 'JSON', html: 'HTML', markdown: 'Markdown' };

  // core errors ({ message, line, col, offset } inside the converted text) as editor positions
  function where(R, e, kind) {
    var doc = Cade.editor.state.doc, first = doc.lineAt(Math.min(R.from, doc.length));
    var line = first.number + e.line - 1, col = e.line === 1 ? e.col + (R.from - first.from) : e.col;
    var msg = String(e.message).replace(/\(opened at line (\d+)\)/, function (m, n) { return '(opened at line ' + (first.number + +n - 1) + ')'; });
    var err = new Error(kind + ' error at line ' + line + ', column ' + col + ': ' + msg);
    err.pos = R.from + (e.offset || 0);
    return err;
  }
  function jsonOf(C, R) {
    var r = C.parseJSON(R.text);
    if (r.error) throw where(R, r.error, 'JSON');
    return r.value;
  }
  function xmlDoc(C, R) {
    var r = C.parseXML(R.text);
    if (r.error) throw where(R, r.error, 'XML');
    return r.doc;
  }
  function docTree(C, R, type) {
    if (type === 'html') return Promise.resolve(C.htmlToDoc(R.text));
    return marked().then(function (M) { return C.htmlToDoc(M.parse(R.text)); });
  }
  function pretty(v) { return JSON.stringify(v, null, 2) + '\n'; }
  function need(type, ok, what) {
    if (ok.indexOf(type) < 0) throw new Error('This looks like ' + LABEL[type] + ' — ' + what);
  }

  // op -> Promise<{ text, lang, note }>
  function convert(op, C, R, type) {
    switch (op) {
      case 'json':
        if (type === 'json') throw new Error('This is JSON already (tip: Beautify Code pretty-prints it)');
        if (type === 'xml') { var d = xmlDoc(C, R); return { text: pretty(C.xmlToJson(d)), lang: 'json', note: 'XML → JSON · ' + d.elements + ' elements' }; }
        if (type === 'soap') { var sd = xmlDoc(C, R), so = C.soapOf(sd); return { text: pretty(C.soapToJson(sd)), lang: 'json', note: 'SOAP ' + so.version + (so.fault ? ' Fault' : '') + ' → JSON (Body payload)' }; }
        return docTree(C, R, type).then(function (t) { return { text: pretty(t), lang: 'json', note: LABEL[type] + ' → JSON document tree' }; });
      case 'json-nons':
        need(type, ['xml', 'soap'], 'XML → JSON needs XML (or a SOAP envelope)');
        var nd = xmlDoc(C, R);
        return { text: pretty(C.xmlToJson(nd, { stripNs: true })), lang: 'json', note: 'XML → JSON without namespaces · ' + nd.elements + ' elements' };
      case 'xml':
        if (type === 'xml' || type === 'soap') throw new Error('This is XML already (tip: Beautify Code pretty-prints it, Validate XML checks it)');
        if (type === 'json') return { text: C.jsonToXml(jsonOf(C, R)), lang: 'xml', note: 'JSON → XML' };
        return docTree(C, R, type).then(function (t) { return { text: C.docToXml(t), lang: 'xml', note: LABEL[type] + ' → XML document tree' }; });
      case 'xml-root':
        need(type, ['json'], 'JSON → XML needs JSON');
        var v = jsonOf(C, R), keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
        var def = keys.length === 1 && !/^[@#]/.test(keys[0]) && !Array.isArray(v[keys[0]]) ? keys[0] : 'root';
        var root = window.prompt('Root element name:', def);
        if (root === null) return null;
        root = root.trim() || def;
        return { text: C.jsonToXml(v, { root: root }), lang: 'xml', note: 'JSON → XML · root <' + C.encodeName(root) + '>' };
      case 'soap':
        need(type, ['json'], 'JSON → SOAP needs JSON (the operation’s parameters)');
        var p = jsonOf(C, R), o = {}, k = p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p) : [];
        var isFault = k.length === 1 && k[0] === 'fault';
        if (!isFault) {
          var body = k.length && k.every(function (x) { return x === 'Body' || x === 'Header'; }) && p.Body ? p.Body : p;
          var bk = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
          var op1 = window.prompt('Operation name (the Body element):', bk.length === 1 && !/^[@#]/.test(bk[0]) ? bk[0] : 'Request');
          if (op1 === null) return null;
          var ns = window.prompt('Operation namespace URI (blank for none):', 'http://tempuri.org/');
          if (ns === null) return null;
          o.operation = op1.trim() || 'Request'; o.ns = ns.trim();
        }
        var ver = window.prompt('SOAP version (1.1 or 1.2):', '1.1');
        if (ver === null) return null;
        o.version = /1\.?2/.test(ver) ? '1.2' : '1.1';
        return { text: C.jsonToSoap(p, o), lang: 'xml', note: 'JSON → SOAP ' + o.version + (isFault ? ' Fault' : ' envelope · ' + o.operation) };
      case 'md':
        if (type === 'markdown') throw new Error('This is Markdown already');
        if (type === 'xml') return { text: C.xmlToMarkdown(xmlDoc(C, R)), lang: 'markdown', note: 'XML → Markdown' };
        if (type === 'soap') return { text: C.soapToMarkdown(xmlDoc(C, R)), lang: 'markdown', note: 'SOAP → Markdown' };
        if (type === 'json') return { text: C.valueToMarkdown(jsonOf(C, R)), lang: 'markdown', note: 'JSON → Markdown' };
        return { text: C.htmlToMarkdown(R.text), lang: 'markdown', note: 'HTML → Markdown' };
      case 'html':
        if (type === 'html') throw new Error('This is HTML already');
        if (type === 'xml') return { text: C.xmlToHtml(xmlDoc(C, R)), lang: 'html', note: 'XML → HTML' };
        if (type === 'soap') return { text: C.soapToHtml(xmlDoc(C, R)), lang: 'html', note: 'SOAP → HTML' };
        if (type === 'json') return { text: C.valueToHtml(jsonOf(C, R)), lang: 'html', note: 'JSON → HTML' };
        return marked().then(function (M) { return { text: M.parse(R.text), lang: 'html', note: 'Markdown → HTML' }; });
    }
    throw new Error('Unknown conversion: ' + op);
  }

  function place(C, R, out) {
    var ed = Cade.editor, len = ed.state.doc.length, body = out.text.replace(/\s+$/, ''), from, to, insert, sel;
    if (R.scope === 'fence') {
      from = R.blockFrom; to = R.blockTo;
      if (out.lang === 'markdown') { insert = body; sel = { anchor: from }; }
      else { var f = C.fenceFor(body); insert = f + out.lang + '\n' + body + '\n' + f; sel = { anchor: from + f.length + out.lang.length + 1 }; }
    } else if (R.scope === 'selection') {
      from = R.from; to = R.to;
      insert = body + (/\n$/.test(R.text) ? '\n' : '');
      sel = { anchor: from, head: from + body.length };
    } else { from = 0; to = len; insert = body + '\n'; sel = { anchor: 0 }; }
    from = Math.min(from, len); to = Math.min(to, len);
    sel.anchor = Math.min(sel.anchor, from + insert.length);
    if (sel.head != null) sel.head = Math.min(sel.head, from + insert.length);
    ed.dispatch({ changes: { from: from, to: to, insert: insert }, selection: sel, userEvent: 'input', scrollIntoView: true });
  }

  function run(ctx, op) {
    var R = detectRange();
    if (!R.text.trim()) return Promise.reject(new Error('Nothing to convert — select text, put the cursor in a ``` block, or write a note'));
    if (Cade.editor.state.readOnly) return Promise.reject(new Error('Read-only mode — editing is locked'));
    var doc0 = Cade.editor.state.doc;
    return core().then(function (C) {
      var type = sourceType(R, C);
      return Promise.resolve(convert(op, C, R, type)).then(function (out) {
        if (!out) return; // a prompt was cancelled
        if (!Cade.editor.state.doc.eq(doc0)) throw new Error('The note changed while converting; run it again');
        place(C, R, out);
        toast(out.note + (R.scope === 'selection' ? ' (selection)' : R.scope === 'fence' ? ' (block)' : ''), 'success', 2800);
      });
    });
  }
  function validate() {
    var R = detectRange();
    if (!R.text.trim()) return Promise.reject(new Error('Nothing to validate — select XML, put the cursor in a ```xml block, or open an XML note'));
    return core().then(function (C) {
      var r = C.parseXML(R.text);
      if (!r.error && typeof DOMParser === 'function' && R.text.length < 4e6) {
        // the browser's own parser as a second opinion (it knows a few rules ours doesn't)
        try {
          var d = new DOMParser().parseFromString(R.text.replace(/^\s+(?=<\?xml)/, ''), 'application/xml'), pe = d.getElementsByTagName('parsererror')[0];
          if (pe) {
            var msg = (pe.textContent || '').replace(/\s+/g, ' ').trim(), lm = /line (\d+)[^\d]+column (\d+)/i.exec(msg);
            r = { error: { message: 'the browser reports: ' + msg.replace(/^This page contains the following errors:\s*/i, '').replace(/\s*Below is a rendering.*$/i, '').slice(0, 200), line: lm ? +lm[1] : 1, col: lm ? +lm[2] : 1, offset: 0 } };
          }
        } catch (e) {}
      }
      if (r.error) {
        var e = where(R, r.error, 'XML'), ed = Cade.editor;
        if (r.error.offset || r.error.line === 1) {
          var pos = Math.min(e.pos, ed.state.doc.length), CM = Cade.CM || {};
          ed.dispatch({ selection: { anchor: pos }, effects: CM.EditorView && CM.EditorView.scrollIntoView ? CM.EditorView.scrollIntoView(pos, { y: 'center' }) : undefined });
        }
        throw new Error('Not well-formed: ' + e.message.replace(/^XML error /, ''));
      }
      var s = C.soapOf(r.doc);
      toast('Well-formed XML · ' + r.doc.elements + ' element' + (r.doc.elements === 1 ? '' : 's') + ' · depth ' + r.doc.depth +
        (s ? ' · SOAP ' + s.version + ' envelope' + (s.fault ? ' with a Fault' : '') : '') + (R.scope === 'selection' ? ' (selection)' : R.scope === 'fence' ? ' (block)' : ''), 'success', 4000);
    });
  }
  window.__CADE_MARKUP__ = { run: run, validate: validate, _detectRange: detectRange };

  // ---- the scripts ------------------------------------------------------------------------------------
  function reg(meta, call) {
    Cade.registerScript('/**\n' + JSON.stringify(meta, null, 2) + '\n**/\nasync function main(ctx) {\n  await window.__CADE_MARKUP__.' + call + ';\n}');
  }
  var I = {
    json: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1'/><path d='M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'/></svg>",
    xml: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='8 6 3 12 8 18'/><polyline points='16 6 21 12 16 18'/><line x1='14' y1='4' x2='10' y2='20'/></svg>",
    soap: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='5' width='18' height='14' rx='2'/><polyline points='3 7 12 13 21 7'/></svg>",
    md: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='5' width='20' height='14' rx='2'/><path d='M6 15V9l2.5 3L11 9v6'/><path d='M17 9v6M15 13l2 2 2-2'/></svg>",
    html: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 3h16l-1.5 16L12 21l-6.5-2L4 3z'/><path d='M15.5 8H8.5l.3 3.5h6.4l-.4 3.5-2.8 1-2.8-1'/></svg>",
    check: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/><polyline points='9 12 11 14 15 10'/></svg>"
  };
  var SCRIPTS = [
    { name: 'Convert to JSON', description: 'XML (namespaces kept as prefixed keys, "@attr", "#text", repeats → arrays), a SOAP envelope (Body payload, or {fault}) or HTML / Markdown (a document tree of sections, paragraphs, lists, tables, code, links) → JSON — the selection, the ``` block at the cursor or the note',
      icon: I.json, tags: 'convert,json,xml to json,soap to json,html to json,markdown to json,md to json,xml,soap,html,markdown,md,document tree,parse,envelope,namespaces', call: 'run(ctx, "json")' },
    { name: 'XML → JSON (strip namespaces)', description: 'XML or SOAP → JSON with the namespace prefixes and xmlns declarations dropped ("soap:Body" → "Body")',
      icon: I.json, tags: 'xml,json,xml to json,convert,strip,namespaces,prefixes,xmlns,soap,local name', call: 'run(ctx, "json-nons")' },
    { name: 'Convert to XML', description: 'JSON (a single top-level key is the root; arrays → repeated elements; "@attr" / "#text" honoured; invalid names escaped as _xHHHH_) or HTML / Markdown (the document tree) → XML',
      icon: I.xml, tags: 'convert,xml,json to xml,html to xml,markdown to xml,md to xml,json,html,markdown,md,document tree,elements', call: 'run(ctx, "xml")' },
    { name: 'JSON → XML…', description: 'JSON → XML with the root element name you choose',
      icon: I.xml, tags: 'json,xml,json to xml,convert,root,element,name,prompt', call: 'run(ctx, "xml-root")' },
    { name: 'JSON → SOAP Envelope…', description: 'Wrap JSON parameters in a SOAP 1.1 / 1.2 envelope — asks for the operation name, its namespace and the version ({"fault": {…}} becomes a Fault)',
      icon: I.soap, tags: 'soap,envelope,json to soap,wsdl,web service,request,operation,namespace,fault,xml,convert,1.1,1.2', call: 'run(ctx, "soap")' },
    { name: 'Convert to Markdown', description: 'XML, a SOAP envelope, JSON (headings for top-level keys, tables for lists of records, nested lists) or HTML → readable Markdown',
      icon: I.md, tags: 'convert,markdown,md,xml to markdown,json to markdown,soap to markdown,html to markdown,html to md,readable,table,list', call: 'run(ctx, "md")' },
    { name: 'Convert to HTML', description: 'XML, a SOAP envelope, JSON (headings, definition lists, tables — escaped) or Markdown → a clean HTML fragment',
      icon: I.html, tags: 'convert,html,markdown to html,md to html,xml to html,json to html,soap to html,render,table,definition list', call: 'run(ctx, "html")' },
    { name: 'Validate XML', description: 'Check that the selection, the ``` block at the cursor or the note is well-formed XML (with namespaces) — the first error with its line and column, the cursor moved there; SOAP envelopes are recognised',
      icon: I.check, tags: 'validate,xml,well-formed,wellformed,check,lint,parse,error,soap,namespaces,xsd,wsdl', call: 'validate()' }
  ];
  SCRIPTS.forEach(function (s) { reg({ name: s.name, description: s.description, author: 'Cade', icon: s.icon, tags: s.tags }, s.call); });
  window.__CADE_MARKUP__.SCRIPTS = SCRIPTS;
})();
