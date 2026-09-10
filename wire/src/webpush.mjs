// Web Push for Cloudflare Workers — VAPID (RFC 8292) + aes128gcm payload
// encryption (RFC 8291 / RFC 8188) on WebCrypto only. The `web-push` npm
// package needs Node's crypto module and does not run in Workers.
//
//   const send = makeSender({ publicKey, privateKey, subject });
//   await send(subscription, '{"title":"…"}', 3600);   // throws {statusCode} on failure

const te = new TextEncoder();
export const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = s => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// RFC 8291 §3 — returns the aes128gcm body (header || ciphertext). `fixed`
// (ephemeral key pair + salt) is only for the RFC test vector.
export async function encryptPayload(p256dhB64, authB64, plaintext, fixed) {
  const uaPublic = fromB64url(p256dhB64);                 // 65 bytes, uncompressed
  const authSecret = fromB64url(authB64);                 // 16 bytes
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const asPair = fixed && fixed.asPrivateJwk
    ? { privateKey: await crypto.subtle.importKey('jwk', fixed.asPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']), publicRaw: fromB64url(fixed.asPublic) }
    : await (async () => { const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); return { privateKey: kp.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) }; })();
  const asPublic = asPair.publicRaw;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPair.privateKey, 256));
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = fixed && fixed.salt ? fromB64url(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const padded = concat(typeof plaintext === 'string' ? te.encode(plaintext) : plaintext, new Uint8Array([2]));   // 0x02 = last record delimiter
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));
  const rs = 4096;
  const header = concat(salt, new Uint8Array([rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ct);
}

// RFC 8292 — ES256 JWT over {aud, exp, sub}, signed with the VAPID private key.
export async function vapidAuthHeader(endpoint, { publicKey, privateKey, subject }, expSeconds) {
  const pub = fromB64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: privateKey, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + (expSeconds || 12 * 3600);
  const enc = o => b64url(te.encode(JSON.stringify(o)));
  const signingInput = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp, sub: subject });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signingInput)));   // raw r||s, as JWS wants
  return `vapid t=${signingInput}.${b64url(sig)}, k=${publicKey}`;
}

export function makeSender(vapid) {
  if (!vapid.publicKey || !vapid.privateKey) throw new Error('VAPID keys missing');
  return async function send(sub, payload, ttl) {
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      const e = new Error('malformed subscription'); e.statusCode = 400; throw e;
    }
    const body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, payload);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(body.length),
        TTL: String(ttl || 3600),
        Urgency: 'high',
        Authorization: await vapidAuthHeader(sub.endpoint, vapid),
      },
      body,
    });
    if (r.status >= 200 && r.status < 300) return { statusCode: r.status };
    const e = new Error(`push service ${r.status}: ${(await r.text()).slice(0, 200)}`);
    e.statusCode = r.status;
    throw e;
  };
}
