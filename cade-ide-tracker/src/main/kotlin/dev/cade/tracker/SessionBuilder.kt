package dev.cade.tracker

import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.project.Project
import java.net.InetAddress
import java.time.Instant
import java.util.UUID

/**
 * Accumulates heartbeats into one session record.
 *
 * The project's name and path are captured at construction rather than read
 * at close: a session frequently outlives the window it belongs to, and
 * reaching into a disposed Project to ask its name is how a tracker starts
 * throwing from inside a shutdown hook.
 */
class SessionBuilder(
    project: Project,
    val startedAt: Long,
    initialFile: String?,
) {
    private val projectName: String = runCatching { project.name }.getOrDefault("project")
    private val projectPath: String = runCatching { project.basePath }.getOrNull().orEmpty()

    private var activeMs = 0L
    private var readingMs = 0L
    private var backgroundMs = 0L
    private val fileMs = LinkedHashMap<String, Long>()
    private val fileEdits = LinkedHashMap<String, Int>()
    private val runs = LinkedHashMap<String, Int>()
    private var current: String? = initialFile

    fun heartbeat(state: Activity, ms: Long, file: String?) {
        when (state) {
            Activity.ACTIVE -> activeMs += ms
            Activity.READING -> readingMs += ms
            Activity.BACKGROUND -> backgroundMs += ms
            else -> return
        }
        // Background time is not attributed to a file — the IDE had the file
        // open, but you were in a browser.
        if (state != Activity.BACKGROUND) {
            (file ?: current)?.let { fileMs.merge(it, ms, Long::plus) }
        }
    }

    fun switchFile(path: String) { current = path }

    fun noteEdit(path: String?) {
        (path ?: current)?.let { fileEdits.merge(it, 1, Int::plus) }
    }

    fun noteRun(kind: String) { runs.merge(kind, 1, Int::plus) }

    /** Work counted so far, in seconds. Background is not work. */
    fun workedSeconds(): Long = (activeMs + readingMs) / 1000

    /** Null for sessions under a minute — the floor timers.js already applies. */
    fun build(endedAt: Long, reason: String): SessionRecord? {
        if (workedSeconds() < 60) return null
        val settings = CadeSettings.get()
        return SessionRecord(
            id = UUID.randomUUID().toString(),
            device = settings.state.deviceName?.takeIf { it.isNotBlank() } ?: hostname(),
            ide = ideName(),
            projectName = projectName,
            projectPath = projectPath,
            // Read at close, not at open: what matters is the branch the work
            // ended up on. It is one small file, off the EDT.
            branch = GitHead.read(projectPath.ifBlank { null }),
            startedAt = Instant.ofEpochMilli(startedAt).toString(),
            endedAt = Instant.ofEpochMilli(endedAt).toString(),
            activeSeconds = activeMs / 1000,
            readingSeconds = readingMs / 1000,
            backgroundSeconds = backgroundMs / 1000,
            files = if (settings.state.trackFiles) {
                fileMs.entries.sortedByDescending { it.value }.take(MAX_FILES).map {
                    FileStat(relativize(it.key), it.value / 1000, fileEdits[it.key] ?: 0)
                }
            } else emptyList(),
            runs = LinkedHashMap(runs),
            closedBy = reason,
        )
    }

    private fun relativize(abs: String): String {
        val base = projectPath.ifBlank { return abs }
        if (!abs.startsWith(base)) return abs
        return abs.removePrefix(base).trimStart('/', '\\').ifBlank { abs }
    }

    companion object {
        /** Enough to see where a day went; short enough to keep records small. */
        private const val MAX_FILES = 40

        private val cachedHost: String by lazy {
            System.getenv("COMPUTERNAME")?.takeIf { it.isNotBlank() }
                ?: System.getenv("HOSTNAME")?.takeIf { it.isNotBlank() }
                // Can block on a misconfigured resolver, so it is last and
                // computed once for the life of the process.
                ?: runCatching { InetAddress.getLocalHost().hostName }.getOrNull()
                ?: "unknown-device"
        }

        fun hostname(): String = cachedHost

        fun ideName(): String =
            runCatching { ApplicationInfo.getInstance().fullApplicationName }
                .getOrDefault("IntelliJ Platform")
    }
}
