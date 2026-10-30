// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.demo

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.BurnKeys
import java.time.Duration
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
    private val burn = BurnHistory()
    private val demo = DemoDeck(Clock { now }, scope.backgroundScope, burn)

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
    fun `the rates and sparklines have made-up history to draw from the first frame`() {
        val project = BurnKeys.project("demo-studio", "/src/garden-planner")
        demo.start()
        scope.runCurrent()

        assertTrue(burn.ratePerMinute(project, now) > 0)
        assertTrue(burn.series(project, now, Duration.ofHours(5), 12).all { it > 0 })
        val two = burn.ratePerMinute(BurnKeys.session("demo-studio", "7f3a91c2"), now) +
            burn.ratePerMinute(BurnKeys.session("demo-studio", "b2e40d17"), now)
        assertEquals(two, burn.ratePerMinute(project, now), 1.0)
    }

    @Test
    fun `the made-up usage keeps moving and leaves with the demo`() {
        val project = BurnKeys.project("demo-laptop", "/src/tide-tables")
        demo.start()
        scope.runCurrent()
        repeat(24) {
            now = now.plusSeconds(5)
            scope.advanceTimeBy(5_000)
            scope.runCurrent()
        }
        assertTrue(burn.ratePerMinute(project, now) > 0)

        demo.stop()
        scope.runCurrent()
        assertEquals(0.0, burn.ratePerMinute(project, now), 0.0)
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
