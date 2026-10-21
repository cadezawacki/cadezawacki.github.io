/* Part-of-speech tagging for Prose EKG and Word Echoes, off the main thread.
 *
 * Started by nlp-client.js while one of those panels is open. It loads the
 * compromise NLP library (pinned, from jsDelivr; the service worker keeps a
 * copy after the first load) plus ekg-core.js, whose nlpEncode() turns a
 * paragraph into compact arrays: term offsets, a bit set of tags and the
 * root form (went → go, children → child). Compromise needs ~300 ms to
 * initialise and ~0.5 ms per sentence, which is why it lives here and not
 * on the page: typing never waits for it.
 *
 * Protocol: → { id, texts: [prepared paragraph…] }
 *           ← { type: 'ready', version } | { type: 'fail', error }
 *           ← { type: 'tags', id, texts, out: [encoded | null…] } */
'use strict';
var NLP_URL = 'https://cdn.jsdelivr.net/npm/compromise@14.18.0/builds/compromise.js';
var core = null, nlp = null;
try {
  importScripts('ekg-core.js');
  core = self.__cadeEkgCore;
  importScripts(NLP_URL);
  nlp = self.nlp;
  if (!core || typeof core.nlpEncode !== 'function' || typeof nlp !== 'function') throw new Error('library missing');
  core.nlpEncode(nlp, 'Warm up the tagger.');
  self.postMessage({ type: 'ready', version: nlp.version || '' });
} catch (e) {
  nlp = null;
  self.postMessage({ type: 'fail', error: String((e && e.message) || e) });
}
self.onmessage = function (e) {
  var d = e.data || {}, texts = d.texts || [], out = [];
  if (!nlp) return;
  for (var i = 0; i < texts.length; i++) {
    var r = null;
    try { r = core.nlpEncode(nlp, String(texts[i])); } catch (x) { r = null; }
    out.push(r);
  }
  self.postMessage({ type: 'tags', id: d.id, texts: texts, out: out });
};
