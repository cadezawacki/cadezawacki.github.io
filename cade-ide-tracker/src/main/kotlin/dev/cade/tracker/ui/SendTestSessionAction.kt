package dev.cade.tracker.ui

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import dev.cade.tracker.CadeClient
import dev.cade.tracker.CadeCrypto
import dev.cade.tracker.CadeKeys
import dev.cade.tracker.CadeSettings
import dev.cade.tracker.FileStat
import dev.cade.tracker.Notifier
import dev.cade.tracker.SessionBuilder
import dev.cade.tracker.SessionRecord
import java.time.Instant
import java.util.UUID

/**
 * Step 4 of the build order, as a menu item: Tools ▸ Cade.project Tracker ▸
 * Send test session.
 *
 * It puts a real, correctly-shaped record through the real path — encrypt,
 * queue, PUT — with no state machine involved. If this lands in the app, the
 * whole pipe is proven end to end and anything still wrong afterwards is in
 * the state machine, which is the part worth debugging with everything under
 * it already known good.
 */
class SendTestSessionAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = CadeSettings.get().isConfigured()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val settings = CadeSettings.get()
        val pass = settings.passphrase
        if (pass.isNullOrBlank()) {
            Notifier.info("Cade.project Tracker", "Set the passphrase first.")
            return
        }
        val project = e.project
        val now = System.currentTimeMillis()
        val rec = SessionRecord(
            id = UUID.randomUUID().toString(),
            device = settings.state.deviceName?.takeIf { it.isNotBlank() } ?: SessionBuilder.hostname(),
            ide = SessionBuilder.ideName(),
            projectName = project?.name ?: "test-project",
            projectPath = project?.basePath ?: "/test-project",
            branch = "test",
            // Ten minutes ending now, so it lands on today's planner where it
            // can be seen — and is unmistakably a test when it does.
            startedAt = Instant.ofEpochMilli(now - 600_000).toString(),
            endedAt = Instant.ofEpochMilli(now).toString(),
            activeSeconds = 480,
            readingSeconds = 120,
            backgroundSeconds = 0,
            files = listOf(FileStat("test/from-the-ide-plugin.txt", 600, 42)),
            runs = mapOf("test" to 1),
            closedBy = "shutdown",
        )

        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching {
                val enc = CadeCrypto.encrypt(rec.toJson(), CadeKeys.keyFor(pass))
                CadeClient.submit(rec.id, rec.toEnvelope(enc))
                CadeClient.queueDepth()
            }
            val fp = CadeCrypto.fingerprint(pass)
            val msg = result.fold(
                onSuccess = { depth ->
                    if (depth == 0) "Sent to ide/$fp/q/${rec.id}. It should appear in Cade.project within a moment."
                    else "Queued, but not sent — $depth record(s) waiting. Check the database URL and the \"ide\" rule."
                },
                onFailure = { "Failed: ${it.message}" },
            )
            Notifier.info("Cade.project Tracker: test session", msg)
        }
    }
}
