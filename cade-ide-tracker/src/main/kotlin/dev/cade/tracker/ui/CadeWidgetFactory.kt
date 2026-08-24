package dev.cade.tracker.ui

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import dev.cade.tracker.Activity
import dev.cade.tracker.ActivityMonitor
import dev.cade.tracker.CadeClient
import dev.cade.tracker.CadeSettings
import java.awt.Component
import java.awt.event.MouseEvent
import java.util.concurrent.CopyOnWriteArrayList

class CadeWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = CadeWidget.ID
    override fun getDisplayName(): String = "Cade.project Tracker"
    override fun isAvailable(project: Project): Boolean = true
    override fun createWidget(project: Project): StatusBarWidget = CadeWidget()
    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

/**
 * "◐ 2h14m · sync.js" in the corner.
 *
 * The one thing this must show, and the reason it exists rather than being
 * left out as boilerplate, is the queue depth: a queue that is silently
 * growing because the database is refusing the writes is the single failure
 * the user has to be able to see.
 */
class CadeWidget : StatusBarWidget, StatusBarWidget.TextPresentation {

    private var statusBar: StatusBar? = null

    override fun ID(): String = ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        live.add(this)
    }

    override fun dispose() {
        live.remove(this)
        statusBar = null
    }

    override fun getAlignment(): Float = Component.CENTER_ALIGNMENT

    override fun getText(): String {
        val monitor = ActivityMonitor.get()
        if (!CadeSettings.get().state.enabled) return "$DOT_OFF cade off"

        val parts = mutableListOf(glyph(monitor.state) + " " + hm(monitor.todaySeconds()))
        monitor.currentFile()?.let { parts.add(it) }
        val queued = CadeClient.queueDepth()
        if (queued > 0) parts.add("$queued queued")
        return parts.joinToString(" · ")
    }

    override fun getTooltipText(): String {
        val monitor = ActivityMonitor.get()
        val settings = CadeSettings.get()
        val queued = CadeClient.queueDepth()
        return buildString {
            append("Cade.project Tracker — ").append(monitor.state.name.lowercase())
            append("\nToday: ").append(hm(monitor.todaySeconds())).append(" (this IDE, since it started)")
            if (!settings.isConfigured()) {
                append("\nNot configured — Settings ▸ Tools ▸ Cade.project Tracker")
            } else if (queued > 0) {
                append("\n").append(queued).append(" session(s) waiting to be sent")
            }
            append("\nClick to open Cade.project")
        }
    }

    override fun getClickConsumer(): Consumer<MouseEvent>? =
        Consumer { BrowserUtil.browse(APP_URL) }

    companion object {
        const val ID = "CadeTracker"
        private const val APP_URL = "https://cadezawacki.github.io/project/"

        // A TextPresentation cannot colour its own text, so the state is in
        // the glyph rather than in a green/amber/grey dot. It also survives
        // being read by someone who cannot tell the colours apart.
        private const val DOT_ACTIVE = "◉"
        private const val DOT_READING = "◐"
        private const val DOT_BACKGROUND = "○"
        private const val DOT_IDLE = "·"
        private const val DOT_OFF = "·"

        private val live = CopyOnWriteArrayList<CadeWidget>()

        private fun glyph(state: Activity) = when (state) {
            Activity.ACTIVE -> DOT_ACTIVE
            Activity.READING -> DOT_READING
            Activity.BACKGROUND -> DOT_BACKGROUND
            else -> DOT_IDLE
        }

        private fun hm(seconds: Long): String {
            val m = seconds / 60
            return if (m < 60) "${m}m" else "${m / 60}h${(m % 60).toString().padStart(2, '0')}m"
        }

        /**
         * Called from the ticker thread. ModalityState.any() so the corner
         * keeps up while a modal dialog is open — and wrapped, because during
         * shutdown there may be no dispatch left to invoke onto, and a cosmetic
         * refresh must never be what throws on the way out.
         */
        fun refreshAll() {
            if (live.isEmpty()) return
            runCatching {
                ApplicationManager.getApplication().invokeLater(
                    { live.forEach { w -> runCatching { w.statusBar?.updateWidget(ID) } } },
                    ModalityState.any(),
                )
            }
        }
    }
}
