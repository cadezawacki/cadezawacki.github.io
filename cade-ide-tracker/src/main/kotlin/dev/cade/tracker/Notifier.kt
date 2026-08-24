package dev.cade.tracker

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Balloons, rationed. A tracker that interrupts you is worse than no tracker,
 * so there is exactly one thing worth saying unprompted — that the database is
 * refusing the writes — and it is said once per IDE run.
 */
object Notifier {
    private const val GROUP = "Cade.project Tracker"
    private val refusalShown = AtomicBoolean(false)

    private fun show(title: String, body: String, type: NotificationType) {
        runCatching {
            NotificationGroupManager.getInstance()
                .getNotificationGroup(GROUP)
                .createNotification(title, body, type)
                .notify(null)
        }
    }

    fun refused() {
        if (!refusalShown.compareAndSet(false, true)) return
        show(
            "Cade.project Tracker: the database refused the write",
            "Its rules do not allow writing under \"ide\". Sessions are being kept on disk " +
                "and will be sent once the rule is published — see project/FIREBASE_RULES.md.",
            NotificationType.WARNING,
        )
    }

    fun info(title: String, body: String) = show(title, body, NotificationType.INFORMATION)

    /** The user fixed the rules and reconnected; allow the warning again. */
    fun resetRefusal() = refusalShown.set(false)
}
