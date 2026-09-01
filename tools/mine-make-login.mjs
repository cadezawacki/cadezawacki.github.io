// mine-make-login.mjs — generates the login ciphertexts embedded in mine.html.
//
//   node tools/mine-make-login.mjs
//
// Same scheme as ppc.html (see tools/ppc-make-login.mjs): each ciphertext is
// the Firebase database URL encrypted with one access word, so the public
// page never carries the URL in the clear. The words are the same two login
// words the players already use for ppc — the gate is anti-spam, not high
// security.
// Wire format is byte-compatible with mine.html's decryptText (same as txt.html):
//   base64( [magic CA DE 01 00][IV 12 bytes][AES-GCM( deflate-raw(url) )] )
// with the AES key derived via PBKDF2 (salt 'cade.txt-salt', 100k iters, SHA-256).
//
// Paste the printed values into LOGIN_CTS in mine.html. Re-run only if the
// database URL or an access word changes.
import { webcrypto as wc } from 'crypto';
import zlib from 'zlib';

const URLPLAIN = 'https://cadetxt-default-rtdb.firebaseio.com';
const WORDS = ['cades', 'aves'];

async function deriveKey(pw, usages) {
  const enc = new TextEncoder();
  const km = await wc.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return wc.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('cade.txt-salt'), iterations: 100000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, usages);
}

async function make(pw) {
  const key = await deriveKey(pw, ['encrypt']);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ct = Buffer.from(await wc.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, zlib.deflateRawSync(Buffer.from(URLPLAIN, 'utf8'))));
  return Buffer.concat([Buffer.from([0xCA, 0xDE, 0x01, 0x00]), Buffer.from(iv), ct]).toString('base64');
}

// Mirror of the page's decryptText, to prove each ciphertext round-trips.
async function decrypt(encoded, pw) {
  const raw = Buffer.from(encoded, 'base64');
  if (!(raw[0] === 0xCA && raw[1] === 0xDE && raw[2] === 0x01 && raw[3] === 0x00)) return null;
  const key = await deriveKey(pw, ['decrypt']);
  try {
    const plain = await wc.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(4, 16) }, key, raw.subarray(16));
    return zlib.inflateRawSync(Buffer.from(plain)).toString('utf8');
  } catch { return null; }
}

for (const w of WORDS) {
  const ct = await make(w);
  const ok = (await decrypt(ct, w)) === URLPLAIN;
  const cross = await decrypt(ct, 'wrong-word');
  if (!ok || cross !== null) throw new Error(`self-test failed for "${w}"`);
  console.log(`${w} => '${ct}'`);
}
console.log('self-test passed: both decrypt with their word, neither with a wrong word');
