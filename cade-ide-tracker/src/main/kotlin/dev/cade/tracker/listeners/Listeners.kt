package dev.cade.tracker.listeners

import com.intellij.execution.ExecutionListener
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.ide.AppLifecycleListener
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.AnActionResult
import com.intellij.openapi.actionSystem.ex.AnActionListener
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.wm.IdeFrame
import dev.cade.tracker.ActivityMonitor

/*
 * Every listener in this file runs on the EDT. They touch atomics and return.
 * Any I/O here — a file read, an HTTP call, a settings lookup that hits disk —
 * and you have written a plugin that makes typing stutter.
 */

/** OS focus. Exclusive, which is what makes one app-level monitor correct. */
class AppFocusListener : ApplicationActivationListener {
    override fun applicationActivated(ideFrame: IdeFrame) {
        ActivityMonitor.get().noteFocus(ideFrame.project)
    }

    override fun applicationDeactivated(ideFrame: IdeFrame) {
        ActivityMonitor.get().noteUnfocus()
    }
}

/** Which file the time belongs to. */
class EditorSelectionListener : FileEditorManagerListener {
    override fun selectionChanged(event: FileEditorManagerEvent) {
        val file = event.newFile ?: return
        ActivityMonitor.get().noteFileOpened(event.manager.project, file.path)
    }
}

/**
 * Runs, debugs and test suites. A live process is the difference between
 * "watching the tests" and "away from the desk", and they look identical to
 * anything that only counts keystrokes.
 */
class RunListener : ExecutionListener {
    override fun processStarted(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
        ActivityMonitor.get().noteRun(classify(executorId, env), started = true)
    }

    override fun processTerminated(
        executorId: String,
        env: ExecutionEnvironment,
        handler: ProcessHandler,
        exitCode: Int,
    ) {
        ActivityMonitor.get().noteRun(classify(executorId, env), started = false)
    }

    // A name heuristic, deliberately. Asking the configuration whether it is a
    // test means depending on each language plugin's own notion of one, and
    // getting "run" for the languages you did not think of; a wrong bucket in
    // a summary line is a far smaller cost than a missing dependency.
    private fun classify(executorId: String, env: ExecutionEnvironment): String = when {
        env.runProfile.name.contains("test", ignoreCase = true) -> "test"
        executorId == DefaultDebugExecutor.EXECUTOR_ID -> "debug"
        else -> "run"
    }
}

/**
 * Any action at all — a commit, a refactor, a search. Without this, an hour
 * spent driving the IDE by keyboard shortcut and menu reads as an hour idle.
 */
class ActionActivityListener : AnActionListener {
    override fun afterActionPerformed(action: AnAction, event: AnActionEvent, result: AnActionResult) {
        ActivityMonitor.get().noteInput(event.project)
    }
}

/**
 * The IDE is closing. The last session of the day is usually the longest one,
 * and without a synchronous close-and-flush here it is the one that vanishes.
 */
class LifecycleListener : AppLifecycleListener {
    override fun appWillBeClosed(isRestart: Boolean) {
        ActivityMonitor.get().shutdown()
    }
}
