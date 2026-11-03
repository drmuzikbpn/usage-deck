// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.model

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TeamStateTest {
    private val t0: Instant = Instant.parse("2026-09-13T14:00:00Z")

    private fun limit(id: String, percent: Int, kind: String = id) = Limit(
        id = id,
        kind = kind,
        group = if (id == "session") "session" else "weekly",
        percent = percent,
        severity = "normal",
        resetsAt = null,
        scopeModel = null,
        isActive = false,
        status = LimitStatus.OK
    )

    private fun session(
        id: String,
        cwd: String,
        projectKey: String,
        projectName: String,
        worktree: String? = null,
        tokens: Tokens = Tokens(input = 100),
        alive: Boolean = true,
        pause: PauseState? = null
    ) = Session(
        sessionId = id,
        pid = 1,
        alive = alive,
        discovered = Discovered.HOOK,
        cwd = cwd,
        transcriptPath = null,
        projectKey = projectKey,
        projectName = projectName,
        worktree = worktree,
        model = "claude-opus-5",
        startedAt = t0,
        lastActivityAt = t0,
        tokens = tokens,
        pause = pause,
        lastTool = null
    )

    private fun machine(
        id: String,
        user: User?,
        limits: List<Limit> = emptyList(),
        limitsFetchedAt: Instant? = null,
        sessions: List<Session> = emptyList(),
        today: Tokens = Tokens.ZERO,
        projectTokens: List<ProjectTokens> = emptyList(),
        health: Health = Health.FRESH
    ) = MachineState(
        config = MachineConfig(id, id, "100.68.1.2", 47291, "tok"),
        health = health,
        lastHeartbeatAt = t0,
        name = id,
        version = "0.1.417+abc",
        user = user,
        limits = limits,
        limitsFetchedAt = limitsFetchedAt,
        today = today,
        sessions = sessions,
        projectTokens = projectTokens
    )

    private val adam = User("adam@example.com", "uuid-adam", "Adam")
    private val jules = User("jules@example.com", "uuid-jules", "Jules")

    @Test
    fun `a machine silent for a day contributes nothing but stays listed`() {
        val quiet = machine(
            "m1",
            jules,
            limits = listOf(limit("session", 91)),
            limitsFetchedAt = t0,
            sessions = listOf(session("s1", "/old", "/old/.git", "old")),
            today = Tokens(input = 500),
            projectTokens = listOf(ProjectTokens("/old", "/old", Tokens(input = 500)))
        ).aged(t0.plusSeconds(86_400))
        val live =
            machine("m2", adam, limits = listOf(limit("session", 10)), limitsFetchedAt = t0, today = Tokens(input = 3))
        val team = TeamState(listOf(quiet, live))
        assertEquals(listOf("m1", "m2"), team.machines.map { it.config.id })
        assertTrue(team.machine("m1")!!.gone)
        assertEquals(listOf("uuid-adam"), team.users.map { it.key })
        assertTrue(team.projects.isEmpty())
        assertEquals(3L, team.teamToday.total)
        assertEquals(0, team.liveSessionCount)
    }

    @Test
    fun `a week with no 5-hour window is a plan without one (daemon 23_68)`() {
        val weeklyOnly = machine("m1", adam, limits = listOf(limit("weekly_all", 6)), limitsFetchedAt = t0)
        val user = TeamState(listOf(weeklyOnly)).users.single()
        assertNull(user.fiveHour)
        assertTrue(user.noFiveHourLimit)
    }

    @Test
    fun `no limits at all is unknown, not a plan without a 5-hour window`() {
        val user = TeamState(listOf(machine("m1", adam))).users.single()
        assertFalse(user.noFiveHourLimit)
        val both =
            machine("m1", adam, limits = listOf(limit("session", 3), limit("weekly_all", 6)), limitsFetchedAt = t0)
        assertFalse(TeamState(listOf(both)).users.single().noFiveHourLimit)
    }

    @Test
    fun `a gone machine never supplies an account's limits even if some arrive`() {
        // A reply without the heartbeat that proves it is not a check-in.
        val quiet = machine("m1", adam).aged(t0.plusSeconds(86_400)).copy(
            limits = listOf(limit("session", 99)),
            limitsFetchedAt = t0.plusSeconds(86_400),
            sessions = listOf(session("s1", "/g", "/g/.git", "g")),
            today = Tokens(input = 8)
        )
        val live =
            machine("m2", adam, limits = listOf(limit("session", 10)), limitsFetchedAt = t0, today = Tokens(input = 3))
        val team = TeamState(listOf(quiet, live))
        val user = team.users.single()
        assertEquals(listOf("m2"), user.machineIds)
        assertEquals(10, user.fiveHour?.percent)
        assertTrue(team.projects.isEmpty())
        assertEquals(0, team.liveSessionCount)
        assertEquals(3L, team.teamToday.total)
    }

    @Test
    fun `same user on two machines collapses with the freshest limits winning`() {
        val stale = machine(
            "m1",
            adam,
            limits = listOf(limit("weekly_all", 10)),
            limitsFetchedAt = t0.minusSeconds(600),
            health = Health.STALE
        )
        val fresh = machine(
            "m2",
            adam.copy(displayName = null),
            limits = listOf(limit("weekly_all", 81), limit("session", 42)),
            limitsFetchedAt = t0,
            health = Health.FRESH
        )
        val team = TeamState(listOf(stale, fresh))
        val user = team.users.single()
        assertEquals("uuid-adam", user.key)
        assertEquals("Adam", user.displayName)
        assertEquals(listOf("m1", "m2"), user.machineIds)
        assertEquals(81, user.sevenDay!!.percent)
        assertEquals(42, user.fiveHour!!.percent)
        assertEquals(t0, user.limitsFetchedAt)
        assertEquals(Health.FRESH, user.health)
    }

    @Test
    fun `blank uuids fall through instead of forging a shared key`() {
        val team = TeamState(
            listOf(
                machine(
                    "m1",
                    adam.copy(accountUuid = "", organizationUuid = ""),
                    limits = listOf(limit("session", 1)),
                    limitsFetchedAt = t0
                ),
                machine(
                    "m2",
                    adam.copy(accountUuid = "", emailAddress = "sam@example.com", organizationUuid = ""),
                    limits = listOf(limit("session", 2)),
                    limitsFetchedAt = t0
                )
            )
        )
        assertEquals(listOf("adam@example.com", "sam@example.com"), team.users.map { it.key })
    }

    @Test
    fun `one account in two organisations is two quotas`() {
        val team = TeamState(
            listOf(
                machine(
                    "m1",
                    adam.copy(organizationUuid = "org-a", organizationName = "Even Seal Productions"),
                    limits = listOf(limit("session", 100)),
                    limitsFetchedAt = t0
                ),
                machine(
                    "m2",
                    adam.copy(organizationUuid = "org-b", organizationName = "Testing"),
                    limits = listOf(limit("session", 5)),
                    limitsFetchedAt = t0
                )
            )
        )
        assertEquals(listOf("uuid-adam/org-a", "uuid-adam/org-b"), team.users.map { it.key })
        assertEquals(listOf(100, 5), team.users.map { it.fiveHour!!.percent })
        assertEquals(listOf("Even Seal Productions", "Testing"), team.users.map { it.organizationName })
    }

    @Test
    fun `two different users stay separate`() {
        val team = TeamState(
            listOf(
                machine("m1", adam, limits = listOf(limit("session", 10)), limitsFetchedAt = t0),
                machine("m2", jules, limits = listOf(limit("session", 90)), limitsFetchedAt = t0)
            )
        )
        assertEquals(2, team.users.size)
        assertEquals(setOf("uuid-adam", "uuid-jules"), team.users.map { it.key }.toSet())
        assertEquals(10, team.users.first { it.key == "uuid-adam" }.fiveHour!!.percent)
    }

    @Test
    fun `a machine with no user falls back to its machine id`() {
        val team = TeamState(listOf(machine("m9", null)))
        val user = team.users.single()
        assertEquals("m9", user.key)
        assertEquals("m9", user.displayName)
        assertNull(user.emailAddress)
    }

    @Test
    fun `scoped limits are exposed separately from the two headlines`() {
        val scoped = limit("weekly_scoped:fable", 10, kind = "weekly_scoped")
        val team = TeamState(
            listOf(
                machine(
                    "m1",
                    adam,
                    limits = listOf(limit("session", 42), limit("weekly_all", 81), scoped),
                    limitsFetchedAt = t0
                )
            )
        )
        val user = team.users.single()
        assertEquals(listOf("weekly_scoped:fable"), user.scoped.map { it.id })
    }

    @Test
    fun `worktrees of one repo roll up into a single project`() {
        val git = "/Users/adam/code/plannerapp/.git"
        val m = machine(
            "m1",
            adam,
            sessions = listOf(
                session("s1", "/Users/adam/code/plannerapp", git, "plannerapp", tokens = Tokens(input = 10)),
                session(
                    "s2",
                    "/Users/adam/code/plannerapp-wt/billing",
                    git,
                    "plannerapp",
                    worktree = "billing",
                    tokens = Tokens(input = 20)
                )
            )
        )
        val project = TeamState(listOf(m)).projects.single()
        assertEquals(git, project.key)
        assertEquals("plannerapp", project.name)
        assertEquals("m1", project.machineId)
        assertEquals(2, project.sessions.size)
        assertEquals(2, project.worktreeCount)
        assertEquals(30L, project.liveTokens.input)
        assertFalse(project.isIdle)
    }

    @Test
    fun `idle projects come after live ones and carry their today totals`() {
        val git = "/Users/adam/code/plannerapp/.git"
        val m = machine(
            "m1",
            adam,
            sessions = listOf(
                session("s1", "/Users/adam/code/plannerapp", git, "plannerapp", tokens = Tokens(input = 10))
            ),
            projectTokens = listOf(
                ProjectTokens("-Users-adam-code-plannerapp", "/Users/adam/code/plannerapp", Tokens(input = 500)),
                ProjectTokens("-Users-adam-code-audioleveler", "/Users/adam/code/audioleveler", Tokens(input = 900))
            )
        )
        val projects = TeamState(listOf(m)).projects
        assertEquals(2, projects.size)
        assertEquals(git, projects[0].key)
        assertEquals(500L, projects[0].todayTokens!!.input)
        assertEquals("/Users/adam/code/audioleveler", projects[1].key)
        assertEquals("audioleveler", projects[1].name)
        assertTrue(projects[1].isIdle)
        assertEquals(900L, projects[1].todayTokens!!.input)
    }

    @Test
    fun `live projects sort by live tokens descending`() {
        val m = machine(
            "m1",
            adam,
            sessions = listOf(
                session("s1", "/a", "/a/.git", "a", tokens = Tokens(input = 10)),
                session("s2", "/b", "/b/.git", "b", tokens = Tokens(input = 99))
            )
        )
        assertEquals(listOf("/b/.git", "/a/.git"), TeamState(listOf(m)).projects.map { it.key })
    }

    @Test
    fun `hard pause wins over soft on a project`() {
        val git = "/g/.git"
        val soft = PauseState(PauseMode.SOFT, "r1", "session:s1", t0, emptyList())
        val hard = PauseState(PauseMode.HARD, "r2", "session:s2", t0, listOf(42))
        val m = machine(
            "m1",
            adam,
            sessions = listOf(
                session("s1", "/g", git, "g", pause = soft),
                session("s2", "/g/wt", git, "g", worktree = "wt", pause = hard)
            )
        )
        assertEquals(PauseMode.HARD, TeamState(listOf(m)).projects.single().pause!!.mode)
    }

    @Test
    fun `team today sums both machines and live sessions are counted`() {
        val team = TeamState(
            listOf(
                machine(
                    "m1",
                    adam,
                    today = Tokens(input = 100, output = 5),
                    sessions = listOf(session("s1", "/a", "/a/.git", "a"))
                ),
                machine(
                    "m2",
                    jules,
                    today = Tokens(input = 200, output = 7),
                    sessions = listOf(
                        session("s2", "/b", "/b/.git", "b"),
                        session("s3", "/c", "/c/.git", "c", alive = false)
                    )
                )
            )
        )
        assertEquals(300L, team.teamToday.input)
        assertEquals(12L, team.teamToday.output)
        assertEquals(2, team.liveSessionCount)
    }

    @Test
    fun `machine and session lookups are scoped to one machine`() {
        val team = TeamState(
            listOf(
                machine("m1", adam, sessions = listOf(session("s1", "/a", "/a/.git", "a"))),
                machine("m2", jules, sessions = listOf(session("s2", "/b", "/b/.git", "b")))
            )
        )
        assertNotNull(team.machine("m2"))
        assertNull(team.machine("nope"))
        assertEquals("s1", team.session("m1", "s1")!!.sessionId)
        assertNull(team.session("m2", "s1"))
    }

    @Test
    fun `same project key on two machines stays two projects`() {
        val git = "/Users/adam/code/plannerapp/.git"
        val team = TeamState(
            listOf(
                machine("m1", adam, sessions = listOf(session("s1", "/x", git, "plannerapp"))),
                machine("m2", jules, sessions = listOf(session("s2", "/x", git, "plannerapp")))
            )
        )
        assertEquals(2, team.projects.size)
        assertEquals(setOf("m1", "m2"), team.projects.map { it.machineId }.toSet())
    }

    @Test
    fun `dead sessions never appear on the board and idle projects need tokens today`() {
        val liveOne = session("live", "/repo/a", "/repo/a/.git", "a", alive = true)
        val deadSameProject = session("dead1", "/repo/a", "/repo/a/.git", "a", alive = false)
        val deadOther = session("dead2", "/repo/old", "/repo/old", "old", alive = false)
        val m = machine("m1", user = null, sessions = listOf(liveOne, deadSameProject, deadOther))
        val team = TeamState(listOf(m))

        assertEquals(1, team.liveSessionCount)
        val a = team.projects.single()
        assertEquals("a", a.name)
        assertEquals(listOf("live"), a.sessions.map { it.sessionId })
        assertEquals(1, a.worktreeCount)
    }

    @Test
    fun `an email-only user is headlined by its local part`() {
        val m = machine("m1", user = User("adam@example.com", "acct-1", null))
        assertEquals("adam", TeamState(listOf(m)).users.single().displayName)
        assertEquals("adam@example.com", TeamState(listOf(m)).users.single().emailAddress)
    }

    @Test
    fun `one account on two machines shows the copy the daemon fetched most recently`() {
        val stale = machineWithLimits("m1", fetchedAt = Instant.parse("2026-09-16T02:10:00Z"), weekly = 74)
        val fresh = machineWithLimits("m2", fetchedAt = Instant.parse("2026-09-16T02:54:00Z"), weekly = 80)

        assertEquals(80, TeamState(listOf(stale, fresh)).users.single().sevenDay?.percent)
        // Order must not matter: the rail flipped between 74 and 80 as machines re-snapshotted.
        assertEquals(80, TeamState(listOf(fresh, stale)).users.single().sevenDay?.percent)
    }

    @Test
    fun `a machine that never reports a fetch time does not outrank one that does`() {
        val unknown = machineWithLimits("m1", fetchedAt = null, weekly = 74)
        val known = machineWithLimits("m2", fetchedAt = Instant.parse("2026-09-16T02:10:00Z"), weekly = 80)

        assertEquals(80, TeamState(listOf(unknown, known)).users.single().sevenDay?.percent)
        assertEquals(80, TeamState(listOf(known, unknown)).users.single().sevenDay?.percent)
    }

    @Test
    fun `a machine whose limits fetch failed never blanks the headline`() {
        val empty = machineWithLimits("m1", fetchedAt = Instant.parse("2026-09-16T03:00:00Z"), weekly = null)
        val known = machineWithLimits("m2", fetchedAt = Instant.parse("2026-09-16T02:10:00Z"), weekly = 80)

        assertEquals(80, TeamState(listOf(empty, known)).users.single().sevenDay?.percent)
    }

    /** One account (same uuid and org) seen through one machine; [weekly] null means no limits at all. */
    private fun machineWithLimits(id: String, fetchedAt: Instant?, weekly: Int?) = MachineState(
        config = MachineConfig(id, id, "100.64.0.1", 47291, "t"),
        health = Health.FRESH,
        lastHeartbeatAt = fetchedAt,
        user = User("adam@example.com", "account-1", "Adam", organizationUuid = "org-1"),
        limits = weekly?.let {
            listOf(
                Limit(
                    id = "weekly_all",
                    kind = "weekly",
                    group = "all",
                    percent = it,
                    severity = "normal",
                    resetsAt = null,
                    scopeModel = null,
                    isActive = true,
                    status = LimitStatus.OK
                )
            )
        }.orEmpty(),
        limitsFetchedAt = fetchedAt
    )

    @Test
    fun `lists the machines that need a re-pair, and they never keep an account looking fresh`() {
        val adam = User("adam@example.com", "acct-1", "Adam")
        val lost = machine("studio", adam, health = Health.DEAD)
            .copy(needsRepair = RepairReason("unauthorized", "rotated"))
        val team = TeamState(listOf(lost, machine("mbp", adam, health = Health.STALE)))

        assertEquals(listOf("studio"), team.needsRepair.map { it.config.id })
        assertEquals(Health.STALE, team.users.single().health)
    }
}
