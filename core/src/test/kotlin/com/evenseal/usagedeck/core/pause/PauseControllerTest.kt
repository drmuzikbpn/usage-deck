// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.pause

import com.evenseal.usagedeck.core.FakeClock
import com.evenseal.usagedeck.core.daemon.DaemonApi
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.daemon.HealthDto
import com.evenseal.usagedeck.core.daemon.PauseResponseDto
import com.evenseal.usagedeck.core.daemon.PauseRuleDto
import com.evenseal.usagedeck.core.daemon.ResumeResponseDto
import com.evenseal.usagedeck.core.daemon.RulesDto
import com.evenseal.usagedeck.core.daemon.SessionsResult
import com.evenseal.usagedeck.core.daemon.SummaryDto
import com.evenseal.usagedeck.core.daemon.TokensDto
import com.evenseal.usagedeck.core.model.Discovered
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.PauseRule
import com.evenseal.usagedeck.core.model.PauseState
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.Tokens
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PauseControllerTest {
    private val t0: Instant = Instant.parse("2026-09-13T14:00:00Z")
    private val installId = "abc"
    private val reason = "usage-deck:abc"

    private class FakeApi(val machineId: String) : DaemonApi {
        val calls = mutableListOf<String>()
        var failures = 0
        var failWith: DaemonException = DaemonException("network", 0, null, null)

        /** Resume calls for these scopes throw [failWith] every time. */
        var refuseResume: Set<String> = emptySet()
        var emptyResume: Boolean = false
        var resumeResponses: Map<String, ResumeResponseDto> = emptyMap()

        override suspend fun health(): HealthDto = HealthDto()

        override suspend fun summary(): SummaryDto = SummaryDto()

        override suspend fun sessions(ifNoneMatch: String?): SessionsResult = SessionsResult.Unchanged

        override suspend fun tokensByProjectToday(): TokensDto = TokensDto()

        override suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto {
            calls += "pause:$scope:${if (mode == PauseMode.HARD) "hard" else "soft"}:$reason"
            if (failures > 0) {
                failures--
                throw failWith
            }
            return PauseResponseDto(
                PauseRuleDto(
                    id = "r-$machineId",
                    scope = scope,
                    mode = if (mode == PauseMode.HARD) "hard" else "soft",
                    reason = reason,
                    createdAt = "2026-09-13T14:00:00Z",
                    createdBy = "dashboard"
                )
            )
        }

        override suspend fun resume(scope: String): ResumeResponseDto {
            calls += "resume:$scope"
            if (scope in refuseResume) throw failWith
            if (failures > 0) {
                failures--
                throw failWith
            }
            return resumeResponses[scope]
                ?: if (emptyResume) ResumeResponseDto() else ResumeResponseDto(removed = listOf("r-$scope"))
        }

        override suspend fun rules(): RulesDto = RulesDto()
    }

    private fun session(
        id: String,
        projectKey: String = "/g/.git",
        discovered: Discovered = Discovered.HOOK,
        pid: Int? = 42,
        pause: PauseState? = null
    ) = Session(
        sessionId = id,
        pid = pid,
        alive = true,
        discovered = discovered,
        cwd = "/g",
        transcriptPath = null,
        projectKey = projectKey,
        projectName = "g",
        worktree = null,
        model = null,
        startedAt = t0,
        lastActivityAt = t0,
        tokens = Tokens.ZERO,
        pause = pause,
        lastTool = null
    )

    private fun machine(
        id: String,
        health: Health = Health.FRESH,
        sessions: List<Session> = emptyList(),
        rules: List<PauseRule> = emptyList()
    ) = MachineState(
        config = MachineConfig(id, id, "100.68.1.2", 47291, "tok"),
        health = health,
        lastHeartbeatAt = t0,
        sessions = sessions,
        rules = rules
    )

    private fun rule(
        scope: String,
        ruleReason: String? = "usage-deck:abc",
        mode: PauseMode = PauseMode.SOFT,
        id: String = "r-1"
    ) = PauseRule(id, scope, mode, ruleReason, t0, "dashboard")

    private class Fixture {
        val clock = FakeClock(Instant.parse("2026-09-13T14:00:00Z"))
        val team = MutableStateFlow(TeamState(emptyList()))
        val settings = MutableStateFlow(PauseSettings())
        val store = InMemoryEscalationStore()
        val apis = mutableMapOf<String, FakeApi>()
        lateinit var controller: PauseController

        fun api(id: String): FakeApi = apis.getOrPut(id) { FakeApi(id) }
    }

    private fun TestScope.fixture(
        machines: List<MachineState> = emptyList(),
        escalationSeconds: Int? = 90,
        restore: List<Escalation> = emptyList()
    ): Fixture {
        val f = Fixture()
        f.team.value = TeamState(machines)
        f.settings.value = PauseSettings(escalationSeconds)
        machines.forEach { f.api(it.config.id) }
        if (restore.isNotEmpty()) f.store.save(restore)
        f.controller = PauseController(
            team = f.team,
            apis = { id -> f.apis[id] },
            installId = installId,
            store = f.store,
            clock = f.clock,
            scope = backgroundScope,
            settings = f.settings
        )
        return f
    }

    @Test
    fun `soft session posts to owning machine with install reason`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1"))), machine("m2")))
        f.controller.start()
        runCurrent()

        val outcomes = f.controller.soft(PauseTarget.Session("m1", "s1"))
        assertEquals(listOf(PauseOutcome("m1", true, null)), outcomes)
        assertEquals(listOf("pause:session:s1:soft:$reason"), f.api("m1").calls)
        assertTrue(f.api("m2").calls.isEmpty())
        assertTrue(f.controller.inFlight.value.isEmpty())
    }

    @Test
    fun `project scope goes to one machine only`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1"))), machine("m2")))
        f.controller.start()
        runCurrent()
        f.controller.soft(PauseTarget.Project("m1", "/g/.git"))
        assertEquals(listOf("pause:project:/g/.git:soft:$reason"), f.api("m1").calls)
        assertTrue(f.api("m2").calls.isEmpty())
    }

    @Test
    fun `a project scope carries the gitCommonDir when there is one and the cwd otherwise`() = runTest {
        // Session.projectKey is gitCommonDir ?: cwd, and that is what the scope string carries,
        // so a `project:<path>` rule matches the daemon's gitCommonDir, main worktree or cwd.
        val repo = session("s1", projectKey = "/Users/adam/code/foo/.git")
        val loose = session("s2", projectKey = "/Users/adam/code/notes")
        val f = fixture(listOf(machine("m1", sessions = listOf(repo, loose))))
        f.controller.start()
        runCurrent()

        f.controller.soft(PauseTarget.Project("m1", repo.projectKey))
        f.controller.soft(PauseTarget.Project("m1", loose.projectKey))
        assertEquals(
            listOf(
                "pause:project:/Users/adam/code/foo/.git:soft:$reason",
                "pause:project:/Users/adam/code/notes:soft:$reason"
            ),
            f.api("m1").calls
        )
    }

    @Test
    fun `soft schedules escalation and hard fires after 90s`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")))))
        f.controller.start()
        runCurrent()
        f.controller.soft(PauseTarget.Session("m1", "s1"))

        val pending = f.controller.pending.value.single()
        assertEquals("m1", pending.machineId)
        assertEquals("session:s1", pending.scope)
        assertEquals(t0.plusSeconds(90), pending.fireAt)
        assertNotNull(f.controller.escalationFor(PauseTarget.Session("m1", "s1")))
        assertEquals(1, f.store.load().size)

        // the daemon echoes the rule back through the team state
        f.team.value = TeamState(
            listOf(
                machine(
                    "m1",
                    sessions = listOf(
                        session("s1", pause = PauseState(PauseMode.SOFT, "r-1", "session:s1", t0, emptyList()))
                    ),
                    rules = listOf(rule("session:s1"))
                )
            )
        )
        f.clock.advance(90)
        advanceTimeBy(90_000)
        runCurrent()

        assertTrue(f.api("m1").calls.contains("pause:session:s1:hard:$reason"))
        assertTrue(f.controller.pending.value.isEmpty())
        assertTrue(f.store.load().isEmpty())
    }

    @Test
    fun `resume cancels pending escalation`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")))))
        f.controller.start()
        runCurrent()
        f.controller.soft(PauseTarget.Session("m1", "s1"))
        assertEquals(1, f.controller.pending.value.size)

        f.controller.resume(PauseTarget.Session("m1", "s1"))
        assertTrue(f.controller.pending.value.isEmpty())
        assertTrue(f.store.load().isEmpty())
        assertTrue(f.api("m1").calls.contains("resume:session:s1"))

        f.clock.advance(300)
        advanceTimeBy(300_000)
        runCurrent()
        assertFalse(f.api("m1").calls.any { it.contains(":hard:") })
    }

    @Test
    fun `rule vanishing from team state cancels escalation`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")))))
        f.controller.start()
        runCurrent()
        f.controller.soft(PauseTarget.Session("m1", "s1"))

        f.team.value = TeamState(
            listOf(machine("m1", sessions = listOf(session("s1")), rules = listOf(rule("session:s1"))))
        )
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(1, f.controller.pending.value.size)

        // somebody resumed from the CLI: the rule disappears
        f.team.value = TeamState(listOf(machine("m1", sessions = listOf(session("s1")))))
        advanceTimeBy(1_100)
        runCurrent()
        assertTrue(f.controller.pending.value.isEmpty())
        assertTrue(f.store.load().isEmpty())

        f.clock.advance(300)
        advanceTimeBy(300_000)
        runCurrent()
        assertFalse(f.api("m1").calls.any { it.contains(":hard:") })
    }

    @Test
    fun `foreign soft pause does not escalate`() = runTest {
        val foreign = PauseState(PauseMode.SOFT, "r-cli", "session:s1", t0, emptyList())
        val f = fixture(
            listOf(
                machine(
                    "m1",
                    sessions = listOf(session("s1", pause = foreign)),
                    rules = listOf(rule("session:s1", ruleReason = "cli"))
                )
            )
        )
        f.controller.start()
        runCurrent()
        f.clock.advance(600)
        advanceTimeBy(600_000)
        runCurrent()
        assertTrue(f.controller.pending.value.isEmpty())
        assertTrue(f.api("m1").calls.isEmpty())
    }

    @Test
    fun `escalation off disables scheduling`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")))), escalationSeconds = null)
        f.controller.start()
        runCurrent()
        f.controller.soft(PauseTarget.Session("m1", "s1"))
        assertTrue(f.controller.pending.value.isEmpty())

        f.clock.advance(600)
        advanceTimeBy(600_000)
        runCurrent()
        assertFalse(f.api("m1").calls.any { it.contains(":hard:") })
    }

    @Test
    fun `all fans out to fresh machines only and retries once`() = runTest {
        val f = fixture(
            listOf(
                machine("m1", health = Health.FRESH, sessions = listOf(session("s1"))),
                machine("m2", health = Health.STALE),
                machine("m3", health = Health.DEAD)
            )
        )
        f.api("m2").failures = 1
        f.controller.start()
        runCurrent()

        val outcomes = f.controller.soft(PauseTarget.All)
        assertEquals(2, outcomes.size)
        assertTrue(outcomes.all { it.ok })
        assertEquals(setOf("m1", "m2"), outcomes.map { it.machineId }.toSet())
        assertEquals(1, f.api("m1").calls.size)
        assertEquals("the failed machine is retried exactly once", 2, f.api("m2").calls.size)
        assertTrue(f.api("m3").calls.isEmpty())
        assertEquals(outcomes, f.controller.lastOutcomes.value)
    }

    @Test
    fun `all reports the machine that stays down`() = runTest {
        val f = fixture(listOf(machine("m1"), machine("m2")))
        f.api("m2").failures = 2
        f.controller.start()
        runCurrent()

        val outcomes = f.controller.soft(PauseTarget.All)
        val bad = outcomes.single { !it.ok }
        assertEquals("m2", bad.machineId)
        assertEquals("Machine unreachable.", bad.error)
        assertEquals(listOf("m1"), f.controller.pending.value.map { it.machineId })
    }

    @Test
    fun `hard on transcript-discovered session is refused locally`() = runTest {
        val f = fixture(
            listOf(machine("m1", sessions = listOf(session("s1", discovered = Discovered.TRANSCRIPT, pid = null))))
        )
        f.controller.start()
        runCurrent()

        val outcome = f.controller.hard(PauseTarget.Session("m1", "s1")).single()
        assertFalse(outcome.ok)
        assertEquals(DaemonException.DEFAULTS["conflict"], outcome.error)
        assertTrue(f.api("m1").calls.isEmpty())
    }

    @Test
    fun `tap on paused target resumes`() = runTest {
        val paused = PauseState(PauseMode.SOFT, "r-1", "session:s1", t0, emptyList())
        val f = fixture(
            listOf(
                machine(
                    "m1",
                    sessions = listOf(session("s1", pause = paused)),
                    rules = listOf(rule("session:s1"))
                )
            )
        )
        f.controller.start()
        runCurrent()
        assertTrue(f.controller.isPaused(PauseTarget.Session("m1", "s1")))

        f.controller.tap(PauseTarget.Session("m1", "s1"))
        assertEquals(listOf("resume:session:s1"), f.api("m1").calls)
    }

    @Test
    fun `resuming a project also lifts the session rules under it`() = runTest {
        val frozen = PauseState(PauseMode.HARD, "r-2", "session:s1", t0, listOf(42))
        val f = fixture(
            listOf(
                machine(
                    "m1",
                    sessions = listOf(session("s1", pause = frozen), session("s2")),
                    rules = listOf(rule("session:s1"), rule("session:s1"))
                )
            )
        )
        f.controller.start()
        runCurrent()
        val project = PauseTarget.Project("m1", "/g/.git")
        assertTrue(f.controller.isPaused(project))

        f.controller.tap(project)
        assertEquals(listOf("resume:${project.scope()}", "resume:session:s1"), f.api("m1").calls)
    }

    @Test
    fun `a nested resume that fails does not stop the others or fail the project`() = runTest {
        val f = fixture(
            listOf(
                machine(
                    "m1",
                    sessions = listOf(session("s1"), session("s2")),
                    rules = listOf(rule("session:s1"), rule("session:s2"))
                )
            )
        )
        f.api("m1").refuseResume = setOf("session:s1")
        f.api("m1").failWith = DaemonException("not_found", 404, null, "No such rule")
        f.controller.start()
        runCurrent()
        val project = PauseTarget.Project("m1", "/g/.git")

        val outcome = f.controller.resume(project).single()

        assertTrue(outcome.ok)
        assertEquals(listOf("resume:${project.scope()}", "resume:session:s1", "resume:session:s2"), f.api("m1").calls)
    }

    @Test
    fun `a project resume reports the project's own refusal`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")), rules = listOf(rule("session:s1")))))
        val project = PauseTarget.Project("m1", "/g/.git")
        f.api("m1").refuseResume = setOf(project.scope())
        f.api("m1").failWith = DaemonException("conflict", 409, null, "Daemon is updating")
        f.controller.start()
        runCurrent()

        val outcome = f.controller.resume(project).single()

        assertFalse(outcome.ok)
        assertEquals("Daemon is updating", outcome.error)
        assertTrue(f.api("m1").calls.contains("resume:session:s1"))
    }

    @Test
    fun `a cascading project resume cancels child escalations without redundant no-op calls`() = runTest {
        val firstPause = PauseState(PauseMode.SOFT, "r-s1", "session:s1", t0, emptyList())
        val secondPause = PauseState(PauseMode.SOFT, "r-s2", "session:s2", t0, emptyList())
        val f = fixture(
            listOf(
                machine(
                    "m1",
                    sessions = listOf(session("s1", pause = firstPause), session("s2", pause = secondPause)),
                    rules = listOf(rule("session:s1", id = "r-s1"), rule("session:s2", id = "r-s2"))
                )
            )
        )
        f.controller.start()
        runCurrent()
        f.controller.soft(PauseTarget.Session("m1", "s1"))
        f.controller.soft(PauseTarget.Session("m1", "s2"))
        assertEquals(2, f.controller.pending.value.size)
        f.api("m1").calls.clear()
        val project = PauseTarget.Project("m1", "/g/.git")
        f.api("m1").resumeResponses = mapOf(
            project.scope() to ResumeResponseDto(
                removed = listOf("r-s1", "r-s2"),
                resumed = listOf("s1", "s2")
            )
        )
        f.api("m1").emptyResume = true

        val outcome = f.controller.resume(project).single()

        assertTrue(outcome.ok)
        assertEquals(listOf("resume:${project.scope()}"), f.api("m1").calls)
        assertTrue(f.controller.pending.value.isEmpty())
    }

    @Test
    fun `an empty resume response does not report success or cancel escalation`() = runTest {
        val paused = PauseState(PauseMode.SOFT, "r-1", "session:s1", t0, emptyList())
        val f = fixture(
            listOf(
                machine(
                    "m1",
                    sessions = listOf(session("s1", pause = paused)),
                    rules = listOf(rule("session:s1"))
                )
            )
        )
        f.controller.start()
        runCurrent()
        f.controller.soft(PauseTarget.Session("m1", "s1"))
        f.api("m1").calls.clear()
        f.api("m1").emptyResume = true

        val outcome = f.controller.resume(PauseTarget.Session("m1", "s1")).single()

        assertFalse(outcome.ok)
        assertTrue(outcome.error!!.contains("Nothing resumed"))
        assertEquals(listOf(outcome), f.controller.lastOutcomes.value)
        assertEquals(1, f.controller.pending.value.size)
    }

    @Test
    fun `global state ignores stale all rules on dead machines`() = runTest {
        val f = fixture(listOf(machine("m1", health = Health.DEAD, rules = listOf(rule("all")))))

        assertFalse(f.controller.isPaused(PauseTarget.All))
    }

    @Test
    fun `a failed resume keeps the pending escalation`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")))))
        f.controller.start()
        runCurrent()
        f.controller.soft(PauseTarget.Session("m1", "s1"))
        assertEquals(1, f.controller.pending.value.size)
        f.api("m1").refuseResume = setOf("session:s1")

        f.controller.resume(PauseTarget.Session("m1", "s1"))

        assertEquals(1, f.controller.pending.value.size)
    }

    @Test
    fun `tap on an unpaused target soft pauses`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")))))
        f.controller.start()
        runCurrent()
        assertFalse(f.controller.isPaused(PauseTarget.Session("m1", "s1")))
        f.controller.tap(PauseTarget.Session("m1", "s1"))
        assertEquals(listOf("pause:session:s1:soft:$reason"), f.api("m1").calls)
    }

    @Test
    fun `hold hard freezes a hook session`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")))))
        f.controller.start()
        runCurrent()
        f.controller.hold(PauseTarget.Session("m1", "s1"))
        assertEquals(listOf("pause:session:s1:hard:$reason"), f.api("m1").calls)
        assertTrue("a hard pause never schedules an escalation", f.controller.pending.value.isEmpty())
    }

    @Test
    fun `pending escalations restore from store and overdue fire immediately`() = runTest {
        val overdue = Escalation("m1", "session:s1", t0.minusSeconds(5))
        val f = fixture(
            machines = listOf(
                machine(
                    "m1",
                    sessions = listOf(session("s1")),
                    rules = listOf(rule("session:s1"))
                )
            ),
            restore = listOf(overdue)
        )
        f.controller.start()
        runCurrent()

        assertTrue(f.api("m1").calls.contains("pause:session:s1:hard:$reason"))
        assertTrue(f.controller.pending.value.isEmpty())
    }

    @Test
    fun `an escalation whose machine is dead at fire time is dropped`() = runTest {
        val overdue = Escalation("m1", "session:s1", t0.minusSeconds(5))
        val f = fixture(
            machines = listOf(
                machine(
                    "m1",
                    health = Health.DEAD,
                    sessions = listOf(session("s1")),
                    rules = listOf(rule("session:s1"))
                )
            ),
            restore = listOf(overdue)
        )
        f.controller.start()
        runCurrent()

        assertTrue(f.api("m1").calls.isEmpty())
        assertTrue(f.controller.pending.value.isEmpty())
        assertTrue(f.store.load().isEmpty())
    }

    @Test
    fun `409 from daemon surfaces user message`() = runTest {
        val f = fixture(listOf(machine("m1", sessions = listOf(session("s1")))))
        f.api("m1").failures = 1
        f.api("m1").failWith = DaemonException("conflict", 409, null, "That session has no trusted pid")
        f.controller.start()
        runCurrent()

        val outcome = f.controller.hard(PauseTarget.Session("m1", "s1")).single()
        assertFalse(outcome.ok)
        assertEquals("That session has no trusted pid", outcome.error)
    }

    @Test
    fun `scope strings follow the daemon grammar`() {
        assertEquals("session:s1", PauseTarget.Session("m1", "s1").scope())
        assertEquals("project:/g/.git", PauseTarget.Project("m1", "/g/.git").scope())
        assertEquals("all", PauseTarget.All.scope())
    }

    @Test
    fun `in memory escalation store round trips`() {
        val store = InMemoryEscalationStore()
        assertTrue(store.load().isEmpty())
        val list = listOf(Escalation("m1", "all", t0))
        store.save(list)
        assertEquals(list, store.load())
        store.save(emptyList())
        assertTrue(store.load().isEmpty())
    }

    @Test
    fun `unknown machine yields a network outcome without crashing`() = runTest {
        val f = fixture(listOf(machine("m1")))
        f.controller.start()
        runCurrent()
        val outcome = f.controller.soft(PauseTarget.Session("nope", "s1")).single()
        assertFalse(outcome.ok)
        assertEquals(DaemonException.DEFAULTS["network"], outcome.error)
        assertNull(f.controller.escalationFor(PauseTarget.Session("nope", "s1")))
    }
}
