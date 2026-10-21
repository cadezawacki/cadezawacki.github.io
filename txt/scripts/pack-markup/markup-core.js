/* Markup Core — pure parsing and conversion for XML, SOAP, JSON, HTML and
 * Markdown (no DOM, no network). UMD: window.__cadeMarkup in the page,
 * module.exports in node (markup-core.test.js). Used by the Markup Pack
 * scripts (pack-markup.js) and by Live Preview's XML / SOAP / JSON views.
 *
 *   parseXML(text)            -> { doc, error }   error = { message, line, col, offset }
 *                                 Strict well-formedness (XML 1.0 + namespaces): tags,
 *                                 one root, quoting, entities, bound prefixes, comments…
 *   serializeXML(node, o)     -> pretty-printed XML text
 *   xmlToJson(doc, o)         -> { root: … }  "@attr", "#text", repeats -> arrays,
 *                                 prefixes kept ("soap:Body", "@xmlns:soap"); o.stripNs drops them
 *   jsonToXml(value, o)       -> XML text (o.root: root element name; arrays -> repeated elements)
 *   soapOf(doc)               -> null | { version, ns, header, headers, body, operation, payload, fault }
 *   soapToJson(doc, o)        -> Body payload ({ Op: … }) or { fault: { code, reason, … } }
 *   jsonToSoap(value, o)      -> SOAP 1.1 / 1.2 envelope text (o.operation, o.ns, o.version)
 *   parseJSON(text)           -> { value, error } (error with line / col)
 *   parseHTML(text)           -> lenient HTML tree (void / raw-text elements, implied ends)
 *   htmlToDoc(html)           -> the document tree below; mdHtml for Markdown (render with marked first)
 *   docToXml(doc)             -> the same tree as XML
 *   htmlToMarkdown(html)      -> Markdown (headings, lists, tasks, tables, code, quotes, links…)
 *   valueToMarkdown(v, o) / valueToHtml(v, o) -> readable Markdown / HTML for any JSON value
 *   xmlToMarkdown / xmlToHtml / soapToMarkdown / soapToHtml (XML text in)
 *   sniff(text)               -> { type: 'json'|'xml'|'soap'|'html'|'markdown'|'text', xml? }
 *
 * Document tree (HTML / Markdown -> JSON):
 *   { type: 'document', title?, content: [block…], sections: [section…] }
 *   section = { heading, level, id?, content: [block…], sections: [section…] }
 *   block   = { type: 'paragraph', text, links?: [{ text, href }] }
 *           | { type: 'list', ordered, start?, items: [{ text, checked?, links?, children?: [block…] }] }
 *           | { type: 'table', caption?, headers: [..], rows: [[..]..] }
 *           | { type: 'code', language?, text } | { type: 'quote', content: [block…] }
 *           | { type: 'image', src, alt?, title? } | { type: 'rule' } | { type: 'heading', level, text }
 *           | { type: 'definitions', items: [{ term, description }] }
 * ES5. */
(function (root) {
  'use strict';

  var XML_NS = 'http://www.w3.org/XML/1998/namespace', XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
  var SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/', SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';
  var hasOwn = Object.prototype.hasOwnProperty;

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObj(v) { return v !== null && typeof v === 'object' && !isArr(v); }
  // own-property set that is safe for keys like "__proto__"
  function put(o, k, v) {
    if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
    else o[k] = v;
  }
  function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;'); }
  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ---- positions ----------------------------------------------------------------------------------
  function lineCol(src, off) {
    var line = 1, last = -1;
    for (var i = 0; i < off && i < src.length; i++) if (src.charCodeAt(i) === 10) { line++; last = i; }
    return { line: line, col: off - last };
  }
  function XmlError(msg, at) { this.message = msg; this.at = at; }

  // ---- XML names --------------------------------------------------------------------------------------
  var NS_START = 'A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
  var NS_CHAR = NS_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040';
  var SURR = '|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]';
  var NAME_SRC = '(?:[:' + NS_START + ']' + SURR + ')(?:[:' + NS_CHAR + ']' + SURR + ')*';
  var NAME_Y = new RegExp(NAME_SRC, 'y');
  var NAME_FULL = new RegExp('^' + NAME_SRC + '$');
  var NCNAME_FULL = new RegExp('^(?:[' + NS_START + ']' + SURR + ')(?:[' + NS_CHAR + ']' + SURR + ')*$');
  var BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
  function isQName(n) {
    var c = n.indexOf(':');
    if (c < 0) return NCNAME_FULL.test(n);
    return c === n.lastIndexOf(':') && NCNAME_FULL.test(n.slice(0, c)) && NCNAME_FULL.test(n.slice(c + 1));
  }
  function prefixOf(n) { var c = n.indexOf(':'); return c > 0 ? n.slice(0, c) : ''; }
  function localOf(n) { var c = n.indexOf(':'); return c > 0 ? n.slice(c + 1) : n; }

  var PREDEF = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function legalCode(c) { return c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD) || (c >= 0x10000 && c <= 0x10FFFF); }
  function fromCode(c) {
    if (c < 0x10000) return String.fromCharCode(c);
    c -= 0x10000;
    return String.fromCharCode(0xD800 + (c >> 10), 0xDC00 + (c & 1023));
  }
  var REF_Y = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z_:\u00C0-\uFFFF][\w.:\-\u00B7-\uFFFF]*));/y;

  // ---- XML parser ----------------------------------------------------------------------------------------
  // Nodes: document { type, children, decl? }, element { type, name, prefix, local, ns,
  // attrs: [[name, value]…], children, line, at }, text / cdata / comment { type, value },
  // pi { type, name, value }, doctype { type, value }.
  function parseXML(input) {
    var src = String(input == null ? '' : input);
    var doc = { type: 'document', children: [], decl: null, elements: 0, depth: 0 };
    try { xmlParse(src, doc); }
    catch (e) {
      if (!(e instanceof XmlError)) throw e;
      var p = lineCol(src, e.at);
      return { doc: null, error: { message: e.message, line: p.line, col: p.col, offset: e.at } };
    }
    return { doc: doc, error: null };
  }
  function xmlParse(src, doc) {
    var n = src.length, i = 0, stack = [], cur = doc, rootSeen = false, ents = null, lenient = false;
    var scope = { xml: XML_NS, xmlns: XMLNS_NS }, scopes = [];
    var line = 1, lineAt = 0; // line of offset lineAt (incremental)
    function lineOf(off) { for (var k = lineAt; k < off; k++) if (src.charCodeAt(k) === 10) line++; lineAt = off; return line; }
    function fail(msg, at) { throw new XmlError(msg, at == null ? i : at); }
    function ws(c) { return c === 32 || c === 10 || c === 9 || c === 13; }
    function skipWs() { while (i < n && ws(src.charCodeAt(i))) i++; }
    function name(at, what) {
      NAME_Y.lastIndex = at;
      var m = NAME_Y.exec(src);
      if (!m) fail(at >= n ? 'Unexpected end of input: expected ' + what : 'Expected ' + what + ', found ' + JSON.stringify(src.charAt(at)), at);
      return m[0];
    }
    function checkChars(s, base) {
      var m = BAD_CHARS.exec(s);
      if (m) fail('Character U+' + ('000' + m[0].charCodeAt(0).toString(16).toUpperCase()).slice(-4) + ' is not allowed in XML', base + m.index);
    }
    function decode(s, base) {
      var amp = s.indexOf('&');
      if (amp < 0) return s;
      var out = '', last = 0;
      while (amp >= 0) {
        REF_Y.lastIndex = amp;
        var m = REF_Y.exec(s);
        if (!m) {
          var semi = /^&[^\s&;<]*;/.exec(s.slice(amp, amp + 64));
          fail(semi ? 'Malformed entity reference ' + semi[0] : 'A bare "&" must be written as &amp;', base + amp);
        }
        var v;
        if (m[1] || m[2]) {
          var code = m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10);
          if (!legalCode(code)) fail('Character reference ' + m[0] + ' is not a legal XML character', base + amp);
          v = fromCode(code);
        } else if (hasOwn.call(PREDEF, m[3])) v = PREDEF[m[3]];
        else if (ents && hasOwn.call(ents, m[3])) v = ents[m[3]];
        else if (lenient) v = m[0];
        else fail('Undefined entity ' + m[0] + (/^(nbsp|copy|reg|hellip|mdash|ndash|eacute)$/.test(m[3]) ? ' (an HTML entity: use &#…; in XML)' : ''), base + amp);
        out += s.slice(last, amp) + v;
        last = amp + m[0].length;
        amp = s.indexOf('&', last);
      }
      return out + s.slice(last);
    }
    function addText(a, b) {
      var raw = src.slice(a, b);
      if (cur === doc) {
        var k = raw.search(/\S/);
        if (k >= 0) fail(rootSeen ? 'Text after the root element' : 'Text before the root element', a + k);
        return;
      }
      checkChars(raw, a);
      var cd = raw.indexOf(']]>');
      if (cd >= 0) fail('"]]>" is not allowed in text', a + cd);
      var v = decode(raw, a), kids = cur.children, last = kids[kids.length - 1];
      if (last && last.type === 'text') last.value += v;
      else kids.push({ type: 'text', value: v });
    }
    // a leading BOM / whitespace before "<?xml" is tolerated (selections and notes often start with a newline)
    if (src.charCodeAt(0) === 0xFEFF) i = 1;
    var lead = i;
    while (lead < n && ws(src.charCodeAt(lead))) lead++;
    if (src.substr(lead, 5) === '<?xml' && ws(src.charCodeAt(lead + 5))) {
      var de = src.indexOf('?>', lead);
      if (de < 0) fail('Unclosed XML declaration', lead);
      var body = src.slice(lead + 5, de), dm;
      doc.decl = {};
      var dre = /\s*([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      while ((dm = dre.exec(body))) doc.decl[dm[1]] = dm[2] != null ? dm[2] : dm[3];
      if (!doc.decl.version) fail('The XML declaration needs a version="1.0"', lead);
      doc.children.push({ type: 'pi', name: 'xml', value: body.trim() });
      i = de + 2;
    }
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) lt = n;
      if (lt > i) addText(i, lt);
      if (lt >= n) { i = n; break; }
      i = lt;
      var c = src.charCodeAt(i + 1), end, nm;
      if (c === 47) { // </name>
        nm = name(i + 2, 'a tag name after "</"');
        var at = i;
        i += 2 + nm.length;
        skipWs();
        if (src.charCodeAt(i) !== 62) fail('Expected ">" to close </' + nm + '>');
        i++;
        if (!stack.length) fail('Unexpected closing tag </' + nm + '>' + (rootSeen ? ' after the root element' : ''), at);
        if (nm !== cur.name) fail('Closing tag </' + nm + '> does not match <' + cur.name + '> (opened at line ' + cur.line + ')', at);
        stack.pop(); scope = scopes.pop();
        cur = stack.length ? stack[stack.length - 1] : doc;
      } else if (c === 33) { // <!
        if (src.substr(i, 4) === '<!--') {
          end = src.indexOf('-->', i + 4);
          if (end < 0) fail('Unclosed comment (no "-->")');
          var cm = src.slice(i + 4, end), dd = cm.indexOf('--');
          if (dd >= 0) fail('"--" is not allowed inside a comment', i + 4 + dd);
          if (cm.charAt(cm.length - 1) === '-') fail('A comment may not end with "--->"', end - 1);
          checkChars(cm, i + 4);
          cur.children.push({ type: 'comment', value: cm });
          i = end + 3;
        } else if (src.substr(i, 9) === '<![CDATA[') {
          if (cur === doc) fail('CDATA is only allowed inside the root element');
          end = src.indexOf(']]>', i + 9);
          if (end < 0) fail('Unclosed CDATA section (no "]]>")');
          checkChars(src.slice(i + 9, end), i + 9);
          cur.children.push({ type: 'cdata', value: src.slice(i + 9, end) });
          i = end + 3;
        } else if (src.substr(i, 9) === '<!DOCTYPE') {
          if (rootSeen || cur !== doc) fail('<!DOCTYPE> must come before the root element');
          var j = i + 9, depth = 0, q = 0;
          for (; j < n; j++) {
            var ch = src.charCodeAt(j);
            if (q) { if (ch === q) q = 0; }
            else if (ch === 34 || ch === 39) q = ch;
            else if (ch === 91) depth++;
            else if (ch === 93) depth--;
            else if (ch === 62 && depth <= 0) break;
          }
          if (j >= n) fail('Unclosed <!DOCTYPE>');
          var dt = src.slice(i + 9, j);
          if (/\b(SYSTEM|PUBLIC)\b/.test(dt.split('[')[0]) || /%/.test(dt)) lenient = true;
          var er = /<!ENTITY\s+([^\s%]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g, em;
          while ((em = er.exec(dt))) { ents = ents || {}; ents[em[1]] = em[2] != null ? em[2] : em[3]; }
          doc.children.push({ type: 'doctype', value: dt.trim() });
          i = j + 1;
        } else fail('Unexpected "<!" (expected a comment, CDATA or DOCTYPE)');
      } else if (c === 63) { // <?pi ?>
        nm = name(i + 2, 'a processing instruction name');
        if (nm.toLowerCase() === 'xml') fail('The XML declaration (<?xml … ?>) is only allowed at the very start');
        end = src.indexOf('?>', i + 2);
        if (end < 0) fail('Unclosed processing instruction <?' + nm);
        cur.children.push({ type: 'pi', name: nm, value: src.slice(i + 2 + nm.length, end).trim() });
        i = end + 2;
      } else { // <name attr="v"…> or />
        if (i + 1 >= n) fail('Unexpected end of input after "<"');
        nm = name(i + 1, 'an element name after "<"');
        var start = i;
        if (!isQName(nm)) fail('Invalid qualified name <' + nm + '>', i + 1);
        if (cur === doc && rootSeen) fail('Only one root element is allowed (found a second one: <' + nm + '>)', start);
        i += 1 + nm.length;
        var attrs = [], seen = {}, decls = null, self = false;
        for (;;) {
          var before = i;
          skipWs();
          c = src.charCodeAt(i);
          if (i >= n) fail('Unclosed tag <' + nm + '> (no ">")', start);
          if (c === 62) { i++; break; }
          if (c === 47) {
            if (src.charCodeAt(i + 1) !== 62) fail('Expected "/>" in <' + nm + '>');
            i += 2; self = true; break;
          }
          if (before === i) fail('Expected whitespace or ">" in <' + nm + '>, found ' + JSON.stringify(src.charAt(i)));
          var an = name(i, 'an attribute name in <' + nm + '>');
          if (!isQName(an)) fail('Invalid attribute name ' + an, i);
          var aat = i;
          i += an.length;
          skipWs();
          if (src.charCodeAt(i) !== 61) fail('Attribute ' + an + ' needs a value (' + an + '="…")', aat);
          i++;
          skipWs();
          var qc = src.charCodeAt(i);
          if (qc !== 34 && qc !== 39) fail('The value of attribute ' + an + ' must be quoted', i);
          var ve = src.indexOf(qc === 34 ? '"' : "'", i + 1);
          if (ve < 0) fail('Unterminated value of attribute ' + an, i);
          var raw = src.slice(i + 1, ve), lp = raw.indexOf('<');
          if (lp >= 0) fail('"<" is not allowed in an attribute value (attribute ' + an + ')', i + 1 + lp);
          checkChars(raw, i + 1);
          if (hasOwn.call(seen, an)) fail('Duplicate attribute ' + an + ' in <' + nm + '>', aat);
          seen[an] = 1;
          var val = decode(raw.replace(/[\t\n\r]/g, ' '), i + 1);
          attrs.push([an, val]);
          if (an === 'xmlns' || an.lastIndexOf('xmlns:', 0) === 0) {
            var pfx = an === 'xmlns' ? '' : an.slice(6);
            if (pfx === 'xmlns' || (pfx === 'xml' && val !== XML_NS)) fail('The prefix ' + pfx + ' cannot be redeclared', aat);
            if (pfx && val === '') fail('The prefix ' + pfx + ' cannot be bound to an empty namespace', aat);
            decls = decls || [];
            decls.push([pfx, val]);
          }
          i = ve + 1;
        }
        var sc = scope;
        if (decls) {
          sc = Object.create(scope);
          for (var d = 0; d < decls.length; d++) sc[decls[d][0] || '#'] = decls[d][1];
        }
        var px = prefixOf(nm), ns;
        if (px) {
          ns = sc[px];
          if (ns == null) fail('Namespace prefix "' + px + '" is not declared (on <' + nm + '>)', start + 1);
        } else ns = sc['#'] || null;
        for (var a = 0; a < attrs.length; a++) {
          var ap = prefixOf(attrs[a][0]);
          if (ap && ap !== 'xmlns' && sc[ap] == null) fail('Namespace prefix "' + ap + '" is not declared (on attribute ' + attrs[a][0] + ')', start + 1);
        }
        var el = { type: 'element', name: nm, prefix: px, local: localOf(nm), ns: ns, attrs: attrs, children: [], line: lineOf(start), at: start };
        doc.elements++;
        cur.children.push(el);
        if (cur === doc) rootSeen = true;
        if (!self) {
          stack.push(el); scopes.push(scope); scope = sc; cur = el;
          if (stack.length > doc.depth) doc.depth = stack.length;
        } else if (doc.depth < stack.length + 1) doc.depth = stack.length + 1;
      }
    }
    if (stack.length) fail('<' + cur.name + '> is never closed (missing </' + cur.name + '>)', cur.at);
    if (!rootSeen) fail(src.trim() ? 'No root element found' : 'The document is empty', n);
  }
  function rootEl(doc) {
    if (!doc) return null;
    for (var i = 0; i < doc.children.length; i++) if (doc.children[i].type === 'element') return doc.children[i];
    return null;
  }
  function kids(el) {
    var out = [];
    for (var i = 0; i < el.children.length; i++) if (el.children[i].type === 'element') out.push(el.children[i]);
    return out;
  }
  function textOf(el) {
    var s = '';
    (function walk(n) {
      for (var i = 0; i < n.children.length; i++) {
        var c = n.children[i];
        if (c.type === 'text' || c.type === 'cdata') s += c.value;
        else if (c.type === 'element') walk(c);
      }
    })(el);
    return s;
  }
  function attr(el, name) { for (var i = 0; i < el.attrs.length; i++) if (el.attrs[i][0] === name) return el.attrs[i][1]; return null; }

  // ---- XML serializer ------------------------------------------------------------------------------
  // Elements whose content is only text print on one line; mixed content is kept as is.
  function serializeXML(node, o) {
    o = o || {};
    var pad = o.indent == null ? '  ' : o.indent, out = [];
    function cdata(v) { return '<![CDATA[' + String(v).split(']]>').join(']]]]><![CDATA[>') + ']]>'; }
    function inline(n) {
      if (n.type === 'text') return escText(n.value);
      if (n.type === 'cdata') return cdata(n.value);
      if (n.type === 'comment') return '<!--' + n.value + '-->';
      if (n.type === 'pi') return '<?' + n.name + (n.value ? ' ' + n.value : '') + '?>';
      var s = '<' + n.name;
      for (var i = 0; i < n.attrs.length; i++) s += ' ' + n.attrs[i][0] + '="' + escAttr(n.attrs[i][1]) + '"';
      if (!n.children.length) return s + '/>';
      s += '>';
      for (var j = 0; j < n.children.length; j++) s += inline(n.children[j]);
      return s + '</' + n.name + '>';
    }
    function el(n, depth) {
      var ind = new Array(depth + 1).join(pad), hasEl = false, hasText = false, i;
      for (i = 0; i < n.children.length; i++) {
        var c = n.children[i];
        if (c.type === 'element' || c.type === 'comment' || c.type === 'pi') hasEl = true;
        else if (c.type === 'cdata' || /\S/.test(c.value)) hasText = true;
      }
      if (!hasEl || hasText || pad === '') { out.push(ind + inline(n)); return; }
      var open = inline({ type: 'element', name: n.name, attrs: n.attrs, children: [] }).replace(/\/>$/, '>');
      out.push(ind + open);
      for (i = 0; i < n.children.length; i++) {
        var k = n.children[i];
        if (k.type === 'element') el(k, depth + 1);
        else if (k.type !== 'text') out.push(ind + pad + inline(k));
      }
      out.push(ind + '</' + n.name + '>');
    }
    if (node.type === 'document') {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (c.type === 'element') el(c, 0);
        else if (c.type === 'doctype') out.push('<!DOCTYPE ' + c.value + '>');
        else if (c.type !== 'text') out.push(inline(c));
      }
    } else el(node, 0);
    return out.join(pad === '' ? '' : '\n');
  }
  var DECL = '<?xml version="1.0" encoding="UTF-8"?>';

  // ---- names for JSON keys (XmlConvert.EncodeName style: invalid chars -> _xHHHH_) --------------------
  function hex4(c) { return ('000' + c.toString(16).toUpperCase()).slice(-4); }
  var START_1 = new RegExp('^[' + NS_START + ']$'), CHAR_1 = new RegExp('^[' + NS_CHAR + ']$');
  function encodeName(key) {
    var s = String(key);
    if (s === '') return '_';
    s = s.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_'); // so decodeName gives back the key exactly
    if (isQName(s)) return s;
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (s.substr(i, 7) === '_x005F_') { out += '_x005F_'; i += 6; continue; }
      out += (i === 0 ? START_1 : CHAR_1).test(ch) ? ch : '_x' + hex4(ch.charCodeAt(0)) + '_';
    }
    return out;
  }
  function decodeName(n) {
    return n.indexOf('_x') < 0 ? n : n.replace(/_x([0-9A-Fa-f]{4})_/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
  }
  function cleanText(s) { return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '\uFFFD'); }

  // ---- XML -> JSON -----------------------------------------------------------------------------------
  function toDoc(x) {
    if (x && x.type === 'document') return x;
    var r = parseXML(x);
    if (r.error) throw xmlErr(r.error);
    return r.doc;
  }
  function xmlErr(e) {
    var err = new Error('XML error at line ' + e.line + ', column ' + e.col + ': ' + e.message);
    err.line = e.line; err.col = e.col; err.offset = e.offset; err.reason = e.message;
    return err;
  }
  function elToJson(el, o) {
    var obj = null, texts = [], hasEl = false, rep = {}, i;
    for (i = 0; i < el.attrs.length; i++) {
      var an = el.attrs[i][0];
      if (o.stripNs && (an === 'xmlns' || an.lastIndexOf('xmlns:', 0) === 0)) continue;
      obj = obj || {};
      put(obj, '@' + decodeName(o.stripNs ? localOf(an) : an), el.attrs[i][1]);
    }
    for (i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.type === 'text' || c.type === 'cdata') texts.push(c.value);
      else if (c.type === 'element') {
        hasEl = true;
        obj = obj || {};
        var k = decodeName(o.stripNs ? c.local : c.name), v = elToJson(c, o);
        if (!hasOwn.call(obj, k)) put(obj, k, v);
        else if (hasOwn.call(rep, k)) obj[k].push(v);
        else { put(obj, k, [obj[k], v]); rep[k] = 1; }
      }
    }
    var text;
    if (hasEl) text = texts.map(function (t) { return t.trim(); }).filter(Boolean).join(' ');
    else text = texts.join('');
    if (!obj) return texts.length ? text : null;
    if (text !== '') put(obj, '#text', text);
    return obj;
  }
  function xmlToJson(x, o) {
    o = o || {};
    var doc = toDoc(x), r = rootEl(doc), out = {};
    put(out, decodeName(o.stripNs ? r.local : r.name), elToJson(r, o));
    return out;
  }

  // ---- JSON -> XML -------------------------------------------------------------------------------------
  function mkEl(name, attrs, children) { return { type: 'element', name: name, attrs: attrs || [], children: children || [] }; }
  function jsonEl(name, v) {
    var el = mkEl(encodeName(name));
    fillEl(el, v);
    return el;
  }
  function fillEl(el, v) {
    if (v === null || v === undefined) return el;
    if (isArr(v)) { for (var a = 0; a < v.length; a++) el.children.push(jsonEl('item', v[a])); return el; }
    if (!isObj(v)) { el.children.push({ type: 'text', value: cleanText(v) }); return el; }
    for (var k in v) {
      if (!hasOwn.call(v, k)) continue;
      var val = v[k];
      if (k.charAt(0) === '@' && k.length > 1 && !isObj(val) && !isArr(val)) { el.attrs.push([encodeName(k.slice(1)), val == null ? '' : cleanText(val)]); continue; }
      if (k === '#text') { if (val != null) el.children.push({ type: 'text', value: cleanText(isObj(val) || isArr(val) ? JSON.stringify(val) : val) }); continue; }
      if (k === '#cdata') { if (val != null) el.children.push({ type: 'cdata', value: cleanText(val) }); continue; }
      if (k === '#comment') { if (val != null) el.children.push({ type: 'comment', value: cleanText(val).replace(/--/g, '- -').replace(/-$/, '- ') }); continue; }
      if (isArr(val)) for (var j = 0; j < val.length; j++) el.children.push(isArr(val[j]) ? fillEl(mkEl(encodeName(k)), val[j]) : jsonEl(k, val[j]));
      else el.children.push(jsonEl(k, val));
    }
    return el;
  }
  // Prefixes that no ancestor declares would make the output not namespace-well-formed: escape their ":".
  function bindPrefixes(el, sc) {
    var decl = null, i;
    for (i = 0; i < el.attrs.length; i++) {
      var an = el.attrs[i][0];
      if (an === 'xmlns' || an.lastIndexOf('xmlns:', 0) === 0) { decl = decl || Object.create(sc); decl[an === 'xmlns' ? '#' : an.slice(6)] = 1; }
    }
    var s = decl || sc;
    function fix(n) { var p = prefixOf(n); return p && p !== 'xml' && p !== 'xmlns' && !s[p] ? n.replace(':', '_x003A_') : n; }
    el.name = fix(el.name);
    for (i = 0; i < el.attrs.length; i++) if (el.attrs[i][0].lastIndexOf('xmlns', 0) !== 0) el.attrs[i][0] = fix(el.attrs[i][0]);
    for (i = 0; i < el.children.length; i++) if (el.children[i].type === 'element') bindPrefixes(el.children[i], s);
  }
  function autoRoot(v) {
    if (!isObj(v)) return '';
    var ks = Object.keys(v);
    return ks.length === 1 && ks[0].charAt(0) !== '@' && ks[0].charAt(0) !== '#' && !isArr(v[ks[0]]) ? ks[0] : '';
  }
  function jsonToXml(value, o) {
    o = o || {};
    var auto = autoRoot(value), want = o.root ? String(o.root) : '', el;
    if (auto && (!want || want === auto)) el = jsonEl(auto, value[auto]);
    else el = jsonEl(want || 'root', value);
    bindPrefixes(el, {});
    var body = serializeXML(el, { indent: o.indent });
    return (o.decl === false ? '' : DECL + '\n') + body + '\n';
  }

  // ---- SOAP ----------------------------------------------------------------------------------------------
  function soapOf(x) {
    var doc = x && x.type === 'document' ? x : null;
    if (!doc) { var r0 = parseXML(x); if (r0.error) return null; doc = r0.doc; }
    var env = rootEl(doc);
    if (!env || env.local !== 'Envelope' || (env.ns !== SOAP11 && env.ns !== SOAP12)) return null;
    var ver = env.ns === SOAP11 ? '1.1' : '1.2', header = null, body = null, k = kids(env), i;
    for (i = 0; i < k.length; i++) {
      if (k[i].ns !== env.ns) continue;
      if (k[i].local === 'Header' && !header) header = k[i];
      else if (k[i].local === 'Body' && !body) body = k[i];
    }
    var payload = [], fault = null, bk = body ? kids(body) : [];
    for (i = 0; i < bk.length; i++) {
      if (bk[i].ns === env.ns && bk[i].local === 'Fault' && !fault) fault = bk[i];
      else payload.push(bk[i]);
    }
    return {
      version: ver, ns: env.ns, prefix: env.prefix, envelope: env, header: header, headers: header ? kids(header) : [],
      body: body, payload: payload, operation: payload[0] || null, faultEl: fault, fault: fault ? faultInfo(fault, ver) : null
    };
  }
  function child(el, local, ns) {
    if (!el) return null;
    var k = kids(el);
    for (var i = 0; i < k.length; i++) if (k[i].local === local && (ns === undefined || k[i].ns === ns)) return k[i];
    return null;
  }
  function trimText(el) { return el ? textOf(el).trim() : undefined; }
  function faultInfo(f, ver) {
    var o = { version: ver };
    if (ver === '1.1') {
      o.code = trimText(child(f, 'faultcode'));
      o.reason = trimText(child(f, 'faultstring'));
      var fa = child(f, 'faultactor');
      if (fa) o.actor = trimText(fa);
      o.detailEl = child(f, 'detail') || null;
    } else {
      var code = child(f, 'Code', SOAP12);
      o.code = trimText(child(code, 'Value', SOAP12));
      var subs = [], sc = child(code, 'Subcode', SOAP12);
      while (sc) { var sv = trimText(child(sc, 'Value', SOAP12)); if (sv) subs.push(sv); sc = child(sc, 'Subcode', SOAP12); }
      if (subs.length) o.subcodes = subs;
      var reason = child(f, 'Reason', SOAP12), texts = reason ? kids(reason).filter(function (e) { return e.local === 'Text'; }) : [];
      o.reason = texts.length ? textOf(texts[0]).trim() : undefined;
      if (texts.length > 1) o.reasons = texts.map(function (e) { return { lang: attr(e, 'xml:lang') || '', text: textOf(e).trim() }; });
      var nd = child(f, 'Node', SOAP12), rl = child(f, 'Role', SOAP12);
      if (nd) o.node = trimText(nd);
      if (rl) o.role = trimText(rl);
      o.detailEl = child(f, 'Detail', SOAP12) || null;
    }
    return o;
  }
  // Children of an element as one JSON object (like elToJson, without the element's own attributes).
  function contentJson(el, o) {
    var k = kids(el);
    if (!k.length) { var t = textOf(el).trim(); return t === '' ? null : t; }
    var tmp = { type: 'element', attrs: [], children: el.children };
    return elToJson(tmp, o);
  }
  function soapToJson(x, o) {
    o = o || {};
    var so = { stripNs: o.stripNs !== false };
    var doc = toDoc(x), s = soapOf(doc);
    if (!s) throw new Error('Not a SOAP envelope (expected a soap:Envelope in the SOAP 1.1 or 1.2 namespace)');
    if (s.fault) {
      var f = {}, fi = s.fault;
      ['code', 'subcodes', 'reason', 'reasons', 'actor', 'node', 'role'].forEach(function (k) { if (fi[k] !== undefined) f[k] = fi[k]; });
      if (fi.detailEl) f.detail = contentJson(fi.detailEl, so);
      return { fault: f };
    }
    var out = {};
    for (var i = 0; i < s.payload.length; i++) {
      var p = s.payload[i], k = decodeName(so.stripNs ? p.local : p.name), v = elToJson(p, so);
      if (hasOwn.call(out, k)) out[k] = isArr(out[k]) ? out[k].concat([v]) : [out[k], v];
      else put(out, k, v);
    }
    return out;
  }
  function jsonToSoap(value, o) {
    o = o || {};
    var v12 = String(o.version || '1.1') === '1.2', envNs = v12 ? SOAP12 : SOAP11, P = 'soap';
    var env = mkEl(P + ':Envelope', [['xmlns:' + P, envNs]]), body = mkEl(P + ':Body'), header = null;
    var payload = value;
    if (isObj(value) && hasOwn.call(value, 'Body') && Object.keys(value).every(function (k) { return k === 'Body' || k === 'Header'; })) {
      payload = value.Body;
      if (value.Header != null) header = fillEl(mkEl(P + ':Header'), value.Header);
    }
    if (header) env.children.push(header);
    env.children.push(body);
    if (isObj(payload) && Object.keys(payload).length === 1 && isObj(payload.fault)) {
      var f = payload.fault, F = mkEl(P + ':Fault');
      if (v12) {
        var code = mkEl(P + ':Code', [], [mkEl(P + ':Value', [], [{ type: 'text', value: String(f.code || P + ':Receiver') }])]), tail = code;
        (f.subcodes || []).forEach(function (s) { var sc = mkEl(P + ':Subcode', [], [mkEl(P + ':Value', [], [{ type: 'text', value: String(s) }])]); tail.children.push(sc); tail = sc; });
        F.children.push(code);
        F.children.push(mkEl(P + ':Reason', [], [mkEl(P + ':Text', [['xml:lang', 'en']], [{ type: 'text', value: String(f.reason || '') }])]));
        if (f.node != null) F.children.push(mkEl(P + ':Node', [], [{ type: 'text', value: String(f.node) }]));
        if (f.role != null) F.children.push(mkEl(P + ':Role', [], [{ type: 'text', value: String(f.role) }]));
        if (f.detail != null) F.children.push(fillEl(mkEl(P + ':Detail'), f.detail));
      } else {
        F.children.push(mkEl('faultcode', [], [{ type: 'text', value: String(f.code || P + ':Server') }]));
        F.children.push(mkEl('faultstring', [], [{ type: 'text', value: String(f.reason || '') }]));
        if (f.actor != null) F.children.push(mkEl('faultactor', [], [{ type: 'text', value: String(f.actor) }]));
        if (f.detail != null) F.children.push(fillEl(mkEl('detail'), f.detail));
      }
      body.children.push(F);
    } else {
      var op = o.operation ? String(o.operation) : autoRoot(payload) || 'Request', params = payload;
      if (autoRoot(payload) === op) params = payload[op];
      var opEl = mkEl(encodeName(op), o.ns ? [['xmlns', String(o.ns)]] : []);
      fillEl(opEl, params);
      body.children.push(opEl);
    }
    bindPrefixes(env, {});
    return DECL + '\n' + serializeXML(env, {}) + '\n';
  }

  // ---- JSON with positions ------------------------------------------------------------------------------
  // Native JSON.parse when it works; on failure a small scanner finds where (Safari's messages have no position).
  function parseJSON(text) {
    var s = String(text == null ? '' : text);
    try { return { value: JSON.parse(s), error: null }; } catch (e) {}
    var i = 0, n = s.length, err = null;
    function fail(msg) { if (!err) err = { message: msg, offset: i }; throw err; }
    function ws() { while (i < n && /[ \t\n\r]/.test(s.charAt(i))) i++; }
    function what() { return i >= n ? 'unexpected end of input' : 'unexpected ' + JSON.stringify(s.charAt(i)); }
    function str() {
      i++;
      while (i < n) {
        var c = s.charAt(i);
        if (c === '"') { i++; return; }
        if (c === '\\') { i++; if (!/["\\\/bfnrtu]/.test(s.charAt(i))) fail('Invalid escape in string'); if (s.charAt(i) === 'u' && !/^[0-9a-fA-F]{4}$/.test(s.substr(i + 1, 4))) fail('Invalid \\u escape'); }
        else if (c < ' ') fail(c === '\n' ? 'Unterminated string (line break inside a string)' : 'Control character in string');
        i++;
      }
      fail('Unterminated string');
    }
    function val() {
      ws();
      var c = s.charAt(i);
      if (c === '{') {
        i++; ws();
        if (s.charAt(i) === '}') { i++; return; }
        for (;;) {
          ws();
          if (s.charAt(i) !== '"') fail(s.charAt(i) === '}' ? 'Trailing comma before "}"' : 'Expected a "quoted" key, ' + what());
          str(); ws();
          if (s.charAt(i) !== ':') fail('Expected ":" after the key, ' + what());
          i++; val(); ws();
          if (s.charAt(i) === ',') { i++; continue; }
          if (s.charAt(i) === '}') { i++; return; }
          fail('Expected "," or "}", ' + what());
        }
      }
      if (c === '[') {
        i++; ws();
        if (s.charAt(i) === ']') { i++; return; }
        for (;;) {
          ws();
          if (s.charAt(i) === ']') fail('Trailing comma before "]"');
          val(); ws();
          if (s.charAt(i) === ',') { i++; continue; }
          if (s.charAt(i) === ']') { i++; return; }
          fail('Expected "," or "]", ' + what());
        }
      }
      if (c === '"') return str();
      var m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
      if (m && m[0] && m[0] !== '-') { i += m[0].length; return; }
      var w = /^(true|false|null)\b/.exec(s.slice(i, i + 6));
      if (w) { i += w[1].length; return; }
      fail(c === "'" ? 'Strings need "double quotes"' : 'Expected a value, ' + what());
    }
    try { val(); ws(); if (i < n) fail('Unexpected text after the JSON value'); }
    catch (e) { if (e !== err) throw e; }
    if (!err) err = { message: 'Invalid JSON', offset: 0 };
    var p = lineCol(s, err.offset);
    return { value: undefined, error: { message: err.message, line: p.line, col: p.col, offset: err.offset } };
  }
  function jsonValue(text) {
    var r = parseJSON(text);
    if (r.error) { var e = new Error('JSON error at line ' + r.error.line + ', column ' + r.error.col + ': ' + r.error.message); e.line = r.error.line; e.col = r.error.col; e.offset = r.error.offset; throw e; }
    return r.value;
  }

  // ---- HTML parser (lenient) --------------------------------------------------------------------------------
  var VOID = {}, RAWT = { script: 1, style: 1, xmp: 1, iframe: 1, noembed: 1, noframes: 1, plaintext: 1 }, RCDATA = { textarea: 1, title: 1 };
  'area base br col embed hr img input link meta param source track wbr keygen command'.split(' ').forEach(function (t) { VOID[t] = 1; });
  var CLOSES_P = {};
  'address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul'.split(' ').forEach(function (t) { CLOSES_P[t] = 1; });
  var ENT = { nbsp: '\u00A0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', bull: '•', middot: '·', times: '×', divide: '÷', deg: '°', plusmn: '±', micro: 'µ', para: '¶', sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', hearts: '♥', spades: '♠', clubs: '♣', diams: '♦', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', iexcl: '¡', iquest: '¿', shy: '\u00AD', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200C', zwj: '\u200D', prime: '′', Prime: '″', infin: '∞', ne: '≠', le: '≤', ge: '≥', minus: '−', check: '✓', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', agrave: 'à', egrave: 'è', ugrave: 'ù', acirc: 'â', ecirc: 'ê', ocirc: 'ô', auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ', aring: 'å', Aring: 'Å', aelig: 'æ', oslash: 'ø', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', Omega: 'Ω', mu: 'μ', lambda: 'λ', theta: 'θ' };
  function decodeHtml(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));?/g, function (m, h, d, nm) {
      if (h || d) { var c = h ? parseInt(h, 16) : parseInt(d, 10); return c > 0 && c <= 0x10FFFF ? fromCode(c) : '\uFFFD'; }
      if (hasOwn.call(ENT, nm) && (m.charAt(m.length - 1) === ';' || /^(amp|lt|gt|quot|nbsp)$/.test(nm))) return ENT[nm];
      return m;
    });
  }
  function hel(name, attrs) { return { type: 'element', name: name, attrs: attrs || [], children: [] }; }
  function parseHTML(input) {
    var src = String(input == null ? '' : input), n = src.length, i = 0;
    var doc = { type: 'document', children: [] }, stack = [doc];
    function top() { return stack[stack.length - 1]; }
    function addText(t) {
      if (!t) return;
      var p = top(), last = p.children[p.children.length - 1];
      if (last && last.type === 'text') last.value += t; else p.children.push({ type: 'text', value: t });
    }
    function inScope(name, stop) {
      for (var k = stack.length - 1; k > 0; k--) { var nm = stack[k].name; if (nm === name) return k; if (stop && stop[nm]) return -1; }
      return -1;
    }
    function closeTo(k) { if (k > 0) stack.length = k; }
    var LIST_STOP = { ul: 1, ol: 1, table: 1 }, TABLE_STOP = { table: 1 }, DL_STOP = { dl: 1, table: 1 }, P_STOP = { button: 1, table: 1, td: 1, th: 1, li: 1, blockquote: 1, div: 1 };
    function implied(name) {
      var k;
      if (CLOSES_P[name] && (k = inScope('p', P_STOP)) > 0) closeTo(k);
      if (name === 'li' && (k = inScope('li', LIST_STOP)) > 0) closeTo(k);
      if ((name === 'dt' || name === 'dd') && ((k = inScope('dd', DL_STOP)) > 0 || (k = inScope('dt', DL_STOP)) > 0)) closeTo(k);
      if ((name === 'td' || name === 'th' || name === 'tr') && ((k = inScope('td', TABLE_STOP)) > 0 || (k = inScope('th', TABLE_STOP)) > 0)) closeTo(k);
      if (name === 'tr' && (k = inScope('tr', TABLE_STOP)) > 0) closeTo(k);
      if ((name === 'thead' || name === 'tbody' || name === 'tfoot') && ((k = inScope('thead', TABLE_STOP)) > 0 || (k = inScope('tbody', TABLE_STOP)) > 0 || (k = inScope('tfoot', TABLE_STOP)) > 0)) closeTo(k);
      if ((name === 'option' || name === 'optgroup') && (k = inScope('option', { select: 1 })) > 0) closeTo(k);
    }
    var TAG = /^<([A-Za-z][A-Za-z0-9:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?|\s*\/(?!>))*)\s*(\/?)>/;
    var ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) { addText(decodeHtml(src.slice(i))); break; }
      if (lt > i) addText(decodeHtml(src.slice(i, lt)));
      i = lt;
      var c = src.charAt(i + 1), end, m;
      if (src.substr(i, 4) === '<!--') {
        end = src.indexOf('-->', i + 4);
        if (end < 0) end = n;
        top().children.push({ type: 'comment', value: src.slice(i + 4, end) });
        i = Math.min(n, end + 3);
      } else if (c === '!' || c === '?') {
        end = src.indexOf('>', i);
        if (end < 0) end = n;
        var raw = src.slice(i + 2, end);
        if (/^doctype/i.test(raw)) doc.children.push({ type: 'doctype', value: raw.slice(7).trim() });
        else if (/^\[CDATA\[/.test(raw)) { var ce = src.indexOf(']]>', i); if (ce < 0) ce = n; addText(src.slice(i + 9, ce)); end = ce + 2; }
        i = Math.min(n, end + 1);
      } else if (c === '/') {
        m = /^<\/([A-Za-z][A-Za-z0-9:-]*)[^>]*>/.exec(src.slice(i, i + 300));
        if (!m) { addText('<'); i++; continue; }
        var cn = m[1].toLowerCase(), k = inScope(cn);
        if (k > 0) closeTo(k);
        i += m[0].length;
      } else if (/[A-Za-z]/.test(c) && (m = TAG.exec(src.slice(i, i + 20000)))) {
        var name = m[1].toLowerCase(), attrs = [], am;
        ATTR.lastIndex = 0;
        while ((am = ATTR.exec(m[2]))) attrs.push([am[1].toLowerCase(), decodeHtml(am[2] != null ? am[2] : am[3] != null ? am[3] : am[4] != null ? am[4] : '')]);
        implied(name);
        var el = hel(name, attrs);
        top().children.push(el);
        i += m[0].length;
        if (VOID[name] || m[3]) continue;
        if (RAWT[name] || RCDATA[name]) {
          var re = new RegExp('</' + name + '\\s*>', 'i'), rest = src.slice(i), em = re.exec(rest);
          var body = em ? rest.slice(0, em.index) : rest;
          if (body) el.children.push({ type: 'text', value: RCDATA[name] ? decodeHtml(body) : body });
          i += em ? em.index + em[0].length : rest.length;
          continue;
        }
        stack.push(el);
      } else { addText('<'); i++; }
    }
    return doc;
  }
  function hattr(el, n) { for (var i = 0; i < el.attrs.length; i++) if (el.attrs[i][0] === n) return el.attrs[i][1]; return null; }
  function hfind(node, name) {
    if (node.type === 'element' && node.name === name) return node;
    var ch = node.children || [];
    for (var i = 0; i < ch.length; i++) { var r = hfind(ch[i], name); if (r) return r; }
    return null;
  }

  // ---- HTML -> document tree ------------------------------------------------------------------------------
  var SKIP = { head: 1, script: 1, style: 1, template: 1, noscript: 1, meta: 1, link: 1, title: 1, base: 1, iframe: 1, object: 1, embed: 1, svg: 1, canvas: 1, video: 1, audio: 1, button: 1, input: 1, select: 1, textarea: 1 };
  var BLOCK = {};
  'p h1 h2 h3 h4 h5 h6 ul ol pre blockquote table hr dl figure figcaption div section article main header footer nav aside body html form details summary center address fieldset hgroup menu'.split(' ').forEach(function (t) { BLOCK[t] = 1; });
  function hasBlock(el) {
    for (var i = 0; i < el.children.length; i++) { var c = el.children[i]; if (c.type === 'element' && (BLOCK[c.name] || (c.name !== 'a' && hasBlock(c)))) return true; }
    return false;
  }
  // Inline text: whitespace collapsed, <br> = newline; links collected.
  function inlineText(nodes, links) {
    var s = '';
    (function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.type === 'text') s += c.value.replace(/[ \t\n\r\f]+/g, ' ');
        else if (c.type !== 'element' || SKIP[c.name]) continue;
        else if (c.name === 'br') s += '\n';
        else if (c.name === 'img') { var alt = hattr(c, 'alt'); if (alt) s += alt; }
        else if (c.name === 'input' && hattr(c, 'type') === 'checkbox') continue;
        else if (c.name === 'a') {
          var at = s.length;
          walk(c.children);
          var href = hattr(c, 'href');
          if (links && href != null) links.push({ text: s.slice(at).replace(/\s+/g, ' ').trim(), href: href });
        } else walk(c.children);
      }
    })(nodes);
    return s.replace(/ *\n */g, '\n').replace(/^[ \n]+|[ \n]+$/g, '');
  }
  function imageBlock(c) {
    var im = { type: 'image', src: hattr(c, 'src') || '' }, alt = hattr(c, 'alt'), ti = hattr(c, 'title');
    if (alt) im.alt = alt;
    if (ti) im.title = ti;
    return im;
  }
  // a paragraph, or an image block when an image (maybe linked) is all there is
  function para(nodes) {
    var only = null, n = 0;
    (function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.type === 'text') { if (/\S/.test(c.value)) n += 2; }
        else if (c.type === 'element' && c.name === 'img') { only = c; n++; }
        else if (c.type === 'element' && c.name === 'a') walk(c.children);
        else if (c.type === 'element' && !SKIP[c.name]) n += 2;
      }
    })(nodes);
    if (only && n === 1) return imageBlock(only);
    var links = [], t = inlineText(nodes, links);
    if (!t) return null;
    var b = { type: 'paragraph', text: t };
    if (links.length) b.links = links;
    return b;
  }
  function rawText(el) {
    var s = '';
    (function walk(n) { for (var i = 0; i < n.children.length; i++) { var c = n.children[i]; if (c.type === 'text') s += c.value; else if (c.type === 'element') { if (c.name === 'br') s += '\n'; else walk(c); } } })(el);
    return s;
  }
  function codeLang(pre) {
    var code = null;
    for (var i = 0; i < pre.children.length; i++) if (pre.children[i].type === 'element' && pre.children[i].name === 'code') { code = pre.children[i]; break; }
    var cls = ((code && hattr(code, 'class')) || '') + ' ' + (hattr(pre, 'class') || '');
    var m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls);
    return m ? m[1] : hattr(pre, 'data-lang') || '';
  }
  function tableBlock(t) {
    var rows = [], headers = null, caption = '';
    (function walk(n) {
      for (var i = 0; i < n.children.length; i++) {
        var c = n.children[i];
        if (c.type !== 'element') continue;
        if (c.name === 'caption') caption = inlineText(c.children);
        else if (c.name === 'tr') {
          var cells = [], allTh = true, any = false;
          for (var j = 0; j < c.children.length; j++) {
            var d = c.children[j];
            if (d.type !== 'element' || (d.name !== 'td' && d.name !== 'th')) continue;
            any = true;
            if (d.name !== 'th') allTh = false;
            cells.push(inlineText(d.children));
          }
          if (!any) continue;
          if (!headers && !rows.length && (allTh || n.name === 'thead')) headers = cells;
          else rows.push(cells);
        } else if (c.name !== 'table') walk(c);
      }
    })(t);
    var b = { type: 'table' };
    if (caption) b.caption = caption;
    b.headers = headers || [];
    b.rows = rows;
    return b;
  }
  function listBlock(el) {
    var b = { type: 'list', ordered: el.name === 'ol' }, st = el.name === 'ol' ? parseInt(hattr(el, 'start'), 10) : NaN;
    if (!isNaN(st) && st !== 1) b.start = st;
    b.items = [];
    for (var i = 0; i < el.children.length; i++) {
      var li = el.children[i];
      if (li.type !== 'element' || li.name !== 'li') continue;
      var inl = [], children = [], item = {}, j, cb = null;
      for (j = 0; j < li.children.length; j++) {
        var c = li.children[j];
        if (c.type === 'element' && c.name === 'input' && hattr(c, 'type') === 'checkbox' && cb === null) { cb = hattr(c, 'checked') != null; continue; }
        if (c.type === 'element' && c.name === 'p' && !children.length && !inlineText(inl)) {
          // a loose list item: its first paragraph is the item's text (a task box may sit inside it)
          for (var q = 0; q < c.children.length; q++) {
            var cc = c.children[q];
            if (cc.type === 'element' && cc.name === 'input' && hattr(cc, 'type') === 'checkbox' && cb === null) cb = hattr(cc, 'checked') != null;
            else inl.push(cc);
          }
          continue;
        }
        if (c.type === 'element' && (BLOCK[c.name] || hasBlock(c))) blocksOf([c], children, false);
        else if (!children.length) inl.push(c);
        else blocksOf([c], children, false);
      }
      var links = [];
      item.text = inlineText(inl, links);
      if (cb !== null) item.checked = cb;
      if (links.length) item.links = links;
      if (children.length) item.children = children;
      b.items.push(item);
    }
    return b;
  }
  // A task item's box: an <input type=checkbox> leading the <li> (or its first <p>).
  function taskBox(li) {
    var first = null, i;
    for (i = 0; i < li.children.length; i++) { var c = li.children[i]; if (c.type === 'element') { first = c; break; } if (/\S/.test(c.value || '')) return null; }
    if (first && first.name === 'p') { for (i = 0; i < first.children.length; i++) if (first.children[i].type === 'element') { first = first.children[i]; break; } }
    return first && first.name === 'input' && hattr(first, 'type') === 'checkbox' ? first : null;
  }
  // Appends the blocks for `nodes` to out; top: headings open sections (handled by the caller via out.heading)
  function blocksOf(nodes, out, top) {
    var run = [];
    function flush() { if (run.length) { var p = para(run); if (p) out.push(p); run = []; } }
    for (var i = 0; i < nodes.length; i++) {
      var c = nodes[i];
      if (c.type === 'text') { run.push(c); continue; }
      if (c.type !== 'element' || SKIP[c.name]) continue;
      var nm = c.name;
      if (!BLOCK[nm] && !hasBlock(c)) { run.push(c); continue; }
      flush();
      if (/^h[1-6]$/.test(nm)) {
        var ht = inlineText(c.children), hb = { type: 'heading', level: +nm.charAt(1), text: ht };
        if (hattr(c, 'id')) hb.id = hattr(c, 'id');
        if (ht) out.push(hb);
      }
      else if (nm === 'p') { if (hasBlock(c)) blocksOf(c.children, out, top); else { var p = para(c.children); if (p) out.push(p); } }
      else if (nm === 'ul' || nm === 'ol' || nm === 'menu') out.push(listBlock(c));
      else if (nm === 'pre') { var cb = { type: 'code' }, lg = codeLang(c); if (lg) cb.language = lg; cb.text = rawText(c).replace(/\n$/, ''); out.push(cb); }
      else if (nm === 'blockquote') { var q = []; blocksOf(c.children, q, false); out.push({ type: 'quote', content: q }); }
      else if (nm === 'table') out.push(tableBlock(c));
      else if (nm === 'hr') out.push({ type: 'rule' });
      else if (nm === 'dl') {
        var items = [], term = null;
        for (var j = 0; j < c.children.length; j++) {
          var d = c.children[j];
          if (d.type !== 'element') continue;
          if (d.name === 'dt') { term = { term: inlineText(d.children), description: '' }; items.push(term); }
          else if (d.name === 'dd') { var dd = inlineText(d.children); if (!term) { term = { term: '', description: '' }; items.push(term); } term.description = term.description ? term.description + '\n' + dd : dd; }
        }
        out.push({ type: 'definitions', items: items });
      } else if (nm === 'figure') {
        var fig = [], cap = hfind(c, 'figcaption');
        blocksOf(c.children.filter(function (k) { return !(k.type === 'element' && k.name === 'figcaption'); }), fig, false);
        if (cap && fig.length === 1 && fig[0].type === 'image') fig[0].caption = inlineText(cap.children);
        else if (cap) fig.push({ type: 'paragraph', text: inlineText(cap.children) });
        for (var f = 0; f < fig.length; f++) out.push(fig[f]);
      } else blocksOf(c.children, out, top); // div, section, article… are transparent
    }
    flush();
    return out;
  }
  function htmlToDoc(html) {
    var tree = typeof html === 'string' ? parseHTML(html) : html;
    var flat = blocksOf(tree.children, [], true);
    var doc = { type: 'document' }, tt = hfind(tree, 'title');
    var title = tt ? rawText(tt).replace(/\s+/g, ' ').trim() : '';
    if (title) doc.title = title;
    doc.content = []; doc.sections = [];
    var stack = [{ level: 0, node: doc }];
    for (var i = 0; i < flat.length; i++) {
      var b = flat[i];
      if (b.type === 'heading') {
        while (stack.length > 1 && stack[stack.length - 1].level >= b.level) stack.pop();
        var s = { heading: b.text, level: b.level };
        if (b.id) s.id = b.id;
        s.content = []; s.sections = [];
        stack[stack.length - 1].node.sections.push(s);
        stack.push({ level: b.level, node: s });
        if (!doc.title && b.level === 1) doc.title = b.text;
      } else stack[stack.length - 1].node.content.push(b);
    }
    return doc;
  }

  // ---- document tree -> XML ---------------------------------------------------------------------------------
  function tx(v) { return { type: 'text', value: cleanText(v) }; }
  function docToXml(doc) {
    function para(b, name) {
      var e = mkEl(name || 'paragraph');
      if (b.links && b.links.length) {
        e.children.push(mkEl('text', [], [tx(b.text)]));
        b.links.forEach(function (l) { e.children.push(mkEl('link', [['href', l.href]], l.text ? [tx(l.text)] : [])); });
      } else if (b.text) e.children.push(tx(b.text));
      return e;
    }
    function block(b) {
      switch (b.type) {
        case 'paragraph': return para(b);
        case 'heading': return mkEl('heading', [['level', String(b.level)]], [tx(b.text)]);
        case 'list':
          var l = mkEl('list', [['ordered', b.ordered ? 'true' : 'false']].concat(b.start != null ? [['start', String(b.start)]] : []));
          b.items.forEach(function (it) {
            var e = para(it, 'item');
            if (it.checked !== undefined) e.attrs.push(['checked', it.checked ? 'true' : 'false']);
            if (it.children) {
              if (!it.links || !it.links.length) e.children = it.text ? [mkEl('text', [], [tx(it.text)])] : [];
              it.children.forEach(function (c) { e.children.push(block(c)); });
            }
            l.children.push(e);
          });
          return l;
        case 'table':
          var t = mkEl('table');
          if (b.caption) t.children.push(mkEl('caption', [], [tx(b.caption)]));
          if (b.headers.length) t.children.push(mkEl('header', [], b.headers.map(function (h) { return mkEl('cell', [], h ? [tx(h)] : []); })));
          b.rows.forEach(function (r) { t.children.push(mkEl('row', [], r.map(function (h) { return mkEl('cell', [], h ? [tx(h)] : []); }))); });
          return t;
        case 'code': return mkEl('code', b.language ? [['language', b.language]] : [], b.text ? [tx(b.text)] : []);
        case 'quote': return mkEl('quote', [], b.content.map(block));
        case 'image':
          return mkEl('image', [['src', b.src]].concat(b.alt ? [['alt', b.alt]] : [], b.title ? [['title', b.title]] : [], b.caption ? [['caption', b.caption]] : []));
        case 'rule': return mkEl('rule');
        case 'definitions':
          return mkEl('definitions', [], b.items.map(function (d) { return mkEl('definition', [], [mkEl('term', [], d.term ? [tx(d.term)] : []), mkEl('description', [], d.description ? [tx(d.description)] : [])]); }));
      }
      return mkEl(encodeName(b.type || 'block'));
    }
    function section(s) {
      var e = mkEl('section', [['level', String(s.level)]].concat(s.id ? [['id', s.id]] : []), [mkEl('heading', [], [tx(s.heading)])]);
      s.content.forEach(function (b) { e.children.push(block(b)); });
      s.sections.forEach(function (c) { e.children.push(section(c)); });
      return e;
    }
    var root = mkEl('document', doc.title ? [['title', doc.title]] : []);
    doc.content.forEach(function (b) { root.children.push(block(b)); });
    doc.sections.forEach(function (s) { root.children.push(section(s)); });
    return DECL + '\n' + serializeXML(root, {}) + '\n';
  }

  // ---- HTML -> Markdown (light; the File Converter has turndown for whole files) ----------------------------
  function mdEsc(s) {
    return s.replace(/\\/g, '\\\\').replace(/([*`\[\]])/g, '\\$1').replace(/(^|[^\w])_|_(?=[^\w]|$)/g, function (m) { return m.replace('_', '\\_'); })
      .replace(/^(\s*)([#>+]|-(?=\s))/gm, '$1\\$2').replace(/^(\s*\d+)([.)])(?=\s)/gm, '$1\\$2');
  }
  function fenceFor(text) {
    var m = String(text).match(/`{3,}/g), n = 3;
    if (m) m.forEach(function (r) { if (r.length >= n) n = r.length + 1; });
    return new Array(n + 1).join('`');
  }
  function htmlToMarkdown(html) {
    var tree = typeof html === 'string' ? parseHTML(html) : html;
    function inl(nodes) {
      var s = '';
      for (var i = 0; i < nodes.length; i++) {
        var c = nodes[i];
        if (c.type === 'text') { s += mdEsc(c.value.replace(/[ \t\n\r\f]+/g, ' ')); continue; }
        if (c.type !== 'element' || SKIP[c.name]) continue;
        var n = c.name, inner;
        if (n === 'br') s += '\n';
        else if (n === 'strong' || n === 'b') { inner = inl(c.children).trim(); if (inner) s += '**' + inner + '**'; }
        else if (n === 'em' || n === 'i' || n === 'cite') { inner = inl(c.children).trim(); if (inner) s += '*' + inner + '*'; }
        else if (n === 'del' || n === 's' || n === 'strike') { inner = inl(c.children).trim(); if (inner) s += '~~' + inner + '~~'; }
        else if (n === 'mark') { inner = inl(c.children).trim(); if (inner) s += '%%yellow|' + inner + '%%'; }
        else if (n === 'code' || n === 'kbd' || n === 'samp' || n === 'tt') {
          var raw = rawText(c).replace(/\n/g, ' '), ticks = '`';
          while (raw.indexOf(ticks) >= 0) ticks += '`';
          if (raw) s += ticks + (raw.charAt(0) === '`' ? ' ' : '') + raw + (raw.slice(-1) === '`' ? ' ' : '') + ticks;
        } else if (n === 'a') {
          inner = inl(c.children).trim();
          var href = hattr(c, 'href'), title = hattr(c, 'title');
          if (href == null || href === '') s += inner;
          else s += '[' + (inner || href) + '](' + href.replace(/[ ()]/g, function (x) { return encodeURIComponent(x); }) + (title ? ' "' + title.replace(/"/g, '\\"') + '"' : '') + ')';
        } else if (n === 'img') {
          var src = hattr(c, 'src') || '', alt = (hattr(c, 'alt') || '').replace(/[\[\]]/g, '');
          s += /^data:/i.test(src) || !src ? (alt ? '[image: ' + alt + ']' : '') : '![' + alt + '](' + src.replace(/ /g, '%20') + ')';
        } else if (n === 'sup') { inner = inl(c.children); s += inner ? '^' + inner : ''; }
        else if (n === 'input' && hattr(c, 'type') === 'checkbox') continue;
        else s += inl(c.children);
      }
      return s;
    }
    function trimLines(s) { return s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim(); }
    function blocks(nodes, out) {
      var run = [];
      function flush() { if (run.length) { var t = trimLines(inl(run)); if (t) out.push(t); run = []; } }
      for (var i = 0; i < nodes.length; i++) {
        var c = nodes[i];
        if (c.type === 'text') { run.push(c); continue; }
        if (c.type !== 'element' || SKIP[c.name]) continue;
        var n = c.name;
        if (!BLOCK[n] && !hasBlock(c)) { run.push(c); continue; }
        flush();
        if (/^h[1-6]$/.test(n)) { var h = trimLines(inl(c.children)).replace(/\n/g, ' '); if (h) out.push(new Array(+n.charAt(1) + 1).join('#') + ' ' + h); }
        else if (n === 'p') { if (hasBlock(c)) blocks(c.children, out); else { var p = trimLines(inl(c.children)); if (p) out.push(p); } }
        else if (n === 'ul' || n === 'ol' || n === 'menu') out.push(list(c));
        else if (n === 'pre') {
          var code = rawText(c).replace(/\n$/, ''), f = fenceFor(code);
          out.push(f + codeLang(c) + '\n' + code + '\n' + f);
        } else if (n === 'blockquote') {
          var q = blocks(c.children, []).join('\n\n');
          if (q) out.push(q.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n'));
        } else if (n === 'hr') out.push('---');
        else if (n === 'table') out.push(table(c));
        else if (n === 'dl') {
          var lines = [];
          for (var j = 0; j < c.children.length; j++) {
            var d = c.children[j];
            if (d.type !== 'element') continue;
            if (d.name === 'dt') lines.push('- **' + trimLines(inl(d.children)) + '**');
            else if (d.name === 'dd') lines.push((lines.length ? '  ' : '- ') + trimLines(inl(d.children)).replace(/\n/g, ' '));
          }
          if (lines.length) out.push(lines.join('\n'));
        } else blocks(c.children, out);
      }
      flush();
      return out;
    }
    function list(el) {
      var ordered = el.name === 'ol', k = parseInt(hattr(el, 'start'), 10), lines = [];
      if (isNaN(k)) k = 1;
      for (var i = 0; i < el.children.length; i++) {
        var li = el.children[i];
        if (li.type !== 'element' || li.name !== 'li') continue;
        var marker = ordered ? (k++) + '. ' : '- ', pad = new Array(marker.length + 1).join(' ');
        var tb = taskBox(li), box = tb ? (hattr(tb, 'checked') != null ? '[x] ' : '[ ] ') : '';
        var parts = blocks(li.children, []), body = '';
        for (var q = 0; q < parts.length; q++) body += (q ? (/^(?:[-*+]|\d+\.) /.test(parts[q]) ? '\n' : '\n\n') : '') + parts[q];
        var bl = body.split('\n');
        lines.push(marker + box + bl[0]);
        for (var j = 1; j < bl.length; j++) lines.push(bl[j] ? pad + bl[j] : '');
      }
      return lines.join('\n');
    }
    function table(t) {
      var tb = tableBlock(t), head = tb.headers.length ? tb.headers : (tb.rows.shift() || []), w = head.length;
      tb.rows.forEach(function (r) { if (r.length > w) w = r.length; });
      if (!w) return '';
      function cell(v) { return String(v == null ? '' : v).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim(); }
      function row(r) { var a = []; for (var i = 0; i < w; i++) a.push(cell(r[i])); return '| ' + a.join(' | ') + ' |'; }
      var out = [row(head), '|' + new Array(w + 1).join(' --- |')];
      tb.rows.forEach(function (r) { out.push(row(r)); });
      return (tb.caption ? '*' + cell(tb.caption) + '*\n\n' : '') + out.join('\n');
    }
    return blocks(tree.children, []).join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  // ---- any JSON value -> readable Markdown / HTML ------------------------------------------------------------
  // "Simple" values print inline: primitives, and XML-ish objects made only of "@attr" keys and "#text".
  function simple(v) {
    if (!isObj(v)) return !isArr(v);
    for (var k in v) if (hasOwn.call(v, k) && !(k.charAt(0) === '@' || k === '#text' || k === '#cdata') ) return false;
    for (var k2 in v) if (hasOwn.call(v, k2) && (isObj(v[k2]) || isArr(v[k2]))) return false;
    return true;
  }
  function simpleText(v) {
    if (v === null || v === undefined) return '';
    if (!isObj(v)) return String(v);
    var t = v['#text'] != null ? String(v['#text']) : v['#cdata'] != null ? String(v['#cdata']) : '', at = [];
    for (var k in v) if (hasOwn.call(v, k) && k.charAt(0) === '@') at.push(k.slice(1) + '=' + v[k]);
    return at.length ? (t ? t + ' (' + at.join(', ') + ')' : at.join(', ')) : t;
  }
  function label(k) { return k.charAt(0) === '@' ? k.slice(1) : k === '#text' ? 'text' : k; }
  // columns for a table, or null when the array isn't a list of similar flat records
  function tableCols(arr) {
    if (!arr.length || arr.length > 5000) return null;
    var cols = [], seen = {}, i, k;
    for (i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!isObj(r)) return null;
      for (k in r) {
        if (!hasOwn.call(r, k)) continue;
        if (!simple(r[k])) return null;
        if (!hasOwn.call(seen, k)) { seen[k] = 0; cols.push(k); }
        seen[k]++;
      }
    }
    if (!cols.length || cols.length > 14) return null;
    var shared = cols.filter(function (c) { return seen[c] >= arr.length / 2; }).length;
    return shared >= Math.ceil(cols.length / 2) ? cols : null;
  }
  function mdCell(v) { return mdInline(simpleText(v)).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
  function mdInline(s) { return mdEsc(String(s)).replace(/\n/g, '  \n'); }
  function valueToMarkdown(value, o) {
    o = o || {};
    var out = [];
    function list(v, ind) {
      var pad = new Array(ind + 1).join(' '), lines = [];
      if (isArr(v)) {
        if (!v.length) return pad + '- *(empty list)*';
        v.forEach(function (x, i) {
          if (simple(x)) lines.push(pad + '- ' + (simpleText(x) === '' ? '*(empty)*' : mdInline(simpleText(x))));
          else if (isObj(x) && Object.keys(x).every(function (k) { return simple(x[k]); }) && oneLine(x).length <= 120) lines.push(pad + '- ' + oneLine(x));
          else lines.push(pad + '- **' + (i + 1) + '.**\n' + list(x, ind + 2));
        });
      } else if (isObj(v)) {
        var ks = Object.keys(v);
        if (!ks.length) return pad + '- *(empty)*';
        ks.forEach(function (k) {
          var x = v[k];
          if (simple(x)) lines.push(pad + '- **' + mdInline(label(k)) + ':** ' + mdInline(simpleText(x)));
          else lines.push(pad + '- **' + mdInline(label(k)) + '**\n' + list(x, ind + 2));
        });
      } else lines.push(pad + '- ' + mdInline(simpleText(v)));
      return lines.join('\n');
    }
    function oneLine(x) { return Object.keys(x).map(function (k) { return '**' + mdInline(label(k)) + ':** ' + mdInline(simpleText(x[k])); }).join(' · '); }
    function table(arr, cols) {
      var t = ['| ' + cols.map(function (c) { return mdInline(label(c)).replace(/\|/g, '\\|'); }).join(' | ') + ' |', '|' + new Array(cols.length + 1).join(' --- |')];
      arr.forEach(function (r) { t.push('| ' + cols.map(function (c) { return hasOwn.call(r, c) ? mdCell(r[c]) : ''; }).join(' | ') + ' |'); });
      return t.join('\n');
    }
    function section(v, level) {
      if (simple(v)) { var st = simpleText(v); out.push(st === '' ? '*(empty)*' : mdInline(st)); return; }
      if (isArr(v)) {
        var cols = tableCols(v);
        if (cols) out.push(table(v, cols));
        else if (v.every(simple)) out.push(list(v, 0));
        else v.forEach(function (x, i) {
          if (level < 3) { out.push(new Array(level + 2).join('#') + ' ' + (i + 1)); section(x, level + 1); }
          else out.push(list([x], 0));
        });
        return;
      }
      var ks = Object.keys(v), flat = {}, nflat = 0;
      ks.forEach(function (k) { if (simple(v[k])) { flat[k] = v[k]; nflat++; } });
      if (nflat) out.push(list(flat, 0));
      ks.forEach(function (k) {
        if (simple(v[k])) return;
        if (level < 3) { out.push(new Array(level + 2).join('#') + ' ' + mdInline(label(k))); section(v[k], level + 1); }
        else out.push(list((function () { var o2 = {}; o2[k] = v[k]; return o2; })(), 0));
      });
    }
    var title = o.title, v = value;
    if (!title) { var r = autoRoot(v); if (r && !simple(v[r])) { title = r; v = v[r]; } }
    if (title) out.push('# ' + mdInline(title));
    if (o.intro) out.push(o.intro);
    (o.sections || []).forEach(function (s) { out.push('## ' + mdInline(s[0])); section(s[1], 2); });
    if (v !== undefined) section(v, 1);
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }
  function valueToHtml(value, o) {
    o = o || {};
    var out = [];
    function cellHtml(v) { return escHtml(simpleText(v)); }
    function nested(v) {
      if (simple(v)) { var t = simpleText(v); return t === '' ? '<em>(empty)</em>' : escHtml(t); }
      if (isArr(v)) {
        var cols = tableCols(v);
        if (cols) return table(v, cols);
        if (!v.length) return '<em>(empty list)</em>';
        return '<ol>' + v.map(function (x) { return '<li>' + nested(x) + '</li>'; }).join('') + '</ol>';
      }
      var ks = Object.keys(v);
      if (!ks.length) return '<em>(empty)</em>';
      return '<dl>' + ks.map(function (k) { return '<dt>' + escHtml(label(k)) + '</dt><dd>' + nested(v[k]) + '</dd>'; }).join('') + '</dl>';
    }
    function table(arr, cols) {
      return '<table>\n<thead><tr>' + cols.map(function (c) { return '<th>' + escHtml(label(c)) + '</th>'; }).join('') + '</tr></thead>\n<tbody>\n' +
        arr.map(function (r) { return '<tr>' + cols.map(function (c) { return '<td>' + (hasOwn.call(r, c) ? cellHtml(r[c]) : '') + '</td>'; }).join('') + '</tr>'; }).join('\n') + '\n</tbody>\n</table>';
    }
    function h(level, text) { return '<h' + level + '>' + escHtml(text) + '</h' + level + '>'; }
    function section(v, level) {
      if (simple(v) || isArr(v)) { out.push(simple(v) ? '<p>' + nested(v) + '</p>' : nested(v)); return; }
      var ks = Object.keys(v), flat = ks.filter(function (k) { return simple(v[k]); });
      if (flat.length) out.push('<dl>\n' + flat.map(function (k) { return '<dt>' + escHtml(label(k)) + '</dt><dd>' + nested(v[k]) + '</dd>'; }).join('\n') + '\n</dl>');
      ks.forEach(function (k) {
        if (simple(v[k])) return;
        if (level < 3) { out.push(h(level + 1, label(k))); section(v[k], level + 1); }
        else out.push('<dl><dt>' + escHtml(label(k)) + '</dt><dd>' + nested(v[k]) + '</dd></dl>');
      });
    }
    var title = o.title, v = value;
    if (!title) { var r = autoRoot(v); if (r && !simple(v[r])) { title = r; v = v[r]; } }
    if (title) out.push(h(1, title));
    if (o.intro) out.push('<p>' + o.intro + '</p>');
    (o.sections || []).forEach(function (s) { out.push(h(2, s[0])); section(s[1], 2); });
    if (v !== undefined) section(v, 1);
    return out.join('\n') + '\n';
  }
  function xmlToMarkdown(x) { return valueToMarkdown(xmlToJson(x, { stripNs: true })); }
  function xmlToHtml(x) { return valueToHtml(xmlToJson(x, { stripNs: true })); }
  // SOAP: the operation (or "SOAP Fault") as the title, the version / namespace, headers, then the payload
  function soapParts(x) {
    var doc = toDoc(x), s = soapOf(doc);
    if (!s) throw new Error('Not a SOAP envelope');
    var so = { stripNs: true }, sections = [], title, value, ns = '';
    var hv = null;
    if (s.headers.length) {
      hv = {};
      s.headers.forEach(function (h) { var k = h.local; put(hv, k, hasOwn.call(hv, k) ? [].concat(hv[k], [elToJson(h, so)]) : elToJson(h, so)); });
    }
    if (s.fault) {
      title = 'SOAP Fault';
      value = soapToJson(doc).fault;
    } else if (s.operation) {
      title = s.operation.local; ns = s.operation.ns || '';
      value = elToJson(s.operation, so);
      if (isObj(value)) { value = Object.keys(value).reduce(function (a, k) { if (k !== '@xmlns') put(a, k, value[k]); return a; }, {}); }
      if (s.payload.length > 1) { value = {}; s.payload.forEach(function (p) { put(value, p.local, elToJson(p, so)); }); title = 'SOAP Body'; }
    } else { title = 'SOAP Body'; value = '(empty)'; }
    // with headers, the payload gets its own "Body" section after them
    if (hv) { sections.push(['Header', hv], [s.fault ? 'Fault' : 'Body', value]); value = undefined; }
    return { s: s, title: title, value: value, sections: sections, ns: ns };
  }
  function soapToMarkdown(x) {
    var p = soapParts(x);
    var intro = '*SOAP ' + p.s.version + (p.ns ? ' · namespace `' + p.ns.replace(/`/g, '') + '`' : '') + '*';
    return valueToMarkdown(p.value, { title: p.title, intro: intro, sections: p.sections });
  }
  function soapToHtml(x) {
    var p = soapParts(x);
    var intro = '<em>SOAP ' + p.s.version + '</em>' + (p.ns ? ' · namespace <code>' + escHtml(p.ns) + '</code>' : '');
    return valueToHtml(p.value, { title: p.title, intro: intro, sections: p.sections });
  }
  function valueMarkdownFromJsonText(t) { return valueToMarkdown(jsonValue(t)); }

  // ---- sniffing ----------------------------------------------------------------------------------------------
  var HTML_NAMES = {};
  ('html head body div span p a ul ol li table thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6 img br hr section article main header footer nav aside ' +
    'form input button label select textarea pre code blockquote em strong b i u small sub sup style script link meta iframe video audio canvas svg ' +
    'figure figcaption details summary dl dt dd abbr cite mark del ins s q picture dialog fieldset legend caption center font big kbd').split(' ').forEach(function (t) { HTML_NAMES[t] = 1; });
  var XHTML = 'http://www.w3.org/1999/xhtml', SVG = 'http://www.w3.org/2000/svg';
  function sniff(text) {
    var t = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
    if (!t) return { type: 'text' };
    var c = t.charAt(0), e = t.charAt(t.length - 1);
    if (c === '{' && e === '}') return { type: 'json' };
    if (c === '[' && e === ']') {
      try { JSON.parse(t); return { type: 'json' }; } catch (x) {}
      if (/^\[\s*[\[{"\d-]/.test(t)) return { type: 'json' };
    }
    if (c !== '<') return { type: 'markdown' };
    if (/^<!doctype\s+html|^<html[\s>]/i.test(t)) return { type: 'html' };
    var x = parseXML(String(text).replace(/^\uFEFF/, '')), isDecl = /^<\?xml\s/.test(t); // untrimmed: error lines match the text
    if (!x.error) {
      if (soapOf(x.doc)) return { type: 'soap', xml: x };
      var r = rootEl(x.doc);
      if (!isDecl && ((!r.prefix && !r.ns && HTML_NAMES[r.name.toLowerCase()]) || r.ns === XHTML || r.ns === SVG)) return { type: 'html' };
      return { type: 'xml', xml: x };
    }
    if (isDecl) return { type: 'xml', xml: x };
    // not well-formed: HTML if it is made of HTML tags, else (prefixed tags, unknown names) XML with its error
    var tags = t.match(/<([A-Za-z][\w:.-]*)/g) || [], html = 0, other = 0;
    for (var i = 0; i < tags.length && i < 200; i++) { var nm = tags[i].slice(1); if (HTML_NAMES[nm.toLowerCase()] && nm.indexOf(':') < 0) html++; else other++; }
    if (html && html >= other) return { type: 'html' };
    if (/<\/?[A-Za-z][\w.-]*:[A-Za-z]/.test(t) || other) return { type: 'xml', xml: x };
    return { type: 'html' };
  }

  var api = {
    SOAP11: SOAP11, SOAP12: SOAP12,
    parseXML: parseXML, serializeXML: serializeXML, rootEl: rootEl, elementsOf: kids, textOf: textOf, attrOf: attr,
    xmlToJson: xmlToJson, jsonToXml: jsonToXml, encodeName: encodeName, decodeName: decodeName,
    soapOf: soapOf, soapToJson: soapToJson, jsonToSoap: jsonToSoap, elToJson: function (el, o) { return elToJson(el, o || {}); },
    parseJSON: parseJSON, jsonValue: jsonValue,
    parseHTML: parseHTML, htmlToDoc: htmlToDoc, docToXml: docToXml, htmlToMarkdown: htmlToMarkdown,
    valueToMarkdown: valueToMarkdown, valueToHtml: valueToHtml, xmlToMarkdown: xmlToMarkdown, xmlToHtml: xmlToHtml,
    soapToMarkdown: soapToMarkdown, soapToHtml: soapToHtml, jsonToMarkdown: valueMarkdownFromJsonText,
    sniff: sniff, fenceFor: fenceFor, escapeHtml: escHtml, xmlError: xmlErr, DECL: DECL
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeMarkup = api;
})(typeof self !== 'undefined' ? self : this);
