package dev.cade.tracker

import javax.crypto.SecretKey

/**
 * One derived key per passphrase, kept for the life of the process.
 *
 * PBKDF2 at 100,000 iterations is ~100 ms — nothing, once; a stutter every
 * time a session closes, and a real cost on the shutdown path where the last
 * session has to be encrypted and written before the IDE goes away.
 *
 * Deliberately not in CadeCrypto: that object is the audited primitive, and
 * the parity harness compiles it on its own. Caching belongs out here.
 */
object CadeKeys {
    @Volatile private var cachedFor: String? = null
    @Volatile private var cached: SecretKey? = null

    @Synchronized
    fun keyFor(passphrase: String): SecretKey {
        // Compared by fingerprint rather than by the passphrase itself, so a
        // heap dump of a long-running IDE does not hand it over in plaintext.
        val fp = CadeCrypto.fingerprint(passphrase)
        cached?.let { if (cachedFor == fp) return it }
        val key = CadeCrypto.deriveKey(passphrase)
        cachedFor = fp
        cached = key
        return key
    }

    /** The passphrase changed in settings; the next close derives afresh. */
    @Synchronized
    fun invalidate() {
        cachedFor = null
        cached = null
    }
}
