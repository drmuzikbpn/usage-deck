// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.demo

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.Discovered
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.LastTool
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.LimitStatus
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.PauseRule
import com.evenseal.usagedeck.core.model.PauseState
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.Tokens
import com.evenseal.usagedeck.core.model.User
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.BurnKeys
import java.time.Duration
import java.time.Instant
import kotlin.math.cos
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

/**
 * "Try the demo": two made-up machines, so App Review and anyone without the daemon can see the
 * app. Generated on the phone, never saved, gone when the app closes or a machine is paired.
 * Pausing here only changes what is drawn; nothing is sent anywhere.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DemoDeck(private val clock: Clock, scope: CoroutineScope, private val burn: BurnHistory) {
    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active.asStateFlow()

    private val paused = MutableStateFlow<Map<String, PauseMode>>(emptyMap())

    /** The made-up team, refreshed so ages and countdowns stay current; null when off. */
    val team: StateFlow<TeamState?> = _active
        .flatMapLatest { on ->
            if (!on) {
                flowOf(null)
            } else {
                combine(ticks(), paused) { now, rules ->
                    DemoData.team(now, rules).also { DemoBurn.record(burn, it, now) }
                }
            }
        }
        .stateIn(scope, SharingStarted.Eagerly, null)

    fun start() {
        DemoBurn.seed(burn, clock.now())
        _active.value = true
    }

    fun stop() {
        _active.value = false
        paused.value = emptyMap()
        DemoBurn.forget(burn, clock.now())
    }

    /** Handles a soft-pause gesture while the demo runs; false hands it to the real controller. */
    fun tap(target: PauseTarget): Boolean = gesture(target, PauseMode.SOFT)

    /** Handles a freeze gesture while the demo runs; false hands it to the real controller. */
    fun hold(target: PauseTarget): Boolean = gesture(target, PauseMode.HARD)

    private fun gesture(target: PauseTarget, mode: PauseMode): Boolean {
        if (!_active.value) return false
        val scope = target.scope()
        paused.value = if (scope in paused.value) paused.value - scope else paused.value + (scope to mode)
        return true
    }

    private fun ticks() = flow {
        while (true) {
            emit(clock.now())
            delay(TICK_MILLIS)
        }
    }

    private companion object {
        const val TICK_MILLIS = 5_000L
    }
}

/**
 * Made-up token spend for the rates and sparklines, which read [BurnHistory] rather than the team.
 * Each session swings between half and one and a half times its own pace, so the charts move.
 */
private object DemoBurn {
    private val HISTORY = Duration.ofHours(5)
    private const val SEED_STEP_SECONDS = 30L
    private const val SWING_SECONDS = 420.0
    private const val SWING = 0.5
    private const val TOKENS_PER_PACE = 18_000.0

    fun seed(burn: BurnHistory, now: Instant) {
        val team = DemoData.team(now, emptyMap())
        generateSequence(now.minus(HISTORY)) { it.plusSeconds(SEED_STEP_SECONDS) }
            .takeWhile { !it.isAfter(now) }
            .forEach { record(burn, team, it) }
    }

    fun record(burn: BurnHistory, team: TeamState, at: Instant) = team.machines.forEach { machine ->
        machine.sessions.groupBy { it.projectKey }.forEach { (key, sessions) ->
            sessions.forEach { burn.record(BurnKeys.session(machine.config.id, it.sessionId), at, spent(it, at)) }
            burn.record(BurnKeys.project(machine.config.id, key), at, sessions.sumOf { spent(it, at) })
        }
    }

    fun forget(burn: BurnHistory, now: Instant) = DemoData.team(now, emptyMap()).machines.forEach { machine ->
        machine.sessions.forEach {
            burn.forget(BurnKeys.session(machine.config.id, it.sessionId))
            burn.forget(BurnKeys.project(machine.config.id, it.projectKey))
        }
    }

    /** The integral of the session's swinging pace, so it only ever rises. */
    private fun spent(session: Session, at: Instant): Long {
        val seconds = at.epochSecond.toDouble()
        val swing = SWING * SWING_SECONDS * cos(seconds / SWING_SECONDS + session.sessionId.hashCode())
        return ((seconds - swing) * session.tokens.input / TOKENS_PER_PACE).toLong()
    }
}

/** The same two machines as the iPhone app's demo. Every name and number is invented. */
internal object DemoData {
    private const val STUDIO = "demo-studio"
    private const val LAPTOP = "demo-laptop"

    fun team(now: Instant, rules: Map<String, PauseMode>): TeamState = TeamState(
        listOf(
            machine(
                id = STUDIO,
                name = "studio",
                email = "adam@example.com",
                person = "Adam",
                fiveHour = limit("session", 62, LimitStatus.OK, now + Duration.ofMinutes(153)),
                sevenDay = limit("weekly_all", 84, LimitStatus.WARN, now + Duration.ofDays(3)),
                sessions = listOf(
                    session("7f3a91c2", "garden-planner", 3_100_000, now),
                    session("b2e40d17", "garden-planner", 1_250_000, now),
                    session("c9d1aa03", "recipe-box", 640_000, now)
                ),
                now = now,
                rules = rules
            ),
            machine(
                id = LAPTOP,
                name = "laptop",
                email = "jules@example.com",
                person = "Jules",
                fiveHour = limit("session", 97, LimitStatus.CRITICAL, now + Duration.ofMinutes(40)),
                sevenDay = limit("weekly_all", 41, LimitStatus.OK, now + Duration.ofDays(5)),
                sessions = listOf(session("e5f60718", "tide-tables", 2_200_000, now)),
                now = now,
                rules = rules
            )
        )
    )

    private fun machine(
        id: String,
        name: String,
        email: String,
        person: String,
        fiveHour: Limit,
        sevenDay: Limit,
        sessions: List<Session>,
        now: Instant,
        rules: Map<String, PauseMode>
    ): MachineState {
        val allRule = rules[PauseTarget.All.scope()]?.let { mode ->
            PauseRule(
                id = "demo-all",
                scope = PauseTarget.All.scope(),
                mode = mode,
                reason = "demo",
                createdAt = now,
                createdBy = "demo"
            )
        }
        return MachineState(
            config = MachineConfig(id, name, "$name.local", 47292, "demo"),
            health = Health.FRESH,
            lastHeartbeatAt = now,
            name = name,
            version = "0.1.0+demo",
            user = User(email, "uuid-$id", person),
            limits = listOf(fiveHour, sevenDay),
            limitsFetchedAt = now.minusSeconds(20),
            today = Tokens(input = 7_400_000, output = 180_000, messages = 312),
            sessions = sessions.map { it.withPause(id, rules, now) },
            rules = listOfNotNull(allRule),
            update = null,
            projectTokens = emptyList(),
            rev = 1,
            lastError = null,
            transport = MachineState.Transport.SSE
        )
    }

    private fun Session.withPause(machineId: String, rules: Map<String, PauseMode>, now: Instant): Session {
        val own = PauseTarget.Session(machineId, sessionId).scope()
        val project = PauseTarget.Project(machineId, projectKey).scope()
        val all = PauseTarget.All.scope()
        val scope = listOf(all, project, own).firstOrNull { it in rules } ?: return this
        return copy(pause = PauseState(rules.getValue(scope), "demo", scope, now, emptyList()))
    }

    private fun limit(id: String, percent: Int, status: LimitStatus, resetsAt: Instant) = Limit(
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

    private fun session(id: String, project: String, tokens: Long, now: Instant) = Session(
        sessionId = id,
        pid = null,
        alive = true,
        discovered = Discovered.HOOK,
        cwd = "/src/$project",
        transcriptPath = null,
        projectKey = "/src/$project",
        projectName = project,
        worktree = null,
        model = "sonnet",
        startedAt = now.minusSeconds(3_600),
        lastActivityAt = now.minusSeconds(12),
        tokens = Tokens(input = tokens, output = 0, messages = 12),
        pause = null,
        lastTool = LastTool("Edit", now.minusSeconds(8))
    )
}
