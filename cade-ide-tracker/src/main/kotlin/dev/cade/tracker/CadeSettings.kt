package dev.cade.tracker

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

@Service(Service.Level.APP)
@State(name = "CadeTracker", storages = [Storage("cade-tracker.xml")])
class CadeSettings : SimplePersistentStateComponent<CadeSettings.S>(S()) {

    class S : BaseState() {
        /** https://xxx-default-rtdb.firebaseio.com — no trailing slash needed. */
        var databaseUrl by string("")
        var enabled by property(true)

        /** Off = project-level totals only, no per-file breakdown leaves the machine. */
        var trackFiles by property(true)

        /** Sent either way; this only decides whether the app counts it as work. */
        var countBackground by property(false)

        var deviceName by string(null)

        // Thresholds, exposed because the right values are personal. Run a
        // week with the defaults and look at the histogram before touching
        // them — reading-heavy days and pairing days pull in opposite
        // directions, and only your own data settles it.
        var softIdleSec by property(120)
        var hardIdleSec by property(900)
        var bgGraceSec by property(180)
        var trimGraceSec by property(60)
    }

    // The passphrase NEVER lands in cade-tracker.xml. That file travels via
    // Settings Sync and gets committed to dotfiles repos by accident.
    private val creds = CredentialAttributes(generateServiceName("CadeTracker", "passphrase"))

    var passphrase: String?
        get() = PasswordSafe.instance.getPassword(creds)
        set(v) = PasswordSafe.instance.setPassword(creds, v)

    // Reading the passphrase goes to the OS keychain, and the ticker asks
    // whether we are configured every thirty seconds. Cached until something
    // changes it — which is `apply()` in the settings panel, and nothing else.
    @Volatile private var configuredCache: Boolean? = null

    fun isConfigured(): Boolean = configuredCache
        ?: (!state.databaseUrl.isNullOrBlank() && !passphrase.isNullOrBlank())
            .also { configuredCache = it }

    fun invalidateConfiguredCache() { configuredCache = null }

    /** Trailing slashes make `$base/ide/...` into `$base//ide/...`, which RTDB rejects. */
    fun baseUrl(): String = state.databaseUrl.orEmpty().trim().trimEnd('/')

    companion object {
        fun get(): CadeSettings = service()
    }
}
