/* Decrypts a CP1 blob using the REAL project/sync.js — not a reimplementation
   of it. sync.js is loaded verbatim into a sandbox with the browser globals it
   touches; the point of the exercise is that no second copy of the algorithm
   exists to drift out of step with the first.

     node decrypt.js <passphrase> <cp1-base64> [expected-fingerprint]

   Exits non-zero on any mismatch. Used by run.sh; also useful on its own when
   a record in the queue will not decrypt and you want to know which half is
   wrong. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [, , passphrase, enc, expectedFp] = process.argv;
if (!passphrase || !enc) {
  console.error('usage: node decrypt.js <passphrase> <cp1-base64> [expected-fp]');
  process.exit(2);
}

const syncPath = path.resolve(__dirname, '../../../project/sync.js');
const source = fs.readFileSync(syncPath, 'utf8');

// sync.js reads State and the DOM, but only from inside functions the parity
// check never calls. Stubs keep the module-level IIFE happy.
const sandbox = {
  console,
  crypto: globalThis.crypto,
  TextEncoder, TextDecoder,
  CompressionStream, DecompressionStream,
  btoa, atob,
  setTimeout, clearTimeout,
  structuredClone,
  State: { getSettings: () => ({ sync: {} }), getRawData: () => ({}), getSyncableData: () => ({}) },
  document: { getElementById: () => null },
  window: { addEventListener() {}, dispatchEvent() {} },
  CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// sync.js declares `const Sync` at the top level of a script, and a top-level
// const never lands on the global object — so read it as the script's
// completion value instead of off the sandbox.
const Sync = vm.runInContext(source + '\n;Sync;', sandbox, { filename: syncPath });

(async () => {
  await Sync._test.setKey(passphrase);

  // Fingerprint parity. sync.js derives it as a side effect of deriveKey and
  // keeps it private, so recompute it here the way sync.js does — string
  // concatenation with the Uint8Array salt, decimal-coerced.
  const SALT = new Uint8Array([0x43, 0x61, 0x64, 0x65, 0x50, 0x72, 0x6f, 0x6a]);
  const buf = await sandbox.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(passphrase + SALT));
  const fp = Array.from(new Uint8Array(buf.slice(0, 8)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const decoded = await Sync.decrypt(enc);

  console.log('js fingerprint : ' + fp);
  console.log('decrypted      : ' + JSON.stringify(decoded));

  if (expectedFp && expectedFp !== fp) {
    console.error(`FAIL: fingerprint mismatch — kotlin ${expectedFp} vs js ${fp}`);
    process.exit(1);
  }
  // Machine-readable tail, on its own marked line so run.sh can compare it
  // byte for byte against the payload that went in.
  console.log('RESULT ' + JSON.stringify(decoded));
})().catch(e => {
  console.error('FAIL: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
