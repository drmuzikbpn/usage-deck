// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.pause

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.daemon.DaemonApi
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.daemon.ResumeResponseDto
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.TeamState
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class PauseOutcome(val machineId: String, val ok: Boolean, val error: String?)

/** `null` turns escalation off; otherwise 30..600 seconds (spec §9). */
data class PauseSettings(val escalationSeconds: Int? = 90)

/**
 * Issues pause/resume against the right machines and runs the soft→hard escalation timer.
 *
 * Only rules whose `reason` equals this phone's `usage-deck:<installId>` are ours; a soft pause
 * started from the CLI or another phone never escalates here.
 */
class PauseController(
    private val team: StateFlow<TeamState>,
    private val apis: (machineId: String) -> DaemonApi?,
    private val installId: String,
    private val store: EscalationStore,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val settings: StateFlow<PauseSettings>
) {
    val reason: String = "usage-deck:$installId"

    private val _pending = MutableStateFlow<List<Escalation>>(emptyList())
    val pending: StateFlow<List<Escalation>> = _pending.asStateFlow()

    private val _inFlight = MutableStateFlow<Set<String>>(emptySet())
    val inFlight: StateFlow<Set<String>> = _inFlight.asStateFlow()

    private val _lastOutcomes = MutableStateFlow<List<PauseOutcome>>(emptyList())
    val lastOutcomes: StateFlow<List<PauseOutcome>> = _lastOutcomes.asStateFlow()

    /** Escalation keys whose rule we have actually observed; only those can be cancelled by its absence. */
    private val observed = mutableSetOf<String>()
    private var timer: Job? = null

    fun start() {
        if (timer != null) return
        _pending.value = store.load()
        timer = scope.launch {
            while (coroutineContext.isActive) {
                tick()
                delay(TICK_MS)
            }
        }
    }

    fun stop() {
        timer?.cancel()
        timer = null
    }

    suspend fun tap(target: PauseTarget) {
        if (isPaused(target)) resume(target) else soft(target)
    }

    suspend fun hold(target: PauseTarget) {
        hard(target)
    }

    suspend fun soft(target: PauseTarget): List<PauseOutcome> = act(target, PauseMode.SOFT)

    suspend fun hard(target: PauseTarget): List<PauseOutcome> = act(target, PauseMode.HARD)

    /**
     * Lifts the target's own rule and, for a project, every session rule underneath it. Daemons
     * from 0.1.66 cascade a project resume themselves; older ones (the Studio is on 0.1.0) resume
     * exactly the scope they are given, and a project's control shows paused whenever any of its
     * sessions is. Resuming an already-lifted scope is a no-op, so the fan-out is harmless on both.
     */
    suspend fun resume(target: PauseTarget): List<PauseOutcome> {
        _lastOutcomes.value = emptyList()
        val scopeString = target.scope()
        val outcomes = targetMachines(target).map { machineId ->
            val scopes = listOf(scopeString) + nestedPausedScopes(machineId, target)
            withInFlight(machineId, scopeString) {
                val api = apis(machineId)
                if (api == null) {
                    networkOutcome(machineId)
                } else {
                    // Resume the broad scope first. New daemons cascade a project resume to its
                    // session rules; when the response proves that happened, do not misclassify a
                    // redundant child no-op as a failure or leave its escalation timer behind.
                    val broad = resumeAttempt(api, scopeString, hasStandingScope(machineId, scopeString))
                    val failures = mutableMapOf(scopeString to broad.error)
                    scopes.drop(1).forEach { childScope ->
                        if (broad.error == null && cascadeConfirmed(machineId, childScope, broad.response)) {
                            failures[childScope] = null
                        } else {
                            failures[childScope] =
                                resumeAttempt(api, childScope, hasStandingScope(machineId, childScope)).error
                        }
                    }
                    failures.filterValues { it == null }.keys.forEach { cancelEscalation(machineId, it) }
                    val own = failures.getValue(scopeString)
                    if (own == null) {
                        PauseOutcome(
                            machineId,
                            true,
                            null
                        )
                    } else {
                        PauseOutcome(machineId, false, own)
                    }
                }
            }
        }
        _lastOutcomes.value = outcomes
        return outcomes
    }

    private data class ResumeAttempt(val response: ResumeResponseDto? = null, val error: String? = null)

    private suspend fun resumeAttempt(api: DaemonApi, scope: String, expectsChange: Boolean): ResumeAttempt = try {
        val result = api.resume(scope)
        if (expectsChange && result.removed.isEmpty() && result.resumed.isEmpty()) {
            ResumeAttempt(error = "Nothing resumed. Refreshing pause state may be required.")
        } else {
            ResumeAttempt(response = result)
        }
    } catch (e: DaemonException) {
        ResumeAttempt(error = e.userMessage())
    }

    private fun cascadeConfirmed(machineId: String, scope: String, response: ResumeResponseDto?): Boolean {
        response ?: return false
        val machine = team.value.machine(machineId) ?: return false
        val ruleIds = machine.rules.filter { it.scope == scope }.map { it.id }
        if (ruleIds.isNotEmpty() && ruleIds.all(response.removed::contains)) return true
        val sessionId = scope.removePrefix("session:")
        return scope.startsWith("session:") && sessionId in response.resumed
    }

    private fun hasStandingScope(machineId: String, scope: String): Boolean {
        val machine = team.value.machine(machineId) ?: return false
        return hasRule(machine, scope) || machine.sessions.any { it.pause?.scope == scope }
    }

    /** The session scopes under a project target that are paused or carry a rule on [machineId]. */
    private fun nestedPausedScopes(machineId: String, target: PauseTarget): List<String> {
        if (target !is PauseTarget.Project) return emptyList()
        val machine = team.value.machine(machineId) ?: return emptyList()
        return machine.sessions
            .filter { it.projectKey == target.projectKey }
            .map { it to PauseTarget.Session(machineId, it.sessionId).scope() }
            .filter { (session, scope) -> session.pause?.scope == scope || hasRule(machine, scope) }
            .map { it.second }
            .distinct()
    }

    fun isPaused(target: PauseTarget): Boolean {
        val state = team.value
        val scopeString = target.scope()
        return when (target) {
            is PauseTarget.Session ->
                state.session(target.machineId, target.sessionId)?.pause != null ||
                    hasRule(state.machine(target.machineId), scopeString)
            is PauseTarget.Project ->
                state.machine(target.machineId)?.sessions
                    ?.any { it.projectKey == target.projectKey && it.pause != null } == true ||
                    hasRule(state.machine(target.machineId), scopeString)
            PauseTarget.All -> state.machines.any { machine ->
                machine.health != Health.DEAD &&
                    (hasRule(machine, scopeString) || machine.sessions.any { it.pause?.scope == scopeString })
            }
        }
    }

    fun escalationFor(target: PauseTarget): Escalation? {
        val scopeString = target.scope()
        return _pending.value.firstOrNull {
            it.scope == scopeString && (target !is PauseTarget.Session || it.machineId == target.machineId) &&
                (target !is PauseTarget.Project || it.machineId == target.machineId)
        }
    }

    // ---- internals ---------------------------------------------------------------------------

    private suspend fun act(target: PauseTarget, mode: PauseMode): List<PauseOutcome> {
        _lastOutcomes.value = emptyList()
        val scopeString = target.scope()
        val fanOut = target is PauseTarget.All
        val outcomes = coroutineScope {
            targetMachines(target)
                .map { machineId -> async { pauseOne(machineId, scopeString, mode, fanOut) } }
                .awaitAll()
        }
        _lastOutcomes.value = outcomes
        return outcomes
    }

    private suspend fun pauseOne(
        machineId: String,
        scopeString: String,
        mode: PauseMode,
        retryOnFailure: Boolean
    ): PauseOutcome {
        refusedLocally(machineId, scopeString, mode)?.let { return it }
        val api = apis(machineId) ?: return networkOutcome(machineId)
        return withInFlight(machineId, scopeString) {
            var outcome = attemptPause(api, machineId, scopeString, mode)
            if (!outcome.ok && retryOnFailure) {
                delay(RETRY_DELAY_MS)
                outcome = attemptPause(api, machineId, scopeString, mode)
            }
            if (outcome.ok && mode == PauseMode.SOFT) scheduleEscalation(machineId, scopeString)
            outcome
        }
    }

    private suspend fun attemptPause(
        api: DaemonApi,
        machineId: String,
        scopeString: String,
        mode: PauseMode
    ): PauseOutcome = try {
        api.pause(scopeString, mode, reason)
        PauseOutcome(machineId, true, null)
    } catch (e: DaemonException) {
        PauseOutcome(machineId, false, e.userMessage())
    }

    /** A hard freeze on a session with no trusted pid is refused here, without troubling the daemon. */
    private fun refusedLocally(machineId: String, scopeString: String, mode: PauseMode): PauseOutcome? {
        if (mode != PauseMode.HARD || !scopeString.startsWith(SESSION_PREFIX)) return null
        val sessionId = scopeString.removePrefix(SESSION_PREFIX)
        val session = team.value.session(machineId, sessionId) ?: return null
        if (session.canHardPause) return null
        return PauseOutcome(machineId, false, DaemonException.DEFAULTS["conflict"])
    }

    private fun networkOutcome(machineId: String) = PauseOutcome(machineId, false, DaemonException.DEFAULTS["network"])

    private suspend fun <T> withInFlight(machineId: String, scopeString: String, block: suspend () -> T): T {
        val key = inFlightKey(machineId, scopeString)
        _inFlight.update { it + key }
        try {
            return block()
        } finally {
            _inFlight.update { it - key }
        }
    }

    private fun inFlightKey(machineId: String, scopeString: String) = "$machineId|$scopeString"

    private fun targetMachines(target: PauseTarget): List<String> = when (target) {
        is PauseTarget.Session -> listOf(target.machineId)
        is PauseTarget.Project -> listOf(target.machineId)
        PauseTarget.All -> team.value.machines.filter { it.health != Health.DEAD }.map { it.config.id }
    }

    private fun hasRule(machine: MachineState?, scopeString: String): Boolean =
        machine?.rules?.any { it.scope == scopeString } == true

    private fun isOurRule(machineId: String, scopeString: String): Boolean =
        team.value.machine(machineId)?.rules?.any { it.scope == scopeString && it.reason == reason } == true

    private fun scheduleEscalation(machineId: String, scopeString: String) {
        val seconds = settings.value.escalationSeconds ?: return
        val escalation = Escalation(machineId, scopeString, clock.now().plusSeconds(seconds.toLong()))
        _pending.update { list ->
            list.filterNot { it.machineId == machineId && it.scope == scopeString } + escalation
        }
        store.save(_pending.value)
    }

    private fun cancelEscalation(machineId: String, scopeString: String) {
        observed.remove(inFlightKey(machineId, scopeString))
        val before = _pending.value
        val after = before.filterNot { it.machineId == machineId && it.scope == scopeString }
        if (after.size != before.size) {
            _pending.value = after
            store.save(after)
        }
    }

    private fun tick() {
        val now = clock.now()
        val survivors = mutableListOf<Escalation>()
        val fire = mutableListOf<Escalation>()
        var changed = false

        _pending.value.forEach { escalation ->
            val key = inFlightKey(escalation.machineId, escalation.scope)
            if (isOurRule(escalation.machineId, escalation.scope)) {
                observed += key
            } else if (key in observed) {
                // our rule was resumed elsewhere
                observed -= key
                changed = true
                return@forEach
            }
            if (now.isBefore(escalation.fireAt)) survivors += escalation else fire += escalation
        }

        if (fire.isEmpty() && !changed) return
        _pending.value = survivors
        store.save(survivors)

        fire.forEach { escalation ->
            observed -= inFlightKey(escalation.machineId, escalation.scope)
            val machine = team.value.machine(escalation.machineId)
            if (machine == null || machine.health == Health.DEAD) return@forEach
            scope.launch {
                pauseOne(escalation.machineId, escalation.scope, PauseMode.HARD, retryOnFailure = false)
            }
        }
    }

    private companion object {
        const val TICK_MS = 1_000L
        const val RETRY_DELAY_MS = 2_000L
        const val SESSION_PREFIX = "session:"
    }
}
