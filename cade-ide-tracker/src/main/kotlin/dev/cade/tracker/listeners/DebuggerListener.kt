package dev.cade.tracker.listeners

import com.intellij.xdebugger.XDebugProcess
import com.intellij.xdebugger.XDebugSessionListener
import com.intellij.xdebugger.XDebuggerManagerListener
import dev.cade.tracker.ActivityMonitor

/**
 * A breakpoint you are staring at is work.
 *
 * Registered from cade-xdebugger.xml, which is loaded only if the xdebugger
 * module is present — so an IDE in the family that ships without it gets a
 * plugin with one fewer signal rather than a stack trace at startup. Nothing
 * else in the plugin references these classes, so they are never loaded there.
 */
class DebuggerListener : XDebuggerManagerListener {

    override fun processStarted(debugProcess: XDebugProcess) {
        val monitor = ActivityMonitor.get()
        monitor.noteInput(runCatching { debugProcess.session.project }.getOrNull())

        // Per-session bookkeeping, paired against the monitor's counter.
        // A session that stops while suspended must report the resume it will
        // now never send, or the IDE reads as busy for the rest of the day.
        debugProcess.session.addSessionListener(object : XDebugSessionListener {
            private var paused = false

            override fun sessionPaused() {
                if (paused) return
                paused = true
                monitor.noteDebuggerSuspended(true)
                monitor.noteInput()      // hitting a breakpoint is a live moment
            }

            override fun sessionResumed() = clear()

            override fun sessionStopped() = clear()

            private fun clear() {
                if (!paused) return
                paused = false
                monitor.noteDebuggerSuspended(false)
            }
        })
    }
}
