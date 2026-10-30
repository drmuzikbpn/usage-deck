// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.FakeClock
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.LimitStatus
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MachineClientTest {
    private val t0 = Instant.parse("2026-09-13T14:00:00Z")
    private val cfg = MachineConfig("m1", "adams-mbp", "192.0.2.2", 47292, "tok", fp = "a".repeat(64))

    private class FakeApi : DaemonApi {
        val calls = mutableListOf<String>()
        var summaryDto = SummaryDto()
        var sessionsDto = SessionsDto()
        var tokensDto = TokensDto()
        var rulesDto = RulesDto()
        var sessionsEtag: String? = "W/\"9\""
        var failSummary: DaemonException? = null
        var failHealth: DaemonException? = null
        var failTokens: DaemonException? = null
        var failPause: DaemonException = DaemonException("not_found", 404, null, null)
        var failResume: DaemonException? = null
        var failRules: DaemonException? = null

        /** When set, sessions() and rules() wait for it — uncancellably, like blocking I/O mid-flight. */
        var gate: CompletableDeferred<Unit>? = null

        override suspend fun health(): HealthDto {
            calls += "health"
            failHealth?.let { throw it }
            return HealthDto()
        }

        override suspend fun summary(): SummaryDto {
            calls += "summary"
            failSummary?.let { throw it }
            return summaryDto
        }

        override suspend fun sessions(ifNoneMatch: String?): SessionsResult {
            calls += "sessions:$ifNoneMatch"
            gate?.let { withContext(NonCancellable) { it.await() } }
            return SessionsResult.Changed(sessionsDto, sessionsEtag)
        }

        override suspend fun tokensByProjectToday(): TokensDto {
            calls += "tokens"
            failTokens?.let { throw it }
            return tokensDto
        }

        override suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto {
            calls += "pause:$scope"
            throw failPause
        }

        override suspend fun resume(scope: String): ResumeResponseDto {
            calls += "resume:$scope"
            failResume?.let { throw it }
            return ResumeResponseDto()
        }

        override suspend fun rules(): RulesDto {
            calls += "rules"
            gate?.let { withContext(NonCancellable) { it.await() } }
            failRules?.let { throw it }
            return rulesDto
        }
    }

    private class Fixture(val scope: TestScope) {
        val clock = FakeClock(Instant.parse("2026-09-13T14:00:00Z"))
        val api = FakeApi()
        val burn = BurnHistory()
        val events = MutableSharedFlow<Any>(extraBufferCapacity = 64)
        val screenOn = MutableStateFlow(true)
        var connects = 0
        lateinit var client: MachineClient
    }

    private fun sessionDto(
        id: String,
        input: Long,
        cwd: String = "/Users/adam/code/plannerapp",
        git: String? = "/Users/adam/code/plannerapp/.git"
    ) = SessionDto(
        sessionId = id,
        pid = 1,
        alive = true,
        discovered = "hook",
        cwd = cwd,
        project = ProjectRefDto(git, "plannerapp"),
        startedAt = "2026-09-13T11:00:00Z",
        lastActivityAt = "2026-09-13T11:00:00Z",
        tokens = TokensCountsDto(input = input)
    )

    private fun snapshot(
        sessions: List<SessionDto> = emptyList(),
        rules: List<PauseRuleDto> = emptyList(),
        todayInput: Long = 100,
        percent: Int = 42,
        rev: Long = 7,
        fetchedAt: String? = "2026-09-13T12:00:00Z"
    ) = DaemonEvent.Snapshot(
        name = "adams-mbp",
        version = "0.1.417+3f9c2ab",
        user = UserDto(emailAddress = "adam@example.com", displayName = "Adam"),
        limits = listOf(LimitDto(id = "session", kind = "session", group = "session", percent = percent)),
        status = StatusDto(byId = mapOf("session" to "ok"), overall = "ok"),
        thresholds = ThresholdsDto(),
        today = TokensCountsDto(input = todayInput),
        sessions = sessions,
        rules = rules,
        update = UpdateDto(state = "idle"),
        rev = rev,
        fetchedAt = fetchedAt
    )

    private fun rule(scope: String) = PauseRuleDto(
        id = "r-1",
        scope = scope,
        mode = "soft",
        reason = "usage-deck:abc",
        createdAt = "2026-09-13T14:00:00Z",
        createdBy = "dashboard"
    )

    private fun TestScope.fixture(config: MachineConfig = cfg): Fixture {
        val f = Fixture(this)
        f.client = MachineClient(
            config = config,
            api = f.api,
            eventSource = {
                f.connects++
                f.events
            },
            burn = f.burn,
            clock = f.clock,
            scope = backgroundScope,
            screenOn = f.screenOn,
            tickerMs = 1000
        )
        f.client.start()
        runCurrent()
        return f
    }

    @Test
    fun `a row from the old plain-http pairing is never contacted and asks for a re-pair`() = runTest {
        val f = fixture(cfg.copy(fp = null))
        advanceTimeBy(10 * 60_000)
        runCurrent()

        val state = f.client.state.value
        assertEquals("legacy", state.needsRepair?.code)
        assertTrue(state.needsRepair!!.message.contains("claude-usage pair"))
        assertEquals(Health.DEAD, state.health)
        assertEquals(0, f.connects)
        assertEquals(emptyList<String>(), f.api.calls)
    }

    @Test
    fun `a legacy row's api refuses every call without touching the network`() = runTest {
        val f = fixture(cfg.copy(fp = null))
        val e = runCatching { f.client.api.pause("all", PauseMode.SOFT, "usage-deck:x") }.exceptionOrNull()
        assertEquals("legacy", (e as DaemonException).code)
        assertEquals(emptyList<String>(), f.api.calls)
    }

    @Test
    fun `a daemon name is shown without control characters and capped`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot().copy(name = "stu\u0000dio\u202E" + "x".repeat(200)))
        runCurrent()
        val name = f.client.state.value.name!!
        assertTrue(name.startsWith("studiox"))
        assertEquals(64, name.length)
    }

    @Test
    fun `snapshot populates state and marks SSE`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1000))))
        runCurrent()
        val s = f.client.state.value
        assertEquals("adams-mbp", s.name)
        assertEquals("0.1.417+3f9c2ab", s.version)
        assertEquals("Adam", s.user!!.displayName)
        assertEquals(1, s.limits.size)
        // The daemon's own fetch time, not this phone's clock: the team merge compares two
        // machines' copies of the same account, so a local stamp would make the last machine to
        // reconnect always look freshest.
        assertEquals(Instant.parse("2026-09-13T12:00:00Z"), s.limitsFetchedAt)
        assertEquals(100L, s.today.input)
        assertEquals(1, s.sessions.size)
        assertEquals("idle", s.update!!.state)
        assertEquals(7L, s.rev)
        assertEquals(MachineState.Transport.SSE, s.transport)
        assertEquals(Health.FRESH, s.health)
    }

    @Test
    fun `a snapshot without a fetch time leaves it unknown rather than claiming now`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(fetchedAt = null))
        runCurrent()
        assertNull(f.client.state.value.limitsFetchedAt)
    }

    @Test
    fun `heartbeat refreshes lastHeartbeatAt and health goes fresh`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.clock.advance(45)
        advanceTimeBy(45_000)
        runCurrent()
        assertEquals(Health.STALE, f.client.state.value.health)

        f.events.emit(DaemonEvent.Heartbeat(rev = 9, at = "2026-09-13T14:00:45.000Z"))
        runCurrent()
        assertEquals(f.clock.now(), f.client.state.value.lastHeartbeatAt)
        assertEquals(Health.FRESH, f.client.state.value.health)
        assertEquals("the heartbeat's rev advances the sessions revision", 9L, f.client.state.value.rev)
    }

    @Test
    fun `no heartbeat for 120s marks dead`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.clock.advance(120)
        advanceTimeBy(120_000)
        runCurrent()
        assertEquals(Health.DEAD, f.client.state.value.health)
    }

    @Test
    fun `a day of silence forgets the readings and a check-in brings the machine back`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1_000))))
        runCurrent()
        f.clock.advance(86_400)
        advanceTimeBy(1_100)
        runCurrent()
        val gone = f.client.state.value
        assertTrue(gone.gone)
        assertEquals(Health.DEAD, gone.health)
        assertTrue(gone.limits.isEmpty())
        assertTrue(gone.sessions.isEmpty())
        assertEquals(0L, gone.today.total)
        assertEquals("who it is survives", "adams-mbp", gone.name)

        f.events.emit(DaemonEvent.Heartbeat(rev = 0, at = "2026-09-14T14:00:01.000Z"))
        runCurrent()
        assertFalse(f.client.state.value.gone)
        assertEquals(Health.FRESH, f.client.state.value.health)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 2_000))))
        runCurrent()
        assertEquals(1, f.client.state.value.sessions.size)
        assertEquals(1, f.client.state.value.limits.size)
    }

    @Test
    fun `a gone machine's sessions are re-read in full, not with the old etag`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1_000)), rev = 7))
        runCurrent()
        f.clock.advance(86_400)
        advanceTimeBy(1_100)
        runCurrent()
        assertTrue(f.client.state.value.gone)

        // The stream drops, then two reconnects fail: the client falls back to polling.
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(6_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()
        assertEquals(MachineState.Transport.POLLING, f.client.state.value.transport)
        assertTrue(f.api.calls.contains("sessions:null"))
        assertFalse(f.api.calls.contains("sessions:W/\"7\""))
        assertFalse("an answered poll is a check-in", f.client.state.value.gone)
    }

    @Test
    fun `session update upserts and records burn`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1_000))))
        runCurrent()

        f.clock.advance(60)
        f.events.emit(DaemonEvent.SessionChange("update", sessionDto("s1", 4_000)))
        runCurrent()
        assertEquals(1, f.client.state.value.sessions.size)
        assertEquals(4_000L, f.client.state.value.sessions.single().tokens.input)
        assertEquals(3000.0, f.burn.ratePerMinute(f.client.burnKeyForSession("s1"), f.clock.now()), 0.01)
        assertEquals(
            3000.0,
            f.burn.ratePerMinute(f.client.burnKeyForProject("/Users/adam/code/plannerapp/.git"), f.clock.now()),
            0.01
        )

        f.events.emit(DaemonEvent.SessionChange("start", sessionDto("s2", 500)))
        runCurrent()
        assertEquals(2, f.client.state.value.sessions.size)
    }

    @Test
    fun `session end removes`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1_000), sessionDto("s2", 20))))
        runCurrent()
        assertEquals(2, f.client.state.value.sessions.size)

        f.events.emit(DaemonEvent.SessionChange("end", sessionDto("s1", 1_000)))
        runCurrent()
        assertEquals(listOf("s2"), f.client.state.value.sessions.map { it.sessionId })
    }

    @Test
    fun `spend replaces today total`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(todayInput = 100))
        runCurrent()
        f.clock.advance(60)
        f.events.emit(
            DaemonEvent.Spend(TokensCountsDto(input = 3_100), TokensCountsDto(input = 3_000))
        )
        runCurrent()
        assertEquals(3_100L, f.client.state.value.today.input)
        assertEquals(3000.0, f.burn.ratePerMinute(f.client.burnKeyForMachine(), f.clock.now()), 0.01)
    }

    @Test
    fun `pause event replaces rules and refetches sessions`() = runTest {
        val f = fixture()
        f.api.sessionsDto = SessionsDto(rev = 9, sessions = listOf(sessionDto("s1", 1_000)))
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()

        f.events.emit(DaemonEvent.Pause(listOf(rule("all")), listOf("s1")))
        runCurrent()
        assertEquals(1, f.client.state.value.rules.size)
        assertEquals(PauseMode.SOFT, f.client.state.value.rules.single().mode)
        assertTrue(f.api.calls.contains("sessions:null"))
        assertEquals(1, f.client.state.value.sessions.size)
    }

    @Test
    fun `a limits event recomputes the status, so a reset week stops being red`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(
            snapshot(rev = 812).copy(status = StatusDto(byId = mapOf("weekly_all" to "critical"), overall = "critical"))
        )
        runCurrent()

        f.events.emit(
            DaemonEvent.Limits(listOf(LimitDto(id = "weekly_all", kind = "weekly_all", percent = 0)), null, false)
        )
        runCurrent()
        val limit = f.client.state.value.limits.single()
        assertEquals(0, limit.percent)
        assertEquals(LimitStatus.OK, limit.status)
    }

    @Test
    fun `limits and spend never move the sessions revision`() = runTest {
        val f = fixture()
        f.api.sessionsDto = SessionsDto(rev = 813, sessions = listOf(sessionDto("s1", 1_000)))
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(rev = 812))
        runCurrent()
        assertEquals(812L, f.client.state.value.rev)

        f.events.emit(DaemonEvent.Limits(listOf(LimitDto(id = "session", kind = "session", percent = 99)), null, false))
        f.events.emit(DaemonEvent.Spend(TokensCountsDto(input = 99), TokensCountsDto(input = 9)))
        runCurrent()
        assertEquals("rev only moves on session or pause changes", 812L, f.client.state.value.rev)
        assertEquals(99, f.client.state.value.limits.single().percent)
        assertEquals(99L, f.client.state.value.today.input)

        // a pause does change it, via the sessions re-read it triggers
        f.events.emit(DaemonEvent.Pause(listOf(rule("all")), listOf("s1")))
        runCurrent()
        assertEquals(813L, f.client.state.value.rev)
    }

    @Test
    fun `update event replaces update state`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.events.emit(DaemonEvent.Update(UpdateDto(state = "deferred", deferredReason = "hard_frozen_sessions")))
        runCurrent()
        assertEquals("deferred", f.client.state.value.update!!.state)
        assertEquals("hard_frozen_sessions", f.client.state.value.update!!.deferredReason)
    }

    @Test
    fun `two failed connects switch to polling and poll summary and sessions with etag`() = runTest {
        val f = fixture()
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        assertEquals(MachineState.Transport.DISCONNECTED, f.client.state.value.transport)
        // hint → message → per-code default
        assertEquals("refused", f.client.state.value.lastError)
        assertEquals(
            "Machine unreachable.",
            DaemonException("network", 0, null, null).userMessage()
        )

        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()

        assertEquals(MachineState.Transport.POLLING, f.client.state.value.transport)
        assertTrue(f.api.calls.contains("summary"))
        assertTrue(f.api.calls.contains("sessions:null"))
        assertTrue(f.api.calls.contains("rules"))

        // the etag from the first poll is sent on the next one
        advanceTimeBy(2_100)
        runCurrent()
        assertTrue(f.api.calls.contains("sessions:W/\"9\""))
    }

    @Test
    fun `polling refreshes pause rules when the event stream is unavailable`() = runTest {
        val f = fixture()
        f.api.rulesDto = RulesDto(rules = listOf(rule("all")))
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()

        assertEquals(listOf("all"), f.client.state.value.rules.map { it.scope })
    }

    @Test
    fun `polling interval is 2s when screen on and 30s when off`() = runTest {
        val f = fixture()
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()

        val afterFirstPoll = f.api.calls.count { it == "summary" }
        assertEquals(1, afterFirstPoll)
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(2, f.api.calls.count { it == "summary" })

        f.screenOn.value = false
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(3, f.api.calls.count { it == "summary" })
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals("no extra poll within 2 s while the screen is off", 3, f.api.calls.count { it == "summary" })
        advanceTimeBy(30_100)
        runCurrent()
        assertEquals(4, f.api.calls.count { it == "summary" })
    }

    @Test
    fun `successful reconnect returns to SSE and replaces state from snapshot`() = runTest {
        val f = fixture()
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()
        assertEquals(MachineState.Transport.POLLING, f.client.state.value.transport)

        advanceTimeBy(6_100)
        runCurrent()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s9", 7)), rev = 21))
        runCurrent()
        val pollsWhileDown = f.api.calls.count { it == "summary" }

        assertEquals(MachineState.Transport.SSE, f.client.state.value.transport)
        assertEquals(21L, f.client.state.value.rev)
        assertEquals(listOf("s9"), f.client.state.value.sessions.map { it.sessionId })
        assertNull(f.client.state.value.lastError)

        advanceTimeBy(10_000)
        runCurrent()
        assertEquals("polling stops once SSE is back", pollsWhileDown, f.api.calls.count { it == "summary" })
    }

    @Test
    fun `project tokens refresh every 30s`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        // fetched once as soon as the client starts
        assertEquals(1, f.api.calls.count { it == "tokens" })
        assertTrue(f.client.state.value.projectTokens.isEmpty())

        f.api.tokensDto = TokensDto(
            groups = listOf(
                TokensGroupDto(key = "-Users-adam-code-plannerapp", label = "/Users/adam/code/plannerapp", input = 5)
            )
        )
        advanceTimeBy(30_100)
        runCurrent()
        assertEquals(2, f.api.calls.count { it == "tokens" })
        assertEquals(1, f.client.state.value.projectTokens.size)
        assertEquals("/Users/adam/code/plannerapp", f.client.state.value.projectTokens.single().label)
        assertEquals(5L, f.client.state.value.projectTokens.single().tokens.input)

        advanceTimeBy(30_100)
        runCurrent()
        assertEquals(3, f.api.calls.count { it == "tokens" })
    }

    @Test
    fun `polling errors land in lastError and never crash the client`() = runTest {
        val f = fixture()
        f.api.failSummary = DaemonException("unauthorized", 401, null, null)
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()
        assertEquals("Token rejected. Re-run pairing on the Mac.", f.client.state.value.lastError)
        assertNotNull(f.client.state.value)
        assertEquals("a poll's 401 is a lost pairing too", "unauthorized", f.client.state.value.needsRepair?.code)
    }

    // ---- lost pairing ------------------------------------------------------------------------

    private val unauthorized =
        DaemonException("unauthorized", 401, "a valid Authorization: Bearer token is required", null)

    @Test
    fun `an sse 401 marks the machine as needing a re-pair and stops reconnecting`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1000))))
        runCurrent()

        f.events.emit(Connection.Closed(unauthorized))
        runCurrent()

        val s = f.client.state.value
        assertEquals("unauthorized", s.needsRepair!!.code)
        assertEquals(Health.DEAD, s.health)
        assertEquals(MachineState.Transport.DISCONNECTED, s.transport)
        assertTrue("its sessions are no longer shown as live", s.sessions.isEmpty())

        advanceTimeBy(59_000)
        runCurrent()
        assertEquals("no reconnect after a rejected token", 1, f.connects)
        assertEquals("no hot polling either", 0, f.api.calls.count { it == "summary" })
        assertEquals(Health.DEAD, f.client.state.value.health)
    }

    @Test
    fun `a 401 on any request while the stream is still open also marks it and drops the stream`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        assertEquals(Health.FRESH, f.client.state.value.health)

        // Token rotated without the daemon closing the established stream: the 30 s tokens
        // refresh is the first request to hear about it.
        f.api.failTokens = unauthorized
        advanceTimeBy(30_100)
        runCurrent()
        assertEquals("unauthorized", f.client.state.value.needsRepair?.code)

        f.events.emit(DaemonEvent.Heartbeat(rev = 9, at = "2026-09-13T14:00:30.000Z"))
        runCurrent()
        assertEquals("a stray heartbeat cannot make it look live again", Health.DEAD, f.client.state.value.health)
    }

    @Test
    fun `a 401 from a pause marks the machine`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.api.failPause = unauthorized

        runCatching { f.client.api.pause("all", PauseMode.SOFT, "usage-deck:x") }

        assertEquals("unauthorized", f.client.state.value.needsRepair?.code)
    }

    @Test
    fun `a certificate that no longer matches the pin is a re-pair too`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Closed(DaemonException("pinning", 0, null, null)))
        runCurrent()

        assertEquals("pinning", f.client.state.value.needsRepair?.code)
        assertTrue(f.client.state.value.needsRepair!!.message.contains("certificate"))
    }

    @Test
    fun `network failures are not a lost pairing`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Closed(DaemonException("network", 0, "refused", null)))
        runCurrent()
        assertNull(f.client.state.value.needsRepair)
    }

    @Test
    fun `a slow probe recovers when the token is accepted again`() = runTest {
        val f = fixture()
        f.api.failRules = unauthorized
        f.events.emit(Connection.Closed(unauthorized))
        runCurrent()

        advanceTimeBy(60_100)
        runCurrent()
        assertEquals("the probe is a bearer-gated GET", 1, f.api.calls.count { it == "rules" })
        assertEquals("still rejected", "unauthorized", f.client.state.value.needsRepair?.code)

        f.api.failRules = null
        advanceTimeBy(60_100)
        runCurrent()
        assertEquals(2, f.api.calls.count { it == "rules" })
        assertNull(f.client.state.value.needsRepair)
        assertEquals("the stream is reopened", 2, f.connects)

        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        assertEquals(Health.FRESH, f.client.state.value.health)
        assertNull(f.client.state.value.lastError)
    }

    @Test
    fun `a resume 401 through the watched api marks the machine`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.api.failResume = unauthorized

        runCatching { f.client.api.resume("all") }

        assertEquals("unauthorized", f.client.state.value.needsRepair?.code)
    }

    @Test
    fun `stop during a lost pairing cancels the probe and nothing reconnects`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Closed(unauthorized))
        runCurrent()

        f.client.stop()
        advanceTimeBy(180_000)
        runCurrent()

        assertEquals(0, f.api.calls.count { it == "rules" })
        assertEquals(1, f.connects)
    }

    @Test
    fun `a probe that answers after stop never reopens the stream`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Closed(unauthorized))
        runCurrent()
        val gate = CompletableDeferred<Unit>()
        f.api.gate = gate
        advanceTimeBy(60_100)
        runCurrent()
        assertEquals("the probe is in flight", 1, f.api.calls.count { it == "rules" })

        f.client.stop()
        gate.complete(Unit)
        advanceTimeBy(10_000)
        runCurrent()

        assertEquals("no orphan stream with the old token", 1, f.connects)
    }

    @Test
    fun `a probe that fails the pin keeps the machine marked`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Closed(DaemonException("pinning", 0, null, null)))
        runCurrent()
        f.api.failRules = DaemonException("pinning", 0, null, null)

        advanceTimeBy(120_100)
        runCurrent()

        assertEquals(2, f.api.calls.count { it == "rules" })
        assertEquals("pinning", f.client.state.value.needsRepair?.code)
        assertEquals(1, f.connects)
    }

    @Test
    fun `a reply that lands after the machine was marked cannot bring its sessions back`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.api.sessionsDto = SessionsDto(rev = 30, sessions = listOf(sessionDto("late", 5)))
        val gate = CompletableDeferred<Unit>()
        f.api.gate = gate

        // A pause event starts a sessions re-read, which is still in flight when the 401 arrives.
        f.events.emit(DaemonEvent.Pause(rules = emptyList(), affected = emptyList()))
        runCurrent()
        f.api.failPause = unauthorized
        runCatching { f.client.api.pause("all", PauseMode.SOFT, "usage-deck:x") }
        assertEquals("unauthorized", f.client.state.value.needsRepair?.code)

        gate.complete(Unit)
        runCurrent()

        val s = f.client.state.value
        assertTrue(s.sessions.isEmpty())
        assertEquals(MachineState.Transport.DISCONNECTED, s.transport)
        assertEquals(Health.DEAD, s.health)
    }
}
