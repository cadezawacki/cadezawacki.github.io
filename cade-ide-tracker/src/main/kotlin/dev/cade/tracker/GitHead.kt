package dev.cade.tracker

import java.io.File

/**
 * Reads the current branch out of .git/HEAD.
 *
 * Deliberately NOT git4idea: that means an optional <depends>, a second
 * config file and classloader care, all to obtain one string — versus this,
 * which works for worktrees, submodules, and every IDE in the family
 * including the ones where git4idea is not installed.
 */
object GitHead {

    fun read(basePath: String?): String? {
        val root = basePath?.let(::File) ?: return null
        val dotGit = resolveGitDir(root) ?: return null
        val head = runCatching { File(dotGit, "HEAD").readText().trim() }.getOrNull() ?: return null
        if (!head.startsWith("ref:")) {
            // Detached HEAD — a short sha is the most useful thing there is.
            return head.take(7).ifBlank { null }
        }
        // "ref: refs/heads/claude/ide-activity-tracker" → "claude/ide-activity-tracker".
        // Taking the segment after the last slash instead would quietly turn
        // every namespaced branch into its last word, which is exactly the
        // branches worth telling apart.
        val ref = head.removePrefix("ref:").trim()
        return ref.removePrefix("refs/heads/").ifBlank { null }
    }

    /** Worktrees and submodules keep .git as a FILE holding "gitdir: <path>". */
    private fun resolveGitDir(root: File): File? {
        val dotGit = File(root, ".git")
        if (dotGit.isDirectory) return dotGit
        if (!dotGit.isFile) return null
        val line = runCatching { dotGit.readText().trim() }.getOrNull() ?: return null
        if (!line.startsWith("gitdir:")) return null
        val target = File(line.removePrefix("gitdir:").trim())
        val dir = if (target.isAbsolute) target else File(root, target.path)
        return if (dir.isDirectory) dir else null
    }
}
