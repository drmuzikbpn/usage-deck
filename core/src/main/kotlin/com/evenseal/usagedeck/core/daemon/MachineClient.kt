// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.model.Aging
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.RepairReason
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.core.model.aged
import com.evenseal.usagedeck.core.pairing.Labels
import java.time.Instant
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Owns one machine's live [MachineState].
 *
 * Runs an SSE connection loop with backoff; after two consecutive connects that never reached
 * [Connection.Open] it also starts REST polling (2 s with the screen on, 30 s otherwise) and
 * keeps polling until SSE opens again. A ticker re-derives [com.evenseal.usagedeck.core.model.Health]
 * from `lastHeartbeatAt`, and project token totals refresh every 30 s. Errors never escape;
 * they land in `state.lastError`.
 *
 * A rejected token (401) or a changed certificate, from any request or the stream, is not a
 * network blip: the machine enters `state.needsRepair`, the stream and polling stop, its sessions
 * are dropped and it reads dead, and only a slow `/health` probe runs (every minute) so a restored
 * token recovers on its own. A re-pair replaces the config and with it this client.
 *
 * A row left over from the retired plain-HTTP pairing (`config.fp == null`) is never contacted at
 * all: it starts in `needsRepair` with the `legacy` reason, runs no stream, no polling and no
 * probe, and its [api] refuses every call before the one it was given is reached.
 */
class MachineClient(
    val config: MachineConfig,
    api: DaemonApi,
    private val eventSource: () -> Flow<Any>,
    private val burn: BurnHistory,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val screenOn: StateFlow<Boolean>,
    private val tickerMs: Long = 1000
) {
    private val _state = MutableStateFlow(
        MachineState(config, needsRepair = if (config.isPinned) null else LEGACY_ROW.repairReason())
    )
    val state: StateFlow<MachineState> = _state.asStateFlow()

    /** [api] as given, watched: an auth failure from any caller (pause, resume) marks the machine. */
    val api: DaemonApi =
        if (config.isPinned) AuthWatchingApi(api) { reason -> enterRepair(reason) } else RefusingApi(LEGACY_ROW)

    private val jobs = mutableListOf<Job>()
    private val lock = Any()
    private var started = false
    private var stopped = false
    private var connectionJob: Job? = null
    private var repairJob: Job? = null
    private var pollingJob: Job? = null
    private var etag: String? = null
    private var thresholds: ThresholdsDto = ThresholdsDto()

    fun start() {
        synchronized(lock) {
            if (started) return
            started = true
            // Not a pairing: there is nothing to connect to, age or probe.
            if (!config.isPinned) return
            connectionJob = scope.launch { connectionLoop() }
            jobs += scope.launch { agingLoop() }
            jobs += scope.launch { projectTokensLoop() }
        }
    }

    /** Final: a stopped client never reconnects or probes again (a re-pair builds a new one). */
    fun stop() {
        synchronized(lock) {
            stopped = true
            stopPolling()
            connectionJob?.cancel()
            connectionJob = null
            repairJob?.cancel()
            repairJob = null
        }
        jobs.forEach { it.cancel() }
        jobs.clear()
    }

    fun burnKeyForSession(sessionId: String) = "${config.id}/s/$sessionId"

    fun burnKeyForProject(projectKey: String) = "${config.id}/p/$projectKey"

    fun burnKeyForMachine() = "${config.id}/m"

    /** `GET /v1/tokens?since=today&groupBy=project`. Failures are swallowed into `lastError`. */
    suspend fun refreshProjectTokens() {
        if (_state.value.needsRepair != null) return
        try {
            val dto = api.tokensByProjectToday()
            updateLive { it.copy(projectTokens = dto.groups.map { g -> g.toModel() }) }
        } catch (e: DaemonException) {
            _state.update { it.copy(lastError = e.userMessage()) }
        }
    }

    // ---- loops -------------------------------------------------------------------------------

    private suspend fun connectionLoop() {
        var failures = 0
        var backoffMs = BACKOFF_MIN_MS
        while (coroutineContext.isActive) {
            var opened = false
            eventSource()
                .onEach { item ->
                    when (item) {
                        Connection.Open -> {
                            opened = true
                            onOpen()
                        }
                        is Connection.Closed -> onClosed(item.error)
                        is DaemonEvent -> onEvent(item)
                        else -> Unit
                    }
                }
                .firstOrNull { it is Connection.Closed }
            if (_state.value.needsRepair != null) return

            if (opened) {
                failures = 0
                backoffMs = BACKOFF_MIN_MS
            } else {
                failures++
            }
            if (failures >= FAILURES_BEFORE_POLLING) startPolling()
            _state.update {
                it.copy(transport = if (pollingJob != null) MachineState.Transport.POLLING else it.transport)
            }
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(BACKOFF_MAX_MS)
        }
    }

    private suspend fun agingLoop() {
        while (coroutineContext.isActive) {
            delay(tickerMs)
            val now = clock.now()
            // The sessions a gone machine forgot must come back in full, not as a 304 against
            // the old ETag.
            if (_state.updateAndGet { it.aged(now) }.gone) etag = null
        }
    }

    private suspend fun projectTokensLoop() {
        while (coroutineContext.isActive) {
            refreshProjectTokens()
            delay(PROJECT_TOKENS_MS)
        }
    }

    // ---- lost pairing ------------------------------------------------------------------------

    /** Terminal until [repairProbeLoop] hears a 200 or a re-pair replaces this client. */
    private fun enterRepair(reason: RepairReason) {
        synchronized(lock) {
            if (_state.value.needsRepair != null) return
            _state.update {
                it.copy(
                    needsRepair = reason,
                    health = Health.DEAD,
                    transport = MachineState.Transport.DISCONNECTED,
                    sessions = emptyList()
                )
            }
            stopPolling()
            connectionJob?.cancel()
            connectionJob = null
            // Only a running client probes; a stopped one is being replaced or removed.
            if (started && !stopped) repairJob = scope.launch { repairProbeLoop() }
        }
    }

    private suspend fun repairProbeLoop() {
        while (coroutineContext.isActive) {
            delay(REPAIR_PROBE_MS)
            // A bearer-gated GET, so only an accepted token (and the pinned key) passes.
            val healthy = try {
                api.rules()
                true
            } catch (e: DaemonException) {
                false
            }
            if (healthy) {
                synchronized(lock) {
                    // The answer can land after stop(): blocking I/O is not a cancellation point.
                    if (stopped) return
                    _state.update { it.copy(needsRepair = null, lastError = null) }
                    repairJob = null
                    connectionJob = scope.launch { connectionLoop() }
                }
                return
            }
        }
    }

    private fun startPolling() {
        if (pollingJob != null || _state.value.needsRepair != null || stopped) return
        pollingJob = scope.launch {
            while (coroutineContext.isActive) {
                poll()
                delay(if (screenOn.value) POLL_SCREEN_ON_MS else POLL_SCREEN_OFF_MS)
            }
        }
        _state.update { it.copy(transport = MachineState.Transport.POLLING) }
    }

    private fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }

    private suspend fun poll() {
        var reachable = false
        try {
            applySummary(api.summary())
            reachable = true
        } catch (e: DaemonException) {
            _state.update { it.copy(lastError = e.userMessage()) }
        }
        try {
            when (val result = api.sessions(etag)) {
                is SessionsResult.Changed -> {
                    etag = result.etag
                    applySessions(result.dto)
                }
                SessionsResult.Unchanged -> Unit
            }
            reachable = true
        } catch (e: DaemonException) {
            _state.update { it.copy(lastError = e.userMessage()) }
        }
        try {
            val rules = api.rules()
            updateLive { it.copy(rules = rules.rules.map { rule -> rule.toModel() }) }
            reachable = true
        } catch (e: DaemonException) {
            _state.update { it.copy(lastError = e.userMessage()) }
        }
        if (reachable) touch()
    }

    // ---- event application -------------------------------------------------------------------

    /**
     * Every update that carries the daemon's data goes through here. Once the machine is marked
     * as needing a re-pair, a reply or event that was already in flight is dropped — checked
     * inside the atomic update, so it cannot slip in between the check and the write.
     */
    private fun updateLive(transform: (MachineState) -> MachineState) {
        _state.update { if (it.needsRepair != null) it else transform(it) }
    }

    private fun onOpen() {
        stopPolling()
        updateLive {
            it.copy(
                transport = MachineState.Transport.SSE,
                lastHeartbeatAt = clock.now(),
                health = Aging.health(clock.now(), clock.now()),
                gone = false,
                lastError = null
            )
        }
    }

    private fun onClosed(error: DaemonException?) {
        error?.repairReason()?.let { reason ->
            _state.update { it.copy(lastError = error.userMessage()) }
            enterRepair(reason)
            return
        }
        val transport =
            if (pollingJob != null) MachineState.Transport.POLLING else MachineState.Transport.DISCONNECTED
        _state.update { it.copy(transport = transport, lastError = error?.userMessage() ?: it.lastError) }
    }

    private fun onEvent(event: DaemonEvent) {
        touch()
        when (event) {
            is DaemonEvent.Snapshot -> applySnapshot(event)
            is DaemonEvent.Limits -> applyLimits(event)
            is DaemonEvent.Spend -> applySpend(event)
            is DaemonEvent.SessionChange -> applySessionChange(event)
            is DaemonEvent.Pause -> applyPause(event)
            is DaemonEvent.Update -> updateLive { it.copy(update = event.update.toModel()) }
            is DaemonEvent.Heartbeat -> applyHeartbeat(event)
            is DaemonEvent.Unknown -> Unit
        }
    }

    /** Every event, heartbeat included, proves the daemon is alive — unless it has rejected us. */
    private fun touch() {
        if (_state.value.needsRepair != null) return
        val now = clock.now()
        updateLive { it.copy(lastHeartbeatAt = now, health = Aging.health(now, now), gone = false) }
    }

    private fun applySnapshot(event: DaemonEvent.Snapshot) {
        val now = clock.now()
        thresholds = event.thresholds
        etag = "W/\"${event.rev}\""
        val sessions = event.sessions.map { it.toModel() }
        updateLive {
            it.copy(
                name = event.name?.let(Labels::machineName),
                version = event.version,
                user = event.user?.toModel(),
                limits = limitsOf(event.limits),
                // The daemon's own fetch time, never `now`: limits belong to the account, and the
                // team merge ranks two machines' copies against each other. Stamping the local
                // clock makes whichever machine reconnected last look freshest, so a stale copy
                // wins and the headline flips between two values.
                limitsFetchedAt = event.fetchedAt.toInstantOrNull(),
                today = event.today.toModel(),
                sessions = sessions,
                rules = event.rules.map { r -> r.toModel() },
                update = event.update?.toModel(),
                rev = event.rev,
                transport = MachineState.Transport.SSE
            )
        }
        burn.record(burnKeyForMachine(), now, event.today.toModel().total)
        recordSessionBurn(sessions, now)
    }

    /**
     * `lastHeartbeatAt` is already bumped by [touch] off the local clock — aging must not depend
     * on the daemon's clock — so only the revision travels with the heartbeat.
     */
    private fun applyHeartbeat(event: DaemonEvent.Heartbeat) {
        if (event.rev <= 0) return
        etag = "W/\"${event.rev}\""
        updateLive { if (event.rev > it.rev) it.copy(rev = event.rev) else it }
    }

    private fun applyLimits(event: DaemonEvent.Limits) {
        updateLive { it.copy(limits = limitsOf(event.limits), limitsFetchedAt = event.fetchedAt.toInstantOrNull()) }
    }

    /** `today` is the cumulative authority; the per-event `delta` is deliberately not used. */
    private fun applySpend(event: DaemonEvent.Spend) {
        val today = event.today.toModel()
        updateLive { it.copy(today = today) }
        burn.record(burnKeyForMachine(), clock.now(), today.total)
    }

    private fun applySessionChange(event: DaemonEvent.SessionChange) {
        val session = event.session.toModel()
        val now = clock.now()
        if (event.type == "end") {
            updateLive { it.copy(sessions = it.sessions.filterNot { s -> s.sessionId == session.sessionId }) }
            burn.forget(burnKeyForSession(session.sessionId))
        } else {
            updateLive {
                val others = it.sessions.filterNot { s -> s.sessionId == session.sessionId }
                it.copy(sessions = others + session)
            }
        }
        recordSessionBurn(_state.value.sessions, now)
    }

    private fun applyPause(event: DaemonEvent.Pause) {
        updateLive { it.copy(rules = event.rules.map { r -> r.toModel() }) }
        // Pause state lives on the sessions, so re-read them once.
        scope.launch {
            try {
                when (val result = api.sessions(null)) {
                    is SessionsResult.Changed -> {
                        etag = result.etag
                        applySessions(result.dto)
                    }
                    SessionsResult.Unchanged -> Unit
                }
            } catch (e: DaemonException) {
                _state.update { it.copy(lastError = e.userMessage()) }
            }
        }
    }

    private fun applySummary(summary: SummaryDto) {
        val now = clock.now()
        thresholds = summary.thresholds
        val today = summary.today.toModel()
        updateLive {
            it.copy(
                limits = summary.toLimits(),
                limitsFetchedAt = summary.fetchedAt.toInstantOrNull(),
                today = today
            )
        }
        burn.record(burnKeyForMachine(), now, today.total)
    }

    private fun applySessions(dto: SessionsDto) {
        val sessions = dto.sessions.map { it.toModel() }
        updateLive { it.copy(sessions = sessions, rev = dto.rev) }
        recordSessionBurn(sessions, clock.now())
    }

    private fun recordSessionBurn(sessions: List<Session>, now: Instant) {
        sessions.forEach { burn.record(burnKeyForSession(it.sessionId), now, it.tokens.total) }
        sessions.groupBy { it.projectKey }.forEach { (key, group) ->
            burn.record(burnKeyForProject(key), now, group.sumOf { it.tokens.total })
        }
    }

    /**
     * A bare `limits` payload has no status map, so derive each status from the row itself. The
     * last summary's map must not be reused: it describes the old percents, so a week that
     * reset from 99% to 0% stayed red until the next snapshot.
     */
    private fun limitsOf(limits: List<LimitDto>): List<Limit> = limits.withoutUnknownScoped().map { dto ->
        dto.toModel(statusFor(dto, thresholds))
    }

    companion object {
        private val LEGACY_ROW = DaemonException(DaemonException.LEGACY, 0, null, null)

        /**
         * The client for a row left over from the retired plain-HTTP pairing. It owns no
         * transport at all — there is none to build — and only reports that the machine must be
         * paired again.
         */
        fun retired(
            config: MachineConfig,
            burn: BurnHistory,
            clock: Clock,
            scope: CoroutineScope,
            screenOn: StateFlow<Boolean>
        ): MachineClient {
            require(!config.isPinned) { "a pinned machine needs a real transport" }
            return MachineClient(config, RefusingApi(LEGACY_ROW), { emptyFlow() }, burn, clock, scope, screenOn)
        }

        private const val BACKOFF_MIN_MS = 3_000L
        private const val BACKOFF_MAX_MS = 30_000L
        private const val FAILURES_BEFORE_POLLING = 2
        private const val POLL_SCREEN_ON_MS = 2_000L
        private const val POLL_SCREEN_OFF_MS = 30_000L
        private const val PROJECT_TOKENS_MS = 30_000L
        private const val REPAIR_PROBE_MS = 60_000L
    }
}

/** The API of a row that is not a pairing: every call fails with [error] and nothing is sent. */
private class RefusingApi(private val error: DaemonException) : DaemonApi {
    override suspend fun health(): HealthDto = throw error

    override suspend fun summary(): SummaryDto = throw error

    override suspend fun sessions(ifNoneMatch: String?): SessionsResult = throw error

    override suspend fun tokensByProjectToday(): TokensDto = throw error

    override suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto = throw error

    override suspend fun resume(scope: String): ResumeResponseDto = throw error

    override suspend fun rules(): RulesDto = throw error
}

/** Passes every call through; a 401 or pin mismatch also reports the machine as needing a re-pair. */
private class AuthWatchingApi(
    private val inner: DaemonApi,
    private val onLost: (RepairReason) -> Unit
) : DaemonApi {
    private inline fun <T> watch(block: () -> T): T = try {
        block()
    } catch (e: DaemonException) {
        e.repairReason()?.let(onLost)
        throw e
    }

    override suspend fun health() = watch { inner.health() }

    override suspend fun summary() = watch { inner.summary() }

    override suspend fun sessions(ifNoneMatch: String?) = watch { inner.sessions(ifNoneMatch) }

    override suspend fun tokensByProjectToday() = watch { inner.tokensByProjectToday() }

    override suspend fun pause(scope: String, mode: PauseMode, reason: String) = watch {
        inner.pause(
            scope,
            mode,
            reason
        )
    }

    override suspend fun resume(scope: String) = watch { inner.resume(scope) }

    override suspend fun rules() = watch { inner.rules() }
}
