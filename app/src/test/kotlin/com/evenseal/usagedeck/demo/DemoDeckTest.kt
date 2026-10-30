// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.demo

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.pause.PauseTarget
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DemoDeckTest {
    private val start = Instant.parse("2026-10-30T12:00:00Z")
    private val scope = TestScope(UnconfinedTestDispatcher())
    private var now = start
    private val demo = DemoDeck(Clock { now }, scope.backgroundScope)

    @Test
    fun `off means no team, and gestures go to the real controller`() {
        scope.runCurrent()
        assertNull(demo.team.value)
        assertFalse(demo.tap(PauseTarget.All))
    }

    @Test
    fun `on shows two machines with live sessions`() {
        demo.start()
        scope.runCurrent()
        val team = demo.team.value!!
        assertEquals(listOf("studio", "laptop"), team.machines.map { it.name })
        assertEquals(4, team.liveSessionCount)
    }

    @Test
    fun `the team keeps refreshing so nothing ages out on screen`() {
        demo.start()
        scope.runCurrent()
        now = start.plusSeconds(600)
        scope.advanceTimeBy(5_001)
        scope.runCurrent()
        assertEquals(now, demo.team.value!!.machines.first().lastHeartbeatAt)
    }

    @Test
    fun `a tap pauses a session here and a second tap resumes it`() {
        demo.start()
        scope.runCurrent()
        val session = demo.team.value!!.machines.first().sessions.first()
        val target = PauseTarget.Session("demo-studio", session.sessionId)

        assertTrue(demo.tap(target))
        scope.runCurrent()
        assertEquals(PauseMode.SOFT, demo.team.value!!.session("demo-studio", session.sessionId)?.pause?.mode)

        assertTrue(demo.tap(target))
        scope.runCurrent()
        assertNull(demo.team.value!!.session("demo-studio", session.sessionId)?.pause)
    }

    @Test
    fun `a hold freezes, and stopping forgets every pause`() {
        demo.start()
        scope.runCurrent()
        assertTrue(demo.hold(PauseTarget.All))
        scope.runCurrent()
        assertTrue(demo.team.value!!.machines.all { m -> m.sessions.all { it.pause?.mode == PauseMode.HARD } })

        demo.stop()
        demo.start()
        scope.runCurrent()
        assertTrue(demo.team.value!!.machines.all { m -> m.sessions.all { it.pause == null } })
    }
}
