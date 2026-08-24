package dev.cade.tracker

/**
 * Step 2 and 3 of the build order, as one command. Depends on nothing but
 * the JDK, so it runs without the IDE and without the plugin being installed:
 *
 *   kotlinc CadeCrypto.kt CryptoSelfTest.kt -include-runtime -d selftest.jar
 *   java -cp selftest.jar dev.cade.tracker.CryptoSelfTestKt "my passphrase"
 *
 * Then, in a browser console on the app with sync connected:
 *
 *   await Sync.decrypt("<the CP1 base64 printed below>")
 *
 * If that returns the object, the whole crypto boundary is proven and every
 * later bug is somewhere easier to reach. The printed fingerprint must also
 * match the `<fp>` segment the app uses in its own Firebase path — the two
 * halves agree on it or they agree on nothing, and neither one errors.
 *
 * tools/parity/run.sh does both checks unattended.
 */
fun main(args: Array<String>) {
    val raw = args.contains("--raw")
    val positional = args.filterNot { it.startsWith("--") }
    val passphrase = positional.getOrNull(0) ?: run {
        System.err.println("usage: CryptoSelfTest <passphrase> [json] [--raw]")
        return
    }
    val json = positional.getOrNull(1) ?: """{"hi":1}"""

    val fp = CadeCrypto.fingerprint(passphrase)
    val enc = CadeCrypto.encrypt(json, CadeCrypto.deriveKey(passphrase))

    if (raw) {
        // Machine-readable: one key=value per line, for the parity harness.
        println("fp=$fp")
        println("enc=$enc")
        return
    }

    println("passphrase   : $passphrase")
    println("plaintext    : $json")
    println("fingerprint  : $fp")
    println("path         : ide/$fp/q/<uuid>")
    println()
    println("CP1 base64   :")
    println(enc)
    println()
    println("Paste into the app's console:  await Sync.decrypt(\"<that>\")")
}
