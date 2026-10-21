// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.SystemClock
import com.evenseal.usagedeck.core.alerts.Alert
import com.evenseal.usagedeck.core.alerts.AlertKind
import com.evenseal.usagedeck.core.model.ActivityOrder
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.PauseState
import com.evenseal.usagedeck.core.model.ProjectView
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.pause.Escalation
import com.evenseal.usagedeck.core.pause.PauseOutcome
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.kiosk.DeckMode
import com.evenseal.usagedeck.service.DeckGraph
import com.evenseal.usagedeck.settings.Settings
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.components.PauseVisual
import com.evenseal.usagedeck.wifi.WifiStatus
import java.time.Duration
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * The seam between the UI and [com.evenseal.usagedeck.core.pause.PauseController]: the screens
 * only ever need these four things, and a test can record them without a daemon.
 */
interface PauseActions {
    val inFlight: StateFlow<Set<String>>
    val lastOutcomes: StateFlow<List<PauseOutcome>>

    fun tap(target: PauseTarget)

    fun hold(target: PauseTarget)

    fun isPaused(target: PauseTarget): Boolean

    fun escalationFor(target: PauseTarget): Escalation?
}

/**
 * `BurnHistory`'s keys are `MachineClient`'s to define; this mirrors the scheme so the UI can
 * ask for a series without holding a client. `BurnKeysContractTest` pins the two together.
 */
object BurnKeys {
    fun session(machineId: String, sessionId: String) = "$machineId/s/$sessionId"

    fun project(machineId: String, projectKey: String) = "$machineId/p/$projectKey"

    fun machine(machineId: String) = "$machineId/m"
}

/**
 * One view model for the whole deck. Every screen reads the same [TeamState] and the same
 * one-second [now] ticker, so nothing on the dock can disagree with anything else on it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeckViewModel(
    val team: StateFlow<TeamState>,
    val wifi: StateFlow<WifiStatus>,
    val mode: StateFlow<DeckMode>,
    val settings: StateFlow<Settings>,
    private val burn: BurnHistory,
    private val actions: PauseActions,
    private val alerts: StateFlow<Alert?>,
    private val isQuiet: (LocalTime) -> Boolean = { false },
    private val clock: Clock = SystemClock,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val scope: CoroutineScope? = null,
    /** Writes a settings change; the Ledger's long-press rename goes through here. */
    private val updateSettings: ((Settings) -> Settings) -> Unit
) : ViewModel() {
    constructor(graph: DeckGraph) : this(
        team = graph.team,
        wifi = graph.wifi.status,
        mode = graph.mode.mode,
        settings = graph.settings.settings,
        burn = graph.burn,
        actions = ControllerPauseActions(graph),
        alerts = graph.notifier.latest,
        isQuiet = graph.settings::isQuiet,
        clock = graph.clock,
        updateSettings = graph.settings::update
    )

    private val work: CoroutineScope get() = scope ?: viewModelScope

    private val _now = MutableStateFlow(clock.now())

    /** One ticker for the entire UI; every countdown and age on screen reads from it. */
    val now: StateFlow<Instant> = _now.asStateFlow()

    private val limitChip: StateFlow<String?> = alerts
        .flatMapLatest { alert ->
            if (alert == null || (alert.kind != AlertKind.WARN && alert.kind != AlertKind.CRITICAL)) {
                flowOf<String?>(null)
            } else {
                flow {
                    emit(alert.body)
                    delay(CHIP_MILLIS)
                    emit(null)
                }
            }
        }
        .stateIn(work, SharingStarted.Eagerly, null)

    private val pauseChip: StateFlow<String?> = actions.lastOutcomes
        .flatMapLatest { outcomes ->
            val error = outcomes.firstOrNull { !it.ok }?.error
            if (error == null) {
                flowOf<String?>(null)
            } else {
                flow {
                    emit(error)
                    delay(CHIP_MILLIS)
                    emit(null)
                }
            }
        }
        .stateIn(work, SharingStarted.Eagerly, null)

    /** The most recent limit warning or pause failure, shown in the status bar for a minute. */
    val alertChip: StateFlow<String?> = combine(pauseChip, limitChip) { pause, limit -> pause ?: limit }
        .stateIn(work, SharingStarted.Eagerly, null)

    /** The night scrim multiplier: full brightness unless quiet hours are on (spec §5). */
    val dimLevel: StateFlow<Float> = combine(now, settings) { instant, current ->
        if (current.autoDim && isQuiet(instant.atZone(zone).toLocalTime())) current.nightDim else 1f
    }.stateIn(work, SharingStarted.Eagerly, 1f)

    init {
        work.launch {
            while (true) {
                _now.value = clock.now()
                delay(TICK_MILLIS)
            }
        }
    }

    fun rate(machineId: String, sessionId: String): Double =
        burn.ratePerMinute(BurnKeys.session(machineId, sessionId), _now.value)

    fun projectRate(machineId: String, key: String): Double =
        burn.ratePerMinute(BurnKeys.project(machineId, key), _now.value)

    /** Live projects for the portrait home, busiest first, by the same rates their rows show. */
    fun projectsByActivity(team: TeamState): List<ProjectView> = ActivityOrder.projects(
        team.projects,
        projectRate = { projectRate(it.machineId, it.key) },
        sessionRate = { project, session -> rate(project.machineId, session.sessionId) }
    )

    /** Every live session for the landscape home, busiest first. */
    fun sessionsByActivity(team: TeamState): List<ActivityOrder.Row> =
        ActivityOrder.sessions(team.projects) { project, session -> rate(project.machineId, session.sessionId) }

    fun series(machineId: String, sessionId: String, minutes: Int = 30, buckets: Int = 16): List<Double> =
        burn.series(BurnKeys.session(machineId, sessionId), _now.value, Duration.ofMinutes(minutes.toLong()), buckets)

    /** The project drill-in's five-hour chart. */
    fun projectSeries(machineId: String, key: String): List<Double> =
        burn.series(BurnKeys.project(machineId, key), _now.value, Duration.ofHours(5), PROJECT_BUCKETS)

    /** The Ledger header's 30-minute sparkline for a whole project. */
    fun projectSparkline(machineId: String, key: String, minutes: Int = 30, buckets: Int = 16): List<Double> =
        burn.series(BurnKeys.project(machineId, key), _now.value, Duration.ofMinutes(minutes.toLong()), buckets)

    private val _expanded = MutableStateFlow<Set<String>>(emptySet())

    /** Projects the user has opened on the Ledger, keyed `machineId|projectKey`. Collapsed by default. */
    val expanded: StateFlow<Set<String>> = _expanded.asStateFlow()

    fun toggleExpanded(machineId: String, key: String) = toggle(projectId(machineId, key))

    /** The Ledger's user quota blocks fold to one line by default; they share [expanded] with projects. */
    fun toggleUserExpanded(userKey: String) = toggle(userId(userKey))

    private fun toggle(id: String) {
        _expanded.value = if (id in _expanded.value) _expanded.value - id else _expanded.value + id
    }

    /** Sets, or with a blank [name] clears, the deck's own name for a person. */
    fun renameUser(userKey: String, name: String) = updateSettings { it.renamed(userKey, name) }

    fun machineToday(machineId: String) = team.value.machine(machineId)?.today

    /**
     * What the pause control for [target] should draw. In-flight beats everything, then a dead
     * machine disables the control, then the actual pause state.
     */
    fun visual(target: PauseTarget): PauseVisual {
        if (isInFlight(target)) return PauseVisual.InFlight
        if (isDead(target)) return PauseVisual.Disabled

        inheritedPauseSource(target)?.let { return PauseVisual.Inherited(it) }

        val state = team.value
        val pause = when (target) {
            is PauseTarget.Session -> state.session(target.machineId, target.sessionId)?.pause
            is PauseTarget.Project ->
                state.machine(target.machineId)?.sessions
                    ?.filter { it.projectKey == target.projectKey }
                    ?.mapNotNull { it.pause }
                    ?.maxByOrNull { it.mode.ordinal }
            PauseTarget.All ->
                state.machines
                    .filter { it.health != Health.DEAD }
                    .flatMap { machine ->
                        machine.sessions.mapNotNull { it.pause }.filter { it.scope == target.scope() } +
                            machine.rules
                                .filter { it.scope == target.scope() }
                                .map { rule ->
                                    PauseState(rule.mode, rule.id, rule.scope, rule.createdAt, emptyList())
                                }
                    }
                    .maxByOrNull { it.mode.ordinal }
        }

        return when {
            pause?.mode == PauseMode.HARD -> PauseVisual.Frozen(
                Format.age(pause.since, _now.value).removeSuffix(" ago")
            )
            pause?.mode == PauseMode.SOFT || actions.isPaused(target) -> PauseVisual.Soft(countdownFor(target))
            else -> PauseVisual.Idle
        }
    }

    /** A broader rule must be resumed at its own scope; a child resume would be a silent no-op. */
    fun inheritedPauseSource(target: PauseTarget): String? {
        if (target === PauseTarget.All) return null
        val machineId = machineIdOf(target) ?: return null
        val machine = team.value.machine(machineId) ?: return null
        val effectiveScopes = when (target) {
            is PauseTarget.Project ->
                machine.sessions
                    .filter { it.projectKey == target.projectKey }
                    .mapNotNull { it.pause?.scope }
            is PauseTarget.Session -> listOfNotNull(
                machine.sessions.firstOrNull { it.sessionId == target.sessionId }?.pause?.scope
            )
            PauseTarget.All -> emptyList()
        }
        if (PauseTarget.All.scope() in effectiveScopes || machine.rules.any { it.scope == PauseTarget.All.scope() }) {
            return PauseVisual.Inherited.ALL
        }
        if (target is PauseTarget.Session) {
            val projectKey = machine.sessions
                .firstOrNull { it.sessionId == target.sessionId }
                ?.projectKey
            val projectScope = projectKey?.let { PauseTarget.Project(machineId, it).scope() }
            if (projectScope in effectiveScopes || machine.rules.any { it.scope == projectScope }) {
                return PauseVisual.Inherited.PROJECT
            }
        }
        return null
    }

    fun tap(target: PauseTarget) = actions.tap(target)

    fun hold(target: PauseTarget) = actions.hold(target)

    private fun countdownFor(target: PauseTarget): String? =
        actions.escalationFor(target)?.let { Format.countdown(it.fireAt, _now.value) }

    private fun isInFlight(target: PauseTarget): Boolean {
        val scope = target.scope()
        return actions.inFlight.value.any { key ->
            val (machineId, keyScope) = key.split('|', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            keyScope == scope && (target === PauseTarget.All || machineId == machineIdOf(target))
        }
    }

    private fun machineIdOf(target: PauseTarget): String? = when (target) {
        is PauseTarget.Session -> target.machineId
        is PauseTarget.Project -> target.machineId
        PauseTarget.All -> null
    }

    private fun isDead(target: PauseTarget): Boolean {
        val id = machineIdOf(target) ?: return team.value.machines.isNotEmpty() &&
            team.value.machines.all { it.health == Health.DEAD }
        return team.value.machine(id)?.health == Health.DEAD
    }

    companion object {
        fun projectId(machineId: String, key: String) = "$machineId|$key"

        /** Users share the [expanded] set with projects under their own prefix. */
        fun userId(userKey: String) = "user|$userKey"

        private const val TICK_MILLIS = 1_000L
        private const val CHIP_MILLIS = 60_000L
        private const val PROJECT_BUCKETS = 30
    }
}

/** The production [PauseActions], fired on the graph's scope so a gesture never blocks the frame. */
private class ControllerPauseActions(private val graph: DeckGraph) : PauseActions {
    override val inFlight: StateFlow<Set<String>> get() = graph.pause.inFlight
    override val lastOutcomes: StateFlow<List<PauseOutcome>> get() = graph.pause.lastOutcomes

    override fun tap(target: PauseTarget) {
        graph.scope.launch { graph.pause.tap(target) }
    }

    override fun hold(target: PauseTarget) {
        graph.scope.launch { graph.pause.hold(target) }
    }

    override fun isPaused(target: PauseTarget) = graph.pause.isPaused(target)

    override fun escalationFor(target: PauseTarget) = graph.pause.escalationFor(target)
}
