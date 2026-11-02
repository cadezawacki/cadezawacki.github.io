/* Dev Pack — developer text tools: JWT decode, hashes (MD5 / SHA-*),
   timestamp <-> date conversion (unix s/ms/us/ns, ISO 8601, RFC 2822,
   Excel serial, kdb+/q), cURL -> fetch / Python requests and fetch -> cURL,
   number bases, lines -> array literal / SQL IN list, colours (convert +
   OKLCH shade ramps), px <-> rem, Base32 / Base58, line endings, humanized
   byte counts / durations and duration sums.
   Script-pack module: one file registering 31 palette scripts.

   Authoring note: helpers and every main() are written as REAL functions
   (readable, syntax-checked, no template-literal double escaping) and are
   serialised with Function#toString into each script's source string. The
   host evaluates every script source on its own, so each registration lists
   exactly the helpers it needs and nothing may reference IIFE variables.

   Scripts write through Cade.editor directly (not ctx) so they can insert
   BELOW the text, replace just one token, or place the cursor — and they
   honour read-only mode by copying the result to the clipboard instead. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;

  function reg(meta, helpers, main) {
    window.Cade.registerScript('/**\n' + JSON.stringify(meta, null, 2) + '\n**/\n' +
      helpers.map(String).join('\n\n') + '\n\n' + String(main));
  }

  var SVG = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>";
  function svgText(t) {
    return "<svg viewBox='0 0 24 24'><text x='12' y='16.5' text-anchor='middle' font-size='12' font-weight='700' font-family='ui-monospace,Menlo,Consolas,monospace' fill='currentColor'>" + t + '</text></svg>';
  }
  var ICON = {
    key: SVG + "<circle cx='7.5' cy='15.5' r='5.5'/><path d='M21 2l-9.6 9.6'/><path d='M15.5 7.5l3 3L22 7l-3-3'/></svg>",
    hash: SVG + "<line x1='4' y1='9' x2='20' y2='9'/><line x1='4' y1='15' x2='20' y2='15'/><line x1='10' y1='3' x2='8' y2='21'/><line x1='16' y1='3' x2='14' y2='21'/></svg>",
    hashAll: SVG + "<line x1='3' y1='8' x2='14' y2='8'/><line x1='3' y1='14' x2='14' y2='14'/><line x1='8' y1='3' x2='6.5' y2='19'/><line x1='12' y1='3' x2='10.5' y2='19'/><line x1='17' y1='12' x2='22' y2='12'/><line x1='17' y1='16' x2='22' y2='16'/><line x1='17' y1='20' x2='22' y2='20'/></svg>",
    clock: SVG + "<path d='M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5'/><path d='M16 2v4'/><path d='M8 2v4'/><path d='M3 10h5'/><path d='M17.5 17.5 16 16.3V14'/><circle cx='16' cy='16' r='6'/></svg>",
    calArrow: SVG + "<rect x='3' y='4' width='18' height='18' rx='2'/><path d='M16 2v4M8 2v4M3 10h18'/><path d='M7 16h9M13 13l3 3-3 3'/></svg>",
    calPlus: SVG + "<rect x='3' y='4' width='18' height='18' rx='2'/><path d='M16 2v4M8 2v4M3 10h18M12 13v6M9 16h6'/></svg>",
    term: SVG + "<rect x='2' y='4' width='20' height='16' rx='2'/><path d='M6 9l3 3-3 3'/><path d='M12 15h5'/></svg>",
    code: SVG + "<polyline points='16 18 22 12 16 6'/><polyline points='8 6 2 12 8 18'/></svg>",
    binary: SVG + "<rect x='14' y='14' width='4' height='6' rx='2'/><rect x='6' y='4' width='4' height='6' rx='2'/><path d='M6 20h4M14 10h4M6 14h2v6M14 4h2v6'/></svg>",
    hex: svgText('0x'),
    bin: svgText('0b'),
    dec: svgText('10'),
    brackets: SVG + "<path d='M8 3H5v18h3'/><path d='M16 3h3v18h-3'/><path d='M9 12h.01M12 12h.01M15 12h.01'/></svg>",
    db: SVG + "<ellipse cx='12' cy='5' rx='8' ry='3'/><path d='M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5'/><path d='M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3'/></svg>",
    prompt: SVG + "<polyline points='4 17 10 11 4 5'/><line x1='12' y1='19' x2='20' y2='19'/></svg>",
    palette: SVG + "<circle cx='13.5' cy='6.5' r='1.2'/><circle cx='17.5' cy='10.5' r='1.2'/><circle cx='8.5' cy='7.5' r='1.2'/><circle cx='6.5' cy='12.5' r='1.2'/><path d='M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z'/></svg>",
    shades: SVG + "<rect x='3' y='3' width='18' height='4' rx='1'/><rect x='3' y='10' width='18' height='4' rx='1' fill='currentColor' fill-opacity='.35'/><rect x='3' y='17' width='18' height='4' rx='1' fill='currentColor'/></svg>",
    rem: svgText('rem'),
    px: svgText('px'),
    b32: svgText('32'),
    b58: svgText('58'),
    enter: SVG + "<polyline points='9 10 4 15 9 20'/><path d='M20 4v7a4 4 0 0 1-4 4H4'/></svg>",
    copy: SVG + "<rect x='9' y='9' width='13' height='13' rx='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/></svg>",
    pilcrow: SVG + "<path d='M13 4v16'/><path d='M17 4v16'/><path d='M19 4H9.5a4.5 4.5 0 0 0 0 9H13'/></svg>",
    drive: SVG + "<line x1='22' y1='12' x2='2' y2='12'/><path d='M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'/><line x1='6' y1='16' x2='6.01' y2='16'/><line x1='10' y1='16' x2='10.01' y2='16'/></svg>",
    hourglass: SVG + "<path d='M5 22h14'/><path d='M5 2h14'/><path d='M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22'/><path d='M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2'/></svg>",
    timer: SVG + "<circle cx='12' cy='13' r='8'/><path d='M12 9v4l2 2'/><path d='M10 2h4'/></svg>"
  };

  /* ================================================================
     Shared editor helpers (serialised into scripts)
     ================================================================ */

  // Same target rule as the host's ctx: explicit selection -> current
  // non-empty line -> whole document (cursor on an empty line).
  function dpTarget() {
    var ed = window.Cade && window.Cade.editor;
    if (!ed) return null;
    var st = ed.state, sel = st.selection.main;
    if (sel.from !== sel.to) return { kind: 'sel', from: sel.from, to: sel.to, text: st.sliceDoc(sel.from, sel.to), head: sel.head };
    var line = st.doc.lineAt(sel.head);
    if (line.text.length) return { kind: 'line', from: line.from, to: line.to, text: line.text, head: sel.head };
    return { kind: 'doc', from: 0, to: st.doc.length, text: st.doc.toString(), head: sel.head };
  }

  function dpCopy(text, msg) {
    var done = function () { showToast(msg || 'Copied to clipboard', 'success', 2500); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) done(); else showToast('Copy failed', 'error', 2000);
    };
    var nav = window.navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // Apply doc-absolute changes ({from, to?, insert}) as one undoable edit.
  // Read-only mode: copy `copyText` (the would-be result) instead.
  function dpApply(changes, copyText) {
    var ed = window.Cade.editor;
    if (ed.state.readOnly) { dpCopy(copyText, 'Read-only mode — result copied to clipboard instead'); return false; }
    var len = ed.state.doc.length;
    var list = changes.map(function (c) {
      var from = Math.min(c.from, len);
      return { from: from, to: Math.max(from, Math.min(c.to == null ? c.from : c.to, len)), insert: c.insert };
    }).sort(function (a, b) { return a.from - b.from; });
    var spec = { changes: list, userEvent: 'input', scrollIntoView: true };
    if (list.length === 1) spec.selection = { anchor: list[0].from + list[0].insert.length };
    ed.dispatch(spec);
    return true;
  }

  // Apply doc-absolute changes to `text` (which starts at doc offset `base`).
  function dpSplice(text, base, changes) {
    var list = changes.slice().sort(function (a, b) { return b.from - a.from; });
    list.forEach(function (c) {
      var a = c.from - base, b = (c.to == null ? c.from : c.to) - base;
      text = text.slice(0, a) + c.insert + text.slice(b);
    });
    return text;
  }

  function dpStoreGet(k) { try { return window.Cade.store.get(k); } catch (e) { return null; } }
  function dpStoreSet(k, v) { try { window.Cade.store.set(k, v); } catch (e) { /* prefs are best-effort */ } }

  /* ================================================================
     1. JWT
     ================================================================ */

  function jwtBytes(part) {
    var s = part.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = window.atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function jwtText(part) {
    try { return new TextDecoder('utf-8').decode(jwtBytes(part)); } catch (e) { return null; }
  }

  function jwtJson(part) {
    var t = jwtText(part);
    if (t == null) return undefined;
    try { return JSON.parse(t); } catch (e) { return undefined; }
  }

  // Every JWS (3 parts) / JWE (5 parts) whose header decodes to a JSON object.
  function jwtFind(text) {
    var re = /(?<![\w-])ey[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){2,4}/g, m, out = [];
    while ((m = re.exec(text))) {
      var tok = m[0], parts = tok.split('.');
      // "…sig." at the end of a sentence: the period is not a 4th part.
      if ((parts.length === 4 || parts.length === 6) && parts[parts.length - 1] === '') { parts.pop(); tok = tok.slice(0, -1); }
      if (parts.length !== 3 && parts.length !== 5) continue;
      var hdr = jwtJson(parts[0]);
      if (!hdr || typeof hdr !== 'object' || Array.isArray(hdr)) continue;
      out.push({ index: m.index, token: tok, parts: parts, header: hdr });
    }
    return out;
  }

  function jwtRel(sec) {
    var s = Math.round(Math.abs(sec));
    var U = [['y', 31536000], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
    for (var i = 0; i < U.length; i++) {
      if (s >= U[i][1] || i === U.length - 1) {
        var a = Math.floor(s / U[i][1]), r = s - a * U[i][1], out = a + U[i][0];
        if (i + 1 < U.length && r >= U[i + 1][1]) out += ' ' + Math.floor(r / U[i + 1][1]) + U[i + 1][0];
        return out;
      }
    }
    return s + 's';
  }

  // ISO 8601 in the viewer's local zone, with offset: 2024-01-15T07:30:00-05:00
  function jwtIsoLocal(d) {
    function p(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
    var off = -d.getTimezoneOffset(), ao = Math.abs(off);
    var ms = d.getMilliseconds();
    return p(d.getFullYear(), 4) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + (ms ? '.' + p(ms, 3) : '') +
      (off < 0 ? '-' : '+') + p(Math.floor(ao / 60)) + ':' + p(ao % 60);
  }

  function jwtWhen(name, v, now) {
    var d = new Date(v * 1000);
    if (isNaN(d.getTime())) return null;
    var diff = v - now, rel = jwtRel(diff), past = diff <= 0, what;
    if (name === 'exp') what = past ? 'expired ' + rel + ' ago' : 'expires in ' + rel;
    else if (name === 'nbf') what = past ? 'valid since ' + rel + ' ago' : 'NOT valid yet — starts in ' + rel;
    else if (name === 'iat') what = past ? 'issued ' + rel + ' ago' : 'issued ' + rel + ' in the future (clock skew?)';
    else what = past ? rel + ' ago' : 'in ' + rel;
    return '// ' + name + ': ' + jwtIsoLocal(d) + ' · ' + what;
  }

  function jwtBlock(j, now) {
    var h = j.header, L = ['```json'];
    if (j.parts.length === 5) {
      L.push('// JWE (encrypted' + (h.alg ? ': ' + h.alg : '') + (h.enc ? ' / ' + h.enc : '') + ') — the payload cannot be read without the key');
      L.push('// header', JSON.stringify(h, null, 2), '```');
      return L.join('\n');
    }
    var sigLen = Math.floor(j.parts[2].length * 3 / 4);
    L.push('// JWT' + (h.alg ? ' (' + h.alg + ')' : '') + ' — decoded only; signature NOT verified' +
      (j.parts[2] ? ' (' + sigLen + '-byte signature)' : ' (no signature)'));
    L.push('// header', JSON.stringify(h, null, 2), '// payload');
    var raw = jwtText(j.parts[1]), p;
    try { p = JSON.parse(raw); } catch (e) { p = undefined; }
    if (p === undefined) { L.push(JSON.stringify(raw == null ? '(payload is not valid base64url)' : raw)); L.push('```'); return L.join('\n'); }
    L.push(JSON.stringify(p, null, 2));
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      ['iat', 'nbf', 'exp', 'auth_time'].forEach(function (k) {
        if (typeof p[k] === 'number' && isFinite(p[k])) { var w = jwtWhen(k, p[k], now); if (w) L.push(w); }
      });
      if (typeof p.exp === 'number' && typeof p.iat === 'number' && p.exp > p.iat) L.push('// lifetime: ' + jwtRel(p.exp - p.iat));
    }
    L.push('```');
    return L.join('\n');
  }

  var jwtMain = function main(ctx) {
    var t = dpTarget();
    if (!t) return;
    var ed = window.Cade.editor, st = ed.state, found;
    found = jwtFind(t.text).map(function (f) { f.abs = t.from + f.index; return f; });
    if (t.kind !== 'sel' && (t.kind === 'doc' || !found.length)) {
      // Nothing on this line (or cursor on an empty line): nearest JWT in the doc.
      var all = jwtFind(st.doc.toString()), best = null, bd = Infinity;
      all.forEach(function (f) {
        var dist = t.head < f.index ? f.index - t.head : t.head > f.index + f.token.length ? t.head - f.index - f.token.length : 0;
        if (dist < bd) { bd = dist; best = f; }
      });
      found = best ? [best] : [];
      if (best) best.abs = best.index;
    }
    if (!found.length) { showToast('No JWT found (header.payload.signature, starting with "ey")', 'error', 3000); return; }
    var now = Date.now() / 1000, groups = {}, order = [], blocks = [], skipped = 0;
    found.forEach(function (f) {
      var line = st.doc.lineAt(f.abs + f.token.length);
      // Re-running on an already decoded token would stack a second block.
      if (line.number + 2 <= st.doc.lines && st.doc.line(line.number + 1).text === '```json' &&
          /^\/\/ JW[TE]/.test(st.doc.line(line.number + 2).text)) { skipped++; return; }
      var b = jwtBlock(f, now);
      if (!groups[line.to]) { groups[line.to] = []; order.push(line.to); }
      groups[line.to].push(b); blocks.push(b);
    });
    if (!blocks.length) { showToast(skipped ? 'Already decoded (see the block below the token)' : 'Nothing to decode', 'info', 2500); return; }
    dpApply(order.map(function (pos) { return { from: pos, to: pos, insert: '\n' + groups[pos].join('\n') }; }), blocks.join('\n\n'));
  };

  /* ================================================================
     2. Hashes
     ================================================================ */

  function hashToHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  // MD5 (RFC 1321) over raw bytes. Pure JS because WebCrypto has no MD5.
  function hashMd5(bytes) {
    var S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21], K = [], i;
    for (i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    var len = bytes.length, nw = (((len + 8) >>> 6) + 1) * 16, w = new Int32Array(nw);
    for (i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
    w[len >> 2] |= 0x80 << ((len % 4) * 8);
    w[nw - 2] = (len * 8) | 0;
    w[nw - 1] = Math.floor(len / 536870912);
    var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (var o = 0; o < nw; o += 16) {
      var A = a0, B = b0, C = c0, D = d0, F, g, x, tmp;
      for (i = 0; i < 64; i++) {
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        tmp = D; D = C; C = B;
        x = (A + F + K[i] + w[o + g]) | 0;
        var r = S[(i >> 4) * 4 + (i % 4)];
        B = (B + ((x << r) | (x >>> (32 - r)))) | 0;
        A = tmp;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    var out = '';
    [a0, b0, c0, d0].forEach(function (v) {
      for (var j = 0; j < 4; j++) { var bb = (v >>> (j * 8)) & 255; out += (bb < 16 ? '0' : '') + bb.toString(16); }
    });
    return out;
  }

  // SHA-256 fallback for insecure contexts (plain http) where crypto.subtle is undefined.
  function hashSha256(bytes) {
    var K = [], H = [], i, j, n = 2, c = 0;
    function frac(x) { return ((x - Math.floor(x)) * 4294967296) | 0; }
    while (c < 64) {
      var prime = true;
      for (j = 2; j * j <= n; j++) if (n % j === 0) { prime = false; break; }
      if (prime) { if (c < 8) H[c] = frac(Math.pow(n, 1 / 2)); K[c] = frac(Math.pow(n, 1 / 3)); c++; }
      n++;
    }
    var len = bytes.length, nw = (((len + 8) >>> 6) + 1) * 16, w = new Int32Array(nw);
    for (i = 0; i < len; i++) w[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    w[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    w[nw - 1] = (len * 8) | 0;
    w[nw - 2] = Math.floor(len / 536870912);
    var W = new Int32Array(64);
    function ror(x, r) { return (x >>> r) | (x << (32 - r)); }
    for (var o = 0; o < nw; o += 16) {
      for (i = 0; i < 64; i++) {
        if (i < 16) W[i] = w[o + i];
        else {
          var s0 = ror(W[i - 15], 7) ^ ror(W[i - 15], 18) ^ (W[i - 15] >>> 3);
          var s1 = ror(W[i - 2], 17) ^ ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
          W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
        }
      }
      var a = H[0], b = H[1], cc = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        var t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + cc) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
  }

  // algo: 'MD5' | 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'. null = unavailable.
  async function hashHex(algo, bytes) {
    if (algo === 'MD5') return hashMd5(bytes);
    var subtle = window.crypto && window.crypto.subtle;
    if (subtle) {
      try { return hashToHex(await subtle.digest(algo, bytes)); } catch (e) { /* fall through */ }
    }
    return algo === 'SHA-256' ? hashSha256(bytes) : null;
  }

  // Hash the selection / line / doc and insert "algo: hex" line(s) BELOW it
  // (hashing must never destroy the input).
  async function hashRun(algos) {
    var t = dpTarget();
    if (!t) return;
    if (!t.text.length) { showToast('Nothing to hash — the document is empty', 'error', 2500); return; }
    var bytes = new TextEncoder().encode(t.text), lines = [];
    for (var i = 0; i < algos.length; i++) {
      var hex = await hashHex(algos[i], bytes);
      lines.push(algos[i].toLowerCase().replace('-', '') + ': ' + (hex || 'unavailable here (crypto.subtle needs https)'));
    }
    var out = lines.join('\n'), st = window.Cade.editor.state, pos, ins;
    if (t.kind === 'doc') {
      pos = Math.min(t.head, st.doc.length); ins = out;     // cursor sits on an empty line: fill it
    } else {
      var end = Math.min(t.to, st.doc.length), line = st.doc.lineAt(end);
      if (t.kind === 'sel' && end === line.from && end > t.from) { pos = end; ins = out + '\n'; }
      else { pos = line.to; ins = '\n' + out; }
    }
    dpApply([{ from: pos, to: pos, insert: ins }], out);
  }

  var hashSha256Main = async function main(ctx) { await hashRun(['SHA-256']); };
  var hashMd5Main = async function main(ctx) { await hashRun(['MD5']); };
  var hashAllMain = async function main(ctx) { await hashRun(['MD5', 'SHA-1', 'SHA-256', 'SHA-512']); };
  var hashPickMain = async function main(ctx) {
    var names = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
    var last = dpStoreGet('cade-devpack-hash-algo') || 'sha256';
    var ans = window.prompt('Hash algorithm — md5, sha1, sha256, sha384 or sha512:', last);
    if (ans == null) return;
    var key = ans.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!names[key]) { showToast('Unknown algorithm: ' + ans, 'error', 2500); return; }
    dpStoreSet('cade-devpack-hash-algo', key);
    await hashRun([names[key]]);
  };

  /* ================================================================
     3. Timestamps <-> dates
     Internal representation: BigInt nanoseconds since 1970-01-01T00:00Z,
     so unix ns and kdb+ timestamps keep full precision.
     ================================================================ */

  function tsPad(n, w) { var s = String(Math.abs(n)); while (s.length < w) s = '0' + s; return (n < 0 ? '-' : '') + s; }

  // Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
  function tsDays(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    var era = Math.floor(y / 400), yoe = y - era * 400;
    var doy = Math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1;
    return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  }

  function tsCivil(z) {
    z += 719468;
    var era = Math.floor(z / 146097), doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
    return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
  }

  function tsFloorDiv(a, b) { var q = a / b; if (a % b !== 0n && ((a < 0n) !== (b < 0n))) q -= 1n; return q; }

  function tsSplit(ns) {
    var DAY = 86400000000000n, days = tsFloorDiv(ns, DAY), rem = ns - days * DAY;
    var secs = Number(rem / 1000000000n), c = tsCivil(Number(days));
    return { y: c[0], mo: c[1], d: c[2], h: Math.floor(secs / 3600), mi: Math.floor(secs % 3600 / 60), s: secs % 60, frac: Number(rem % 1000000000n) };
  }

  // Years 0001..9999 — beyond that formatting/Date are meaningless.
  function tsInRange(ns) { return ns != null && ns >= -62135596800000000000n && ns < 253402300800000000000n; }

  function tsRoundMs(ns) { return tsFloorDiv(ns + 500000n, 1000000n) * 1000000n; }

  // fixed = exact digit count; otherwise '' / .123 / .123456 / .123456789
  function tsFrac(frac, fixed) {
    var s = tsPad(frac, 9);
    if (fixed) return '.' + s.slice(0, fixed);
    if (!frac) return '';
    return '.' + (s.slice(3) === '000000' ? s.slice(0, 3) : s.slice(6) === '000' ? s.slice(0, 6) : s);
  }

  function tsYmd(p, sep) { return (p.y < 0 ? '-' : '') + tsPad(Math.abs(p.y), 4) + sep + tsPad(p.mo, 2) + sep + tsPad(p.d, 2); }
  function tsHms(p) { return tsPad(p.h, 2) + ':' + tsPad(p.mi, 2) + ':' + tsPad(p.s, 2); }

  function tsLocalOff(ns) {
    var d = new Date(Number(tsFloorDiv(ns, 1000000n)));
    return isNaN(d.getTime()) ? 0 : Math.round(-d.getTimezoneOffset());
  }

  function tsOffStr(min) { var a = Math.abs(min); return (min < 0 ? '-' : '+') + tsPad(Math.floor(a / 60), 2) + ':' + tsPad(a % 60, 2); }

  // Exact decimal string x unit (BigInt) -> BigInt, rounded half up. '1700000000.5' s -> ns.
  function tsNum(str, unit) {
    var m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(str).replace(/_/g, ''));
    if (!m || !(m[2] || m[3])) return null;
    var fr = m[3] || '', p = 10n ** BigInt(fr.length), mant = BigInt((m[2] || '0') + fr);
    var v = (mant * unit * 2n + p) / (2n * p);
    return m[1] ? -v : v;
  }

  // BigInt n / unit as a decimal string with at most k fraction digits (trailing zeros trimmed).
  function tsDec(n, unit, k) {
    var p = 10n ** BigInt(k), neg = n < 0n, a = neg ? -n : n;
    var sc = (a * p * 2n + unit) / (2n * unit);
    var fp = (sc % p).toString();
    while (fp.length < k) fp = '0' + fp;
    fp = fp.replace(/0+$/, '');
    return (neg && sc ? '-' : '') + (sc / p).toString() + (fp ? '.' + fp : '');
  }

  // A number in a given interpretation -> ns since the unix epoch (or a
  // duration in ns for ktime/kspan). Excel: days since 1899-12-30, except
  // serials < 60 which are shifted one day by Excel's fictitious 1900-02-29
  // (serial 60). kdb+: epoch 2000.01.01.
  function tsFrom(kind, str) {
    var DAY = 86400000000000n, K = 946684800000000000n, isInt = /^-?\d+$/.test(str), v;
    switch (kind) {
      case 's': return tsNum(str, 1000000000n);
      case 'ms': return tsNum(str, 1000000n);
      case 'us': return tsNum(str, 1000n);
      case 'ns': return isInt ? BigInt(str) : null;
      case 'excel': v = parseFloat(str); return tsRoundMs(tsNum(str, DAY) - BigInt(v >= 60 ? 25569 : 25568) * DAY);
      case 'kdate': return isInt ? K + BigInt(str) * DAY : null;
      case 'kts': return isInt ? K + BigInt(str) : null;
      case 'kdt': return tsRoundMs(K + tsNum(str, DAY));
      case 'kmonth':
        if (!isInt) return null;
        v = parseInt(str, 10);
        return BigInt(tsDays(2000 + Math.floor(v / 12), ((v % 12) + 12) % 12 + 1, 1)) * DAY;
      case 'ktime': return isInt ? BigInt(str) * 1000000n : null;
      case 'kspan': return isInt ? BigInt(str) : null;
    }
    return null;
  }

  // q duration literals: timespan 0D12:30:00.000000000, time 12:30:00.000
  function tsSpan(ns, kind) {
    var neg = ns < 0n, a = neg ? -ns : ns;
    if (kind === 'ktime') {
      var ms = Number(a / 1000000n);
      return (neg ? '-' : '') + tsPad(Math.floor(ms / 3600000), 2) + ':' + tsPad(Math.floor(ms % 3600000 / 60000), 2) + ':' +
        tsPad(Math.floor(ms % 60000 / 1000), 2) + '.' + tsPad(ms % 1000, 3);
    }
    var DAY = 86400000000000n, r = a % DAY, secs = Number(r / 1000000000n);
    return (neg ? '-' : '') + (a / DAY) + 'D' + tsPad(Math.floor(secs / 3600), 2) + ':' + tsPad(Math.floor(secs % 3600 / 60), 2) + ':' +
      tsPad(secs % 60, 2) + '.' + tsPad(Number(r % 1000000000n), 9);
  }

  function tsTo(fmt, ns) {
    var DAY = 86400000000000n, K = 946684800000000000n, p, off;
    if (fmt === 'ns') return ns.toString();
    if (fmt === 'ktsns') return (ns - K).toString();
    if (fmt === 's') return tsDec(ns, 1000000000n, 9);
    if (fmt === 'ms') return tsDec(ns, 1000000n, 6);
    if (fmt === 'us') return tsDec(ns, 1000n, 3);
    if (fmt === 'kdateint') return tsFloorDiv(ns - K, DAY).toString();
    if (fmt === 'kdtfloat') return tsDec(tsRoundMs(ns) - K, DAY, 10);
    if (fmt === 'excel') return tsDec(tsRoundMs(ns) + BigInt(ns < BigInt(tsDays(1900, 3, 1)) * DAY ? 25568 : 25569) * DAY, DAY, 10);
    if (!tsInRange(ns)) return null;
    switch (fmt) {
      case 'iso': p = tsSplit(ns); return tsYmd(p, '-') + 'T' + tsHms(p) + tsFrac(p.frac) + 'Z';
      case 'isolocal':
        off = tsLocalOff(ns); p = tsSplit(ns + BigInt(off) * 60000000000n);
        return tsYmd(p, '-') + 'T' + tsHms(p) + tsFrac(p.frac) + tsOffStr(off);
      case 'kts': p = tsSplit(ns); return tsYmd(p, '.') + 'D' + tsHms(p) + tsFrac(p.frac, 9);
      case 'kdate': p = tsSplit(ns); return tsYmd(p, '.');
      case 'kdt': p = tsSplit(tsRoundMs(ns)); return tsYmd(p, '.') + 'T' + tsHms(p) + tsFrac(p.frac, 3);
      case 'kmonth': p = tsSplit(ns); return tsYmd(p, '.').slice(0, -3) + 'm';
    }
    return null;
  }

  // "2023-11-14 22:13:20 UTC (local: 2023-11-14 17:13:20 -05:00)"
  function tsHuman(ns, noLocal) {
    if (!tsInRange(ns)) return null;
    var p = tsSplit(ns), s = tsYmd(p, '-') + ' ' + tsHms(p) + tsFrac(p.frac) + ' UTC', off = tsLocalOff(ns);
    if (off && !noLocal) {
      var q = tsSplit(ns + BigInt(off) * 60000000000n);
      s += ' (local: ' + tsYmd(q, '-') + ' ' + tsHms(q) + tsFrac(q.frac) + ' ' + tsOffStr(off) + ')';
    }
    return s;
  }

  // Readable rendering of a number under one interpretation (null = n/a).
  function tsDescribe(kind, str, compact) {
    var ns = tsFrom(kind, str);
    if (ns == null) return null;
    if (kind === 'ktime' || kind === 'kspan') return tsSpan(ns, kind);
    if (!tsInRange(ns)) return null;
    var p = tsSplit(ns), dt = tsYmd(p, '-') + ' ' + tsHms(p) + tsFrac(p.frac), isInt = /^-?\d+$/.test(str);
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    switch (kind) {
      case 'excel':
        var v = parseFloat(str);
        if (v >= 60 && v < 61) return '1900-02-29' + (isInt ? '' : ' ' + tsHms(p) + tsFrac(p.frac)) + " (Excel's fictitious leap day)";
        return (isInt ? tsYmd(p, '-') : dt) + ' (Excel serial)';
      case 'kdate': return tsTo('kdate', ns) + ' (' + tsYmd(p, '-') + ')';
      case 'kts': return tsTo('kts', ns) + ' (' + dt + ' UTC)';
      case 'kdt': return tsTo('kdt', ns) + ' (' + dt + ' UTC)';
      case 'kmonth': return tsTo('kmonth', ns) + ' (' + MONTHS[p.mo - 1] + ' ' + p.y + ')';
    }
    return tsHuman(ns, compact);
  }

  // Unambiguous unix epochs by digit count, plausible years 2001-2099 only:
  // 10 = s, 13 = ms, 16 = us, 19 = ns (s / ms may carry a fraction).
  function tsAuto(ip, frac) {
    var n = ip.length, v = Number(ip);
    if (n === 10 && v >= 1e9 && v < 4102444800) return 's';
    if (n === 13 && v >= 1e12 && v < 4102444800e3) return 'ms';
    if (frac) return null;
    if (n === 16 && v >= 1e15 && v < 4102444800e6) return 'us';
    if (n === 19 && v >= 1e18 && v < 4102444800e9) return 'ns';
    return null;
  }

  // Best guess for a lone ambiguous number (pre-selects the prompt).
  function tsGuess(str) {
    var m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str), n = m[2].replace(/^0+(?=\d)/, '').length, v = Math.abs(parseFloat(str));
    var a = !m[1] && tsAuto(m[2], m[3]);
    if (a) return a;
    if (n === 18 && !m[3]) return 'kts';               // kdb+ ns since 2000 for 2003-2031
    if (v >= 20000 && v < 80000) return 'excel';        // 1954-2119
    if (v < 20000) return m[3] ? 'kdt' : 'kdate';       // kdb+ days since 2000
    return n >= 17 ? 'ns' : n >= 14 ? 'us' : n >= 11 ? 'ms' : 's';
  }

  function tsKinds(withDur) {
    var k = [['s', 'unix seconds'], ['ms', 'unix milliseconds'], ['us', 'unix microseconds'], ['ns', 'unix nanoseconds'],
      ['excel', 'Excel serial'], ['kdate', 'kdb date int'], ['kts', 'kdb timestamp ns'], ['kdt', 'kdb datetime float'], ['kmonth', 'kdb month int']];
    if (withDur) k.push(['ktime', 'kdb time ms'], ['kspan', 'kdb timespan ns']);
    return k;
  }

  // Ask how to read an ambiguous number; every option previews its result.
  function tsAsk(str, withDur) {
    var K = tsKinds(withDur), guess = tsGuess(str), def = 1, lines = [];
    K.forEach(function (k, i) {
      if (k[0] === guess) def = i + 1;
      var d = tsDescribe(k[0], str, true), label = k[1];
      while (label.length < 19) label += ' ';
      lines.push((i < 9 ? ' ' : '') + (i + 1) + '  ' + label + (d ? '→ ' + d : '(n/a)'));
    });
    var ans = window.prompt('Read ' + str + ' as:\n' + lines.join('\n'), String(def));
    if (ans == null) return null;
    var i = parseInt(ans, 10);
    if (i >= 1 && i <= K.length && tsDescribe(K[i - 1][0], str, true)) return K[i - 1][0];
    showToast('Not a valid choice for ' + str, 'error', 2500);
    return null;
  }

  function tsTargets() {
    return [['s', 'unix seconds'], ['ms', 'unix milliseconds'], ['us', 'unix microseconds'], ['ns', 'unix nanoseconds'],
      ['iso', 'ISO 8601 UTC'], ['isolocal', 'ISO 8601 local'], ['excel', 'Excel serial'],
      ['kts', 'kdb timestamp'], ['kdate', 'kdb date'], ['kdt', 'kdb datetime'],
      ['kdateint', 'kdb date int'], ['ktsns', 'kdb timestamp ns'], ['kdtfloat', 'kdb datetime float']];
  }

  // Ask for an output format (numbered list previewing `sampleNs`). Accepts a
  // number or a name (unix, ms, ns, iso, excel, kdb, date…); trailing "+" =
  // keep the originals. Remembers the last choice under `key`. wholeSec: preview
  // unix seconds without a fraction (what Insert Timestamp writes).
  function tsAskTarget(sampleNs, title, key, allowKeep, wholeSec) {
    var T = tsTargets(), last = dpStoreGet(key) || 's', def = 1;
    var lines = T.map(function (t, i) {
      if (t[0] === last) def = i + 1;
      var label = t[1];
      while (label.length < 19) label += ' ';
      var ns = wholeSec && t[0] === 's' ? sampleNs - sampleNs % 1000000000n : sampleNs;
      return (i < 9 ? ' ' : '') + (i + 1) + '  ' + label + (tsTo(t[0], ns) || '(n/a)');
    });
    var msg = title + '\n' + lines.join('\n') + (allowKeep ? '\nAdd + to keep the originals (e.g. ' + def + '+). Dates without a zone are read as UTC.' : '');
    var ans = window.prompt(msg, String(def));
    if (ans == null) return null;
    ans = ans.trim().toLowerCase();
    var keep = /\+$/.test(ans);
    ans = ans.replace(/\+$/, '').trim();
    var A = { unix: 's', epoch: 's', sec: 's', secs: 's', seconds: 's', millis: 'ms', milliseconds: 'ms', 'µs': 'us', micros: 'us', nanos: 'ns',
      utc: 'iso', 'iso8601': 'iso', local: 'isolocal', serial: 'excel', xl: 'excel', xls: 'excel', xlsx: 'excel',
      kdb: 'kts', q: 'kts', timestamp: 'kts', date: 'kdate', datetime: 'kdt', dateint: 'kdateint', kdbns: 'ktsns', float: 'kdtfloat' };
    var idx = /^\d+$/.test(ans) ? parseInt(ans, 10) : 0, fmt = null;
    if (idx >= 1 && idx <= T.length) fmt = T[idx - 1][0];
    else if (A[ans]) fmt = A[ans];
    else T.forEach(function (t) { if (t[0] === ans) fmt = t[0]; });
    if (!fmt) { showToast('Unknown format: ' + ans, 'error', 2500); return null; }
    dpStoreSet(key, fmt);
    return { fmt: fmt, keep: keep && allowKeep };
  }

  function tsMake(y, mo, d, h, mi, s, f, off) {
    if (mo < 1 || mo > 12 || d < 1 || h > 24 || mi > 59 || s > 60) return null;
    var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (d > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]) return null;
    if (h === 24 && (mi || s || +f)) return null;
    return (BigInt(tsDays(y, mo, d)) * 86400n + BigInt(h * 3600 + mi * 60 + s - off * 60)) * 1000000000n +
      BigInt(((f || '') + '000000000').slice(0, 9));
  }

  // Zone suffix -> offset minutes ('' = UTC), null if unrecognised.
  function tsZone(z) {
    z = z.trim();
    if (!z) return 0;
    var m = /^(?:(z|utc|gmt|ut)|([ecmp])([sd])t)?\s*(?:([+-])(\d{2}):?(\d{2})?)?$/i.exec(z);
    if (!m || !(m[1] || m[2] || m[4])) return null;
    var off = 0;
    if (m[2]) off = -({ e: 5, c: 6, m: 7, p: 8 }[m[2].toLowerCase()] - (m[3].toLowerCase() === 'd' ? 1 : 0)) * 60;
    if (m[4]) off += (m[4] === '-' ? -1 : 1) * (+m[5] * 60 + +(m[6] || 0));
    return off;
  }

  function tsTimeZone(s) {
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(?:([ap])\.?m\.?)?\s*(.*)$/i.exec(s.trim());
    if (!m) return null;
    var h = +m[1];
    if (m[5]) { if (h < 1 || h > 12) return null; h = h % 12 + (m[5].toLowerCase() === 'p' ? 12 : 0); }
    var off = tsZone(m[6]);
    return off == null ? null : { h: h, mi: +m[2], s: +(m[3] || 0), f: m[4] || '', off: off };
  }

  function tsMonth(w) {
    var full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    w = w.replace(/\.$/, '');
    for (var i = 0; i < 12; i++) if (w === full[i] || w === full[i].slice(0, 3) || (i === 8 && w === 'sept')) return i + 1;
    return 0;
  }

  // Parse one date token (as found by tsScan) -> ns, or null. Zone-less = UTC
  // (the kdb+/Excel/log convention).
  function tsParseDate(s) {
    var m, t;
    if ((m = /^(\d{4})\.(\d{2})m$/.exec(s))) return tsMake(+m[1], +m[2], 1, 0, 0, 0, '', 0);
    if ((m = /^(\d{4})\.(\d{2})\.(\d{2})(?:([DT])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/.exec(s)))
      return tsMake(+m[1], +m[2], +m[3], +(m[5] || 0), +(m[6] || 0), +(m[7] || 0), m[8] || '', 0);
    if ((m = /^(\d{4})([-/])(\d{2})\2(\d{2})(?:[T ](.+))?$/i.exec(s))) {
      t = m[5] ? tsTimeZone(m[5]) : { h: 0, mi: 0, s: 0, f: '', off: 0 };
      return t && tsMake(+m[1], +m[3], +m[4], t.h, t.mi, t.s, t.f, t.off);
    }
    // Month-name forms: RFC 2822, Date#toString, "Jan 15, 2024 3:30 PM", "15 January 2024"…
    var str = s.replace(/\([^)]*\)/g, ' '), tm = /\d{1,2}:\d{2}/.exec(str), head = str, tail = '';
    if (tm) { head = str.slice(0, tm.index); tail = str.slice(tm.index); }
    var y = null, mo = null, d = null, words = head.toLowerCase().replace(/,/g, ' ').split(/\s+/);
    for (var i = 0; i < words.length; i++) {
      var w = words[i], mm;
      if (!w || w === 'at') continue;
      if (/^\d{4}$/.test(w)) y = +w;
      else if (/^\d{1,2}(?:st|nd|rd|th)?$/.test(w)) d = parseInt(w, 10);
      else if ((mm = tsMonth(w))) mo = mm;
      else if (!/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/.test(w)) return null;
    }
    if (y == null || mo == null || d == null) return null;
    t = tail ? tsTimeZone(tail) : { h: 0, mi: 0, s: 0, f: '', off: 0 };
    return t && tsMake(y, mo, d, t.h, t.mi, t.s, t.f, t.off);
  }

  // Find timestamp-ish tokens: date strings (ISO 8601, kdb+ q date / timestamp
  // / datetime / month, yyyy/mm/dd, RFC 2822 and other month-name forms) and/or
  // unix epochs by digit count. Returns sorted, non-overlapping
  // [{from, to, str, ns, kind}] with offsets relative to `text`.
  function tsScan(text, wantDates, wantNums) {
    var B = '(?<![\\w.:+\\-/])', E = '(?![\\w:]|[.\\-/]\\d)';
    var MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
    var DOW = '(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+)?';
    var TIME = '\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:\\s?[ap]\\.?m\\.?)?';
    var ZONE = '(?:\\s?(?:z|utc|gmt|ut|[ecmp][sd]t)(?![a-z]))?(?:\\s?[+-]\\d{2}:?\\d{2})?(?:\\s\\([a-z][a-z .]{1,40}\\))?';
    var pats = [];
    if (wantDates) {
      pats.push(
        [B + '\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{1,2}:\\d{2}(?::\\d{2}(?:[.,]\\d{1,9})?)?(?:\\s?(?:Z|UTC|GMT|[+-]\\d{2}(?::?\\d{2})?)(?![\\w:]))?)?' + E, 'g'],
        [B + '\\d{4}\\.\\d{2}\\.\\d{2}(?:D\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?|T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?)?' + E, 'g'],
        [B + '\\d{4}\\.\\d{2}m(?!\\w)', 'g'],
        [B + '\\d{4}/\\d{2}/\\d{2}(?:[ T]' + TIME + ')?' + E, 'gi'],
        ['\\b' + DOW + '\\d{1,2}(?:st|nd|rd|th)?\\s+' + MON + ',?\\s+\\d{4}(?:,?\\s+(?:at\\s+)?' + TIME + ZONE + ')?(?![\\w:])', 'gi'],
        ['\\b' + DOW + MON + '\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}(?:,?\\s+(?:at\\s+)?' + TIME + ZONE + ')?(?![\\w:])', 'gi']);
    }
    var cands = [], m;
    pats.forEach(function (p) {
      var re = new RegExp(p[0], p[1]);
      while ((m = re.exec(text))) {
        var ns = tsParseDate(m[0].trim());
        if (tsInRange(ns)) cands.push({ from: m.index, to: m.index + m[0].length, str: m[0], ns: ns, kind: 'date' });
      }
    });
    if (wantNums) {
      var nre = /(?<![\w.\-+:/])(\d+)(?:\.(\d+))?(?!\w|[.:/-]\d)/g;
      while ((m = nre.exec(text))) {
        var kind = tsAuto(m[1], m[2]);
        if (kind) cands.push({ from: m.index, to: m.index + m[0].length, str: m[0], ns: tsFrom(kind, m[0]), kind: kind });
      }
    }
    cands.sort(function (a, b) { return a.from - b.from || (b.to - b.from) - (a.to - a.from); });
    var out = [], end = -1;
    cands.forEach(function (c) { if (c.from >= end) { out.push(c); end = c.to; } });
    return out;
  }

  // A lone q duration literal -> its underlying integer.
  function tsParseDur(s) {
    var m = /^(-)?(\d*)D(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(s), v;
    if (m) {
      v = (BigInt(m[2] || '0') * 86400n + BigInt(+m[3] * 3600 + +m[4] * 60 + +(m[5] || 0))) * 1000000000n + BigInt(((m[6] || '') + '000000000').slice(0, 9));
      return { v: (m[1] ? -v : v).toString(), what: 'q timespan → nanoseconds' };
    }
    m = /^(-)?(\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/.exec(s);
    if (m) {
      v = ((+m[2] * 60 + +m[3]) * 60 + +m[4]) * 1000 + +m[5];
      return { v: String(m[1] ? -v : v), what: 'q time → milliseconds' };
    }
    return null;
  }

  var TS = [tsPad, tsDays, tsCivil, tsFloorDiv, tsSplit, tsInRange, tsRoundMs, tsFrac, tsYmd, tsHms, tsLocalOff, tsOffStr,
    tsNum, tsDec, tsFrom, tsSpan, tsTo, tsHuman, tsDescribe, tsAuto, tsGuess, tsKinds, tsAsk, tsTargets, tsAskTarget,
    tsMake, tsZone, tsTimeZone, tsMonth, tsParseDate, tsScan, tsParseDur];

  // Timestamps -> Dates: annotate (never replace) numeric timestamps.
  var tsToDatesMain = function main(ctx) {
    var t = dpTarget();
    if (!t) return;
    var text = t.text, trimmed = text.trim(), lead = text.length - text.replace(/^\s+/, '').length, changes = [];
    var one = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (one) {
      // A lone number: obvious unix epochs convert directly; anything else
      // (Excel serial, kdb+ ints, odd magnitudes) asks how to read it.
      var kind = (!one[1] && tsAuto(one[2], one[3])) || tsAsk(trimmed, true);
      if (!kind) return;
      var desc = tsDescribe(kind, trimmed);
      if (!desc) { showToast('Out of range for that format', 'error', 2500); return; }
      changes.push({ from: t.from + lead + trimmed.length, to: t.from + lead + trimmed.length, insert: ' → ' + desc });
    } else {
      tsScan(text, false, true).forEach(function (tok) {
        if (/^\s*→/.test(text.slice(tok.to))) return;          // already annotated
        var d = tsDescribe(tok.kind, tok.str);
        if (d) changes.push({ from: t.from + tok.to, to: t.from + tok.to, insert: ' → ' + d });
      });
    }
    if (!changes.length) {
      showToast('No unix timestamps found (10/13/16/19 digits). Select a lone number to read it as Excel / kdb+; use Dates → Timestamps… for date strings', 'error', 4500);
      return;
    }
    dpApply(changes, dpSplice(text, t.from, changes));
  };

  // Dates -> Timestamps…: convert every date / epoch token to a chosen format.
  var tsToStampsMain = function main(ctx) {
    var t = dpTarget();
    if (!t) return;
    var text = t.text, trimmed = text.trim(), lead = text.length - text.replace(/^\s+/, '').length, toks = [];
    var dur = tsParseDur(trimmed);
    if (dur) {
      dpApply([{ from: t.from + lead, to: t.from + lead + trimmed.length, insert: dur.v }], dur.v);
      showToast(dur.what, 'info', 2500);
      return;
    }
    var one = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (one) {
      var kind = (!one[1] && tsAuto(one[2], one[3])) || tsAsk(trimmed, false);
      if (!kind) return;
      var ns1 = tsFrom(kind, trimmed);
      if (!tsInRange(ns1)) { showToast('Out of range for that format', 'error', 2500); return; }
      toks.push({ from: lead, to: lead + trimmed.length, str: trimmed, ns: ns1 });
    } else {
      toks = tsScan(text, true, true);
    }
    if (!toks.length) { showToast('No dates or timestamps found', 'error', 3000); return; }
    var first = toks[0].str.trim();
    var tgt = tsAskTarget(toks[0].ns, 'Convert ' + toks.length + ' date/timestamp' + (toks.length > 1 ? 's' : '') +
      ' to which format?  (preview: ' + (first.length > 40 ? first.slice(0, 40) + '…' : first) + ')', 'cade-devpack-ts-target', true);
    if (!tgt) return;
    var changes = [];
    toks.forEach(function (tok) {
      var out = tsTo(tgt.fmt, tok.ns);
      if (out == null) return;
      if (out === tok.str.trim()) return;                       // already in that format
      if (tgt.keep) {
        if (!/^\s*→/.test(text.slice(tok.to))) changes.push({ from: t.from + tok.to, to: t.from + tok.to, insert: ' → ' + out });
      } else {
        changes.push({ from: t.from + tok.from, to: t.from + tok.to, insert: out });
      }
    });
    if (!changes.length) { showToast('Already in that format', 'info', 2000); return; }
    dpApply(changes, dpSplice(text, t.from, changes));
  };

  var tsInsertMain = function main(ctx) {
    var tgt = tsAskTarget(BigInt(Date.now()) * 1000000n, 'Insert the current time as:', 'cade-devpack-ins-target', false, true);
    if (!tgt) return;
    var ms = Date.now();
    if (tgt.fmt === 's') ms -= ms % 1000;                       // "now" in seconds = whole seconds, like date +%s
    var out = tsTo(tgt.fmt, BigInt(ms) * 1000000n), sel = window.Cade.editor.state.selection.main;
    dpApply([{ from: sel.from, to: sel.to, insert: out }], out);
  };

  /* ================================================================
     4. cURL -> fetch / Python requests
     ================================================================ */

  // One escape of a bash $'…' string starting at s[i] (just past the backslash).
  function curlAnsi(s, i) {
    var c = s[i], m, map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    if (map[c] != null) return [map[c], i + 1];
    if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)))) return [String.fromCharCode(parseInt(m[0], 16)), i + 1 + m[0].length];
    if (c === 'u' && (m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(i + 1)))) return [String.fromCharCode(parseInt(m[0], 16)), i + 1 + m[0].length];
    if (c === 'U' && (m = /^[0-9a-fA-F]{1,8}/.exec(s.slice(i + 1)))) return [String.fromCodePoint(parseInt(m[0], 16)), i + 1 + m[0].length];
    if ((m = /^[0-7]{1,3}/.exec(s.slice(i)))) return [String.fromCharCode(parseInt(m[0], 8)), i + m[0].length];
    return ['\\' + (c || ''), i + 1];
  }

  // Bash-style word splitting: '…', "…", $'…', backslash escapes and
  // backslash-newline continuations. Stops at an unquoted | ; < > or a
  // leading & (pipes / redirects are not part of the request). out.ends[k]
  // is the source offset just past token k.
  function curlTokens(s) {
    var out = [], cur = null, i = 0, n = s.length, c, j, buf;
    out.ends = [];
    function add(x) { cur = (cur == null ? '' : cur) + x; }
    while (i < n) {
      c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { if (cur != null) { out.push(cur); out.ends.push(i); cur = null; } i++; continue; }
      if (c === '\\') {
        if (s[i + 1] === '\n') { i += 2; continue; }
        if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
        add(s[i + 1] || ''); i += 2; continue;
      }
      if (c === "'") { j = s.indexOf("'", i + 1); if (j < 0) j = n; add(s.slice(i + 1, j)); i = j + 1; continue; }
      if (c === '$' && s[i + 1] === "'") {
        i += 2; buf = '';
        while (i < n && s[i] !== "'") {
          if (s[i] === '\\' && i + 1 < n) { var r = curlAnsi(s, i + 1); buf += r[0]; i = r[1]; } else buf += s[i++];
        }
        add(buf); i++; continue;
      }
      if (c === '"') {
        i++; buf = '';
        while (i < n && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < n) {
            if (s[i + 1] === '\n') { i += 2; continue; }
            if ('$`"\\'.indexOf(s[i + 1]) >= 0) { buf += s[i + 1]; i += 2; continue; }
          }
          buf += s[i++];
        }
        add(buf); i++; continue;
      }
      if (c === '|' || c === ';' || c === '<' || c === '>' || (c === '&' && cur == null)) break;
      if (c === '#' && cur == null) { while (i < n && s[i] !== '\n') i++; continue; }
      add(c); i++;
    }
    if (cur != null) { out.push(cur); out.ends.push(Math.min(i, n)); }
    return out;
  }

  function curlEnc(s) {
    return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
  }

  // --data-urlencode forms: content | =content | name=content | @file | name@file
  function curlUrlEncode(v, notes) {
    var eq = v.indexOf('='), at = v.indexOf('@');
    if (eq < 0 && at >= 0 && /^[^=]*@/.test(v)) { notes.push('--data-urlencode ' + v + ': contents of file "' + v.slice(at + 1) + '"'); return (at > 0 ? v.slice(0, at) + '=' : '') + '<file:' + v.slice(at + 1) + '>'; }
    if (eq < 0) return curlEnc(v);
    if (eq === 0) return curlEnc(v.slice(1));
    return v.slice(0, eq) + '=' + curlEnc(v.slice(eq + 1));
  }

  // Parse a curl command line into a request model, or null if no "curl".
  function curlParse(src) {
    var args = curlTokens(src), start = -1, i;
    for (i = 0; i < args.length; i++) if (/^(?:.*[\/\\])?curl(?:\.exe)?$/i.test(args[i])) { start = i; break; }
    if (start < 0) return null;
    var r = { url: null, method: null, headers: [], data: [], json: [], form: [], user: null, cookies: [], urlQuery: [], notes: [],
      get: false, head: false, insecure: false, location: false, digest: false, maxTime: null, connectTimeout: null, proxy: null, upload: null, dataFile: null };
    var SHORT_ARG = { X: 'request', H: 'header', d: 'data', u: 'user', b: 'cookie', F: 'form', A: 'user-agent', e: 'referer', m: 'max-time',
      x: 'proxy', o: 'output', T: 'upload-file', r: 'range', c: 'cookie-jar', D: 'dump-header', E: 'cert', K: 'config', U: 'proxy-user',
      w: 'write-out', y: 'speed-time', Y: 'speed-limit', z: 'time-cond', C: 'continue-at', Q: 'quote', t: 'telnet-option', P: 'ftp-port' };
    var SHORT_FLAG = { G: 'get', I: 'head', k: 'insecure', L: 'location' };
    var LONG_ARG = ' request header data data-raw data-binary data-ascii data-urlencode json user cookie form form-string user-agent referer' +
      ' max-time connect-timeout proxy output upload-file range cookie-jar dump-header cert key cacert capath config proxy-user write-out url' +
      ' oauth2-bearer aws-sigv4 retry retry-delay retry-max-time limit-rate interface resolve connect-to url-query cert-type key-type ciphers' +
      ' pass proxy-header local-port max-filesize max-redirs netrc-file pinnedpubkey proto proto-redir request-target unix-socket' +
      ' abstract-unix-socket socks4 socks4a socks5 socks5-hostname preproxy noproxy tls-max dns-servers doh-url trace trace-ascii stderr' +
      ' expect100-timeout happy-eyeballs-timeout-ms keepalive-time variable proxy-cacert proxy-cert proxy-key mail-from mail-rcpt mail-auth' +
      ' speed-limit speed-time time-cond continue-at quote telnet-option ftp-port output-dir etag-save etag-compare hostpubsha256 ';
    function setHdr(name, val) {
      var low = name.toLowerCase();
      r.headers = r.headers.filter(function (h) { return h[0].toLowerCase() !== low; });
      r.headers.push([name, val]);
    }
    function addHdr(h) {
      var c = h.indexOf(':');
      if (c < 0) { if (/;\s*$/.test(h)) r.headers.push([h.replace(/;\s*$/, '').trim(), '']); return; }
      var name = h.slice(0, c).trim(), val = h.slice(c + 1).trim();
      if (name && val) r.headers.push([name, val]);   // "Name:" alone removes a curl default — nothing to emit
    }
    function dataArg(name, v) {
      if (v == null) return;
      if ((name === 'data' || name === 'data-ascii' || name === 'data-binary') && v[0] === '@') {
        r.dataFile = v.slice(1);
        r.notes.push('body read from file "' + v.slice(1) + '" (curl ' + (name === 'data-binary' ? '--data-binary' : '-d') + ' @file)');
        return;
      }
      if (name === 'data-urlencode') v = curlUrlEncode(v, r.notes);
      else if (name === 'data' || name === 'data-ascii') v = v.replace(/[\r\n]/g, '');
      r.data.push(v);
    }
    function opt(name, v) {
      switch (name) {
        case 'request': r.method = v; break;
        case 'header': if (v != null) addHdr(v); break;
        case 'data': case 'data-ascii': case 'data-raw': case 'data-binary': case 'data-urlencode': dataArg(name, v); break;
        case 'json': if (v != null) r.json.push(v); break;
        case 'user': r.user = v; break;
        case 'cookie': if (v != null) { if (v.indexOf('=') >= 0) r.cookies.push(v); else r.notes.push('cookies read from file "' + v + '" were not included'); } break;
        case 'form': case 'form-string': if (v != null) r.form.push({ spec: v, literal: name === 'form-string' }); break;
        case 'user-agent': if (v != null) setHdr('User-Agent', v); break;
        case 'referer': if (v != null) setHdr('Referer', v.replace(/;auto$/, '')); break;
        case 'oauth2-bearer': if (v != null) setHdr('Authorization', 'Bearer ' + v); break;
        case 'range': if (v != null) setHdr('Range', 'bytes=' + v); break;
        case 'get': r.get = true; break;
        case 'head': r.head = true; break;
        case 'insecure': r.insecure = true; break;
        case 'location': r.location = true; break;
        case 'digest': r.digest = true; break;
        case 'max-time': r.maxTime = v; break;
        case 'connect-timeout': r.connectTimeout = v; break;
        case 'proxy': r.proxy = v; break;
        case 'upload-file': r.upload = v; break;
        case 'url': if (r.url == null) r.url = v; break;
        case 'url-query': if (v != null) r.urlQuery.push(v[0] === '+' ? v.slice(1) : curlUrlEncode(v, r.notes)); break;
      }
    }
    i = start + 1;
    var end = args.ends[start];
    while (i < args.length) {
      var a = args[i++];
      if (!/^-./.test(a) && a !== '--' && r.url != null) break;      // 2nd bare word: prose after the command
      if (a === '--') { if (r.url == null && i < args.length) r.url = args[i++]; end = args.ends[i - 1]; break; }
      if (/^--./.test(a)) {
        var eq = a.indexOf('='), name = eq > 2 ? a.slice(2, eq) : a.slice(2);
        if (LONG_ARG.indexOf(' ' + name + ' ') >= 0) opt(name, eq > 2 ? a.slice(eq + 1) : args[i++]);
        else opt(name, null);                        // a flag (unknown ones are ignored)
      } else if (/^-./.test(a)) {
        for (var k = 1; k < a.length; k++) {
          var ch = a[k];
          if (SHORT_ARG[ch]) { opt(SHORT_ARG[ch], k + 1 < a.length ? a.slice(k + 1) : args[i++]); break; }
          if (SHORT_FLAG[ch]) opt(SHORT_FLAG[ch], null);
        }
      } else r.url = a;
      end = args.ends[Math.min(i, args.length) - 1];
    }
    if (r.url == null) return { error: 'No URL in the curl command' };
    var model = curlModel(r);
    model.end = end;
    return model;
  }

  function curlHdr(m, name) {
    var low = name.toLowerCase(), v = null;
    m.headers.forEach(function (h) { if (h[0].toLowerCase() === low) v = h[1]; });
    return v;
  }

  function curlDropHdr(m, name) {
    var low = name.toLowerCase();
    m.headers = m.headers.filter(function (h) { return h[0].toLowerCase() !== low; });
  }

  // "a=1&b=2" -> [[a,1],[b,2]] when the body really is a urlencoded form.
  function curlPairs(s) {
    if (!s || /[\s]/.test(s.replace(/\+/g, '')) || /^[\[{"]/.test(s) || s.indexOf('=') < 0) return null;
    var out = [], parts = s.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf('='), k = eq < 0 ? parts[i] : parts[i].slice(0, eq), v = eq < 0 ? '' : parts[i].slice(eq + 1);
      try { out.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))]); } catch (e) { return null; }
    }
    return out.length ? out : null;
  }

  // Minimal JSON parser that keeps key order, duplicate keys and number TEXT
  // (JSON.parse would round 64-bit ids and reorder integer-like keys).
  function curlJson(text) {
    var i = 0, n = text.length;
    function ws() { while (i < n && ' \t\n\r'.indexOf(text[i]) >= 0) i++; }
    function fail() { throw new Error('json'); }
    function str() {
      var st = i++;
      while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      if (i >= n) fail();
      i++;
      return JSON.parse(text.slice(st, i));
    }
    function val() {
      ws();
      var c = text[i], m;
      if (c === '{') {
        i++; var o = { t: 'o', v: [] }; ws();
        if (text[i] === '}') { i++; return o; }
        for (;;) {
          ws(); if (text[i] !== '"') fail();
          var k = str(); ws(); if (text[i++] !== ':') fail();
          o.v.push([k, val()]); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; return o; }
          fail();
        }
      }
      if (c === '[') {
        i++; var a = { t: 'a', v: [] }; ws();
        if (text[i] === ']') { i++; return a; }
        for (;;) {
          a.v.push(val()); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return a; }
          fail();
        }
      }
      if (c === '"') return { t: 's', v: str() };
      if ((m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400))) && m[0]) { i += m[0].length; return { t: 'n', v: m[0] }; }
      if (text.substr(i, 4) === 'true') { i += 4; return { t: 'b', v: 'true' }; }
      if (text.substr(i, 5) === 'false') { i += 5; return { t: 'b', v: 'false' }; }
      if (text.substr(i, 4) === 'null') { i += 4; return { t: 'z', v: 'null' }; }
      fail();
    }
    try { var v = val(); ws(); return i === n ? v : null; } catch (e) { return null; }
  }

  // Would re-emitting this JSON as a JS (or, with py, Python) literal lose
  // anything? Duplicate keys collapse in both; integers beyond 2^53 only in JS.
  function curlJsonUnsafe(node, py) {
    if (node.t === 'n') return !py && !/[.eE]/.test(node.v) && !Number.isSafeInteger(Number(node.v));
    if (node.t === 'a') return node.v.some(function (x) { return curlJsonUnsafe(x, py); });
    if (node.t === 'o') {
      var seen = {};
      return node.v.some(function (kv) { if (seen['$' + kv[0]]) return true; seen['$' + kv[0]] = 1; return curlJsonUnsafe(kv[1], py); });
    }
    return false;
  }

  function curlJsonText(node, ind) {
    var pad = ind + '  ';
    if (node.t === 's') return JSON.stringify(node.v);
    if (node.t === 'o') {
      if (!node.v.length) return '{}';
      return '{\n' + node.v.map(function (kv) { return pad + JSON.stringify(kv[0]) + ': ' + curlJsonText(kv[1], pad); }).join(',\n') + '\n' + ind + '}';
    }
    if (node.t === 'a') {
      if (!node.v.length) return '[]';
      return '[\n' + node.v.map(function (x) { return pad + curlJsonText(x, pad); }).join(',\n') + '\n' + ind + ']';
    }
    return node.v;
  }

  function curlJsStr(s) {
    return "'" + String(s).replace(/[\\'\n\r\t\u2028\u2029]|[\x00-\x1f\x7f]/g, function (c) {
      return { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c] || '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
    }) + "'";
  }

  function curlPyStr(s) {
    s = String(s);
    var q = s.indexOf("'") >= 0 && s.indexOf('"') < 0 ? '"' : "'";
    return q + s.replace(/[\\\n\r\t'"]|[\x00-\x1f\x7f]/g, function (c) {
      if (c === '"' || c === "'") return c === q ? '\\' + c : c;
      return { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c] || '\\x' + ('0' + c.charCodeAt(0).toString(16)).slice(-2);
    }) + q;
  }

  function curlPyLit(node, ind) {
    var pad = ind + '    ';
    if (node.t === 's') return curlPyStr(node.v);
    if (node.t === 'b') return node.v === 'true' ? 'True' : 'False';
    if (node.t === 'z') return 'None';
    if (node.t === 'n') return node.v;
    if (node.t === 'o') {
      if (!node.v.length) return '{}';
      return '{\n' + node.v.map(function (kv) { return pad + curlPyStr(kv[0]) + ': ' + curlPyLit(kv[1], pad) + ','; }).join('\n') + '\n' + ind + '}';
    }
    if (!node.v.length) return '[]';
    return '[\n' + node.v.map(function (x) { return pad + curlPyLit(x, pad) + ','; }).join('\n') + '\n' + ind + ']';
  }

  // -F name=value | name=@file[;type=…][;filename=…] | name=<file
  function curlFormPart(f) {
    var eq = f.spec.indexOf('=');
    var name = eq < 0 ? f.spec : f.spec.slice(0, eq), v = eq < 0 ? '' : f.spec.slice(eq + 1);
    if (!f.literal && (v[0] === '@' || v[0] === '<')) {
      var bits = v.slice(1).split(';'), part = { name: name, file: bits[0], contents: v[0] === '<', type: null, filename: null };
      bits.slice(1).forEach(function (b) {
        var m = /^\s*(type|filename)=("?)(.*)\2\s*$/.exec(b);
        if (m) part[m[1]] = m[3];
      });
      return part;
    }
    if (!f.literal) {
      var mq = /^"(.*)"$/.exec(v);
      if (mq) v = mq[1].replace(/\\(["\\])/g, '$1');
      else v = v.replace(/;type=[\w\/+.-]+$/, '');
    }
    return { name: name, value: v };
  }

  function curlModel(r) {
    var m = { url: r.url, headers: r.headers.slice(), cookies: [], notes: r.notes.slice(), auth: null, digest: r.digest,
      insecure: r.insecure, location: r.location, timeout: r.maxTime || r.connectTimeout, proxy: r.proxy, query: null, body: { kind: 'none' } };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(m.url)) m.url = 'http://' + m.url;
    // Credentials in the URL: fetch() refuses them, requests prefers auth=.
    var um = /^([a-z][a-z0-9+.-]*:\/\/)([^\/@?#]+)@/i.exec(m.url);
    if (um && !r.user) {
      m.url = um[1] + m.url.slice(um[0].length);
      var ci = um[2].indexOf(':');
      try { m.auth = [decodeURIComponent(ci < 0 ? um[2] : um[2].slice(0, ci)), decodeURIComponent(ci < 0 ? '' : um[2].slice(ci + 1))]; } catch (e) { m.auth = null; }
    }
    if (r.user != null) { var uc = r.user.indexOf(':'); m.auth = uc < 0 ? [r.user, ''] : [r.user.slice(0, uc), r.user.slice(uc + 1)]; }
    r.cookies.forEach(function (c) { m.cookies.push(c); });
    if (r.urlQuery.length) m.url += (m.url.indexOf('?') >= 0 ? '&' : '?') + r.urlQuery.join('&');

    var data = r.data.length ? r.data.join('&') : null;
    if (r.json.length) {
      data = (data ? data : '') + r.json.join('');
      if (!curlHdr(m, 'Content-Type')) m.headers.push(['Content-Type', 'application/json']);
      if (!curlHdr(m, 'Accept')) m.headers.push(['Accept', 'application/json']);
    }
    var hasBody = data != null || r.dataFile != null || r.form.length > 0;
    m.method = (r.method || (r.head ? 'HEAD' : r.get ? 'GET' : hasBody ? 'POST' : r.upload ? 'PUT' : 'GET')).toUpperCase();
    if (r.get && data != null) {                     // -G: the data becomes the query string
      m.query = data;
      m.queryPairs = curlPairs(data);
      data = null;
    }
    var ct = (curlHdr(m, 'Content-Type') || '').toLowerCase();
    if (r.form.length) {
      m.body = { kind: 'multipart', parts: r.form.map(curlFormPart) };
      if (/^multipart\/form-data/.test(ct)) curlDropHdr(m, 'Content-Type');   // boundary must be generated
    } else if (r.dataFile != null && !r.get) {
      m.body = { kind: 'file', file: r.dataFile };
      if (!ct) m.headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    } else if (r.upload) {
      m.body = { kind: 'file', file: r.upload };
    } else if (data != null) {
      var node = /json/.test(ct) ? curlJson(data) : null, pairs;
      if (node && (node.t === 'o' || node.t === 'a')) m.body = { kind: 'json', node: node, raw: data };
      else if ((!ct || /x-www-form-urlencoded/.test(ct)) && (pairs = curlPairs(data))) m.body = { kind: 'form', pairs: pairs, raw: data };
      else {
        m.body = { kind: 'raw', raw: data };
        // curl labels -d bodies as a form unless told otherwise; fetch would say text/plain.
        if (!ct) m.headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
      }
    }
    // Merge repeated header names (objects/dicts can't hold duplicates).
    var merged = [], idx = {};
    m.headers.forEach(function (h) {
      var low = h[0].toLowerCase();
      if (idx[low] != null) merged[idx[low]][1] += (low === 'cookie' ? '; ' : ', ') + h[1];
      else { idx[low] = merged.length; merged.push([h[0], h[1]]); }
    });
    m.headers = merged;
    if (r.form.length && (r.data.length || r.json.length)) m.notes.push('-d/--json ignored: curl cannot combine them with -F');
    return m;
  }

  function curlFetch(m) {
    var pre = [], opts = [], hdrs = [], body = m.body, url = m.url;
    m.notes.forEach(function (n) { pre.push('// ' + n); });
    if (m.query != null) url += (url.indexOf('?') >= 0 ? '&' : '?') + m.query;
    if (m.method !== 'GET') opts.push('method: ' + curlJsStr(m.method));
    var forbidden = [];
    m.headers.forEach(function (h) {
      if (body.kind === 'form' && /^content-type$/i.test(h[0]) && /^application\/x-www-form-urlencoded$/i.test(h[1])) return; // URLSearchParams sets it
      if (/^(cookie|referer|origin|host|user-agent|connection|content-length|accept-encoding|sec-.*|proxy-.*)$/i.test(h[0])) forbidden.push(h[0]);
      hdrs.push(curlJsStr(h[0]) + ': ' + curlJsStr(h[1]));
    });
    if (m.cookies.length) { hdrs.push("'Cookie': " + curlJsStr(m.cookies.join('; '))); forbidden.push('Cookie'); }
    if (m.auth) {
      if (m.digest) pre.push('// curl --digest: fetch has no digest auth; this sends Basic auth instead');
      hdrs.push("'Authorization': 'Basic ' + btoa(" + curlJsStr(m.auth[0] + ':' + m.auth[1]) + ')');
    }
    if (hdrs.length) opts.push('headers: {\n    ' + hdrs.join(',\n    ') + '\n  }');
    if (body.kind === 'json') {
      if (curlJsonUnsafe(body.node)) opts.push('body: ' + curlJsStr(body.raw) + ' // kept as text: a value would not survive JSON.parse');
      else opts.push('body: JSON.stringify(' + curlJsonText(body.node, '  ') + ')');
    } else if (body.kind === 'form') {
      var keys = {}, dup = body.pairs.some(function (p) { if (keys['$' + p[0]]) return true; keys['$' + p[0]] = 1; return false; });
      opts.push('body: new URLSearchParams(' + (dup
        ? '[\n    ' + body.pairs.map(function (p) { return '[' + curlJsStr(p[0]) + ', ' + curlJsStr(p[1]) + ']'; }).join(',\n    ') + '\n  ]'
        : '{\n    ' + body.pairs.map(function (p) { return curlJsStr(p[0]) + ': ' + curlJsStr(p[1]); }).join(',\n    ') + '\n  }') + ')');
    } else if (body.kind === 'raw') {
      opts.push('body: ' + curlJsStr(body.raw));
    } else if (body.kind === 'file') {
      opts.push('body: new Blob([/* contents of ' + body.file.replace(/\*\//g, '* /') + ' */])');
    } else if (body.kind === 'multipart') {
      pre.push('const form = new FormData();');
      body.parts.forEach(function (p) {
        if (p.value != null) pre.push('form.append(' + curlJsStr(p.name) + ', ' + curlJsStr(p.value) + ');');
        else if (p.contents) pre.push('form.append(' + curlJsStr(p.name) + ', ' + curlJsStr('') + '); // TODO: contents of ' + p.file);
        else {
          var fname = p.filename || p.file.split(/[\/\\]/).pop();
          pre.push('form.append(' + curlJsStr(p.name) + ', new Blob([/* contents of ' + p.file.replace(/\*\//g, '* /') + ' */]' +
            (p.type ? ', { type: ' + curlJsStr(p.type) + ' }' : '') + '), ' + curlJsStr(fname) + ');');
        }
      });
      opts.push('body: form');
    }
    if (m.timeout) opts.push('signal: AbortSignal.timeout(' + Math.round(parseFloat(m.timeout) * 1000) + ')');
    if (m.insecure) pre.push('// curl -k: fetch cannot skip TLS verification (Node: use an undici Agent with connect: { rejectUnauthorized: false })');
    if (m.proxy) pre.push('// curl -x ' + m.proxy + ': fetch has no proxy option (Node: undici ProxyAgent)');
    if (forbidden.length) pre.push('// Browsers silently drop ' + forbidden.filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ') + ' — they are sent from Node 18+');
    var call = 'const res = await fetch(' + curlJsStr(url) + (opts.length ? ', {\n  ' + opts.join(',\n  ') + '\n}' : '') + ');';
    var L = pre.concat([call]);
    if (m.method !== 'HEAD') {
      var accept = (curlHdr(m, 'Accept') || '') + ' ' + (body.kind === 'json' ? 'json' : '');
      L.push(/json/i.test(accept) ? 'const data = await res.json();' : 'const text = await res.text();');
    }
    return L.join('\n');
  }

  function curlPython(m) {
    var pre = [], blocks = [], args = [curlPyStr(m.url)], body = m.body, headers = m.headers.slice(), cookies = [];
    m.notes.forEach(function (n) { pre.push('# ' + n); });
    // requests wants cookies as a dict, not a Cookie header.
    var cookieStr = m.cookies.slice();
    headers = headers.filter(function (h) { if (/^cookie$/i.test(h[0])) { cookieStr.push(h[1]); return false; } return true; });
    cookieStr.join('; ').split(/;\s*/).forEach(function (c) {
      var eq = c.indexOf('=');
      if (eq > 0) cookies.push([c.slice(0, eq).trim(), c.slice(eq + 1).trim()]);
    });
    if (body.kind === 'json' && headers.some(function (h) { return /^content-type$/i.test(h[0]) && /^application\/json$/i.test(h[1].trim()); }) && !curlJsonUnsafe(body.node, true))
      headers = headers.filter(function (h) { return !/^content-type$/i.test(h[0]); });   // json= sets it
    if (body.kind === 'form') headers = headers.filter(function (h) { return !(/^content-type$/i.test(h[0]) && /^application\/x-www-form-urlencoded$/i.test(h[1].trim())); });
    function dict(name, pairs) {
      var keys = {}, dup = pairs.some(function (p) { if (keys['$' + p[0]]) return true; keys['$' + p[0]] = 1; return false; });
      if (dup) return name + ' = [\n' + pairs.map(function (p) { return '    (' + curlPyStr(p[0]) + ', ' + p[1] + '),'; }).join('\n') + '\n]';
      return name + ' = {\n' + pairs.map(function (p) { return '    ' + curlPyStr(p[0]) + ': ' + p[1] + ','; }).join('\n') + '\n}';
    }
    function q(pairs) { return pairs.map(function (p) { return [p[0], curlPyStr(p[1])]; }); }
    if (m.query != null) {
      if (m.queryPairs) { blocks.push(dict('params', q(m.queryPairs))); args.push('params=params'); }
      else args[0] = curlPyStr(m.url + (m.url.indexOf('?') >= 0 ? '&' : '?') + m.query);
    }
    if (cookies.length) { blocks.push(dict('cookies', q(cookies))); args.push('cookies=cookies'); }
    if (headers.length) { blocks.push(dict('headers', q(headers))); args.push('headers=headers'); }
    if (body.kind === 'json') {
      if (curlJsonUnsafe(body.node, true)) { blocks.push('data = ' + curlPyStr(body.raw) + (/[^\x00-\x7f]/.test(body.raw) ? '.encode()' : '')); args.push('data=data'); }
      else { blocks.push('json_data = ' + curlPyLit(body.node, '')); args.push('json=json_data'); }
    } else if (body.kind === 'form') {
      blocks.push(dict('data', q(body.pairs))); args.push('data=data');
    } else if (body.kind === 'raw') {
      // str bodies are encoded as latin-1 by http.client; send UTF-8 bytes instead.
      blocks.push('data = ' + curlPyStr(body.raw) + (/[^\x00-\x7f]/.test(body.raw) ? '.encode()' : '')); args.push('data=data');
    } else if (body.kind === 'file') {
      blocks.push("with open(" + curlPyStr(body.file) + ", 'rb') as f:\n    data = f.read()"); args.push('data=data');
    } else if (body.kind === 'multipart') {
      blocks.push(dict('files', body.parts.map(function (p) {
        if (p.value != null) return [p.name, '(None, ' + curlPyStr(p.value) + ')'];
        if (p.contents) return [p.name, '(None, open(' + curlPyStr(p.file) + ", 'rb').read())"];
        var fname = p.filename || p.file.split(/[\/\\]/).pop(), op = 'open(' + curlPyStr(p.file) + ", 'rb')";
        if (!p.type && fname === p.file) return [p.name, op];
        return [p.name, '(' + curlPyStr(fname) + ', ' + op + (p.type ? ', ' + curlPyStr(p.type) : '') + ')'];
      })));
      args.push('files=files');
    }
    if (m.auth) args.push('auth=' + (m.digest ? 'requests.auth.HTTPDigestAuth(' + curlPyStr(m.auth[0]) + ', ' + curlPyStr(m.auth[1]) + ')' : '(' + curlPyStr(m.auth[0]) + ', ' + curlPyStr(m.auth[1]) + ')'));
    if (m.proxy) { blocks.push("proxies = {\n    'http': " + curlPyStr(m.proxy) + ",\n    'https': " + curlPyStr(m.proxy) + ',\n}'); args.push('proxies=proxies'); }
    if (m.insecure) args.push('verify=False');
    if (m.timeout) args.push('timeout=' + parseFloat(m.timeout));
    if (m.method === 'HEAD' && m.location) args.push('allow_redirects=True');
    var fn = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete', HEAD: 'head', OPTIONS: 'options' }[m.method];
    var head = fn ? 'response = requests.' + fn + '(' : 'response = requests.request(' + curlPyStr(m.method) + ', ';
    var call = head + args.join(', ') + ')';
    if (call.length > 100) call = (fn ? 'response = requests.' + fn + '(\n' : 'response = requests.request(\n    ' + curlPyStr(m.method) + ',\n') +
      args.map(function (a) { return '    ' + a + ','; }).join('\n') + '\n)';
    return ['import requests', ''].concat(pre.length ? pre.concat(['']) : [], blocks.length ? [blocks.join('\n\n'), ''] : [], [call]).join('\n');
  }

  // The curl command to convert: the selection, else the (multi-line, "\"-
  // continued) curl command under / nearest the cursor. Swallows a ``` fence
  // that wraps exactly that command so the output doesn't nest fences.
  function curlLocate() {
    var ed = window.Cade.editor, st = ed.state, sel = st.selection.main, doc = st.doc;
    if (sel.from !== sel.to) {
      var stx = st.sliceDoc(sel.from, sel.to);
      return /\bcurl\b/.test(stx) ? { from: sel.from, to: sel.to, text: stx } : null;
    }
    var cur = doc.lineAt(sel.head).number, blocks = [], n = doc.lines, ln;
    for (ln = 1; ln <= n; ln++) {
      var t = doc.line(ln).text, k;
      if (t.length > 20000) continue;
      // A line that IS a curl command ("$ " shell prompt allowed) is replaced
      // whole; "run: curl …" on the cursor line is replaced from "curl" on.
      if (/^\s*(?:[$%>#]\s*)?curl(?:\.exe)?\s/i.test(t)) k = 0;
      else if (ln === cur && (k = t.search(/(?:^|\s)curl\s+\S/i)) >= 0) k = t.indexOf('curl', k);
      else continue;
      var end = ln;
      while (end < n && /\\\s*$/.test(doc.line(end).text)) end++;
      blocks.push({ a: ln, b: end, col: k });
      ln = end;
    }
    if (!blocks.length) return null;
    var best = null, bd = Infinity;
    blocks.forEach(function (b) {
      var d = cur < b.a ? b.a - cur : cur > b.b ? cur - b.b : 0;
      if (d < bd) { bd = d; best = b; }
    });
    var from = doc.line(best.a).from + best.col, to = doc.line(best.b).to;
    if (!best.col && best.a > 1 && best.b < n && /^\s*(?:```|~~~)/.test(doc.line(best.a - 1).text) && /^\s*(?:```|~~~)\s*$/.test(doc.line(best.b + 1).text)) {
      from = doc.line(best.a - 1).from; to = doc.line(best.b + 1).to;
    }
    return { from: from, to: to, text: st.sliceDoc(from, to), inline: best.col > 0 };
  }

  function curlRun(lang) {
    var loc = curlLocate();
    if (!loc) { showToast('No curl command found — select one or put the cursor on it', 'error', 3000); return; }
    var src = loc.text.split('\n').filter(function (l) { return !/^\s*(?:```|~~~)/.test(l); }).join('\n');
    var model = curlParse(src);
    if (!model || model.error) { showToast(model ? model.error : 'Could not parse the curl command', 'error', 3000); return; }
    var code = lang === 'python' ? curlPython(model) : curlFetch(model);
    if (loc.inline) loc.to = loc.from + model.end;          // "run: curl … and see" keeps " and see"
    var st = window.Cade.editor.state, out = '```' + (lang === 'python' ? 'python' : 'js') + '\n' + code + '\n```';
    var pre = loc.from > st.doc.lineAt(loc.from).from ? '\n' : '', post = loc.to < st.doc.lineAt(loc.to).to ? '\n' : '';
    dpApply([{ from: loc.from, to: loc.to, insert: pre + out + post }], code);
  }

  var CURL = [curlAnsi, curlTokens, curlEnc, curlUrlEncode, curlParse, curlHdr, curlDropHdr, curlPairs, curlJson, curlJsonUnsafe,
    curlJsonText, curlJsStr, curlPyStr, curlPyLit, curlFormPart, curlModel, curlFetch, curlPython, curlLocate, curlRun];

  var curlFetchMain = function main(ctx) { curlRun('js'); };
  var curlPyMain = function main(ctx) { curlRun('python'); };

  /* ================================================================
     5. Number bases (BigInt, so 64-bit+ values are exact)
     ================================================================ */

  function nbParse(sign, body) {
    var b = body.replace(/_/g, ''), p = b.slice(0, 2).toLowerCase(), v, base;
    if (p === '0x') { v = BigInt('0x' + b.slice(2)); base = 16; }
    else if (p === '0b' && /^0b[01]+$/i.test(b)) { v = BigInt('0b' + b.slice(2)); base = 2; }
    else if (p === '0o') { v = BigInt('0o' + b.slice(2)); base = 8; }
    else if (/^\d+$/.test(b)) { v = BigInt(b); base = 10; }
    else { v = BigInt('0x' + b); base = 16; }       // lone bare hex such as ff / 0b1f
    return { v: sign ? -v : v, base: base };
  }

  // The whole (trimmed) selection as one number; bare hex like "ff" only here.
  function nbSingle(s) {
    var m = /^(-?)(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*|[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*)$/.exec(s);
    return m ? nbParse(m[1], m[2]) : null;
  }

  // Number tokens inside text: decimal integers, 0x…, 0b…, 0o… (floats,
  // versions, dates, times, ranges and $amounts are skipped).
  function nbScan(text) {
    var re = /(?<![\w.$#\-:/])(-?)(0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|\d(?:_?\d)*)(?!\w|[.:/-]\w)/g, m, out = [];
    while ((m = re.exec(text))) {
      var p = nbParse(m[1], m[2]);
      out.push({ from: m.index, to: m.index + m[0].length, str: m[0], v: p.v, base: p.base });
    }
    return out;
  }

  function nbFmt(v, base, group) {
    var neg = v < 0n, a = neg ? -v : v, s = a.toString(base);
    if (base === 16) s = s.toUpperCase();
    if (group && base === 2 && s.length > 8) { while (s.length % 4) s = '0' + s; s = s.replace(/(\d{4})(?=\d)/g, '$1_'); }
    return (neg ? '-' : '') + ({ 16: '0x', 2: '0b', 8: '0o', 10: '' }[base]) + s;
  }

  // Two's-complement view of a negative value in the smallest fitting width.
  function nbTwos(v) {
    if (v >= 0n) return '';
    for (var w = 8; w <= 1024; w *= 2) {
      if (v >= -(1n << BigInt(w - 1))) {
        var u = (1n << BigInt(w)) + v, h = u.toString(16).toUpperCase();
        while (h.length < w / 4) h = '0' + h;
        return ' (two\'s complement i' + w + ': 0x' + h + ')';
      }
    }
    return '';
  }

  function nbConvert(base) {
    var t = dpTarget();
    if (!t) return;
    var text = t.text, trimmed = text.trim(), lead = text.length - text.replace(/^\s+/, '').length, changes = [];
    var one = nbSingle(trimmed);
    if (one) changes.push({ from: t.from + lead, to: t.from + lead + trimmed.length, insert: nbFmt(one.v, base), str: trimmed });
    else nbScan(text).forEach(function (tok) { changes.push({ from: t.from + tok.from, to: t.from + tok.to, insert: nbFmt(tok.v, base), str: tok.str }); });
    changes = changes.filter(function (c) { return c.insert !== c.str; });
    if (!changes.length) { showToast('No numbers to convert', 'info', 2500); return; }
    dpApply(changes, dpSplice(text, t.from, changes));
  }

  var NB = [nbParse, nbSingle, nbScan, nbFmt, nbTwos, nbConvert];

  var nbAllMain = function main(ctx) {
    var t = dpTarget();
    if (!t) return;
    var text = t.text, trimmed = text.trim(), lead = text.length - text.replace(/^\s+/, '').length, changes = [];
    var one = nbSingle(trimmed);
    if (one) {
      var all = [10, 16, 2, 8].map(function (b) { return nbFmt(one.v, b, true); }).join(' = ') + nbTwos(one.v);
      changes.push({ from: t.from + lead, to: t.from + lead + trimmed.length, insert: all });
    } else {
      // Blank out earlier "(= …)" annotations so a re-run doesn't annotate them.
      var masked = text.replace(/ \(= [^)\n]*\)/g, function (s) { return Array(s.length + 1).join(' '); });
      var seen = 0;
      nbScan(masked).forEach(function (tok) {
        seen++;
        if (/^ \(= /.test(text.slice(tok.to))) return;               // already annotated
        var other = [10, 16, 2, 8].filter(function (b) { return b !== tok.base; }).map(function (b) { return nbFmt(tok.v, b, true); });
        changes.push({ from: t.from + tok.to, to: t.from + tok.to, insert: ' (= ' + other.join(' = ') + ')' });
      });
    }
    if (!changes.length) {
      showToast(seen ? 'Already annotated' : 'No numbers found (decimal, 0x…, 0b…, 0o…)', seen ? 'info' : 'error', 2500);
      return;
    }
    dpApply(changes, dpSplice(text, t.from, changes));
  };

  var nbHexMain = function main(ctx) { nbConvert(16); };
  var nbBinMain = function main(ctx) { nbConvert(2); };
  var nbDecMain = function main(ctx) { nbConvert(10); };

  /* ================================================================
     6. Lines -> array literal / SQL IN list
     ================================================================ */

  // Line-list tools read the selection, else the paragraph (the run of
  // non-blank lines) around the cursor, else the whole document.
  function dpBlock() {
    var t = dpTarget();
    if (!t || t.kind !== 'line') return t;
    var st = window.Cade.editor.state, doc = st.doc, ln = doc.lineAt(t.head), a = ln.number, b = ln.number;
    if (!ln.text.trim()) return t;
    while (a > 1 && doc.line(a - 1).text.trim()) a--;
    while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
    var from = doc.line(a).from, to = doc.line(b).to;
    return { kind: a === b ? 'line' : 'para', from: from, to: to, text: st.sliceDoc(from, to), head: t.head };
  }

  // One item per non-blank line (trimmed). A single line is split on tabs or
  // commas instead. Lines that all end in "," (pasted from a list) lose it, and
  // items that are ALL wrapped in the same quotes are unwrapped.
  function lsItems(text) {
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length === 1 && /[\t,]/.test(lines[0])) {
      lines = lines[0].split(lines[0].indexOf('\t') >= 0 ? '\t' : ',').map(function (l) { return l.trim(); }).filter(Boolean);
    } else if (lines.length > 1 && lines.slice(0, -1).every(function (l) { return /,$/.test(l); })) {
      lines = lines.map(function (l) { return l.replace(/,$/, '').trim(); }).filter(Boolean);
    }
    var q = lines.length && /^['"`]/.test(lines[0]) ? lines[0][0] : null;
    if (q && lines.every(function (l) { return l.length >= 2 && l[0] === q && l[l.length - 1] === q; })) {
      lines = lines.map(function (l) {
        var s = l.slice(1, -1).replace(/\\(.)/g, '$1');
        return q === "'" ? s.replace(/''/g, "'") : s;
      });
    }
    return lines;
  }

  // JSON-number grammar (no leading zeros, so ZIP codes / IDs like 007 stay strings).
  function lsIsNum(s) { return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s); }

  // How the items can be written unquoted in `lang`: 'int' | 'float' | null.
  function lsNumKind(items, lang) {
    if (!items.length || !items.every(lsIsNum)) return null;
    var ints = items.every(function (s) { return /^-?\d+$/.test(s); });
    if (ints && lang !== 'py' && lang !== 'sql') {
      // JS / JSON would silently round 20-digit IDs; Go's int is 64-bit.
      var max = lang === 'go' ? 9223372036854775807n : 9007199254740991n;
      if (items.some(function (s) { var v = BigInt(s); return v > max || v < -max - (lang === 'go' ? 1n : 0n); })) return null;
    }
    return ints ? 'int' : 'float';
  }

  function lsQuote(s, lang) {
    if (lang === 'json') return JSON.stringify(s);
    var q = lang === 'go' ? '"' : "'";
    return q + s.replace(/[\\'"\x00-\x1f\x7f\u2028\u2029]/g, function (c) {
      if (c === '\\') return '\\\\';
      if (c === "'" || c === '"') return c === q ? '\\' + c : c;
      var E = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }, code = c.charCodeAt(0);
      if (E[c]) return E[c];
      if (code > 0xff) return '\\u' + code.toString(16);
      return '\\x' + (code < 16 ? '0' : '') + code.toString(16);
    }) + q;
  }

  // ['a', 'b'] / ["a", "b"] / []string{"a", "b"} — one item per line (with
  // the trailing comma the language allows or requires) past 80 characters.
  function lsArray(items, lang) {
    var num = lsNumKind(items, lang);
    var vals = items.map(function (s) { return num ? s : lsQuote(s, lang); });
    var open = '[', close = ']', ind = '  ', trail = lang === 'json' ? '' : ',';
    if (lang === 'go') { open = '[]' + (num === 'int' ? 'int' : num ? 'float64' : 'string') + '{'; close = '}'; ind = '\t'; }
    var one = open + vals.join(', ') + close;
    if (one.length <= 80) return one;
    return open + '\n' + vals.map(function (v) { return ind + v; }).join(',\n') + trail + '\n' + close;
  }

  // IN ('a', 'b') — '' escaping, numbers bare only when every item is one,
  // duplicates dropped (first kept).
  function lsSqlIn(items) {
    var num = lsNumKind(items, 'sql'), seen = {}, vals = [], dups = 0;
    items.forEach(function (s) {
      var key = num ? (/^-?\d+$/.test(s) ? String(BigInt(s)) : String(Number(s))) : s;
      if (seen['$' + key]) { dups++; return; }
      seen['$' + key] = 1;
      vals.push(num ? s : "'" + s.replace(/'/g, "''") + "'");
    });
    var one = 'IN (' + vals.join(', ') + ')';
    return { text: one.length <= 80 ? one : 'IN (\n  ' + vals.join(',\n  ') + '\n)', count: vals.length, dups: dups };
  }

  function lsLang(ans) {
    var a = String(ans).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    var A = { '1': 'js', js: 'js', javascript: 'js', ts: 'js', typescript: 'js', node: 'js', '2': 'json', json: 'json',
      '3': 'py', py: 'py', python: 'py', python3: 'py', '4': 'go', go: 'go', golang: 'go' };
    return A[a] || null;
  }

  var lsArrayMain = function main(ctx) {
    var t = dpBlock();
    if (!t) return;
    var items = lsItems(t.text);
    if (!items.length) { showToast('No lines to convert — select some lines (blank lines are skipped)', 'error', 3000); return; }
    var last = dpStoreGet('cade-devpack-array-lang') || 'js', keys = ['js', 'json', 'py', 'go'], def = keys.indexOf(last) + 1 || 1;
    var labels = { js: 'JavaScript', json: 'JSON', py: 'Python', go: 'Go' }, sample = items.slice(0, 2);
    var lines = keys.map(function (k, i) {
      var p = lsArray(sample, k).replace(/\s*\n\s*/g, ' ');
      if (items.length > 2) p = p.replace(/,?\s*([\]}])$/, ', …$1');
      if (p.length > 48) p = p.slice(0, 47) + '…';
      var label = labels[k];
      while (label.length < 12) label += ' ';
      return ' ' + (i + 1) + '  ' + label + p;
    });
    var ans = window.prompt('Array literal of ' + items.length + ' item' + (items.length === 1 ? '' : 's') + ' — which language? (number or js / json / py / go)\n' + lines.join('\n'), String(def));
    if (ans == null) return;
    var lang = lsLang(ans);
    if (!lang) { showToast('Unknown language: ' + ans + ' — use js, json, py or go', 'error', 3000); return; }
    dpStoreSet('cade-devpack-array-lang', lang);
    var out = lsArray(items, lang);
    dpApply([{ from: t.from, to: t.to, insert: out }], out);
  };

  var lsSqlMain = function main(ctx) {
    var t = dpBlock();
    if (!t) return;
    var items = lsItems(t.text);
    if (!items.length) { showToast('No lines to convert — select some lines (blank lines are skipped)', 'error', 3000); return; }
    var r = lsSqlIn(items);
    dpApply([{ from: t.from, to: t.to, insert: r.text }], r.text);
    if (r.dups) showToast(r.count + ' value' + (r.count === 1 ? '' : 's') + ' · ' + r.dups + ' duplicate' + (r.dups === 1 ? '' : 's') + ' removed', 'info', 3000);
  };

  /* ================================================================
     7. fetch -> cURL
     A small reader for the JS expressions that appear in fetch() calls
     (strings, templates, objects, arrays, + concatenation, calls such as
     JSON.stringify / new Headers / new URLSearchParams / new FormData);
     anything else is kept as raw source and reported.
     ================================================================ */

  // Read one expression of `src` starting at `start` -> { node, end }.
  // Nodes: str num bool null undef tpl cat obj arr id call new raw (each with .src).
  function fcRead(src, start) {
    var i = start, n = src.length;
    function ws() {
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (src[i] === '/' && src[i + 1] === '*') { var e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
        return;
      }
    }
    function esc() {                       // at a backslash
      var d = src[i + 1], E = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }, h;
      i += 2;
      if (d === 'x') { h = parseInt(src.substr(i, 2), 16); i += 2; return isNaN(h) ? '' : String.fromCharCode(h); }
      if (d === 'u') {
        if (src[i] === '{') { var e2 = src.indexOf('}', i); h = parseInt(src.slice(i + 1, e2), 16); i = e2 + 1; return isNaN(h) ? '' : String.fromCodePoint(h); }
        h = parseInt(src.substr(i, 4), 16); i += 4; return isNaN(h) ? '' : String.fromCharCode(h);
      }
      if (d === '\n') return '';
      if (d === '\r') { if (src[i] === '\n') i++; return ''; }
      return E[d] != null ? E[d] : (d || '');
    }
    function str(q) {
      var out = '';
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += esc(); continue; }
        if (src[i] === '\n') break;          // unterminated
        out += src[i++];
      }
      i++;
      return out;
    }
    function tpl() {
      var parts = [], cur = '';
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { cur += esc(); continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          parts.push(cur); cur = ''; i += 2;
          parts.push(expr()); ws();
          if (src[i] === '}') i++;
          continue;
        }
        cur += src[i++];
      }
      i++;
      parts.push(cur);
      return { t: 'tpl', parts: parts };
    }
    function skip() {                      // balanced, up to a top-level , ; ) ] }
      var depth = 0;
      while (i < n) {
        var c = src[i];
        if (c === '"' || c === "'") { str(c); continue; }
        if (c === '`') { tpl(); continue; }
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { ws(); continue; }
        if ('([{'.indexOf(c) >= 0) depth++;
        else if (')]}'.indexOf(c) >= 0) { if (!depth) return; depth--; }
        else if ((c === ',' || c === ';') && !depth) return;
        i++;
      }
    }
    function path() {
      var m = /^[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*/.exec(src.slice(i, i + 300));
      if (!m) return '';
      i += m[0].length;
      return m[0].replace(/\s+/g, '');
    }
    function list(close) {                 // at the opener
      var out = [], guard;
      i++;
      for (;;) {
        ws();
        if (i >= n) break;
        if (src[i] === close) { i++; break; }
        guard = i;
        if (src.substr(i, 3) === '...') { i += 3; out.push({ t: 'spread', node: expr() }); }
        else out.push(expr());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === close) { i++; break; }
        if (i === guard) { skip(); if (i === guard) i++; }
      }
      return out;
    }
    function obj() {
      var props = [];
      i++;
      for (;;) {
        ws();
        if (i >= n) break;
        if (src[i] === '}') { i++; break; }
        var guard = i, key = null, m, s0 = i;
        if (src.substr(i, 3) === '...') { i += 3; props.push({ spread: expr() }); }
        else {
          if (src[i] === '"' || src[i] === "'") key = str(src[i]);
          else if (src[i] === '[') { var k = list(']'); key = { computed: k[0] || null, src: src.slice(s0, i) }; }
          else if ((m = /^(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/.exec(src.slice(i, i + 200)))) { key = m[0]; i += m[0].length; }
          ws();
          if (src[i] === ':') { i++; props.push({ key: key, value: expr() }); }
          else if (src[i] === '(') { skip(); props.push({ key: key, value: { t: 'raw', src: 'function' } }); }
          else if (typeof key === 'string') props.push({ key: key, value: { t: 'id', name: key, src: key } });
        }
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; break; }
        if (i === guard) { skip(); if (i === guard) i++; }
      }
      return { t: 'obj', props: props };
    }
    function unary() {
      ws();
      var c = src[i], m, s0 = i, node;
      if (c === '"' || c === "'") node = { t: 'str', v: str(c) };
      else if (c === '`') node = tpl();
      else if (c === '{') node = obj();
      else if (c === '[') node = { t: 'arr', items: list(']') };
      else if (c === '(') { i++; node = expr(); ws(); if (src[i] === ')') i++; return node; }
      else if ((m = /^-?\s*(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)(?![\w$])/.exec(src.slice(i, i + 80)))) {
        i += m[0].length;
        var raw = m[0].replace(/[\s_]/g, ''), neg = raw[0] === '-';
        node = { t: 'num', v: (neg ? -1 : 1) * Number(neg ? raw.slice(1) : raw) };
      } else if (/[A-Za-z_$]/.test(c || '')) {
        var w = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 100))[0];
        if (w === 'await' || w === 'void' || w === 'typeof') { i += w.length; return unary(); }
        if (w === 'true' || w === 'false') { i += w.length; node = { t: 'bool', v: w === 'true' }; }
        else if (w === 'null') { i += 4; node = { t: 'null' }; }
        else if (w === 'undefined') { i += 9; node = { t: 'undef' }; }
        else if (w === 'new') {
          i += 3; ws();
          var callee = path();
          ws();
          node = { t: 'new', callee: callee, args: src[i] === '(' ? list(')') : [] };
        } else {
          var p = path();
          ws();
          node = src[i] === '(' ? { t: 'call', callee: p, args: list(')') } : { t: 'id', name: p };
        }
      } else { skip(); node = { t: 'raw' }; }
      node.src = src.slice(s0, i).trim();
      return node;
    }
    function expr() {
      ws();
      var s0 = i, parts = [unary()];
      for (;;) {
        ws();
        if (src[i] === '+' && src[i + 1] !== '+' && src[i + 1] !== '=') { i++; parts.push(unary()); continue; }
        break;
      }
      ws();
      if (i < n && ',;)]}'.indexOf(src[i]) < 0) { skip(); return { t: 'raw', src: src.slice(s0, i).trim() }; }
      if (parts.length === 1) return parts[0];
      return { t: 'cat', parts: parts, src: src.slice(s0, i).trim() };
    }
    var node = expr();
    return { node: node, end: i };
  }

  // Every fetch( call in `text`: { from, to, args } (offsets into text).
  function fcFind(text) {
    var re = /(?<![\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?fetch\s*\(/g, m, out = [];
    while ((m = re.exec(text))) {
      var j = m.index + m[0].length, args = [];
      for (var k = 0; k < 8; k++) {
        var a = fcRead(text, j);
        if (a.node.t === 'raw' && !a.node.src) break;
        args.push(a.node);
        j = a.end;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === ',') { j++; continue; }
        break;
      }
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === ')') j++;
      if (args.length) out.push({ from: m.index, to: j, args: args });
      re.lastIndex = Math.max(re.lastIndex, j);
    }
    return out;
  }

  // Last "const|let|var name = …" before `before` in env.src -> node.
  function fcResolve(name, env) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    var re = new RegExp('(?<![\\w$.])(?:const|let|var)\\s+' + name.replace(/\$/g, '\\$') + '\\s*=(?!=)', 'g'), m, at = -1;
    while ((m = re.exec(env.src)) && m.index < env.before) at = m.index + m[0].length;
    if (at < 0) return null;
    return fcRead(env.src, at).node;
  }

  // name.append(…) / name.set(…) calls between its declaration and the fetch.
  function fcAppends(name, env) {
    var out = [], re = new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '\\s*\\.\\s*(append|set)\\s*(?=\\()', 'g'), m;
    while ((m = re.exec(env.src)) && m.index < env.before) {
      var j = m.index + m[0].length, args = [];
      j++;
      for (var k = 0; k < 3; k++) {
        var a = fcRead(env.src, j);
        args.push(a.node); j = a.end;
        while (j < env.src.length && /\s/.test(env.src[j])) j++;
        if (env.src[j] === ',') { j++; continue; }
        break;
      }
      if (m[1] === 'set') out = out.filter(function (o) { return !(o[0].t === 'str' && args[0].t === 'str' && o[0].v === args[0].v); });
      out.push(args);
    }
    return out;
  }

  // Unknown value: a plain identifier (or process.env.X) becomes a shell
  // variable marker \uE000NAME\uE001 (-> "$NAME"); anything else stays as
  // ${expr} text and is listed in the notes.
  function fcMark(src, env) {
    var m = /^(?:(?:process\.env|import\.meta\.env)\.)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(src || '');
    if (m) { if (env.vars.indexOf(m[1]) < 0) env.vars.push(m[1]); return '\uE000' + m[1] + '\uE001'; }
    if (env.todo.indexOf(src) < 0) env.todo.push(src);
    return '${' + src + '}';
  }

  // Follow identifiers to their declarations — but stop at the identifier
  // when its value is something we can't read (a call such as getToken()),
  // so it becomes a shell variable named after it.
  function fcDeref(node, env) {
    var seen = 0;
    while (node && node.t === 'id' && seen++ < 6) {
      env.hops = (env.hops || 0) + 1;
      if (env.hops > 300) return node;          // self-referencing declarations
      var r = fcResolve(node.name, env);
      if (!r || r.t === 'raw' || (r.t === 'call' && !/^(?:JSON\.stringify|String|encodeURIComponent|encodeURI|btoa|Object\.fromEntries|AbortSignal\.timeout)$/.test(r.callee)) ||
        (r.t === 'new' && !/^(?:Headers|URLSearchParams|FormData|URL|Request|Blob|File|ArrayBuffer|Uint8Array)$/.test(r.callee))) return node;
      node = r;
    }
    return node;
  }

  // Node -> string (as JS would coerce it), markers for unknowns.
  function fcStr(node, env) {
    node = fcDeref(node, env);
    if (!node) return '';
    switch (node.t) {
      case 'str': return node.v;
      case 'num': return String(node.v);
      case 'bool': return String(node.v);
      case 'null': return 'null';
      case 'undef': return 'undefined';
      case 'tpl': return node.parts.map(function (p) { return typeof p === 'string' ? p : fcStr(p, env); }).join('');
      case 'cat': return node.parts.map(function (p) { return fcStr(p, env); }).join('');
      case 'id': return fcMark(node.name, env);
      case 'call':
        if (node.callee === 'JSON.stringify' && node.args[0]) {
          var ind = node.args[2], pad = '';
          if (ind && ind.t === 'num') pad = Array(Math.min(10, Math.max(0, ind.v)) + 1).join(' ');
          else if (ind && ind.t === 'str') pad = ind.v.slice(0, 10);
          return fcJson(node.args[0], env, pad, 0);
        }
        if (node.callee === 'String' && node.args[0]) return fcStr(node.args[0], env);
        if ((node.callee === 'encodeURIComponent' || node.callee === 'encodeURI' || node.callee === 'btoa') && node.args[0]) {
          var s = fcStr(node.args[0], env);
          if (/\uE000|\$\{/.test(s)) return fcMark(node.src, env);
          try { return node.callee === 'btoa' ? window.btoa(s) : window[node.callee](s); } catch (e) { return fcMark(node.src, env); }
        }
        if (/\.toString$/.test(node.callee)) return fcStr({ t: 'id', name: node.callee.replace(/\.toString$/, ''), src: node.callee.replace(/\.toString$/, '') }, env);
        return fcMark(node.src, env);
      case 'new':
        if (node.callee === 'URL' && node.args[0]) {
          var u = fcStr(node.args[0], env);
          if (node.args[1]) { var b = fcStr(node.args[1], env); try { return new window.URL(u, b).href; } catch (e) { return b.replace(/\/?$/, '/') + u.replace(/^\//, ''); } }
          return u;
        }
        if (node.callee === 'URLSearchParams') return fcForm(node, env);
        return fcMark(node.src, env);
    }
    return fcMark(node.src, env);
  }

  // Node -> JSON text the way JSON.stringify(value, null, pad) would print it.
  function fcJson(node, env, pad, lvl) {
    node = fcDeref(node, env);
    var nl = pad ? '\n' + Array(lvl + 2).join(pad) : '', end = pad ? '\n' + Array(lvl + 1).join(pad) : '', colon = pad ? ': ' : ':';
    if (!node) return 'null';
    switch (node.t) {
      case 'str': case 'tpl': case 'cat': return JSON.stringify(fcStr(node, env));
      case 'num': return isFinite(node.v) ? String(node.v) : 'null';
      case 'bool': return String(node.v);
      case 'null': return 'null';
      case 'undef': return 'null';
      case 'arr':
        if (!node.items.length) return '[]';
        return '[' + nl + node.items.map(function (it) {
          if (it.t === 'spread') { env.notes.push('spread …' + (it.node.src || '') + ' in the body array was left out'); return null; }
          var d = fcDeref(it, env);
          return d && (d.t === 'undef' || (d.t === 'raw' && /=>|^function\b/.test(d.src || ''))) ? 'null' : fcJson(it, env, pad, lvl + 1);
        }).filter(function (x) { return x != null; }).join(',' + nl) + end + ']';
      case 'obj':
        var out = [];
        node.props.forEach(function (p) {
          if (p.spread) { env.notes.push('spread …' + (p.spread.src || '') + ' in the body was left out'); return; }
          var v = fcDeref(p.value, env);
          if (v && (v.t === 'undef' || (v.t === 'raw' && (v.src === 'function' || /=>|^function\b/.test(v.src || ''))))) return;   // JSON.stringify drops these
          var k = typeof p.key === 'string' ? p.key : p.key && p.key.computed ? fcStr(p.key.computed, env) : '';
          out.push(JSON.stringify(k) + colon + fcJson(p.value, env, pad, lvl + 1));
        });
        return out.length ? '{' + nl + out.join(',' + nl) + end + '}' : '{}';
      case 'call':
        if (node.callee === 'JSON.stringify' || node.callee === 'String') return JSON.stringify(fcStr(node, env));
        break;
      case 'new':
        if (node.callee === 'Date') return JSON.stringify(fcMark(node.src, env));
        break;
    }
    // Unknown value: assumed to be a string.
    return JSON.stringify(fcMark(node.t === 'id' ? node.name : node.src, env));
  }

  // [[name, valueNode]] from an object / [[k, v]] array / Headers / URLSearchParams / FormData node.
  function fcPairs(node, env, allowAppends) {
    var name = node && node.t === 'id' ? node.name : null;
    node = fcDeref(node, env);
    var out = [];
    if (!node) return out;
    if (node.t === 'obj') {
      node.props.forEach(function (p) {
        if (p.spread) { env.notes.push('spread …' + (p.spread.src || '') + ' was left out'); return; }
        var k = typeof p.key === 'string' ? p.key : p.key && p.key.computed ? fcStr(p.key.computed, env) : '';
        var v = fcDeref(p.value, env);
        if (v && v.t === 'undef') return;
        out.push([k, p.value]);
      });
    } else if (node.t === 'arr') {
      node.items.forEach(function (it) {
        it = fcDeref(it, env);
        if (it && it.t === 'arr' && it.items.length >= 2) out.push([fcStr(it.items[0], env), it.items[1]]);
      });
    } else if (node.t === 'new' && /^(?:Headers|URLSearchParams|FormData)$/.test(node.callee)) {
      if (node.args[0]) {
        var a0 = fcDeref(node.args[0], env);
        if (node.callee === 'URLSearchParams' && a0 && (a0.t === 'str' || a0.t === 'tpl' || a0.t === 'cat')) {
          fcStr(a0, env).replace(/^\?/, '').split('&').forEach(function (kv) {
            if (!kv) return;
            var eq = kv.indexOf('='), dec = function (s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } };
            out.push([dec(eq < 0 ? kv : kv.slice(0, eq)), { t: 'str', v: eq < 0 ? '' : dec(kv.slice(eq + 1)) }]);
          });
        } else if (node.callee === 'FormData') {
          env.notes.push('new FormData(' + (node.args[0].src || '') + '): the fields of that <form> are not known here');
        } else out = fcPairs(node.args[0], env, false);
      }
    } else if (node.t === 'call' && /^Object\.fromEntries$/.test(node.callee) && node.args[0]) {
      out = fcPairs(node.args[0], env, false);
    } else if (node.t !== 'undef' && node.t !== 'null') {
      env.notes.push('could not read ' + (node.src || 'a value') + ' — fill it in by hand');
    }
    if (name && allowAppends !== false) {
      fcAppends(name, env).forEach(function (a) {
        if (a[0]) out.push([fcStr(a[0], env), a[1] || { t: 'str', v: '' }, a[2]]);
      });
    }
    return out;
  }

  // application/x-www-form-urlencoded, like URLSearchParams#toString (markers kept).
  function fcFormEnc(s) {
    return s.split(/(\uE000[A-Za-z0-9_]+\uE001)/).map(function (part, k) {
      if (k % 2) return part;
      return encodeURIComponent(part).replace(/[!'()~]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }).replace(/%20/g, '+');
    }).join('');
  }

  function fcForm(node, env) {
    return fcPairs(node, env).map(function (p) { return fcFormEnc(p[0]) + '=' + fcFormEnc(fcStr(p[1], env)); }).join('&');
  }

  // Shell word for a string that may hold \uE000NAME\uE001 markers ("$NAME").
  function fcShell(s) {
    var parts = String(s).split(/\uE000([A-Za-z0-9_]+)\uE001/), out = '';
    parts.forEach(function (p, k) {
      if (k % 2) { out += '"$' + p + '"'; return; }
      if (!p) return;
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(p)) {
        var E = { '\t': '\\t', '\n': '\\n', '\r': '\\r', '\x1b': '\\e' };
        out += "$'" + p.replace(/[\\']/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, function (c) {
          return E[c] || '\\x' + (c.charCodeAt(0) < 16 ? '0' : '') + c.charCodeAt(0).toString(16);
        }) + "'";
      } else out += "'" + p.replace(/'/g, "'\\''") + "'";
    });
    return out || "''";
  }

  // One fetch call -> { cmd, notes }.
  function fcCurl(call, env) {
    env.vars = []; env.todo = []; env.notes = [];
    var args = call.args, a0 = fcDeref(args[0], env);
    if (a0 && a0.t === 'new' && a0.callee === 'Request') args = a0.args.concat(args.slice(1));
    var url = fcStr(args[0], env), opts = args[1] ? fcDeref(args[1], env) : null, o = {};
    if (opts && opts.t === 'obj') {
      opts.props.forEach(function (p) {
        if (p.spread) { var s = fcDeref(p.spread, env); if (s && s.t === 'obj') s.props.forEach(function (q) { if (typeof q.key === 'string') o[q.key] = q.value; }); else env.notes.push('options spread …' + (p.spread.src || '') + ' was left out'); return; }
        if (typeof p.key === 'string') o[p.key] = p.value;
      });
    } else if (opts && opts.t !== 'undef') env.notes.push('could not read the fetch options (' + (opts.src || '') + ')');
    var L = ['curl ' + fcShell(url)], hdrs = fcPairs(o.headers, env), body = o.body ? fcDeref(o.body, env) : null;
    var method = o.method ? fcStr(o.method, env) : 'GET';
    if (/^(?:delete|get|head|options|post|put)$/i.test(method)) method = method.toUpperCase();    // fetch normalises only these
    var bodyArgs = [];
    if (body && body.t !== 'undef' && body.t !== 'null') {
      if (body.t === 'new' && body.callee === 'FormData') {
        var parts = fcPairs(o.body, env);
        if (!parts.length && !body.args.length) env.notes.push('the FormData is empty here — add -F name=value fields');
        parts.forEach(function (p) {
          var v = fcDeref(p[1], env);
          if (v && (v.t === 'str' || v.t === 'tpl' || v.t === 'cat' || v.t === 'num' || v.t === 'bool')) bodyArgs.push('--form-string ' + fcShell(p[0] + '=' + fcStr(v, env)));
          else {
            var fname = p[2] ? fcStr(p[2], env) : null;
            if (!fname && v && v.t === 'new' && v.callee === 'File' && v.args[1]) fname = fcStr(v.args[1], env);
            bodyArgs.push('-F ' + fcShell(p[0] + '=@' + (fname || 'path/to/file')));
            env.notes.push('field "' + p[0] + '" is a file (' + ((p[1] && p[1].src) || 'blob') + ') — point -F at it on disk');
          }
        });
      } else if (body.t === 'new' && body.callee === 'URLSearchParams') {
        bodyArgs.push('--data-raw ' + fcShell(fcForm(o.body, env)));
      } else if (body.t === 'str' || body.t === 'tpl' || body.t === 'cat' || body.t === 'num' ||
        (body.t === 'call' && /^(?:JSON\.stringify|String|encodeURIComponent|btoa)$/.test(body.callee))) {
        bodyArgs.push('--data-raw ' + fcShell(fcStr(o.body, env)));
        if (!hdrs.some(function (h) { return /^content-type$/i.test(h[0]); })) {
          // A string body makes fetch send text/plain; curl would say form-urlencoded.
          hdrs.push(['Content-Type', { t: 'str', v: 'text/plain;charset=UTF-8' }]);
          if (body.t === 'call' && body.callee === 'JSON.stringify') env.notes.push('no Content-Type was set, so fetch sends this JSON as text/plain — add -H \'Content-Type: application/json\' if the API expects JSON');
        }
      } else if (body.t === 'new' && /^(?:Blob|File|ArrayBuffer|Uint8Array)$/.test(body.callee)) {
        bodyArgs.push('--data-binary @path/to/file');
        env.notes.push('the body is a ' + body.callee + ' — --data-binary @file sends a file\'s bytes');
      } else {
        bodyArgs.push('--data-raw ' + fcShell(fcMark(body.t === 'id' ? body.name : body.src, env)));
      }
    }
    hdrs.forEach(function (h) {
      L.push('-H ' + fcShell(h[0] + ': ' + fcStr(h[1], env)));
    });
    if (method === 'HEAD') L.splice(1, 0, '--head');
    else if (!(method === 'GET' && !bodyArgs.length) && !(method === 'POST' && bodyArgs.length)) L.splice(1, 0, '-X ' + (/^[A-Za-z]+$/.test(method) ? method : fcShell(method)));
    L = L.concat(bodyArgs);
    var cred = o.credentials ? fcStr(o.credentials, env) : '';
    if (cred === 'include') env.notes.push("credentials: 'include' — add the browser's cookies with -b 'name=value'");
    var redirect = o.redirect ? fcStr(o.redirect, env) : '';
    if (redirect === 'follow') L.push('-L');
    var sig = o.signal ? fcDeref(o.signal, env) : null;
    if (sig && sig.t === 'call' && sig.callee === 'AbortSignal.timeout' && sig.args[0] && fcDeref(sig.args[0], env).t === 'num') {
      L.push('--max-time ' + String(Math.round(fcDeref(sig.args[0], env).v) / 1000));
    }
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(?:\uE000|\$\{)/.test(url)) env.notes.push('relative URL — prefix it with the site\'s origin');
    var notes = env.notes.slice();
    if (env.vars.length) notes.unshift('set these shell variables first (from the JS code): ' + env.vars.map(function (v) { return '$' + v; }).join(', '));
    if (env.todo.length) notes.unshift('fill in by hand: ' + env.todo.map(function (v) { return '${' + v + '}'; }).join(', '));
    return { cmd: L.join(' \\\n  '), notes: notes.filter(function (v, k, a) { return a.indexOf(v) === k; }) };
  }

  var fcMain = function main(ctx) {
    var ed = window.Cade.editor, st = ed.state, doc = st.doc, text = doc.toString(), sel = st.selection.main;
    var calls = fcFind(text);
    if (sel.from !== sel.to) calls = calls.filter(function (c) { return c.from < sel.to && c.to > sel.from; });
    else if (calls.length) {
      var best = null, bd = Infinity;
      calls.forEach(function (c) {
        var d = sel.head < c.from ? c.from - sel.head : sel.head > c.to ? sel.head - c.to : 0;
        if (d < bd) { bd = d; best = c; }
      });
      calls = [best];
    }
    if (!calls.length) { showToast('No fetch(…) call found — select one or put the cursor on it', 'error', 3000); return; }
    var blocks = [];
    calls.forEach(function (c) {
      var r = fcCurl(c, { src: text, before: c.from });
      blocks.push(r.notes.map(function (n) { return '# ' + n; }).concat([r.cmd]).join('\n'));
    });
    var out = '```bash\n' + blocks.join('\n\n') + '\n```';
    // Below the call (or selection) — after the ``` fence that holds it, if any.
    var endPos = sel.from !== sel.to ? Math.max(sel.to, calls[calls.length - 1].to) : calls[calls.length - 1].to;
    if (sel.from !== sel.to && endPos > sel.from && endPos === doc.lineAt(endPos).from && endPos === sel.to) endPos--;
    var line = doc.lineAt(Math.min(endPos, doc.length)), open = false, k;
    for (k = 1; k < line.number; k++) if (/^\s*(?:```|~~~)/.test(doc.line(k).text)) open = !open;
    if (open && !/^\s*(?:```|~~~)/.test(line.text)) {
      for (k = line.number + 1; k <= doc.lines; k++) if (/^\s*(?:```|~~~)\s*$/.test(doc.line(k).text)) { line = doc.line(k); break; }
    }
    var after = st.sliceDoc(line.to, Math.min(doc.length, line.to + 4000));
    if (/^\n+```(?:bash|sh|shell)?\n(?:#[^\n]*\n)*curl /.test(after + '\n') || /^\n+(?:#[^\n]*\n)*curl /.test(after)) {
      showToast('Already converted — the curl command is right below', 'info', 2500);
      return;
    }
    dpApply([{ from: line.to, to: line.to, insert: '\n\n' + out }], out);
  };

  /* ================================================================
     8. Colours: convert between hex / rgb / hsl / oklch / CSS names,
        and build an OKLCH shade ramp
     ================================================================ */

  function colNames() {
    var s = 'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 ' +
      'blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 ' +
      'chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b ' +
      'darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f ' +
      'darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f ' +
      'darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 ' +
      'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff ' +
      'gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 ' +
      'indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 ' +
      'lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 ' +
      'lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa ' +
      'lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 ' +
      'magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db ' +
      'mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 ' +
      'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 ' +
      'olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 ' +
      'paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd ' +
      'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 ' +
      'salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd ' +
      'slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 ' +
      'tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32';
    var byName = {}, byHex = {};
    s.split(' ').forEach(function (p) {
      var kv = p.split(':');
      byName[kv[0]] = kv[1];
      if (!byHex[kv[1]]) byHex[kv[1]] = kv[0];       // aqua before cyan, gray before grey…
    });
    return { byName: byName, byHex: byHex };
  }

  function colLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function colGam(c) { var v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return v * 255; }

  // sRGB 0..255 -> OKLCH { l 0..1, c, h deg } (Björn Ottosson's OKLab).
  function colToOklch(rgb) {
    var r = colLin(rgb.r), g = colLin(rgb.g), b = colLin(rgb.b);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    var L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    var C = Math.sqrt(A * A + B * B), H = Math.atan2(B, A) * 180 / Math.PI;
    if (H < 0) H += 360;
    return { l: L, c: C, h: C < 1e-4 ? 0 : H };
  }

  // OKLCH -> unclamped sRGB 0..255.
  function colFromOklch(L, C, H) {
    var a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180);
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    var s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return {
      r: colGam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: colGam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: colGam(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    };
  }

  function colInGamut(c) { return [c.r, c.g, c.b].every(function (v) { return v > -0.5 && v < 255.5; }); }

  // OKLCH -> in-gamut sRGB: keep lightness + hue, reduce chroma until it fits.
  function colMap(L, C, H) {
    L = Math.max(0, Math.min(1, L));
    var c = colFromOklch(L, C, H), mapped = false;
    if (!colInGamut(c)) {
      mapped = true;
      var lo = 0, hi = C;
      for (var k = 0; k < 24; k++) { var mid = (lo + hi) / 2; if (colInGamut(colFromOklch(L, mid, H))) lo = mid; else hi = mid; }
      c = colFromOklch(L, lo, H);
    }
    ['r', 'g', 'b'].forEach(function (k) { c[k] = Math.max(0, Math.min(255, c[k])); });
    c.mapped = mapped;
    return c;
  }

  function colHsl(rgb) {
    var r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var l = (mx + mn) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return { h: h, s: s * 100, l: l * 100 };
  }

  function colFromHsl(h, s, l) {
    h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }

  function colTrim(v, d) { var s = v.toFixed(d); return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s; }

  // CSS number / percentage / angle tokens -> numbers. pct = what 100% means.
  function colNum(tok, pct) {
    if (tok == null) return NaN;
    tok = tok.toLowerCase();
    if (tok === 'none') return 0;
    var m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$/.exec(tok);
    if (!m) return NaN;
    var v = parseFloat(m[1]);
    if (m[2] === '%') return pct == null ? NaN : v / 100 * pct;
    if (m[2] === 'grad') return v * 0.9;
    if (m[2] === 'rad') return v * 180 / Math.PI;
    if (m[2] === 'turn') return v * 360;
    return v;
  }

  // Split "a b c / d" or "a, b, c, d" -> { v: [a, b, c], alpha } (strings) or null.
  function colArgs(inner) {
    var s = inner.trim(), alpha = null, parts;
    if (s.indexOf(',') >= 0) {
      parts = s.split(',').map(function (x) { return x.trim(); });
      if (parts.length === 4) alpha = parts.pop();
      if (parts.length !== 3 || parts.some(function (x) { return !x || /\s/.test(x); })) return null;
    } else {
      var sl = s.split('/');
      if (sl.length > 2) return null;
      if (sl.length === 2) alpha = sl[1].trim();
      parts = sl[0].trim().split(/\s+/);
      if (parts.length !== 3) return null;
    }
    return { v: parts, alpha: alpha };
  }

  function colAlpha(tok) {
    if (tok == null || tok === '') return 1;
    var a = colNum(tok, 1);
    return isNaN(a) ? NaN : Math.max(0, Math.min(1, a));
  }

  // One colour token -> { r, g, b (0..255), a, fmt, mapped } or null.
  function colParse(str, N) {
    var s = str.trim(), low = s.toLowerCase(), m, a;
    if ((m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s))) {
      var h = m[1];
      if (h.length <= 4) h = h.split('').map(function (c) { return c + c; }).join('');
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1, fmt: 'hex' };
    }
    if ((m = /^(rgba?|hsla?|oklch)\(([^()]*)\)$/i.exec(s))) {
      var fn = m[1].toLowerCase(), args = colArgs(m[2]);
      if (!args) return null;
      a = colAlpha(args.alpha);
      if (isNaN(a)) return null;
      var v = args.v;
      if (fn[0] === 'r') {
        var rgb = v.map(function (x) { return colNum(x, 255); });
        if (rgb.some(isNaN) || /deg|rad|turn/i.test(v.join(''))) return null;
        var out = { r: rgb[0], g: rgb[1], b: rgb[2], a: a, fmt: 'rgb' };
        out.mapped = rgb.some(function (x) { return x < 0 || x > 255; });
        ['r', 'g', 'b'].forEach(function (k) { out[k] = Math.max(0, Math.min(255, out[k])); });
        return out;
      }
      if (fn[0] === 'h') {
        var hh = colNum(v[0]), ss = colNum(v[1].replace(/%$/, '')), ll = colNum(v[2].replace(/%$/, ''));
        if ([hh, ss, ll].some(isNaN) || /%/.test(v[0])) return null;
        var c = colFromHsl(hh, ss, ll);
        c.a = a; c.fmt = 'hsl';
        return c;
      }
      var L = colNum(v[0], 1), C = colNum(v[1], 0.4), H = colNum(v[2]);
      if ([L, C, H].some(isNaN) || /%/.test(v[2])) return null;
      var o = colMap(L, Math.max(0, C), H);
      return { r: o.r, g: o.g, b: o.b, a: a, fmt: 'oklch', mapped: o.mapped };
    }
    if (/^[a-z]+$/.test(low) && N.byName[low]) { var c2 = colParse('#' + N.byName[low], N); c2.fmt = 'name'; return c2; }
    return null;
  }

  function colHex(c) {
    var p = function (v) { v = Math.round(Math.max(0, Math.min(255, v))); return (v < 16 ? '0' : '') + v.toString(16); };
    return '#' + p(c.r) + p(c.g) + p(c.b) + (c.a < 1 ? p(c.a * 255) : '');
  }

  // Every format for a colour, keyed by fmt.
  function colFormats(c, N) {
    var al = c.a < 1 ? ' / ' + colTrim(c.a, 3) : '', hsl = colHsl(c), ok = colToOklch(c);
    var hex = colHex(c), f = {
      hex: hex,
      rgb: 'rgb(' + Math.round(c.r) + ' ' + Math.round(c.g) + ' ' + Math.round(c.b) + al + ')',
      hsl: 'hsl(' + (Math.round(hsl.s) ? Math.round(hsl.h) % 360 : 0) + ' ' + Math.round(hsl.s) + '% ' + Math.round(hsl.l) + '%' + al + ')',
      oklch: 'oklch(' + colTrim(ok.l * 100, 1) + '% ' + colTrim(ok.c, 3) + ' ' + (ok.c < 0.0005 ? '0' : colTrim(ok.h, 1)) + al + ')'
    };
    if (c.a >= 1 && N.byHex[hex.slice(1)]) f.name = N.byHex[hex.slice(1)];
    return f;
  }

  // Colour tokens in `text` -> [{ from, to, str, col }] (annotations made by
  // Colour Convert are skipped, so re-running doesn't stack them).
  function colScan(text, N) {
    var ann = / → (?:≈ )?(?:[^·\n]*? · )+(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl|oklch)\([^)\n]*\)|[a-z]+)(?: \(mapped into sRGB\))?/g;
    var masked = text.replace(ann, function (s) { return Array(s.length + 1).join('\u0001'); });
    var re = /(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|(?<![\w-])(?:rgba?|hsla?|oklch)\([^()\n]*\)|(?<![\w#$@.-])[a-zA-Z]{3,20}(?![\w-])/g;
    var out = [], m, lone = text.trim();
    while ((m = re.exec(masked))) {
      var s = m[0], from = m.index, to = from + s.length;
      if (/^[a-z]/i.test(s) && !/\(/.test(s)) {
        if (!N.byName[s.toLowerCase()]) continue;
        // Named colours only where code puts them, not in prose: after : = ( , or a quote,
        // or before ; , ) } ! or a quote / the end of the line.
        var before = masked.slice(Math.max(0, from - 40), from), after = masked.slice(to, to + 40);
        if (!(s === lone || /[:=(,'"`]\s*$/.test(before) || /^\s*(?:[;,)}!'"`]|$|\n)/.test(after))) continue;
      }
      if (/^#\d{3,4}$/.test(s) && s !== lone) continue;            // "#123" is far more often an issue number
      var col = colParse(s, N);
      if (col) out.push({ from: from, to: to, str: s, col: col });
    }
    return out;
  }

  var colConvertMain = function main(ctx) {
    var t = dpTarget();
    if (!t) return;
    var N = colNames(), toks = colScan(t.text, N), changes = [], seen = 0;
    toks.forEach(function (tok) {
      seen++;
      if (/^ → /.test(t.text.slice(tok.to))) return;                   // already annotated
      var f = colFormats(tok.col, N), keys = ['hex', 'rgb', 'hsl', 'oklch', 'name'].filter(function (k) { return f[k] && k !== tok.col.fmt; });
      var ins = ' → ' + (tok.col.mapped ? '≈ ' : '') + keys.map(function (k) { return f[k]; }).join(' · ') + (tok.col.mapped ? ' (mapped into sRGB)' : '');
      changes.push({ from: t.from + tok.to, to: t.from + tok.to, insert: ins });
    });
    if (!changes.length) {
      showToast(seen ? 'Already annotated' : 'No colours found (#hex, rgb(), hsl(), oklch() or a CSS colour name)', seen ? 'info' : 'error', 3000);
      return;
    }
    dpApply(changes, dpSplice(t.text, t.from, changes));
  };

  // Tailwind-like 50…950 lightness / chroma profile (OKLCH, from Tailwind v4's palette).
  function colRamp(base) {
    var STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    var T = [0.971, 0.936, 0.885, 0.808, 0.704, 0.637, 0.577, 0.505, 0.444, 0.396, 0.258];
    var K = [0.06, 0.14, 0.27, 0.49, 0.82, 1, 1.07, 1.02, 0.86, 0.66, 0.42];
    var ok = colToOklch(base), a = 0, bd = Infinity, i;
    for (i = 0; i < T.length; i++) if (Math.abs(T[i] - ok.l) < bd) { bd = Math.abs(T[i] - ok.l); a = i; }
    var top = Math.max(T[0], ok.l), bot = Math.min(T[T.length - 1], ok.l);
    return STEPS.map(function (step, k) {
      if (k === a) return { step: step, hex: colHex({ r: base.r, g: base.g, b: base.b, a: 1 }), base: true };
      var L = k < a ? top + (T[k] - T[0]) * (ok.l - top) / (T[a] - T[0]) : bot + (T[k] - T[T.length - 1]) * (ok.l - bot) / (T[a] - T[T.length - 1]);
      if (k < a && T[a] === T[0]) L = T[k];
      var c = colMap(L, ok.c * K[k] / K[a], ok.h);
      c.a = 1;
      return { step: step, hex: colHex(c), base: false };
    });
  }

  var colShadesMain = function main(ctx) {
    var t = dpTarget();
    if (!t) return;
    var N = colNames(), toks = colScan(t.text, N);
    if (!toks.length) { showToast('No colour found — put the cursor on a #hex, rgb(), hsl(), oklch() or named colour', 'error', 3000); return; }
    var tok = toks[0], st = window.Cade.editor.state, doc = st.doc, abs = t.from + tok.from, line = doc.lineAt(abs);
    if (t.kind === 'sel') line = doc.lineAt(Math.max(t.from, t.to - (t.to > t.from && t.to === doc.lineAt(t.to).from ? 1 : 0)));
    var head = st.sliceDoc(doc.lineAt(abs).from, abs), ind = /^\s*/.exec(doc.lineAt(abs).text)[0];
    var nm = /(--[\w-]+|\$[\w-]+|[A-Za-z_][\w-]*)\s*[:=]\s*['"]?$/.exec(head), css = nm && /^(?:--|\$)/.test(nm[1]);
    var base = nm ? nm[1].replace(/-(?:50|[1-9]00|950)$/, '') : null;
    if (line.number < doc.lines && /^\s*(?:\S*-)?50\b[^\n]*#[0-9a-f]{6}/i.test(doc.line(line.number + 1).text)) {
      showToast('Shades already listed below', 'info', 2500);
      return;
    }
    var ramp = colRamp(tok.col), out = ramp.map(function (s) {
      if (base) return ind + base + '-' + s.step + ': ' + s.hex + (css ? ';' : '') + (s.base ? (css ? ' /* base */' : '  (base)') : '');
      var label = String(s.step);
      while (label.length < 5) label += ' ';
      return ind + label + s.hex + (s.base ? '  (base)' : '');
    }).join('\n');
    dpApply([{ from: line.to, to: line.to, insert: '\n' + out }], out);
  };

  /* ================================================================
     9. CSS units: px <-> rem (root font size 16px)
     ================================================================ */

  function unFmt(v) { var s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; }

  // Convert every <number><from> in text (0 values and hyphenated words such
  // as icon-16px are left alone) -> { text, n, changes }.
  function unConvert(text, from, to, base) {
    var re = new RegExp('(?<![\\w.$#@])(?<![\\w]-)(-?)(\\d+(?:\\.\\d+)?|\\.\\d+)' + from + '(?![\\w%-]|\\.\\d)', 'gi'), changes = [], m;
    while ((m = re.exec(text))) {
      var v = parseFloat(m[1] + m[2]);
      if (!v) continue;
      var out = unFmt(from === 'px' ? v / base : v * base) + to;
      changes.push({ from: m.index, to: m.index + m[0].length, insert: out });
    }
    return changes;
  }

  function unRun(from, to) {
    var t = dpTarget();
    if (!t) return;
    var ch = unConvert(t.text, from, to, 16).map(function (c) { return { from: t.from + c.from, to: t.from + c.to, insert: c.insert }; });
    if (!ch.length) { showToast('No non-zero ' + from + ' values found', 'info', 2500); return; }
    dpApply(ch, dpSplice(t.text, t.from, ch));
  }

  var unPxRemMain = function main(ctx) { unRun('px', 'rem'); };
  var unRemPxMain = function main(ctx) { unRun('rem', 'px'); };

  /* ================================================================
     10. Base32 (RFC 4648) / Base58 (Bitcoin) over UTF-8
     ================================================================ */

  function bxB32Enc(text) {
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes = new TextEncoder().encode(text), out = '', bits = 0, val = 0;
    for (var i = 0; i < bytes.length; i++) {
      val = (val << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
      val &= (1 << bits) - 1;
    }
    if (bits) out += A[(val << (5 - bits)) & 31];
    while (out.length % 8) out += '=';
    return out;
  }

  // -> { text } or { error }. Case-insensitive; whitespace and padding optional.
  function bxB32Dec(src) {
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', s = src.replace(/\s+/g, '').toUpperCase();
    var pad = /=+$/.exec(s), body = pad ? s.slice(0, pad.index) : s;
    var bad = /[^A-Z2-7]/.exec(body);
    if (bad) return { error: 'Not valid Base32: unexpected "' + bad[0] + '" at position ' + (bad.index + 1) + ' (alphabet A–Z, 2–7)' };
    if ([1, 3, 6].indexOf(body.length % 8) >= 0) return { error: 'Not valid Base32: ' + body.length + ' characters is not a possible length (truncated?)' };
    if (pad && (s.length % 8 || pad[0].length > 6)) return { error: 'Not valid Base32: wrong amount of = padding' };
    var bytes = [], bits = 0, val = 0;
    for (var i = 0; i < body.length; i++) {
      val = (val << 5) | A.indexOf(body[i]); bits += 5;
      if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; }
      val &= (1 << bits) - 1;
    }
    return bxUtf8(bytes, 'Base32');
  }

  function bxUtf8(bytes, what) {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) }; }
    catch (e) { return { error: what + ' decoded to ' + bytes.length + ' bytes that are not UTF-8 text (binary data?)' }; }
  }

  function bxB58Enc(text) {
    var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', bytes = new TextEncoder().encode(text), digits = [], zeros = 0, i, j;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    for (i = zeros; i < bytes.length; i++) {
      var carry = bytes[i];
      for (j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = '';
    for (i = 0; i < zeros; i++) out += '1';
    for (i = digits.length - 1; i >= 0; i--) out += A[digits[i]];
    return out;
  }

  function bxB58Dec(src) {
    var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', s = src.replace(/\s+/g, ''), bytes = [], zeros = 0, i, j;
    for (i = 0; i < s.length; i++) {
      var v = A.indexOf(s[i]);
      if (v < 0) {
        var hint = /[0OIl]/.test(s[i]) ? ' (0, O, I and l are not in the Bitcoin alphabet)' : '';
        return { error: 'Not valid Base58: unexpected "' + s[i] + '" at position ' + (i + 1) + hint };
      }
      var carry = v;
      for (j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 255; carry >>= 8; }
      while (carry) { bytes.push(carry & 255); carry >>= 8; }
    }
    while (zeros < s.length && s[zeros] === '1') zeros++;
    var out = [];
    for (i = 0; i < zeros; i++) out.push(0);
    for (i = bytes.length - 1; i >= 0; i--) out.push(bytes[i]);
    return bxUtf8(out, 'Base58');
  }

  // Encode / decode the selection (or line / document) in place.
  function bxRun(fn, decode) {
    var t = dpTarget();
    if (!t) return;
    var text = decode ? t.text.trim() : t.text, lead = decode ? t.text.length - t.text.replace(/^\s+/, '').length : 0;
    if (!text.length) { showToast('Nothing to ' + (decode ? 'decode' : 'encode') + ' — the document is empty', 'error', 2500); return; }
    var r = fn(text);
    if (typeof r === 'string') r = { text: r };
    if (r.error) { showToast(r.error, 'error', 4000); return; }
    var from = t.from + lead, to = from + text.length;
    dpApply([{ from: from, to: to, insert: r.text }], r.text);
  }

  var bxB32EncMain = function main(ctx) { bxRun(bxB32Enc, false); };
  var bxB32DecMain = function main(ctx) { bxRun(bxB32Dec, true); };
  var bxB58EncMain = function main(ctx) { bxRun(bxB58Enc, false); };
  var bxB58DecMain = function main(ctx) { bxRun(bxB58Dec, true); };

  /* ================================================================
     11. Line endings
     CodeMirror stores every line break as "\n": CRLF and lone CR are
     converted when text is pasted, imported or dispatched, so a document
     can never hold a CR. What CAN survive are the Unicode separators
     U+2028 / U+2029 and NEL (U+0085), which most tools treat as breaks.
     ================================================================ */

  // Count the line-break styles in a string.
  function leCount(s) {
    var c = { crlf: 0, lf: 0, cr: 0, ls: 0, ps: 0, nel: 0 }, m, re = /\r\n|\n|\r|\u2028|\u2029|\u0085/g;
    while ((m = re.exec(s))) c[{ '\r\n': 'crlf', '\n': 'lf', '\r': 'cr', '\u2028': 'ls', '\u2029': 'ps', '\u0085': 'nel' }[m[0]]]++;
    return c;
  }

  function leDescribe(c) {
    var names = { crlf: 'CRLF', lf: 'LF', cr: 'CR', ls: 'U+2028', ps: 'U+2029', nel: 'NEL' }, kinds = Object.keys(names).filter(function (k) { return c[k]; });
    if (!kinds.length) return 'no line breaks';
    var style = kinds.length > 1 ? 'mixed' : { crlf: 'CRLF (Windows)', lf: 'LF (Unix / macOS)', cr: 'CR (classic Mac)', ls: 'U+2028', ps: 'U+2029', nel: 'NEL' }[kinds[0]];
    return style + ' — ' + kinds.map(function (k) { return c[k] + ' ' + names[k]; }).join(' · ');
  }

  var leLfMain = function main(ctx) {
    var ed = window.Cade.editor, st = ed.state, sel = st.selection.main;
    var from = sel.from !== sel.to ? sel.from : 0, to = sel.from !== sel.to ? sel.to : st.doc.length, text = st.sliceDoc(from, to);
    var c = leCount(text), odd = c.crlf + c.cr + c.ls + c.ps + c.nel;
    if (!odd) {
      showToast('Already LF — ' + (c.lf + 1) + ' line' + (c.lf ? 's' : '') + ', no U+2028 / U+2029 / NEL separators (the editor turns CRLF and CR into LF as text comes in)', 'info', 4500);
      return;
    }
    var out = text.replace(/\r\n|\r|\u2028|\u2029|\u0085/g, '\n');
    if (dpApply([{ from: from, to: to, insert: out }], out)) showToast('Converted to LF: ' + leDescribe({ crlf: c.crlf, lf: 0, cr: c.cr, ls: c.ls, ps: c.ps, nel: c.nel }).replace(/^[^—]*— /, ''), 'success', 3500);
  };

  var leCrlfMain = function main(ctx) {
    var st = window.Cade.editor.state, sel = st.selection.main;
    var text = sel.from !== sel.to ? st.sliceDoc(sel.from, sel.to) : st.doc.toString();
    if (!text.length) { showToast('Nothing to copy — the document is empty', 'error', 2500); return; }
    var out = text.replace(/\r\n|\r|\n|\u2028|\u2029|\u0085/g, '\r\n'), n = leCount(out).crlf;
    dpCopy(out, 'Copied ' + (sel.from !== sel.to ? 'the selection' : 'the document') + ' with CRLF line endings (' + n + ' line break' + (n === 1 ? '' : 's') + ') — the note itself stays LF');
  };

  var leShowMain = async function main(ctx) {
    var st = window.Cade.editor.state, dc = leCount(st.doc.toString()), clip = null, why = '';
    try {
      var nav = window.navigator;
      if (nav && nav.clipboard && nav.clipboard.readText) clip = await nav.clipboard.readText();
      else why = 'clipboard reading is not available here';
    } catch (e) { why = 'clipboard access was blocked'; }
    var msg = 'Note: ' + leDescribe(dc) + ' (stored as LF)';
    if (clip != null) msg += clip.length ? ' · Clipboard: ' + leDescribe(leCount(clip)) : ' · Clipboard: empty';
    else msg += ' · Clipboard: ' + why;
    showToast(msg, 'info', 7000);
  };

  /* ================================================================
     12. Humanize bytes / durations (annotations, never replacements)
     ================================================================ */

  function huBytes(v) {
    var BIN = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'], SI = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    function f(v, k, U) { var i = 0; while (v >= k && i < U.length - 1) { v /= k; i++; } return (Math.round(v * 100) / 100) + ' ' + U[i]; }
    return f(v, 1024, BIN) + ' (' + f(v, 1000, SI) + ')';
  }

  // Seconds -> "1d 1h 1m 1s" (fractional seconds kept to 3 places; < 1s -> ms).
  function huDur(sec, maxUnit) {
    if (sec < 0) return '-' + huDur(-sec, maxUnit);
    var ms = Math.round(sec * 1000);
    if (ms < 1000) return ms + 'ms';
    var U = [['d', 86400000], ['h', 3600000], ['m', 60000]], out = [];
    if (maxUnit === 'h') U.shift();
    U.forEach(function (u) { var q = Math.floor(ms / u[1]); if (q) { out.push(q + u[0]); ms -= q * u[1]; } });
    if (ms) out.push((ms % 1000 ? (ms / 1000).toFixed(3).replace(/0+$/, '') : String(ms / 1000)) + 's');
    return out.join(' ');
  }

  // Numbers (with an optional unit) in text -> [{ from, to, v, unit }].
  function huScan(text, unitRe) {
    var re = new RegExp('(?<![\\w.$#\\-:/])(\\d(?:_?\\d)*(?:\\.\\d+)?)(?:\\s?(' + unitRe + '))?(?![\\w%]|[.:/,-]\\d)', 'g'), m, out = [];
    while ((m = re.exec(text))) out.push({ from: m.index, to: m.index + m[0].length, v: parseFloat(m[1].replace(/_/g, '')), unit: m[2] || '', str: m[0] });
    return out;
  }

  function huRun(kind) {
    var t = dpTarget();
    if (!t) return;
    var text = t.text, lone = text.trim(), changes = [], seen = 0;
    var masked = text.replace(/ → [^\n]*/g, function (s) { return Array(s.length + 1).join('\u0001'); });
    var toks = kind === 'bytes' ? huScan(masked, 'bytes?|B(?![A-Za-z])') : huScan(masked, 'milliseconds?|ms|seconds?|secs?|s(?![A-Za-z])');
    toks.forEach(function (tok) {
      seen++;
      if (/^ → /.test(text.slice(tok.to))) return;
      var isLone = tok.str === lone, out;
      if (kind === 'bytes') {
        if (tok.v < 1000 && !isLone) return;
        if (tok.v !== Math.floor(tok.v) && !tok.unit) return;
        out = huBytes(tok.v);
      } else {
        var sec = /^m/i.test(tok.unit) ? tok.v / 1000 : tok.v;
        if (!tok.unit && !isLone && /^(?:19|20)\d\d$/.test(tok.str)) return;     // a year, not 33 minutes
        if (sec < 60 && !isLone && !/^m/i.test(tok.unit)) return;
        if (/^m/i.test(tok.unit) && tok.v < 1000 && !isLone) return;
        out = huDur(sec);
      }
      changes.push({ from: t.from + tok.to, to: t.from + tok.to, insert: ' → ' + out });
    });
    if (!changes.length) {
      showToast(seen ? 'Nothing to humanize (already annotated, or too small to matter)' :
        kind === 'bytes' ? 'No byte counts found' : 'No durations found (seconds, or numbers ending in ms / s)', seen ? 'info' : 'error', 3000);
      return;
    }
    dpApply(changes, dpSplice(text, t.from, changes));
  }

  var huBytesMain = function main(ctx) { huRun('bytes'); };
  var huDurMain = function main(ctx) { huRun('dur'); };

  /* ================================================================
     13. Sum Durations
     ================================================================ */

  // Total seconds of every duration on one line, or null if there are none:
  // 1h20m, 45m, 1.5 hrs, 1 hr 5 min, 90s, 250ms, 2d, 1w, 1:30 (h:mm),
  // 1:30:00 (h:mm:ss), ISO 8601 PT1H30M.
  function sdLine(line) {
    var total = 0, n = 0, m;
    var s = line.replace(/(?<![\w])P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?(?![\w])/g,
      function (all, w, d, h, mi, se) {
        if (!(w || d || h || mi || se)) return all;
        total += (+w || 0) * 604800 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+se || 0); n++;
        return Array(all.length + 1).join(' ');
      });
    s = s.replace(/(?<![\d:.])(\d{1,4}):([0-5]\d)(?::([0-5]\d(?:\.\d+)?))?(?![\d:])/g, function (all, h, mi, se) {
      total += +h * 3600 + +mi * 60 + (+se || 0); n++;
      return Array(all.length + 1).join(' ');
    });
    var U = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 };
    var re = /(\d+(?:\.\d+)?|\.\d+)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)(?![a-z])/gi, last = -1;
    while ((m = re.exec(s))) {
      var prev = m.index ? s[m.index - 1] : '';
      if (/[\d.]/.test(prev)) continue;
      if (/[A-Za-z_]/.test(prev) && m.index !== last) continue;      // "mp3s", but 1h20m chains
      var u = m[2].toLowerCase(), key = /^(?:ms|msecs?|millisecond)/.test(u) ? 'ms' : u[0];
      total += parseFloat(m[1]) * U[key]; n++;
      last = m.index + m[0].length;
    }
    return n ? total : null;
  }

  var sdMain = function main(ctx) {
    var t = dpBlock();
    if (!t) return;
    var total = 0, used = 0, skipped = 0;
    t.text.split('\n').forEach(function (l) {
      if (!l.trim() || /^\s*=/.test(l)) return;                  // blank, or an earlier total
      var v = sdLine(l);
      if (v == null) skipped++; else { total += v; used++; }
    });
    if (!used) { showToast('No durations found (like 1h20m, 45m, 1:30:00, 90s, 2.5h, 1 hr 5 min)', 'error', 3500); return; }
    var out = '= ' + huDur(total, 'h') + (total >= 3600 ? ' (' + (Math.round(total / 36) / 100) + ' h)' : '');
    var ins = (/\n\n$/.test(t.text) ? '' : /\n$/.test(t.text) ? '\n' : '\n\n') + out;
    dpApply([{ from: t.to, to: t.to, insert: ins }], out);
    if (skipped) showToast('Summed ' + used + ' line' + (used === 1 ? '' : 's') + ' · ' + skipped + ' without a duration skipped', 'info', 3000);
  };

  /* ================================================================
     Registration
     ================================================================ */

  var DP = [dpTarget, dpCopy, dpApply, dpSplice, dpStoreGet, dpStoreSet];
  var JWT = [jwtBytes, jwtText, jwtJson, jwtFind, jwtRel, jwtIsoLocal, jwtWhen, jwtBlock];
  var HASH = [hashToHex, hashMd5, hashSha256, hashHex, hashRun];

  reg({ name: 'JWT Decode', description: "Decode a JWT's header + payload to pretty JSON below it, with iat / nbf / exp as local times (signature not verified)",
    author: 'Cade', icon: ICON.key, tags: 'jwt,token,decode,auth,bearer,json,claims,exp,oauth,oidc,jws,jwe,dev' }, DP.concat(JWT), jwtMain);

  reg({ name: 'Hash SHA-256', description: 'Insert the SHA-256 hex digest of the selection (or line / document) on a new line below it',
    author: 'Cade', icon: ICON.hash, tags: 'hash,sha256,sha-256,sha2,digest,checksum,crypto,dev' }, DP.concat(HASH), hashSha256Main);
  reg({ name: 'Hash MD5', description: 'Insert the MD5 hex digest of the selection (or line / document) on a new line below it',
    author: 'Cade', icon: ICON.hash, tags: 'hash,md5,digest,checksum,crypto,dev' }, DP.concat(HASH), hashMd5Main);
  reg({ name: 'Hash (all)', description: 'Insert MD5, SHA-1, SHA-256 and SHA-512 hex digests of the selection (or line / document) below it',
    author: 'Cade', icon: ICON.hashAll, tags: 'hash,md5,sha1,sha-1,sha256,sha512,sha-512,digest,checksum,all,crypto,dev' }, DP.concat(HASH), hashAllMain);
  reg({ name: 'Hash…', description: 'Pick MD5, SHA-1, SHA-256, SHA-384 or SHA-512 and insert the hex digest below the selection (or line / document)',
    author: 'Cade', icon: ICON.hash, tags: 'hash,sha1,sha384,sha512,sha256,md5,digest,checksum,algorithm,crypto,dev' }, DP.concat(HASH), hashPickMain);

  reg({ name: 'Timestamps → Dates', description: 'Annotate unix epochs (s / ms / µs / ns) with UTC + local dates; a lone number can be read as Excel serial or kdb+ q',
    author: 'Cade', icon: ICON.clock, tags: 'timestamp,epoch,unix,date,time,excel,serial,kdb,q,kx,convert,human,readable,dev' }, DP.concat(TS), tsToDatesMain);
  reg({ name: 'Dates → Timestamps…', description: 'Convert ISO / RFC 2822 / kdb+ q / Excel dates and epochs to a chosen format (unix s/ms/ns, ISO, Excel, kdb+)',
    author: 'Cade', icon: ICON.calArrow, tags: 'timestamp,epoch,unix,date,time,iso,rfc2822,excel,serial,kdb,q,kx,convert,dev' }, DP.concat(TS), tsToStampsMain);
  reg({ name: 'Insert Timestamp As…', description: 'Insert the current time as unix s / ms / ns, ISO 8601, Excel serial, kdb+ timestamp / date…',
    author: 'Cade', icon: ICON.calPlus, tags: 'timestamp,insert,now,epoch,unix,iso,excel,serial,kdb,q,kx,date,time,dev' }, DP.concat(TS), tsInsertMain);

  reg({ name: 'cURL → fetch', description: "Turn a curl command (e.g. Chrome's Copy as cURL) into JavaScript fetch() code",
    author: 'Cade', icon: ICON.term, tags: 'curl,fetch,javascript,js,node,http,request,api,convert,dev' }, DP.concat(CURL), curlFetchMain);
  reg({ name: 'cURL → Python requests', description: 'Turn a curl command (e.g. Chrome\'s Copy as cURL) into Python requests code',
    author: 'Cade', icon: ICON.code, tags: 'curl,python,requests,http,request,api,convert,dev' }, DP.concat(CURL), curlPyMain);

  reg({ name: 'Number Base Convert', description: 'Show numbers as decimal / hex / binary / octal (a lone number becomes 255 = 0xFF = 0b11111111 = 0o377)',
    author: 'Cade', icon: ICON.binary, tags: 'number,base,hex,binary,octal,decimal,convert,radix,bits,dev' }, DP.concat(NB), nbAllMain);
  reg({ name: 'To Hex', description: 'Convert numbers (decimal, 0b…, 0o…) in place to hexadecimal 0x…',
    author: 'Cade', icon: ICON.hex, tags: 'hex,hexadecimal,number,base,convert,radix,dev' }, DP.concat(NB), nbHexMain);
  reg({ name: 'To Binary', description: 'Convert numbers (decimal, 0x…, 0o…, a lone bare hex) in place to binary 0b…',
    author: 'Cade', icon: ICON.bin, tags: 'binary,bits,number,base,convert,radix,dev' }, DP.concat(NB), nbBinMain);
  reg({ name: 'To Decimal', description: 'Convert 0x… / 0b… / 0o… numbers (or a lone bare hex like ff) in place to decimal',
    author: 'Cade', icon: ICON.dec, tags: 'decimal,number,base,convert,radix,hex,binary,octal,dev' }, DP.concat(NB), nbDecMain);

  var LS = [dpBlock, lsItems, lsIsNum, lsNumKind, lsQuote, lsArray, lsSqlIn, lsLang];
  var FC = [fcRead, fcFind, fcResolve, fcAppends, fcMark, fcDeref, fcStr, fcJson, fcPairs, fcFormEnc, fcForm, fcShell, fcCurl];
  var COL = [colNames, colLin, colGam, colToOklch, colFromOklch, colInGamut, colMap, colHsl, colFromHsl, colTrim, colNum, colArgs,
    colAlpha, colParse, colHex, colFormats, colScan, colRamp];
  var UN = [unFmt, unConvert, unRun];
  var BX = [bxB32Enc, bxB32Dec, bxUtf8, bxB58Enc, bxB58Dec, bxRun];
  var LE = [leCount, leDescribe];
  var HU = [huBytes, huDur, huScan, huRun];

  reg({ name: 'Lines → Array Literal…', description: "Turn lines into a JavaScript / JSON / Python / Go array literal — ['a', 'b'] with the right escaping, numbers bare when every line is one, one item per line past 80 characters",
    author: 'Cade', icon: ICON.brackets, tags: 'array,list,literal,lines,javascript,js,json,python,py,go,golang,quote,escape,convert,dev' }, DP.concat(LS), lsArrayMain);
  reg({ name: 'Lines → SQL IN List', description: "Turn lines into IN ('a', 'b') — '' escaping, numbers bare when every line is one, duplicates and blank lines dropped",
    author: 'Cade', icon: ICON.db, tags: 'sql,in,list,where,lines,quote,escape,ids,query,database,dedupe,convert,dev' }, DP.concat(LS), lsSqlMain);

  reg({ name: 'fetch → cURL', description: 'Turn a JavaScript fetch() call (headers, JSON.stringify / URLSearchParams / FormData bodies) into a curl command, inserted below it',
    author: 'Cade', icon: ICON.prompt, tags: 'fetch,curl,javascript,js,http,request,api,shell,bash,headers,convert,dev' }, DP.concat(FC), fcMain);

  reg({ name: 'Colour Convert', description: 'Annotate every #hex, rgb(), hsl(), oklch() or CSS colour name with its other forms: #0f9598 → rgb(15 149 152) · hsl(181 82% 33%) · oklch(60.9% 0.101 197.4)',
    author: 'Cade', icon: ICON.palette, tags: 'color,colour,convert,hex,rgb,rgba,hsl,hsla,oklch,css,named,palette,dev' }, DP.concat(COL), colConvertMain);
  reg({ name: 'Colour Shades', description: 'Insert a Tailwind-style 50–950 shade ramp for the colour at the cursor, built perceptually in OKLCH (the colour itself keeps its nearest step)',
    author: 'Cade', icon: ICON.shades, tags: 'color,colour,shades,tints,ramp,scale,palette,tailwind,oklch,css,variables,design,dev' }, DP.concat(COL), colShadesMain);

  reg({ name: 'px → rem', description: 'Convert every non-zero px length to rem at a 16px root (24px → 1.5rem, up to 4 decimals)',
    author: 'Cade', icon: ICON.rem, tags: 'px,rem,css,units,convert,font size,pixels,responsive,dev' }, DP.concat(UN), unPxRemMain);
  reg({ name: 'rem → px', description: 'Convert every non-zero rem length to px at a 16px root (1.5rem → 24px)',
    author: 'Cade', icon: ICON.px, tags: 'rem,px,css,units,convert,font size,pixels,dev' }, DP.concat(UN), unRemPxMain);

  reg({ name: 'Base32 Encode', description: 'Encode the selection (or line / document) as RFC 4648 Base32 of its UTF-8 bytes',
    author: 'Cade', icon: ICON.b32, tags: 'base32,encode,rfc4648,totp,otp,binary,dev' }, DP.concat(BX), bxB32EncMain);
  reg({ name: 'Base32 Decode', description: 'Decode RFC 4648 Base32 (any case, padding optional) back to UTF-8 text',
    author: 'Cade', icon: ICON.b32, tags: 'base32,decode,rfc4648,totp,otp,binary,dev' }, DP.concat(BX), bxB32DecMain);
  reg({ name: 'Base58 Encode', description: 'Encode the selection (or line / document) as Base58 (Bitcoin alphabet) of its UTF-8 bytes',
    author: 'Cade', icon: ICON.b58, tags: 'base58,encode,bitcoin,btc,ipfs,address,binary,dev' }, DP.concat(BX), bxB58EncMain);
  reg({ name: 'Base58 Decode', description: 'Decode Base58 (Bitcoin alphabet) back to UTF-8 text',
    author: 'Cade', icon: ICON.b58, tags: 'base58,decode,bitcoin,btc,ipfs,address,binary,dev' }, DP.concat(BX), bxB58DecMain);

  reg({ name: 'Line Endings → LF', description: 'Turn stray U+2028 / U+2029 / NEL line separators in the selection (or note) into plain LF line breaks and report what was found',
    author: 'Cade', icon: ICON.enter, tags: 'line endings,eol,lf,newline,unix,u+2028,line separator,paragraph separator,nel,cleanup,dev' }, DP.concat(LE), leLfMain);
  reg({ name: 'Line Endings → CRLF (Copy)', description: 'Copy the selection (or note) to the clipboard with Windows CRLF line endings — the note itself always stores LF',
    author: 'Cade', icon: ICON.copy, tags: 'line endings,eol,crlf,windows,newline,copy,clipboard,dos,dev' }, DP.concat(LE), leCrlfMain);
  reg({ name: 'Show Line Endings', description: "Report the line-ending style of the clipboard (CRLF / LF / CR / mixed, with counts) and the note's own line breaks",
    author: 'Cade', icon: ICON.pilcrow, tags: 'line endings,eol,crlf,lf,cr,mixed,detect,newline,clipboard,windows,unix,dev' }, DP.concat(LE), leShowMain);

  reg({ name: 'Humanize Bytes', description: 'Annotate byte counts with binary and SI sizes: 1048576 → 1 MiB (1.05 MB) (numbers of 1000+ or with a B / bytes unit)',
    author: 'Cade', icon: ICON.drive, tags: 'bytes,size,humanize,human,readable,kib,mib,gib,kb,mb,gb,file size,memory,dev' }, DP.concat(HU), huBytesMain);
  reg({ name: 'Humanize Durations', description: 'Annotate durations in seconds (or with an ms / s unit): 90061 → 1d 1h 1m 1s, 1500ms → 1.5s',
    author: 'Cade', icon: ICON.hourglass, tags: 'duration,seconds,milliseconds,ms,humanize,human,readable,time,elapsed,uptime,ttl,dev' }, DP.concat(HU), huDurMain);
  reg({ name: 'Sum Durations', description: 'Add up durations line by line (1h20m, 45m, 1:30:00, 90s, 2.5h, 1 hr 5 min, PT1H) and append the total',
    author: 'Cade', icon: ICON.timer, tags: 'sum,total,durations,time,hours,minutes,timesheet,add,log,hh:mm,dev' }, DP.concat(HU, [sdLine]).concat([dpBlock]), sdMain);
})();
