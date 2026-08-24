#!/usr/bin/env bash
# Steps 2 and 3 of the build order, unattended.
#
#   ./tools/parity/run.sh [passphrase]
#
# Compiles the REAL CadeCrypto.kt, encrypts a record with it, and decrypts
# that with the REAL project/sync.js under Node. Also compares the two
# fingerprints. Nothing here reimplements either side — a parity check whose
# two halves are both copies proves only that the copies agree.
#
# Needs: a Kotlin compiler and Node 18+.
#   - `kotlinc` on PATH, or
#   - KOTLINC_JARS=<dir of kotlin-compiler-embeddable + its deps>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
pass="${1:-parity-test-passphrase}"
json='{"id":"parity","projectName":"cadezawacki.github.io","activeSeconds":1544,"files":[{"path":"project/sync.js","seconds":840,"edits":312}],"closedBy":"idle"}'
out="$root/build/parity"
src="$root/src/main/kotlin/dev/cade/tracker"

mkdir -p "$out"

if command -v kotlinc >/dev/null 2>&1; then
  kotlinc "$src/CadeCrypto.kt" "$src/CryptoSelfTest.kt" -d "$out/classes" -nowarn
  run_cp="$out/classes:$(dirname "$(command -v kotlinc)")/../lib/kotlin-stdlib.jar"
elif [ -n "${KOTLINC_JARS:-}" ]; then
  cp_all="$(find "$KOTLINC_JARS" -name '*.jar' | tr '\n' ':')"
  java -Xmx1g -cp "$cp_all" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
    "$src/CadeCrypto.kt" "$src/CryptoSelfTest.kt" \
    -classpath "$KOTLINC_JARS/kotlin-stdlib.jar" -d "$out/classes" -nowarn 2>/dev/null ||
  java -Xmx1g -cp "$cp_all" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
    "$src/CadeCrypto.kt" "$src/CryptoSelfTest.kt" \
    -classpath "$(find "$KOTLINC_JARS" -name 'kotlin-stdlib*.jar' | head -1)" \
    -d "$out/classes" -nowarn
  run_cp="$out/classes:$(find "$KOTLINC_JARS" -name 'kotlin-stdlib*.jar' | head -1)"
else
  echo "no kotlinc on PATH and KOTLINC_JARS unset" >&2
  exit 2
fi

kout="$(java -cp "$run_cp" dev.cade.tracker.CryptoSelfTestKt "$pass" "$json" --raw 2>/dev/null)"
fp="$(printf '%s\n' "$kout" | sed -n 's/^fp=//p')"
enc="$(printf '%s\n' "$kout" | sed -n 's/^enc=//p')"

echo "kotlin fingerprint : $fp"
node "$here/decrypt.js" "$pass" "$enc" "$fp" >"$out/decrypted.txt"
grep -v '^RESULT ' "$out/decrypted.txt"

# The decrypted object must be the object that went in. Byte-compare the
# machine-readable tail decrypt.js prints against the input JSON.
got="$(sed -n 's/^RESULT //p' "$out/decrypted.txt")"
if [ "$got" != "$json" ]; then
  echo "FAIL: round trip changed the payload" >&2
  echo "  in : $json" >&2
  echo "  out: $got" >&2
  exit 1
fi
echo
echo "PASS — fingerprints agree and sync.js read what CadeCrypto wrote."
