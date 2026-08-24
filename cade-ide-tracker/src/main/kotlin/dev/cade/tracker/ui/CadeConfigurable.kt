package dev.cade.tracker.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.Configurable
import com.intellij.ui.JBIntSpinner
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import dev.cade.tracker.ActivityMonitor
import dev.cade.tracker.CadeClient
import dev.cade.tracker.CadeCrypto
import dev.cade.tracker.CadeSettings
import java.awt.BorderLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Settings ▸ Tools ▸ Cade.project Tracker.
 *
 * Plain Swing over the Kotlin UI DSL on purpose: FormBuilder has been stable
 * for a decade and this panel will outlive several revisions of the DSL.
 */
class CadeConfigurable : Configurable {

    private val databaseUrl = JBTextField()
    private val passphrase = JBPasswordField()
    private val deviceName = JBTextField()

    private val enabled = JBCheckBox("Track activity")
    private val trackFiles = JBCheckBox("Record which files the time went to")
    private val countBackground = JBCheckBox("Count time in other windows as work")

    private val softIdle = JBIntSpinner(120, 15, 3600)
    private val hardIdle = JBIntSpinner(900, 60, 7200)
    private val bgGrace = JBIntSpinner(180, 0, 3600)
    private val trimGrace = JBIntSpinner(60, 0, 900)

    private val testResult = JBLabel(" ")
    private val fingerprint = JBLabel(" ")

    override fun getDisplayName(): String = "Cade.project Tracker"

    override fun createComponent(): JComponent {
        val test = JButton("Test connection").apply {
            addActionListener {
                testResult.text = "Testing…"
                val url = databaseUrl.text.orEmpty()
                val pass = String(passphrase.password)
                // Off the EDT: this is a network round trip, and a settings
                // dialog that freezes is a settings dialog nobody opens twice.
                ApplicationManager.getApplication().executeOnPooledThread {
                    val msg = CadeClient.testConnection(url, pass)
                    ApplicationManager.getApplication().invokeLater { testResult.text = msg }
                }
            }
        }

        val showFp = JButton("Show fingerprint").apply {
            addActionListener {
                val pass = String(passphrase.password)
                fingerprint.text = if (pass.isBlank()) "Set the passphrase first."
                else "Records go to ide/" + CadeCrypto.fingerprint(pass) + "/q/ — " +
                    "this must match the fingerprint Cade.project uses."
            }
        }

        val buttons = JPanel(BorderLayout()).apply {
            add(test, BorderLayout.WEST)
            add(showFp, BorderLayout.CENTER)
        }

        val form = FormBuilder.createFormBuilder()
            .addComponent(enabled)
            .addSeparator()
            .addLabeledComponent("Database URL", databaseUrl, 1, false)
            .addComponentToRightColumn(
                JBLabel("The Realtime Database URL, e.g. https://x-default-rtdb.firebaseio.com")
                    .apply { foreground = JBUI.CurrentTheme.Label.disabledForeground() })
            .addLabeledComponent("Passphrase", passphrase, 1, false)
            .addComponentToRightColumn(
                JBLabel("The same passphrase Cade.project syncs with. Kept in the password safe, never in settings.")
                    .apply { foreground = JBUI.CurrentTheme.Label.disabledForeground() })
            .addLabeledComponent("Device name", deviceName, 1, false)
            .addComponent(buttons)
            .addComponent(testResult)
            .addComponent(fingerprint)
            .addSeparator()
            .addComponent(trackFiles)
            .addComponent(countBackground)
            .addSeparator()
            .addLabeledComponent("Active until idle for (s)", softIdle, 1, false)
            .addLabeledComponent("Reading until idle for (s)", hardIdle, 1, false)
            .addLabeledComponent("Count background for (s)", bgGrace, 1, false)
            .addLabeledComponent("Trim grace on close (s)", trimGrace, 1, false)
            .addComponentToRightColumn(
                JBLabel("Run a week on the defaults and look at the numbers before changing these.")
                    .apply { foreground = JBUI.CurrentTheme.Label.disabledForeground() })
            .addComponentFillVertically(JPanel(), 0)
            .panel

        reset()
        return form
    }

    override fun isModified(): Boolean {
        val s = CadeSettings.get()
        return databaseUrl.text != s.state.databaseUrl.orEmpty() ||
            String(passphrase.password) != s.passphrase.orEmpty() ||
            deviceName.text != s.state.deviceName.orEmpty() ||
            enabled.isSelected != s.state.enabled ||
            trackFiles.isSelected != s.state.trackFiles ||
            countBackground.isSelected != s.state.countBackground ||
            softIdle.number != s.state.softIdleSec ||
            hardIdle.number != s.state.hardIdleSec ||
            bgGrace.number != s.state.bgGraceSec ||
            trimGrace.number != s.state.trimGraceSec
    }

    override fun apply() {
        val s = CadeSettings.get()
        s.state.databaseUrl = databaseUrl.text.trim()
        s.state.deviceName = deviceName.text.trim().ifBlank { null }
        s.state.enabled = enabled.isSelected
        s.state.trackFiles = trackFiles.isSelected
        s.state.countBackground = countBackground.isSelected
        s.state.softIdleSec = softIdle.number
        s.state.hardIdleSec = hardIdle.number
        s.state.bgGraceSec = bgGrace.number
        s.state.trimGraceSec = trimGrace.number
        s.passphrase = String(passphrase.password).ifBlank { null }
        // Re-derive the key, allow the refusal warning to fire again, and try
        // the queue immediately — the usual reason for opening this dialog is
        // that something was wrong, and the fix should take effect now.
        ActivityMonitor.get().settingsChanged()
    }

    override fun reset() {
        val s = CadeSettings.get()
        databaseUrl.text = s.state.databaseUrl.orEmpty()
        passphrase.text = s.passphrase.orEmpty()
        deviceName.text = s.state.deviceName.orEmpty()
        enabled.isSelected = s.state.enabled
        trackFiles.isSelected = s.state.trackFiles
        countBackground.isSelected = s.state.countBackground
        softIdle.number = s.state.softIdleSec
        hardIdle.number = s.state.hardIdleSec
        bgGrace.number = s.state.bgGraceSec
        trimGrace.number = s.state.trimGraceSec
        testResult.text = " "
        fingerprint.text = " "
    }
}
