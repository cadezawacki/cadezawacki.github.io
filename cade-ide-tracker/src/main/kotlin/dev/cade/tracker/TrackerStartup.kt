package dev.cade.tracker

import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.VisibleAreaListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.Disposer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Wires the signals that have no declarative topic. Document, caret and
 * scroll events hang off the editor event multicaster, which is registered by
 * hand — and MUST be given a Disposable, or every dynamic plugin reload leaks
 * another copy.
 */
class TrackerStartup : ProjectActivity {

    override suspend fun execute(project: Project) {
        val monitor = ActivityMonitor.get()

        // Something to attribute time to before anyone has touched anything.
        // Not treated as input: opening the IDE and walking away is not work.
        monitor.noteProjectOpened(project)

        // The project's own disposal is the close signal. A ProjectCloseListener
        // would do as well, but Project IS a Disposable and this needs no
        // second listener class and no second topic.
        Disposer.register(project, Disposable { monitor.noteProjectClosed(project) })

        installEditorSignals()
    }

    companion object {
        private val installed = AtomicBoolean(false)

        /**
         * ONCE per IDE, not once per project.
         *
         * The multicaster spans every editor in every window, so registering
         * from each ProjectActivity would attach N copies and make each
         * keystroke fire N times — each one attributing the keystroke to
         * whichever project happened to register last. The project comes from
         * focus and file-selection events instead, which really are
         * project-scoped.
         */
        private fun installEditorSignals() {
            if (!installed.compareAndSet(false, true)) return
            val monitor = ActivityMonitor.get()
            val parent = TrackerDisposable.get()
            val multicaster = EditorFactory.getInstance().eventMulticaster

            multicaster.addDocumentListener(object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    // Typing: the strongest signal there is. A map lookup and
                    // two atomic stores, then out — anything heavier here and
                    // you have written a plugin that makes typing stutter.
                    val file = FileDocumentManager.getInstance().getFile(event.document)
                    monitor.noteEdit(null, file?.path)
                }
            }, parent)

            multicaster.addCaretListener(object : CaretListener {
                override fun caretPositionChanged(event: CaretEvent) {
                    monitor.noteInput(event.editor.project)
                }
            }, parent)

            // Scrolling is the tell that separates "reading" from "walked away
            // with a file open". Cheap to capture, disproportionately useful.
            multicaster.addVisibleAreaListener(VisibleAreaListener { event ->
                monitor.noteInput(event.editor.project)
            }, parent)
        }
    }
}
