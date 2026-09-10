// VAPID key tool for The Wire (ppc fitness push). No dependencies, Node ≥ 18.
//
//   node tools/vapid-keygen.mjs            → mint a fresh pair
//   VAPID_PRIVATE_KEY=… node tools/vapid-keygen.mjs --check
//                                          → does this private key match the
//                                            public key in ppc.html?
//
// The PUBLIC key lives in ppc.html (`const VAPID_PUB = ...`); the PRIVATE key
// lives only in the repo's Actions secret VAPID_PRIVATE_KEY (Settings →
// Secrets and variables → Actions). Both halves must come from the SAME
// pair — a private key from another pair cannot sign for the public key the
// phones subscribed with (push services answer 401/403). After rotating the
// public key, every phone has to re-run Settings → "Enable on this phone".
import { webcrypto, createECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4), 'base64');

if (process.argv.includes('--check')) {
  // read the private key from the env (not argv — keeps it out of shell history)
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!priv) { console.error('set VAPID_PRIVATE_KEY in the environment, e.g.\n  VAPID_PRIVATE_KEY=… node tools/vapid-keygen.mjs --check'); process.exit(2); }
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ppc.html'), 'utf8');
  const m = /const VAPID_PUB = '([A-Za-z0-9_-]+)'/.exec(page);
  if (!m) { console.error('could not find VAPID_PUB in ppc.html'); process.exit(2); }
  let derived;
  try {
    const raw = fromB64url(priv);
    if (raw.length !== 32) throw new Error('private key should decode to 32 bytes, got ' + raw.length);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(raw);
    derived = b64url(ecdh.getPublicKey());          // 65-byte uncompressed point, same form web-push uses
  } catch (e) {
    console.error('that is not a valid VAPID private key: ' + e.message); process.exit(1);
  }
  if (derived === m[1]) {
    console.log('✅ MATCH — this private key signs for the VAPID_PUB in ppc.html.');
    console.log('   Store it as the VAPID_PRIVATE_KEY Actions secret, then run the fit-push workflow manually (Actions → fit-push → Run workflow) and look for "sent …" lines.');
  } else {
    console.log('❌ NO MATCH — this private key belongs to a different pair.');
    console.log('   ppc.html public key: ' + m[1]);
    console.log('   this key derives to:  ' + derived);
    console.log('   Either find the original private key, or mint a new pair (node tools/vapid-keygen.mjs), paste the new public key into ppc.html, set the secret, and re-enable push on each phone.');
    process.exit(1);
  }
} else {
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await webcrypto.subtle.exportKey('raw', key.publicKey);   // 65 bytes, uncompressed point
  const jwk = await webcrypto.subtle.exportKey('jwk', key.privateKey);  // d = private scalar, already base64url
  console.log('VAPID public key  (ppc.html → VAPID_PUB):');
  console.log('  ' + b64url(pub));
  console.log('VAPID private key (Actions secret → VAPID_PRIVATE_KEY):');
  console.log('  ' + jwk.d);
  console.log('\nNext: paste the public key into ppc.html, add the secret, then re-enable push on each phone.');
  console.log('Verify any time with: VAPID_PRIVATE_KEY=… node tools/vapid-keygen.mjs --check');
}
