// One-shot VAPID key generator for The Wire (ppc fitness push).
//   node tools/vapid-keygen.mjs
// Prints a fresh public/private pair. Paste the PUBLIC key into ppc.html
// (`const VAPID_PUB = ...`) and store the PRIVATE key as the repository
// Actions secret VAPID_PRIVATE_KEY (Settings → Secrets and variables →
// Actions → New repository secret). Both halves must come from the SAME
// run — a private key from an older pair will not sign for the public key
// the phones subscribed with. After rotating the public key, every phone
// has to re-run Settings → "Enable on this phone" once.
//
// No dependencies: uses Node's WebCrypto (Node ≥ 18).
import { webcrypto as crypto } from 'node:crypto';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('raw', key.publicKey);          // 65 bytes, uncompressed point
const jwk = await crypto.subtle.exportKey('jwk', key.privateKey);          // d = private scalar, already base64url

console.log('VAPID public key  (ppc.html → VAPID_PUB):');
console.log('  ' + b64url(pub));
console.log('VAPID private key (Actions secret → VAPID_PRIVATE_KEY):');
console.log('  ' + jwk.d);
console.log('\nNext: paste the public key into ppc.html, add the secret, then re-enable push on each phone.');
