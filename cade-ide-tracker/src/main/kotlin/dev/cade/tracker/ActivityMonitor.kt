package dev.cade.tracker

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import dev.cade.tracker.ui.CadeWidget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.LocalDate
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

enum class Activity { ACTIVE, READING, BACKGROUND, IDLE, AWAY }

/**
 * The state machine. Everything else in the plugin serves this.
 *
 *   STATE       ENTER WHEN                                   COUNTS AS
 *   ACTIVE      focused && sinceInput < softIdle             work (active)
 *   READING     focused && sinceInput < hardIdle && a file   work (reading)
 *               is open, OR the debugger is suspended, OR a
 *               run/test process is alive
 *   BACKGROUND  !focused && sinceUnfocus < bgGrace           work (tagged)
 *   IDLE        anything else                                nothing
 *   AWAY        wall clock jumped by more than 3 ticks       nothing
 *
 * One APP-level service, not one per project. Two windows are both "active"
 * by any per-project measure, which is how a tracker reports sixteen hours in
 * an eight-hour day; OS focus is exclusive, so there is exactly one answer and
 * this is the thing that holds it.
 */
@Service(Service.Level.APP)
class ActivityMonitor(private val scope: CoroutineScope) {

    companion object {
        fun get(): ActivityMonitor = service()

        private val log = logger<ActivityMonitor>()

        private const val TICK_MS = 30_000L
        private const val SESSION_MAX_MS = 30 * 60_000L

        /** A tick this late means the process was suspended, not merely slow. */
        private const val GAP_MS = TICK_MS * 3

        /** Retry the queue every five minutes, so an outage heals itself. */
        private const val FLUSH_EVERY_TICKS = 10

        /**
         * The IDE is waiting on us at this point, so the shutdown flush gets a
         * short leash. Anything it does not manage is on disk and goes out on
         * the next start — which is worth several seconds of nobody's time.
         */
        private val SHUTDOWN_TIMEOUT: Duration = Duration.ofSeconds(3)
        private const val SHUTDOWN_BUDGET_MS = 4_000L
    }

    // Written from the EDT by listeners, read from the ticker coroutine.
    // Atomics and volatiles only: the input path fires on every keystroke, and
    // a lock there is a lock in the typing loop.
    private val lastInputAt = AtomicLong(System.currentTimeMillis())
    private val lastUnfocusAt = AtomicLong(0)

    // The last moment there was EVIDENCE of work — which is not the same as
    // the last keystroke. Watching a twenty-minute test suite produces no
    // input at all, and trimming that session back to the last keystroke ends
    // it before most of the work it recorded: a record whose end precedes its
    // own heartbeats, and sometimes its own start. A live process or a
    // suspended debugger is evidence; a file merely sitting open is not.
    private val lastEvidenceAt = AtomicLong(System.currentTimeMillis())
    private val processesAlive = AtomicInteger(0)
    private val suspendedDebuggers = AtomicInteger(0)

    @Volatile private var focused = true
    @Volatile private var activeProject: Project? = null
    @Volatile private var activeFile: String? = null

    @Volatile var state: Activity = Activity.IDLE
        private set

    private var builder: SessionBuilder? = null
    private var lastTickAt = System.currentTimeMillis()
    private var ticksSinceFlush = 0

    // Status-bar tally only. The app is the real store — this is a number for
    // the corner of the screen, and it resets when the IDE does.
    private var tallyDate: LocalDate = LocalDate.now()
    private var tallySeconds = 0L

    init {
        scope.launch(Dispatchers.Default) {
            // Anything a crash or a lost network left stranded on disk.
            runCatching { CadeClient.flush() }
            while (isActive) {
                delay(TICK_MS)
                runCatching { tick() }.onFailure { log.warn("Cade: tick failed", it) }
            }
        }
    }

    // ── input path — called from EDT listeners, stays allocation-free ──────

    fun noteInput(project: Project? = null, file: String? = null) {
        val now = System.currentTimeMillis()
        lastInputAt.set(now)
        lastEvidenceAt.set(now)
        if (project != null) activeProject = project
        if (file != null) activeFile = file
    }

    /** Typing specifically: the strongest signal there is, and the edit count. */
    fun noteEdit(project: Project?, file: String?) {
        noteInput(project, file)
        builder?.noteEdit(file)
    }

    fun noteFocus(project: Project?) {
        focused = true
        if (project != null) activeProject = project
        val now = System.currentTimeMillis()
        lastInputAt.set(now)
        lastEvidenceAt.set(now)
    }

    fun noteUnfocus() {
        focused = false
        lastUnfocusAt.set(System.currentTimeMillis())
    }

    fun noteFileOpened(project: Project, path: String) {
        activeProject = project
        activeFile = path
        val now = System.currentTimeMillis()
        lastInputAt.set(now)
        lastEvidenceAt.set(now)
        builder?.switchFile(path)
    }

    /**
     * A project became available without anyone having touched it yet — the
     * IDE just opened. Adopted only if nothing else is active, and pointedly
     * NOT counted as input: opening the IDE and walking away is not work.
     */
    fun noteProjectOpened(project: Project) {
        if (activeProject == null) activeProject = project
    }

    /** Its windows are going away; anything still open belongs to that project. */
    fun noteProjectClosed(project: Project) {
        if (activeProject !== project) return
        closeSession("shutdown", trimTo = lastEvidenceAt.get(), synchronous = true)
        activeProject = null
        activeFile = null
    }

    fun noteRun(kind: String, started: Boolean) {
        if (started) {
            processesAlive.incrementAndGet()
            builder?.noteRun(kind)
        } else {
            // Clamped: processTerminated can arrive for a process that started
            // before the plugin loaded, and a negative count would make every
            // idle minute look like a running test suite forever after.
            processesAlive.updateAndGet { if (it > 0) it - 1 else 0 }
        }
        val now = System.currentTimeMillis()
        lastInputAt.set(now)
        lastEvidenceAt.set(now)
    }

    /**
     * Paired, never absolute: each debug session reports its own pause and its
     * own resume (and a stop while paused counts as a resume). Zeroing a
     * shared flag instead would let one session ending clear another's
     * suspension, and a debugger that never resumes reads as work forever.
     */
    fun noteDebuggerSuspended(suspended: Boolean) {
        if (suspended) suspendedDebuggers.incrementAndGet()
        else suspendedDebuggers.updateAndGet { if (it > 0) it - 1 else 0 }
    }

    // ── the ticker ────────────────────────────────────────────────────────

    private fun tick() {
        val now = System.currentTimeMillis()
        val sinceTick = now - lastTickAt
        lastTickAt = now

        // GAP: the lid was closed, the machine hibernated, or the JVM froze.
        // Whatever it was, it was not work. Close retroactively and return
        // before the normal accounting can absorb the lost span.
        //
        // Interval drift is the primary signal rather than nanoTime, which
        // excludes suspend on Linux and macOS but not reliably on Windows.
        if (sinceTick > GAP_MS) {
            log.debug("Cade: ${sinceTick / 1000}s gap between ticks — treating as away")
            closeSession("away", trimTo = lastEvidenceAt.get())
            state = Activity.AWAY
            ui()
            return
        }

        val settings = CadeSettings.get()
        val s = settings.state
        if (!s.enabled) {
            closeSession("disabled", trimTo = lastEvidenceAt.get())
            state = Activity.IDLE
            ui()
            return
        }
        // Unconfigured is not the same as disabled: keep the machine running
        // so the status bar is honest, but do not open sessions that have
        // nowhere to go.
        if (!settings.isConfigured()) {
            state = if (focused && now - lastInputAt.get() < s.softIdleSec * 1000L)
                Activity.ACTIVE else Activity.IDLE
            ui()
            return
        }

        // Something is running, or the debugger is sitting on a breakpoint:
        // that is happening now, whatever the keyboard has been doing.
        val liveProcess = suspendedDebuggers.get() > 0 || processesAlive.get() > 0
        if (liveProcess) lastEvidenceAt.set(now)

        val sinceInput = now - lastInputAt.get()
        val next = when {
            !focused && now - lastUnfocusAt.get() < s.bgGraceSec * 1000L -> Activity.BACKGROUND
            !focused -> Activity.IDLE
            sinceInput < s.softIdleSec * 1000L -> Activity.ACTIVE
            // Reading is work. A breakpoint you are staring at is work. A test
            // suite you are watching is work. Keystroke-only detection scores
            // all three as idle and undercounts a real day badly.
            liveProcess -> Activity.ACTIVE
            sinceInput < s.hardIdleSec * 1000L && activeFile != null -> Activity.READING
            else -> Activity.IDLE
        }

        when (next) {
            Activity.ACTIVE, Activity.READING, Activity.BACKGROUND -> {
                val b = builder ?: openSession(now) ?: run { state = next; ui(); return }
                // Never credit a session with time from before it existed: the
                // first tick after an anchored open covers only the part of
                // the interval the session was actually alive for.
                b.heartbeat(next, minOf(sinceTick, now - b.startedAt), activeFile)
                if (now - b.startedAt > SESSION_MAX_MS) {
                    // Bounds crash loss to half an hour and keeps records
                    // small. Adjacent blocks coalesce in the app if you would
                    // rather see fewer of them.
                    closeSession("rollover", trimTo = now)
                    // Anchored at `now`, not at the last keystroke: the
                    // session that just closed ends here, and anchoring back
                    // would draw two overlapping blocks on the planner.
                    openSession(now, anchorToInput = false)
                }
            }
            Activity.IDLE, Activity.AWAY -> closeSession("idle", trimTo = lastEvidenceAt.get())
        }
        state = next
        maybeFlush()
        ui()
    }

    /**
     * A record that could not be sent when it closed would otherwise sit on
     * disk until the IDE restarts — so an afternoon offline stayed invisible
     * in the app until the next morning. Cheap: the depth is a counter.
     */
    private fun maybeFlush() {
        if (++ticksSinceFlush < FLUSH_EVERY_TICKS) return
        ticksSinceFlush = 0
        if (CadeClient.queueDepth() == 0) return
        scope.launch(Dispatchers.IO) { runCatching { CadeClient.flush() } }
    }

    private fun openSession(now: Long, anchorToInput: Boolean = true): SessionBuilder? {
        val p = activeProject ?: return null
        if (runCatching { p.isDisposed }.getOrDefault(true)) {
            activeProject = null
            return null
        }
        // Anchor the session to the keystroke that woke it, not to the tick
        // that noticed — otherwise every planner block starts up to half a
        // minute late. Bounded to one tick back so no time is invented.
        val startedAt = if (anchorToInput)
            maxOf(lastInputAt.get(), now - TICK_MS).coerceAtMost(now) else now
        return SessionBuilder(p, startedAt, activeFile).also { builder = it }
    }

    /**
     * THE MOST IMPORTANT FUNCTION IN THE PLUGIN.
     *
     * `trimTo` is when work actually stopped — not now(). Ending at now()
     * inflates every session by exactly the idle threshold, silently, forever,
     * and the totals look entirely plausible the whole time. That single bug
     * is why hand-rolled trackers flatter their authors.
     */
    private fun closeSession(reason: String, trimTo: Long, synchronous: Boolean = false) {
        val b = builder ?: return
        builder = null

        val settings = CadeSettings.get()
        val grace = settings.state.trimGraceSec * 1000L
        // Clamped at both ends: never later than now (no future timestamps),
        // never earlier than the start (no record that ends before it began,
        // whatever the evidence clock says).
        val end = minOf(trimTo + grace, System.currentTimeMillis()).coerceAtLeast(b.startedAt)
        val rec = b.build(end, reason) ?: return          // under a minute: dropped

        addToTally(rec.activeSeconds + rec.readingSeconds)

        val pass = settings.passphrase
        if (pass.isNullOrBlank()) {
            log.warn("Cade: a session closed with no passphrase set — dropping it")
            return
        }

        // The IDE is going away and the coroutine scope with it: a launch here
        // would be cancelled before it ran, and the last session of the day —
        // the one most likely to be the longest — would simply evaporate.
        if (synchronous) {
            // Persist only. Transmitting here would put a network round trip
            // on the EDT between the user and their closing IDE; the bounded
            // flush in shutdown() is where the sending happens.
            runCatching { encryptAndQueue(rec, pass, transmit = false) }
                .onFailure { log.warn("Cade: could not queue the final session", it) }
        } else {
            scope.launch(Dispatchers.IO) {
                runCatching { encryptAndQueue(rec, pass, transmit = true) }
                    .onFailure { log.warn("Cade: could not queue a session", it) }
            }
        }
        ui()
    }

    private fun encryptAndQueue(rec: SessionRecord, passphrase: String, transmit: Boolean) {
        val enc = CadeCrypto.encrypt(rec.toJson(), CadeKeys.keyFor(passphrase))
        CadeClient.submit(rec.id, rec.toEnvelope(enc), transmit)
    }

    /** The IDE is closing. Flush on this thread or the last session is lost. */
    fun shutdown() {
        closeSession("shutdown", trimTo = lastEvidenceAt.get(), synchronous = true)
        runCatching { CadeClient.flush(SHUTDOWN_TIMEOUT, SHUTDOWN_BUDGET_MS) }
    }

    /** Settings changed under us — re-derive, and let the warning fire again. */
    fun settingsChanged() {
        CadeSettings.get().invalidateConfiguredCache()
        CadeKeys.invalidate()
        Notifier.resetRefusal()
        scope.launch(Dispatchers.IO) { runCatching { CadeClient.flush() } }
        ui()
    }

    // ── status bar ────────────────────────────────────────────────────────

    private fun addToTally(seconds: Long) {
        val today = LocalDate.now()
        if (today != tallyDate) { tallyDate = today; tallySeconds = 0 }
        tallySeconds += seconds
    }

    /** Closed sessions today, plus whatever the open one has counted so far. */
    fun todaySeconds(): Long {
        if (LocalDate.now() != tallyDate) return builder?.workedSeconds() ?: 0
        return tallySeconds + (builder?.workedSeconds() ?: 0)
    }

    fun currentFile(): String? = activeFile?.substringAfterLast('/')?.substringAfterLast('\\')

    private fun ui() = CadeWidget.refreshAll()
}
