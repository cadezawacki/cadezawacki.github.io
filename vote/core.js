// Shared by the voter page (voteuser.html) and the admin page (voteleader.html).
//
// Storage follows the same approach as txt.html: Firebase Realtime Database
// over its REST API, no sign-in, payloads AES-GCM encrypted in the browser
// with a PBKDF2-derived key. Everything lives under rooms/ so it is covered
// by the existing database rules (see project/FIREBASE_RULES.md).
//
//   rooms/__vote_idx_<fp>        admin's race list, sealed with the admin passphrase
//   rooms/__vote_<race>/meta     { name, entries:[{id,name}], parent? } sealed with the race key
//   rooms/__vote_<race>/lock     server timestamp while locked, absent otherwise
//   rooms/__vote_<race>/votes/<voterId>  { d: sealed {r:[ids]}, t: server timestamp }
//
// A race key is random and only ever travels in the voter link's #fragment,
// so a QR code never exposes the admin passphrase.
const V = (() => {
  const te = new TextEncoder(), td = new TextDecoder();

  const b64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64u = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (s) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return unb64(s);
  };

  const rid = (n = 9) => b64u(crypto.getRandomValues(new Uint8Array(n)));

  const keys = new Map();
  function deriveKey(pw) {
    let p = keys.get(pw);
    if (!p) {
      p = (async () => {
        const km = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: te.encode('cade.vote-salt'), iterations: 100000, hash: 'SHA-256' },
          km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      })();
      p.catch(() => keys.delete(pw));
      keys.set(pw, p);
    }
    return p;
  }

  async function seal(obj, pw) {
    const key = await deriveKey(pw);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return b64(out);
  }

  async function unseal(str, pw) {
    const raw = unb64(str);
    const key = await deriveKey(pw);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
    return JSON.parse(td.decode(pt));
  }

  async function fingerprint(pw) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode('vote-fp:' + pw)));
    return Array.from(h.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const normUrl = (u) => (u || '').trim().replace(/\/+$/, '');

  async function rest(base, path, method = 'GET', body) {
    const opts = { method, cache: 'no-store' };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(normUrl(base) + '/' + path + '.json', opts);
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Permission denied' : 'Network error ' + r.status);
    return r.json();
  }

  const SERVER_TIME = { '.sv': 'timestamp' };
  const racePath = (id) => 'rooms/__vote_' + id;
  const indexPath = (fp) => 'rooms/__vote_idx_' + fp;

  // Voter link payload lives in the #fragment, which browsers never send to a server.
  const encodeLink = (o) => b64u(te.encode(JSON.stringify(o)));
  const decodeLink = (s) => { try { return JSON.parse(td.decode(unb64u(s))); } catch { return null; } };

  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return { rid, seal, unseal, fingerprint, normUrl, rest, SERVER_TIME, racePath, indexPath, encodeLink, decodeLink, store, esc };
})();
