/* Checks for Send to device: URL validation, TTL / missed links, the rate
 * limit, the receiver's decision, picking a target (?to= / the one online
 * receiver), message and ack shapes, the sender's status lines, the iOS
 * Shortcut / bookmarklet strings, pop-up help per browser, history, and the
 * widget / plugin registration against the manifest.
 * Not loaded by the app. Run: node txt/widgets/linksend/linksend.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), vm = require('vm');
var L = require('./linksend-core.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
var ch = String.fromCharCode;

test('web links pass and are normalised', function () {
  assert.strictEqual(L.cleanUrl('https://example.com'), 'https://example.com/');
  assert.strictEqual(L.cleanUrl('http://example.com/a?b=1#c'), 'http://example.com/a?b=1#c');
  assert.strictEqual(L.cleanUrl('HTTPS://Example.COM/Path'), 'https://example.com/Path');
  assert.strictEqual(L.cleanUrl('  https://example.com/x \n\t'), 'https://example.com/x');
  assert.strictEqual(L.cleanUrl(ch(0x200b) + 'https://example.com/x' + ch(0xfeff)), 'https://example.com/x', 'zero-width marks around it');
  assert.strictEqual(L.cleanUrl('https://example.com/a b'), 'https://example.com/a%20b');
  assert.strictEqual(L.cleanUrl('https://xn--80ak6aa92e.com/'), 'https://xn--80ak6aa92e.com/');
});
test('everything that is not http(s) is refused, whatever the spelling', function () {
  var bad = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'JAVASCRIPT:alert(1)', '  javascript:alert(1)', '\tjavascript:alert(1)',
    'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)', ch(0) + 'javascript:alert(1)', ch(1) + ' javascript:alert(1)',
    ch(0x200b) + 'javascript:alert(1)', ch(0xfeff) + 'javascript:alert(1)', 'javascript://example.com/%0aalert(1)',
    'data:text/html,<script>alert(1)</script>', 'DATA:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd', 'FILE://C:/x',
    'blob:https://example.com/123', 'about:blank', 'vbscript:msgbox(1)', 'mailto:a@b.c', 'tel:123', 'ftp://example.com/',
    'chrome://settings', 'view-source:https://example.com', 'ws://example.com', 'intent://x#Intent;end',
    '//example.com/x', '/relative', 'example.com', 'https://', 'http://', 'https:example.com/x?' + 'a'.repeat(9000), '', '   ', null, undefined, 42, {}
  ];
  bad.forEach(function (u) { assert.strictEqual(L.cleanUrl(u), null, JSON.stringify(u)); });
  // "https:example.com" is a real (if odd) web link: the parser fixes it up
  assert.strictEqual(L.cleanUrl('https:example.com'), 'https://example.com/');
});
test('typed links: a bare domain means https, a scheme is never invented', function () {
  assert.strictEqual(L.cleanUrl('example.com/x', true), 'https://example.com/x');
  assert.strictEqual(L.cleanUrl('www.example.co.uk', true), 'https://www.example.co.uk/');
  assert.strictEqual(L.cleanUrl('javascript:alert(1)', true), null);
  assert.strictEqual(L.cleanUrl('JaVaScRiPt:alert(1)', true), null);
  assert.strictEqual(L.cleanUrl('javascript%3Aalert(1)', true), null);
  assert.strictEqual(L.cleanUrl('localhost:3000', true), null);
  assert.strictEqual(L.cleanUrl('hello world', true), null);
  assert.strictEqual(L.cleanUrl('example.com', false), null, 'not lenient: received links must be complete');
});
test('finding a link in a selection or the clipboard', function () {
  assert.strictEqual(L.findUrl('see https://example.com/a, then'), 'https://example.com/a');
  assert.strictEqual(L.findUrl('(https://example.com/a)'), 'https://example.com/a');
  assert.strictEqual(L.findUrl('  example.com/path  '), 'https://example.com/path');
  assert.strictEqual(L.findUrl('no link here'), null);
  assert.strictEqual(L.findUrl('javascript:alert(1)'), null);
  assert.strictEqual(L.hostOf('https://www.example.com/x'), 'example.com');
  assert.strictEqual(L.shortUrl('https://www.example.com/'), 'example.com');
  assert.ok(L.shortUrl('https://example.com/' + 'x'.repeat(200), 40).length === 40);
});
test('TTL: fresh within it, expired after it, no stamp = expired', function () {
  var ttl = L.ttlMs(10), now = 1e12;
  assert.strictEqual(ttl, 600000);
  assert.strictEqual(L.classify(now - 599999, now, ttl), 'fresh');
  assert.strictEqual(L.classify(now - 600000, now, ttl), 'fresh');
  assert.strictEqual(L.classify(now - 600001, now, ttl), 'expired');
  assert.strictEqual(L.classify(now + 5000, now, ttl), 'fresh', 'a clock a little ahead');
  assert.strictEqual(L.classify(0, now, ttl), 'expired');
  assert.strictEqual(L.classify(undefined, now, ttl), 'expired');
  assert.strictEqual(L.classify(NaN, now, ttl), 'expired');
  assert.strictEqual(L.ttlMs(0), 600000, 'default 10 min');
  assert.strictEqual(L.ttlMs('abc'), 600000);
  assert.strictEqual(L.ttlMs(60), 3600000);
  assert.strictEqual(L.ttlMs(0.1), 60000, 'at least a minute');
  // the older of the two stamps counts: a copied message can't be made fresh
  assert.strictEqual(L.sentAt(100, 200), 100);
  assert.strictEqual(L.sentAt(300, 200), 200);
  assert.strictEqual(L.sentAt(0, 200), 200);
  assert.strictEqual(L.sentAt(100, undefined), 100);
  assert.strictEqual(L.sentAt(undefined, null), 0);
});
test('rate limit: 5 a minute, then listed but not opened, then again', function () {
  var lim = L.makeLimiter(5, 60000), t = 1000;
  for (var i = 0; i < 5; i++) assert.strictEqual(lim.take(t + i), true, 'link ' + (i + 1));
  assert.strictEqual(lim.take(t + 10), false, 'the 6th');
  assert.strictEqual(lim.take(t + 59000), false);
  assert.strictEqual(lim.left(t + 59000), 0);
  assert.strictEqual(lim.take(t + 60000), true, 'the first one has left the window');
  assert.strictEqual(L.RATE_MAX, 5);
});
test('the receiver decides: refused, expired, limited, open', function () {
  var now = 5e11, ttl = L.ttlMs(10), lim = L.makeLimiter(2, 60000);
  var m = function (at, url) { return L.readMessage({ id: 'abcdef123', url: url || 'https://example.com', at: at, from: { id: 'ph', name: 'iPhone', kind: 'phone' } }); };
  assert.strictEqual(L.decide(m(now - 1000, 'javascript:alert(1)'), now, now, ttl, lim), 'refused');
  assert.strictEqual(L.decide(null, now, now, ttl, lim), 'refused');
  assert.strictEqual(L.decide(m(now - 11 * 60000), now, now, ttl, lim), 'expired');
  assert.strictEqual(L.decide(m(now - 1000), now - 11 * 60000, now, ttl, lim), 'expired', 'the routing stamp is older');
  assert.strictEqual(L.decide(m(now - 1000), now, now, ttl, lim), 'open');
  assert.strictEqual(L.decide(m(now - 1000), now, now, ttl, lim), 'open');
  assert.strictEqual(L.decide(m(now - 1000), now, now, ttl, lim), 'limited');
  assert.strictEqual(L.decide(m(now - 99 * 60000), now, now, ttl, lim), 'expired', 'expired ones never count against the rate');
});
function dev(id, name, live, at, kind) { return { id: id, name: name, kind: kind || 'desktop', live: !!live, at: at || 0, ttl: 10, pop: '' }; }
test('target: ?to= by id, by name (any case / spacing), by its start; one online receiver', function () {
  var list = [dev('mac1', 'MacBook', true, 9), dev('work', 'Work PC', false, 5), dev('ph', 'iPhone', true, 8, 'phone')];
  assert.strictEqual(L.pickTarget(list, 'work', 'ph').target.id, 'work');
  assert.strictEqual(L.pickTarget(list, 'macbook', 'ph').target.id, 'mac1');
  assert.strictEqual(L.pickTarget(list, '  MACBOOK ', 'ph').target.id, 'mac1');
  assert.strictEqual(L.pickTarget(list, 'work  pc', 'ph').target.id, 'work', 'offline is fine: it waits there');
  assert.strictEqual(L.pickTarget(list, 'Work', 'ph').target.id, 'work', 'by the start of the name');
  assert.strictEqual(L.pickTarget(list, 'Work', 'ph').why, 'to');
  var r = L.pickTarget(list, 'Linux box', 'ph');
  assert.strictEqual(r.target, null); assert.strictEqual(r.missing, true);
  var two = [dev('a', 'Mac · Chrome', true, 1), dev('b', 'Mac · Safari', true, 2)];
  r = L.pickTarget(two, 'mac', 'x');
  assert.strictEqual(r.target, null, 'ambiguous'); assert.strictEqual(r.matches.length, 2);
  assert.strictEqual(L.pickTarget(two, 'mac safari', 'x').target.id, 'b', 'separators ignored');
  assert.strictEqual(L.pickTarget([dev('a', 'Mac · Chrome', true), dev('b', 'Mac · Safari', false)], 'mac', 'x').target.id, 'a', 'the online one of several matches');
  // no ?to=: exactly one online receiver (not this device) → it
  r = L.pickTarget(list, '', 'ph');
  assert.strictEqual(r.target.id, 'mac1'); assert.strictEqual(r.why, 'only');
  assert.strictEqual(L.pickTarget(list, null, 'nobody').target, null, 'two online → ask');
  assert.strictEqual(L.pickTarget([dev('w', 'Work PC', false)], '', 'ph').target, null, 'none online → ask');
  assert.strictEqual(L.pickTarget([], 'mac', 'ph').target, null);
  assert.strictEqual(L.pickTarget(list, 'iphone', 'ph').target, null, 'never this device');
  assert.strictEqual(L.pickTarget(list, 'any', 'ph').target.id, 'mac1', '"any" = no preference');
});
test('devices: live from the connection entries, online first, stale and self left out', function () {
  var d = L.deviceFromEntry('mac1', { s: 'x', at: 50, live: { abc: 1 } }, { n: 'MacBook', k: 'desktop', t: 15, p: 'blocked' }, 'ph');
  assert.deepStrictEqual(d, { id: 'mac1', name: 'MacBook', kind: 'desktop', ttl: 15, pop: 'blocked', at: 50, live: true, self: false });
  assert.strictEqual(L.deviceFromEntry('x', { at: 1 }, { n: 'X', k: 'toaster' }, '').kind, 'desktop');
  assert.strictEqual(L.deviceFromEntry('x', { at: 1 }, { n: 'X' }, '').live, false);
  assert.strictEqual(L.deviceFromEntry('x', { at: 1 }, null, ''), null, 'unreadable (another key)');
  var now = 100 * 86400000;
  var list = [dev('a', 'Old', false, now - 61 * 86400000), dev('b', 'Seen', false, now - 3600000), dev('c', 'Live', true, now - 7200000), dev('me', 'Me', true, now)];
  var s = L.sortDevices(list, now, 'me');
  assert.deepStrictEqual(s.map(function (x) { return x.id; }), ['c', 'b']);
  assert.deepStrictEqual(L.sortDevices(list, now, 'me', true).map(function (x) { return x.id; }), ['me', 'c', 'b']);
});
test('message and ack shapes', function () {
  var m = L.makeMessage({ url: ' https://example.com/a ', title: 'A  title\nwith\tbreaks', from: { id: 'ph1', name: 'iPhone', kind: 'phone' }, at: 1700000000000 });
  assert.deepStrictEqual(Object.keys(m).sort(), ['at', 'from', 'id', 'title', 'url', 'v']);
  assert.strictEqual(m.url, 'https://example.com/a');
  assert.strictEqual(m.title, 'A title with breaks');
  assert.ok(L.okId(m.id) && m.id.indexOf((1700000000000).toString(36)) === 0, 'time-ordered id');
  assert.deepStrictEqual(m.from, { id: 'ph1', name: 'iPhone', kind: 'phone' });
  assert.strictEqual(L.makeMessage({ url: 'javascript:alert(1)', from: {} }), null);
  assert.strictEqual(L.makeMessage({ url: 'https://x.y', title: 'x'.repeat(500), from: {} }).title.length, 300);
  var note = L.makeMessage({ url: 'https://h.io/txt.html?room=plans', room: 'plans', from: {}, at: 1 });
  assert.strictEqual(note.room, 'plans');
  var r = L.readMessage(JSON.parse(JSON.stringify(m)));
  assert.strictEqual(r.url, m.url); assert.strictEqual(r.bad, undefined);
  assert.strictEqual(L.readMessage({ id: 'abcdefgh', url: 'data:text/html,x', from: { name: 'X' } }).bad, true, 'kept, marked, so the sender is told');
  assert.strictEqual(L.readMessage({ id: 'ab', url: 'https://x.y' }), null, 'bad id');
  assert.strictEqual(L.readMessage({ id: 'abcdefgh' }), null, 'no url');
  assert.strictEqual(L.readMessage('nope'), null);
  assert.strictEqual(L.readMessage({ id: 'abcdefgh', url: 'https://x.y', from: { name: '<b>' + 'n'.repeat(80), kind: 'evil' } }).from.name.length, 40);
  var a = L.makeAck(m.id, 'opened', { id: 'mac1', name: 'MacBook', kind: 'desktop' }, 5, 'tap');
  assert.deepStrictEqual(a, { v: 1, id: m.id, st: 'opened', by: { id: 'mac1', name: 'MacBook', kind: 'desktop' }, at: 5, how: 'tap' });
  L.ACK_STATES.forEach(function (st) { assert.ok(L.readAck({ id: m.id, st: st, by: {} }), st); });
  assert.deepStrictEqual(L.ACK_STATES, ['opened', 'blocked', 'limited', 'expired', 'refused']);
  assert.strictEqual(L.readAck({ id: m.id, st: 'pwned', by: {} }), null);
  assert.strictEqual(L.readAck({ id: 'x', st: 'opened' }), null);
  assert.strictEqual(L.makeAck(m.id, 'opened', {}, 1, 'sideways').how, undefined);
});
test('what the sender shows', function () {
  var mac = { name: 'MacBook', live: true, ttl: 10, pop: '' }, now = 1e6;
  var s = function (st, d, age, how) { return L.statusFor({ st: st, t0: now - (age || 0), how: how }, d || mac, now); };
  assert.strictEqual(s('opened').text, 'Opened on MacBook ✓');
  assert.strictEqual(s('opened').tone, 'ok');
  assert.ok(/tap/i.test(s('opened', mac, 0, 'tap').sub));
  assert.ok(/note/.test(s('opened', mac, 0, 'note').text));
  assert.strictEqual(s('blocked').text, 'MacBook blocked the pop-up');
  assert.ok(/waiting there.*tap Open on that screen/.test(s('blocked').sub));
  assert.ok(/tap Open on that screen/.test(s('limited').sub));
  assert.strictEqual(s('expired').text, 'Saved to Missed links on MacBook');
  assert.ok(/refused/.test(s('refused').text));
  assert.strictEqual(s('sent', { name: 'MacBook', live: false, ttl: 10 }).text, 'MacBook is offline — it’ll open when txt is next open there (within 10 min)');
  assert.ok(/within 25 min/.test(s('sent', { name: 'W', live: false, ttl: 25 }).text), 'the receiver’s own TTL');
  assert.strictEqual(s('sent', mac, 1000).tone, 'busy');
  assert.ok(/blocked there/.test(s('sent', { name: 'M', live: true, ttl: 10, pop: 'blocked' }, 1000).sub));
  assert.ok(/hasn’t answered/.test(s('sent', mac, L.ANSWER_MS + 1).text));
  assert.ok(/Not opened in time/.test(s('sent', mac, 11 * 60000).text));
  assert.ok(/Sending to MacBook/.test(s('sending').text));
  assert.strictEqual(s('failed').tone, 'bad');
});
test('iOS Shortcut text and the bookmarklet', function () {
  var base = 'https://cadezawacki.github.io/txt.html';
  assert.strictEqual(L.shortcutTemplate(base), base + '?send=URL&title=TITLE');
  assert.strictEqual(L.shortcutTemplate(base, 'Work PC'), base + '?send=URL&title=TITLE&to=Work%20PC');
  // run each bookmarklet as a browser would: percent-decode once, then evaluate
  function runBm(bm, href, title) {
    assert.ok(bm.indexOf('javascript:') === 0);
    assert.ok(!/\s/.test(bm), 'no raw whitespace (pasted as an address)');
    var src = decodeURIComponent(bm.slice('javascript:'.length)), opened = null;
    vm.runInNewContext(src, { location: { href: href }, document: { title: title }, window: { open: function (u, t) { opened = [u, t]; } }, encodeURIComponent: encodeURIComponent });
    return opened;
  }
  var href = 'https://news.example/a?b=1&c=2#x', title = 'Q&A: 100% “quotes” \'n stuff';
  var o = runBm(L.bookmarklet(base), href, title);
  assert.strictEqual(o[0], base + '?send=' + encodeURIComponent(href) + '&title=' + encodeURIComponent(title));
  assert.strictEqual(o[1], '_blank');
  o = runBm(L.bookmarklet(base, "Cade's iPhone 100%"), href, title);
  var u = new URL(o[0]);
  assert.strictEqual(u.searchParams.get('send'), href);
  assert.strictEqual(u.searchParams.get('title'), title);
  assert.strictEqual(u.searchParams.get('to'), "Cade's iPhone 100%");
});
test('pop-up help names the right browser first', function () {
  var ua = {
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  };
  for (var k in ua) assert.strictEqual(L.popupBrowser(ua[k], 0), k, k);
  assert.strictEqual(L.popupBrowser(ua.safari, 5), 'ios', 'an iPad asking for the desktop site');
  var h = L.popupHelp(ua.chrome, 'cadezawacki.github.io', 0);
  assert.strictEqual(h.name, 'Chrome');
  assert.ok(/Always allow pop-ups and redirects/.test(h.steps.join(' ')) && /cadezawacki\.github\.io/.test(h.steps.join(' ')));
  assert.strictEqual(h.others.length, 4);
  assert.ok(/Allow pop-ups for/.test(L.popupHelp(ua.firefox, 'h').steps.join(' ')));
  assert.ok(/Settings for This Website/.test(L.popupHelp(ua.safari, 'h').steps.join(' ')) && /Pop-up Windows/.test(L.popupHelp(ua.safari, 'h').steps.join(' ')));
  assert.ok(/&lt;x&gt;/.test(L.popupHelp(ua.chrome, '<x>').steps.join(' ')), 'host escaped');
});
test('history: newest first, at most 20, updates in place; missed = not opened', function () {
  var h = [];
  for (var i = 0; i < 25; i++) h = L.histAdd(h, { id: 'id' + i, st: 'opened' });
  assert.strictEqual(h.length, 20); assert.strictEqual(h[0].id, 'id24');
  h = L.histAdd(h, { id: 'id20', st: 'blocked' });
  assert.strictEqual(h.length, 20); assert.strictEqual(h[0].id, 'id20'); assert.strictEqual(h.filter(function (x) { return x.id === 'id20'; }).length, 1);
  h = L.histUpdate(h, 'id21', { st: 'expired' });
  assert.deepStrictEqual(L.missedOf(h).map(function (x) { return x.id; }), ['id20', 'id21']);
  h = L.histUpdate(h, 'id20', { st: 'opened', how: 'tap' });
  assert.deepStrictEqual(L.missedOf(h).map(function (x) { return x.id; }), ['id21']);
  assert.strictEqual(L.fmtAgo(10000), 'just now'); assert.strictEqual(L.fmtAgo(5 * 60000), '5 min ago'); assert.strictEqual(L.fmtAgo(3 * 3600000), '3 h ago'); assert.strictEqual(L.fmtAgo(30 * 3600000), 'yesterday');
});
test('widget and receiver plugin register as the manifest says', function () {
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules;
  var w = man.filter(function (m) { return m.id === 'linksend'; })[0], p = man.filter(function (m) { return m.id === 'linksend-recv'; })[0];
  assert.ok(w && p, 'both in the manifest');
  assert.strictEqual(w.type, 'widget'); assert.strictEqual(w.entry, 'widgets/linksend/linksend.js');
  assert.strictEqual(p.type, 'plugin'); assert.strictEqual(p.settingKey, 'plugins.linksend-recv'); assert.strictEqual(p.default, false, 'opt-in per device');
  assert.strictEqual(p.section, 'Devices');
  assert.strictEqual(p.prefs.fields.filter(function (f) { return f.key === 'ttl'; })[0].default, L.TTL_DEFAULT);
  [w.entry, w.css].concat(w.precache, p.entry, p.precache).forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f); });
  var reg = null, plug = null, css = [];
  var fake = {
    Cade: {
      loadCSS: function (c) { css.push(c); }, asset: function (r) { return './txt/widgets/linksend/' + r; }, registerWidget: function (o) { reg = o; },
      registerPlugin: function (o) { plug = o; }, CM: { ViewPlugin: { define: function (f) { return { __vp: f }; } } }, escapeHtml: String
    },
    document: { addEventListener: function () {}, removeEventListener: function () {} },
    location: { href: 'https://cadezawacki.github.io/txt.html', host: 'cadezawacki.github.io' }
  };
  new Function('window', 'module', 'document', 'location', fs.readFileSync(path.join(__dirname, 'linksend.js'), 'utf8'))(fake, undefined, fake.document, fake.location);
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], w[k], k); });
  assert.ok(typeof fake.__cadeLinkSend.openSender === 'function' && typeof fake.__cadeLinkSend.openPanel === 'function');
  new Function('window', 'module', 'document', 'location', fs.readFileSync(path.join(__dirname, 'linksend-recv.js'), 'utf8'))(fake, undefined, fake.document, fake.location);
  assert.strictEqual(plug.id, 'linksend-recv');
  assert.ok(plug.ext && plug.ext.__vp, 'lifetime tied to an editor ViewPlugin');
  assert.deepStrictEqual(css, ['linksend.css', 'linksend.css']);
  assert.strictEqual(fake.__cadeLinkRecv.TEST_URL, 'https://cadezawacki.github.io/txt/widgets/linksend/opened.html');
});
test('the motion rule: no reduced-motion opt-outs', function () {
  ['linksend.css', 'linksend.js', 'linksend-recv.js', 'linksend-core.js'].forEach(function (f) {
    assert.ok(!/prefers-reduced-motion/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')), f);
  });
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'linksend: ' + passed + ' passed');
