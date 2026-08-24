package dev.cade.tracker

import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.zip.GZIPOutputStream
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Byte-for-byte compatible with project/sync.js. Two traps live here; get
 * either wrong and the plugin writes ciphertext nobody can read to a path
 * nobody reads, with no error on either side.
 *
 * Prove it before building anything on top — see CryptoSelfTest and
 * tools/parity/run.sh, which decrypt this object's output with the real
 * sync.js.
 */
object CadeCrypto {
    private const val MAGIC = "CP1"
    private const val ITERATIONS = 100_000

    // TRAP 1 — the same constant is used two different ways in sync.js.
    //
    // Key derivation (sync.js: `salt: SALT`) passes the raw Uint8Array, i.e.
    // the 8 ASCII bytes of "CadeProj".
    private val SALT_BYTES = byteArrayOf(0x43, 0x61, 0x64, 0x65, 0x50, 0x72, 0x6f, 0x6a)

    // The fingerprint (sync.js: `enc.encode(passphrase + SALT)`) does JS
    // string concatenation, which coerces the Uint8Array via toString() and
    // yields the DECIMAL COMMA-JOINED form. Not the bytes. Not "CadeProj".
    private const val SALT_JS_STRING = "67,97,100,101,80,114,111,106"

    // TRAP 2 — WebCrypto's importKey('raw', enc.encode(passphrase)) keys off
    // the UTF-8 bytes of the passphrase. SunJCE's PBKDF2WithHmacSHA256 also
    // UTF-8-encodes the char[], so the two agree — but by implementation
    // detail rather than by specification. A non-ASCII passphrase is worth
    // checking against a known vector before you trust it.
    fun deriveKey(passphrase: String): SecretKey {
        require(passphrase.isNotEmpty()) { "passphrase is empty" }
        val spec = PBEKeySpec(passphrase.toCharArray(), SALT_BYTES, ITERATIONS, 256)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        return SecretKeySpec(factory.generateSecret(spec).encoded, "AES")
    }

    /** First 8 bytes of SHA-256, hex — the `<fp>` path segment. 16 chars. */
    fun fingerprint(passphrase: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest((passphrase + SALT_JS_STRING).toByteArray(Charsets.UTF_8))
            .take(8)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** JSON → gzip → AES-GCM → "CP1" + iv(12) + ct+tag → base64. */
    fun encrypt(json: String, key: SecretKey): String {
        val gz = ByteArrayOutputStream().also { bos ->
            GZIPOutputStream(bos).use { it.write(json.toByteArray(Charsets.UTF_8)) }
        }.toByteArray()

        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // A 128-bit tag matches WebCrypto's default, and Java appends it to
        // the ciphertext exactly as WebCrypto does — so the layouts line up
        // and no repacking is needed on either side.
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        val ct = cipher.doFinal(gz)

        return Base64.getEncoder()
            .encodeToString(MAGIC.toByteArray(Charsets.UTF_8) + iv + ct)
    }
}
