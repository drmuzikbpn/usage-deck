// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.ProjectTokens
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.Tokens
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.project.BurnChart
import com.evenseal.usagedeck.ui.project.ProjectScreen
import com.evenseal.usagedeck.ui.theme.DeckTheme
import java.time.Duration
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProjectScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val projectKey = "/repo/plannerapp"

    /** Project spent 1.9M of the machine's 3.114M today, which reads as 61 %. */
    private fun team(machineToday: Long = 3_114_754, lastToolName: String? = "Edit") = TeamState(
        listOf(
            Fx.machine(
                id = "m1",
                name = "Adam",
                email = "adam@example.com",
                fiveHour = 42,
                sevenDay = 18,
                sessions = listOf(Fx.session("a1b2c3d4", lastToolName = lastToolName)),
                today = Tokens(input = machineToday),
                projectTokens = listOf(ProjectTokens(projectKey, projectKey, Tokens(input = 1_900_000)))
            )
        )
    )

    private fun burnWith38kPerMinute(): BurnHistory = BurnHistory().apply {
        val key = BurnKeys.session("m1", "a1b2c3d4")
        record(key, Fx.NOW.minusSeconds(60), 0)
        record(key, Fx.NOW, 38_000)
    }

    private fun show(
        machineToday: Long = 3_114_754,
        lastToolName: String? = "Edit",
        burn: BurnHistory = burnWith38kPerMinute()
    ) {
        val vm = fakeViewModel(team = team(machineToday, lastToolName), burn = burn)
        compose.setContent {
            DeckTheme {
                ProjectScreen(vm = vm, machineId = "m1", key = projectKey, onBack = {})
            }
        }
    }

    @Test
    fun aProjectInheritedFromPauseAllOffersTheEffectiveResumeAllAction() {
        val pausedTeam = TeamState(
            team().machines.map { machine ->
                machine.copy(sessions = machine.sessions.map { it.copy(pause = Fx.softPause("all")) })
            }
        )
        val actions = RecordingPauseActions(paused = setOf("all"))
        val vm = fakeViewModel(team = pausedTeam, actions = actions, burn = burnWith38kPerMinute())
        compose.setContent {
            DeckTheme { ProjectScreen(vm = vm, machineId = "m1", key = projectKey, onBack = {}) }
        }

        compose.onNodeWithText("Resume all").performClick()

        org.junit.Assert.assertEquals(listOf<PauseTarget>(PauseTarget.All), actions.taps)
    }

    @Test
    fun theThreeTilesReadTodayRateAndShare() {
        show()
        compose.onNodeWithText("1.9M").assertExists()
        compose.onNodeWithText("38k/min").assertExists()
        compose.onNodeWithText("61%").assertExists()
    }

    @Test
    fun shareIsADashWhenTheMachineReportsNoSpendToday() {
        show(machineToday = 0)
        compose.onNodeWithText("—").assertExists()
    }

    @Test
    fun aSessionWithoutLastToolFallsBackToLastActivity() {
        show(lastToolName = null)
        compose.onNodeWithText("last activity 12s ago").assertExists()
    }

    @Test
    fun aSessionWithLastToolNamesTheTool() {
        show()
        compose.onNodeWithText("last tool Edit 8s ago").assertExists()
    }

    @Test
    fun theBottomBarCountsTheSessionsItWouldPause() {
        show()
        compose.onNodeWithText("Pause / Stop").assertExists()
        compose.onNodeWithText("Pause / Stop").performClick()
        compose.onNodeWithText("Soft pause").assertExists()
        compose.onNodeWithText("Freeze now").assertExists()
    }

    @Test
    fun burnChartDrawsWithAnEmptySeries() {
        compose.setContent {
            DeckTheme { BurnChart(series = emptyList(), modifier = Modifier) }
        }
        compose.onNodeWithText("now").assertExists()
    }

    @Test
    fun burnChartLabelsTheTopOfTheScaleToOneSignificantFigure() {
        val burn = BurnHistory().apply {
            val key = BurnKeys.project("m1", projectKey)
            record(key, Fx.NOW.minus(Duration.ofHours(5)), 0)
            record(key, Fx.NOW.minus(Duration.ofMinutes(10)), 0)
            record(key, Fx.NOW, 380_000)
        }
        show(burn = burn)
        // 38 000 tokens/min at the peak, rounded up to one significant figure for the top label.
        compose.onNodeWithText("40k").assertExists()
    }
}
