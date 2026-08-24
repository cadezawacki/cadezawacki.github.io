package dev.cade.tracker

import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.logger
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.createDirectories
import kotlin.io.path.deleteIfExists
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.nameWithoutExtension
import kotlin.io.path.readText
import kotlin.io.path.writeText

/**
 * Append-only writer over Firebase's REST API. Every record is its own node
 * under its own uuid, so a retry is a no-op rather than a corruption — which
 * is the entire reason this design stays out of sync.js's read-modify-write
 * protocol.
 *
 * No Firebase SDK and no HTTP library: java.net.http.HttpClient is enough,
 * and that matters — shading the Firebase Admin SDK into an IDE plugin is
 * misery, and every megabyte of it would be there to do one PUT.
 */
object CadeClient {
    private val log = logger<CadeClient>()

    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    // Under the system path rather than the config path: this is a spool, not
    // a setting, and it must not travel with Settings Sync.
    private val queueDir: Path = Path.of(PathManager.getSystemPath()).resolve("cade-tracker-queue")

    private fun queue(): Path? = runCatching { queueDir.createDirectories() }
        .onFailure { log.warn("Cade: cannot create the queue directory", it) }
        .getOrNull()

    // The status bar asks for this on every repaint, and a directory listing
    // on the EDT is a directory listing on the EDT. Kept up to date by the two
    // places that change the queue instead.
    private val depth = AtomicInteger(-1)

    /**
     * Persist first, transmit second. A crash in between loses nothing, and
     * an IDE that was offline all afternoon sends the afternoon on restart.
     */
    fun submit(recordId: String, envelopeJson: String, transmit: Boolean = true) {
        val dir = queue() ?: return
        val f = dir.resolve("$recordId.json")
        val written = runCatching { f.writeText(envelopeJson) }
            .onFailure { log.warn("Cade: could not queue $recordId", it) }
            .isSuccess
        if (!written) return
        recount()
        if (transmit) flush()
    }

    /**
     * Drains the disk queue. Safe to call from anywhere; never on the EDT.
     * Returns how many records were accepted by the server.
     */
    @Synchronized
    fun flush(perRequestTimeout: Duration = Duration.ofSeconds(20), budgetMs: Long = Long.MAX_VALUE): Int {
        val s = CadeSettings.get()
        if (!s.isConfigured()) return 0
        val dir = queue() ?: return 0
        val fp = CadeCrypto.fingerprint(s.passphrase!!)
        val base = s.baseUrl()
        val deadline = if (budgetMs == Long.MAX_VALUE) Long.MAX_VALUE
                       else System.currentTimeMillis() + budgetMs
        var sent = 0

        val pending = runCatching { dir.listDirectoryEntries("*.json") }.getOrElse { return 0 }
        for (f in pending.sortedBy { it.fileName.toString() }) {
            if (System.currentTimeMillis() >= deadline) break
            val id = f.nameWithoutExtension
            val body = runCatching { f.readText() }.getOrNull() ?: continue

            when (val code = put("$base/ide/$fp/q/$id.json?print=silent", body, perRequestTimeout)) {
                200, 204 -> { runCatching { f.deleteIfExists() }; sent++ }
                // Rules refuse the write. Retrying cannot fix a configuration
                // fault, and retrying anyway means every session close fires
                // another denied request — sync.js's `refusal` latch, same
                // reasoning, one path over.
                401, 403 -> {
                    log.warn("Cade: the database refused ide/$fp — its rules do not allow " +
                        "writing there. Add the \"ide\" rule; see project/FIREBASE_RULES.md.")
                    Notifier.refused()
                    recount()
                    return sent
                }
                // Offline, DNS down, a 5xx: the record stays queued and the
                // next flush tries again. Stop the loop either way — if one
                // request could not reach the server, the next twenty won't.
                else -> {
                    log.debug("Cade: $id stays queued (status $code)")
                    recount()
                    return sent
                }
            }
        }
        recount()
        return sent
    }

    /** Status code, or -1 when the request never reached a server. */
    private fun put(url: String, body: String, timeout: Duration = Duration.ofSeconds(20)): Int {
        val req = HttpRequest.newBuilder(URI.create(url))
            .timeout(timeout)
            .header("Content-Type", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString(body))
            .build()
        return runCatching { http.send(req, HttpResponse.BodyHandlers.ofString()).statusCode() }
            .getOrElse { -1 }
    }

    /**
     * Writes a throwaway record and reports what the server said, verbatim.
     * A 403 here means the rules are missing the `ide` path — saying so in
     * the settings dialog saves a console-archaeology session.
     */
    fun testConnection(databaseUrl: String, passphrase: String): String {
        if (databaseUrl.isBlank()) return "Set the database URL first."
        if (passphrase.isBlank()) return "Set the passphrase first."
        val fp = runCatching { CadeCrypto.fingerprint(passphrase) }
            .getOrElse { return "Could not derive the fingerprint: ${it.message}" }
        val base = databaseUrl.trim().trimEnd('/')
        val url = "$base/ide/$fp/probe.json?print=silent"
        return when (val code = put(url, """{"v":1,"probe":true}""")) {
            200, 204 -> {
                runCatching {
                    http.send(
                        HttpRequest.newBuilder(URI.create(url)).DELETE().build(),
                        HttpResponse.BodyHandlers.discarding(),
                    )
                }
                "OK — wrote and removed ide/$fp/probe. Records will land at ide/$fp/q/."
            }
            401, 403 -> "$code — the database refused the write. Its rules do not allow " +
                "writing under \"ide\". See project/FIREBASE_RULES.md."
            404 -> "404 — no database at that URL. Check for a typo, and that the URL is the " +
                "Realtime Database one (…-default-rtdb.firebaseio.com), not the project URL."
            -1 -> "Could not reach $base at all — offline, or the URL does not resolve."
            else -> "HTTP $code — unexpected. The record was not written."
        }
    }

    /**
     * A silently growing queue is the one failure the user must be able to
     * see, so this is cheap enough to call from a paint: it reads a counter
     * rather than the directory, and only counts for real when it has never
     * counted before.
     */
    fun queueDepth(): Int {
        val cached = depth.get()
        if (cached >= 0) return cached
        return recount()
    }

    private fun recount(): Int {
        val n = runCatching { queueDir.listDirectoryEntries("*.json").size }.getOrDefault(0)
        depth.set(n)
        return n
    }
}
