package dev.cade.tracker

/** One file's share of a session. `path` is repo-relative where it can be. */
data class FileStat(val path: String, val seconds: Long, val edits: Int)

/**
 * The decrypted payload — see PART 2 of the design. This is the whole wire
 * contract with ide.js; anything added here is available there for free,
 * because State.createLog() spreads what it is given and `logs` is already a
 * merged collection.
 */
data class SessionRecord(
    val id: String,
    val device: String,
    val ide: String,
    val projectName: String,
    val projectPath: String,
    val branch: String?,
    val startedAt: String,
    val endedAt: String,
    val activeSeconds: Long,
    val readingSeconds: Long,
    val backgroundSeconds: Long,
    val files: List<FileStat>,
    val runs: Map<String, Int>,
    /** idle | away | rollover | shutdown | disabled */
    val closedBy: String,
) {
    fun toJson(): String = Json.obj(
        // Repeated inside the envelope as well as being the node key, so
        // dedupe survives a node-key rewrite.
        "id" to Json.str(id),
        "device" to Json.str(device),
        "ide" to Json.str(ide),
        "projectName" to Json.str(projectName),
        "projectPath" to Json.str(projectPath),
        "branch" to Json.str(branch),
        "startedAt" to Json.str(startedAt),
        "endedAt" to Json.str(endedAt),
        "activeSeconds" to Json.num(activeSeconds),
        "readingSeconds" to Json.num(readingSeconds),
        "backgroundSeconds" to Json.num(backgroundSeconds),
        "files" to Json.arr(files.map {
            Json.obj(
                "path" to Json.str(it.path),
                "seconds" to Json.num(it.seconds),
                "edits" to Json.num(it.edits),
            )
        }),
        "runs" to Json.intMap(runs),
        "closedBy" to Json.str(closedBy),
    )

    /**
     * The outer envelope, which carries no plaintext at all: a version, the
     * id, the ciphertext, and a server-stamped time for TTL sweeps.
     */
    fun toEnvelope(encrypted: String): String = Json.obj(
        "v" to Json.num(1),
        "id" to Json.str(id),
        "enc" to Json.str(encrypted),
        "at" to """{".sv":"timestamp"}""",
    )
}
