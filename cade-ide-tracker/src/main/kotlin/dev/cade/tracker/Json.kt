package dev.cade.tracker

/**
 * A JSON writer, hand-rolled, about forty lines.
 *
 * The platform does bundle Gson, but what is bundled and what is *exported to
 * plugins* drifts between releases, and a NoClassDefFoundError at the moment a
 * session closes loses the session. Nothing here needs a library: the wire
 * format is a flat object, a list of file stats, and a map of run counts.
 */
internal object Json {

    fun str(v: String?): String {
        if (v == null) return "null"
        val sb = StringBuilder(v.length + 16)
        sb.append('"')
        for (c in v) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                // Paths and branch names have carried stranger things than
                // this, and a raw control character makes the whole record
                // unparseable at the far end rather than just ugly.
                c < ' ' -> sb.append("\\u").append("%04x".format(c.code))
                else -> sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    fun num(v: Long): String = v.toString()

    fun num(v: Int): String = v.toString()

    /** Values must already be encoded. Null values are dropped, not written. */
    fun obj(vararg fields: Pair<String, String?>): String =
        fields.filter { it.second != null }
            .joinToString(",", "{", "}") { str(it.first) + ":" + it.second }

    fun arr(items: List<String>): String = items.joinToString(",", "[", "]")

    fun intMap(m: Map<String, Int>): String =
        m.entries.joinToString(",", "{", "}") { str(it.key) + ":" + num(it.value) }
}
