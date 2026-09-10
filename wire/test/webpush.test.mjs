// node wire/test/webpush.test.mjs — RFC 8291 Appendix A vector + a round trip
// (Node ≥ 20: WebCrypto is global). No network.
import { encryptPayload, vapidAuthHeader, b64url, fromB64url } from '../src/webpush.mjs';
import { createECDH, hkdfSync, createDecipheriv, createPublicKey, createVerify } from 'node:crypto';

// --- RFC 8291 §5 / Appendix A test vector ---
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const asPub = fromB64url(V.asPublic);
const asJwk = { kty: 'EC', crv: 'P-256', d: V.asPrivate, x: b64url(asPub.slice(1, 33)), y: b64url(asPub.slice(33)), ext: true };
const body = await encryptPayload(V.uaPublic, V.auth, V.plaintext, { asPrivateJwk: asJwk, asPublic: V.asPublic, salt: V.salt });
const got = b64url(body);
console.log(got === V.body ? 'PASS rfc8291 vector' : 'FAIL rfc8291 vector\n got ' + got + '\n exp ' + V.body);
if (got !== V.body) process.exit(1);

// --- round trip with random keys, decrypted independently with Node crypto ---
const ua = createECDH('prime256v1'); ua.generateKeys();
const auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
const msg = JSON.stringify({ title: '💬 Avery', body: 'round trip ' + Date.now() });
const out = await encryptPayload(b64url(ua.getPublicKey()), auth, msg);
const salt = out.slice(0, 16), rs = new DataView(out.buffer).getUint32(16), idlen = out[20], asPublic = out.slice(21, 21 + idlen), ct = out.slice(21 + idlen);
const secret = ua.computeSecret(asPublic);
const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), Buffer.from(asPublic)]);
const ikm = Buffer.from(hkdfSync('sha256', secret, fromB64url(auth), keyInfo, 32));
const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
const d = createDecipheriv('aes-128-gcm', cek, nonce);
d.setAuthTag(ct.slice(-16));
const pt = Buffer.concat([d.update(ct.slice(0, -16)), d.final()]);
const ok = rs === 4096 && pt[pt.length - 1] === 2 && pt.slice(0, -1).toString() === msg;
console.log(ok ? 'PASS round trip' : 'FAIL round trip'); if (!ok) process.exit(1);

// --- VAPID header: signature verifies with the public key, claims are right ---
const kp = createECDH('prime256v1'); kp.generateKeys();
const vapid = { publicKey: b64url(kp.getPublicKey()), privateKey: b64url(kp.getPrivateKey()), subject: 'mailto:test@example.com' };
const hdr = await vapidAuthHeader('https://web.push.apple.com/QAbc123', vapid, 3600);
const m = /^vapid t=([^,]+), k=(.+)$/.exec(hdr);
const [h, p, s] = m[1].split('.');
const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
const pubKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(kp.getPublicKey().slice(1, 33)), y: b64url(kp.getPublicKey().slice(33)) }, format: 'jwk' });
const v = createVerify('SHA256'); v.update(h + '.' + p);
const sigOk = v.verify({ key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
const claimsOk = claims.aud === 'https://web.push.apple.com' && claims.sub === vapid.subject && claims.exp > Date.now() / 1000 && m[2] === vapid.publicKey;
console.log(sigOk && claimsOk ? 'PASS vapid jwt' : 'FAIL vapid jwt ' + JSON.stringify({ sigOk, claimsOk, claims }));
if (!(sigOk && claimsOk)) process.exit(1);
console.log('all good');
