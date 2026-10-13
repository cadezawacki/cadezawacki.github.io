#!/usr/bin/env python3
"""Mirror the files listed in files.json into this repository.

Each file is downloaded from its source URL, checked against the size and
SHA-256 that Mozilla publishes for it (Remote Settings collection
"translations-models"), and committed + pushed in batches. GitHub Pages then
serves it at https://cadezawacki.github.io/<repo>/<path>, where Cade.txt's
Decode Lab fetches it (and verifies the SHA-256 again before use).
Idempotent: files already present with the right hash are skipped.
"""
import hashlib, json, os, subprocess, time, urllib.request

BATCH = 250 * 1024 * 1024  # bytes per commit/push


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(url, dest, size, digest):
    tmp = dest + '.part'
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'cade-txt-models-mirror'})
            with urllib.request.urlopen(req, timeout=180) as r, open(tmp, 'wb') as out:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    out.write(b)
            got_size = os.path.getsize(tmp)
            if got_size != size:
                raise ValueError('size %d, expected %d' % (got_size, size))
            got = sha256(tmp)
            if got != digest:
                raise ValueError('sha256 %s, expected %s' % (got, digest))
            os.replace(tmp, dest)
            return
        except Exception as e:  # noqa: BLE001 - retry anything, fail loudly at the end
            print('  retry %d: %s (%s)' % (attempt + 1, url, e), flush=True)
            time.sleep(5 * (attempt + 1))
    if os.path.exists(tmp):
        os.remove(tmp)
    raise SystemExit('FAILED ' + url)


def git(*args):
    subprocess.check_call(['git'] + list(args))


def commit(msg):
    git('add', '-A', '.')
    if subprocess.call(['git', 'diff', '--cached', '--quiet']) != 0:
        git('commit', '-q', '-m', msg)
        git('push', '-q', 'origin', 'HEAD')


def main():
    files = json.load(open('files.json'))
    pending = done = 0
    for f in files:
        dest = f['path']
        if dest.startswith('/') or '..' in dest.split('/'):
            raise SystemExit('bad path ' + dest)
        if os.path.exists(dest) and os.path.getsize(dest) == f['size'] and sha256(dest) == f['sha256']:
            continue
        os.makedirs(os.path.dirname(dest) or '.', exist_ok=True)
        print('fetch %s (%.1f MB)' % (dest, f['size'] / 1e6), flush=True)
        fetch(f['url'], dest, f['size'], f['sha256'])
        pending += f['size']
        done += 1
        if pending >= BATCH:
            commit('Mirror models (%d files so far)' % done)
            pending = 0
    commit('Mirror models (%d files)' % done)
    print('done: %d downloaded, %d listed' % (done, len(files)))


if __name__ == '__main__':
    main()
