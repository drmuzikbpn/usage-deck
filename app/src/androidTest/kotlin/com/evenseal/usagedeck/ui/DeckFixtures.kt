// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.alerts.Alert
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.Discovered
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.LimitStatus
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.PauseRule
import com.evenseal.usagedeck.core.model.PauseState
import com.evenseal.usagedeck.core.model.ProjectTokens
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.Tokens
import com.evenseal.usagedeck.core.model.User
import com.evenseal.usagedeck.core.pause.Escalation
import com.evenseal.usagedeck.core.pause.PauseOutcome
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.kiosk.DeckMode
import com.evenseal.usagedeck.settings.Settings
import com.evenseal.usagedeck.wifi.WifiStatus
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Shared fixtures for the Compose tests — one real state shape, reused by every screen test. */
object Fx {
    val NOW: Instant = Instant.parse("2026-09-13T12:00:00Z")

    fun limit(
        id: String,
        percent: Int,
        status: LimitStatus = LimitStatus.OK,
        resetsAt: Instant? = NOW.plusSeconds(9_180)
    ) = Limit(
        id = id,
        kind = if (id == "session") "session" else "weekly_all",
        group = "default",
        percent = percent,
        severity = status.name.lowercase(),
        resetsAt = resetsAt,
        scopeModel = null,
        isActive = true,
        status = status
    )

    fun session(
        id: String,
        projectKey: String = "/repo/plannerapp",
        projectName: String = "plannerapp",
        tokens: Long = 1_900_000,
        pause: PauseState? = null,
        lastToolName: String? = "Edit",
        pid: Int? = 4242
    ) = Session(
        sessionId = id,
        pid = pid,
        alive = true,
        discovered = if (pid != null) Discovered.HOOK else Discovered.TRANSCRIPT,
        cwd = projectKey,
        transcriptPath = null,
        projectKey = projectKey,
        projectName = projectName,
        worktree = null,
        model = "sonnet",
        startedAt = NOW.minusSeconds(3_600),
        lastActivityAt = NOW.minusSeconds(12),
        tokens = Tokens(input = tokens, output = 0, messages = 12),
        pause = pause,
        lastTool = lastToolName?.let { com.evenseal.usagedeck.core.model.LastTool(it, NOW.minusSeconds(8)) }
    )

    fun softPause(scope: String) = PauseState(PauseMode.SOFT, "r1", scope, NOW.minusSeconds(20), emptyList())

    fun machine(
        id: String,
        name: String,
        email: String,
        fiveHour: Int,
        sevenDay: Int,
        health: Health = Health.FRESH,
        sessions: List<Session> = emptyList(),
        today: Tokens = Tokens(input = 3_114_754),
        projectTokens: List<ProjectTokens> = emptyList(),
        rules: List<PauseRule> = emptyList()
    ) = MachineState(
        config = MachineConfig(id, name, "100.1.1.1", 8787, "token"),
        health = health,
        lastHeartbeatAt = NOW.minusSeconds(2),
        name = name,
        version = "0.1.417+abc1234",
        user = User(email, "uuid-$id", name),
        limits = listOf(limit("session", fiveHour), limit("weekly_all", sevenDay)),
        limitsFetchedAt = NOW.minusSeconds(5),
        today = today,
        sessions = sessions,
        rules = rules,
        update = null,
        projectTokens = projectTokens,
        rev = 7,
        lastError = null,
        transport = MachineState.Transport.SSE
    )

    /** Adam at 42 %, Sam at 77 %, one live session each. */
    fun twoUsers(): TeamState = TeamState(
        listOf(
            machine(
                id = "m1",
                name = "Adam",
                email = "adam@example.com",
                fiveHour = 42,
                sevenDay = 18,
                sessions = listOf(session("a1b2c3d4"))
            ),
            machine(
                id = "m2",
                name = "Sam",
                email = "sam@example.com",
                fiveHour = 77,
                sevenDay = 31,
                sessions = listOf(session("e5f6a7b8", projectKey = "/repo/audioleveler", projectName = "audioleveler"))
            )
        )
    )
}

/** Records what the UI asked for instead of talking to a daemon. */
class RecordingPauseActions(
    private val paused: Set<String> = emptySet(),
    private val escalations: Map<String, Escalation> = emptyMap(),
    override val inFlight: StateFlow<Set<String>> = MutableStateFlow(emptySet()),
    override val lastOutcomes: StateFlow<List<PauseOutcome>> = MutableStateFlow(emptyList())
) : PauseActions {
    val taps = mutableListOf<PauseTarget>()
    val holds = mutableListOf<PauseTarget>()

    override fun tap(target: PauseTarget) {
        taps += target
    }

    override fun hold(target: PauseTarget) {
        holds += target
    }

    override fun isPaused(target: PauseTarget) = target.scope() in paused

    override fun escalationFor(target: PauseTarget) = escalations[target.scope()]
}

/** Builds a [DeckViewModel] over fixtures, with no graph and no network. */
fun fakeViewModel(
    team: TeamState = Fx.twoUsers(),
    actions: PauseActions = RecordingPauseActions(),
    burn: BurnHistory = BurnHistory(),
    wifi: WifiStatus = WifiStatus(connected = true, ssid = "deck", rssi = -50, ip = "10.0.0.2", bars = 3),
    alert: Alert? = null,
    settings: Settings = Settings(),
    /** Where the view model's settings writes land; the Ledger's rename test reads it back. */
    settingsFlow: MutableStateFlow<Settings> = MutableStateFlow(settings),
    /** Swap the team mid-test to exercise reordering. */
    teamFlow: MutableStateFlow<TeamState> = MutableStateFlow(team)
): DeckViewModel = DeckViewModel(
    team = teamFlow,
    wifi = MutableStateFlow(wifi),
    mode = MutableStateFlow(DeckMode.DOCK),
    settings = settingsFlow,
    burn = burn,
    actions = actions,
    alerts = MutableStateFlow(alert),
    clock = Clock { Fx.NOW },
    scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    updateSettings = { f -> settingsFlow.value = f(settingsFlow.value) }
)
