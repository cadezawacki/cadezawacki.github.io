package dev.cade.tracker

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service

/**
 * The parent Disposable for listeners that have no declarative topic and so
 * must be registered by hand — the editor event multicaster ones.
 *
 * Registering those without a parent leaks a listener per dynamic plugin
 * reload, and the leak is invisible: the IDE simply gets slower to type in
 * over an afternoon of plugin development, which is exactly the afternoon you
 * are least likely to suspect your own plugin.
 *
 * An application service is disposed when the plugin unloads, which is the
 * lifetime these listeners want.
 */
@Service(Service.Level.APP)
class TrackerDisposable : Disposable {
    override fun dispose() = Unit

    companion object {
        fun get(): Disposable = service<TrackerDisposable>()
    }
}
