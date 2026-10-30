// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.fakedaemon

import com.evenseal.usagedeck.core.daemon.PauseRuleDto
import com.evenseal.usagedeck.core.daemon.PauseStateDto
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** A scripted sequence of state changes, advanced one step per [FakeDaemon.tick]. */
interface Scenario {
    val name: String

    fun init(s: FakeState)

    fun step(s: FakeState, n: Int, emit: (String, String) -> Unit)
}

@Serializable
private data class SessionEventBody(
    val type: String,
    val session: com.evenseal.usagedeck.core.daemon.SessionDto
)

@Serializable
private data class PauseBody(val rules: List<PauseRuleDto>, val affected: List<String>)

object Scenarios {
    /** Nothing moves; useful for eyeballing layout. */
    val idle: Scenario = object : Scenario {
        override val name = "idle"

        override fun init(s: FakeState) = Unit

        override fun step(s: FakeState, n: Int, emit: (String, String) -> Unit) = Unit
    }

    /** Walks `weekly_all` from 70 % to 97 % in 3-point steps, flipping status at 80 and 95. */
    val warnCrossing: Scenario = object : Scenario {
        override val name = "warnCrossing"

        override fun init(s: FakeState) {
            s.limit(WEEKLY)?.let { s.setLimit(WEEKLY, it.copy(percent = START)) }
            s.setStatus(WEEKLY, "ok")
        }

        override fun step(s: FakeState, n: Int, emit: (String, String) -> Unit) {
            val current = s.limit(WEEKLY) ?: return
            val now = current.percent ?: 0
            if (now >= CEILING) return
            val percent = (now + STEP).coerceAtMost(CEILING)
            s.setLimit(WEEKLY, current.copy(percent = percent))
            s.setStatus(
                WEEKLY,
                when {
                    percent >= s.thresholds.critical -> "critical"
                    percent >= s.thresholds.warn -> "warn"
                    else -> "ok"
                }
            )
            s.status = s.status.copy(overall = s.status.byId[WEEKLY] ?: "ok")
            emit("limits", FakeJson.encodeToString(s.limitsBody()))
        }

        private val WEEKLY = "weekly_all"
        private val START = 70
        private val STEP = 3
        private val CEILING = 97
    }

    /** At step three the first session is hard-frozen, with both a `pause` and a `session` event. */
    val freeze: Scenario = object : Scenario {
        override val name = "freeze"

        override fun init(s: FakeState) = Unit

        override fun step(s: FakeState, n: Int, emit: (String, String) -> Unit) {
            if (n != FREEZE_STEP) return
            val session = s.sessions.firstOrNull() ?: return
            val rule = PauseRuleDto(
                id = "r-freeze",
                scope = "session:${session.sessionId}",
                mode = "hard",
                reason = "fakedaemon:freeze",
                createdAt = "2026-09-13T14:05:00Z",
                createdBy = "cli"
            )
            s.rules = s.rules + rule
            val frozen = session.copy(
                pause = PauseStateDto(
                    mode = "hard",
                    ruleId = rule.id,
                    scope = rule.scope,
                    since = rule.createdAt,
                    frozenPids = emptyList(),
                    freezes = 1
                )
            )
            s.replaceSession(frozen)
            s.bumpRev()
            emit("pause", FakeJson.encodeToString(PauseBody(s.rules, listOf(session.sessionId))))
            emit("session", FakeJson.encodeToString(SessionEventBody("update", frozen)))
        }

        private val FREEZE_STEP = 3
    }

    /** Heartbeats stop after step five and come back three minutes (90 two-second steps) later. */
    val machineDrop: Scenario = object : Scenario {
        override val name = "machineDrop"

        override fun init(s: FakeState) {
            s.heartbeats = true
        }

        override fun step(s: FakeState, n: Int, emit: (String, String) -> Unit) {
            s.heartbeats = n < DROP_STEP || n >= RECOVER_STEP
        }

        private val DROP_STEP = 5
        private val RECOVER_STEP = 95
    }

    /**
     * The bearer is rotated at step 5 and every request is refused with 401 from then on, while
     * an already-open event stream stays open — what the deck saw in the field.
     */
    val tokenRotated: Scenario = object : Scenario {
        override val name = "tokenRotated"

        override fun init(s: FakeState) {
            s.tokenRotated = false
        }

        override fun step(s: FakeState, n: Int, emit: (String, String) -> Unit) {
            if (n >= ROTATE_STEP) s.tokenRotated = true
        }

        private val ROTATE_STEP = 5
    }

    fun byName(n: String): Scenario = when (n) {
        warnCrossing.name -> warnCrossing
        freeze.name -> freeze
        machineDrop.name -> machineDrop
        tokenRotated.name -> tokenRotated
        else -> idle
    }
}
