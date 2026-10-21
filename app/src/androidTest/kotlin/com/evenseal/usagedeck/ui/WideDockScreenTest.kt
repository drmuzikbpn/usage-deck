// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui

import android.content.res.Configuration
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.PauseRule
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.User
import com.evenseal.usagedeck.ui.components.SETTINGS_CHIP
import com.evenseal.usagedeck.ui.theme.DeckTheme
import com.evenseal.usagedeck.ui.widedock.ACCOUNT_PAGER
import com.evenseal.usagedeck.ui.widedock.WideDockScreen
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WideDockScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val opened = mutableListOf<Route>()

    private fun showLandscape(vm: DeckViewModel) {
        compose.setContent {
            val landscape = Configuration(LocalConfiguration.current).apply {
                orientation = Configuration.ORIENTATION_LANDSCAPE
            }
            CompositionLocalProvider(LocalConfiguration provides landscape) {
                DeckTheme { WideDockScreen(vm = vm, onOpen = { opened += it }) }
            }
        }
    }

    @Test
    fun theRailCarriesTheBigFiveHourNumeral() {
        showLandscape(fakeViewModel())
        compose.onNodeWithText("42").assertIsDisplayed()
        compose.onNodeWithContentDescription(ACCOUNT_PAGER).performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.onNodeWithText("77").assertIsDisplayed()
    }

    @Test
    fun eachRingCountsDownToItsReset() {
        showLandscape(fakeViewModel())
        // Every fixture limit resets 2 h 33 m after Fx.NOW; the page in hand carries two rings.
        compose.onAllNodesWithText("2h33m").assertCountEquals(2)
    }

    @Test
    fun theRailCarriesTheSevenDayNumeral() {
        showLandscape(fakeViewModel())
        compose.onNodeWithText("18").assertIsDisplayed()
        compose.onNodeWithContentDescription(ACCOUNT_PAGER).performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.onNodeWithText("31").assertIsDisplayed()
    }

    @Test
    fun theRailFooterShowsTheTeamTotalAndLiveCount() {
        showLandscape(fakeViewModel())
        compose.onNodeWithText("team today", substring = true).assertExists()
        compose.onNodeWithText("2 live", substring = true).assertExists()
    }

    @Test
    fun theRailCarriesPauseAllAndProjects() {
        showLandscape(fakeViewModel())
        compose.onNodeWithText("Pause all").assertExists()
        compose.onNodeWithText("Projects").performClick()
        assertEquals(listOf<Route>(Route.Projects), opened)
    }

    @Test
    fun aGlobalPauseChangesTheRailActionToResumeAll() {
        val rule = PauseRule("r-all", "all", PauseMode.SOFT, "usage-deck:test", Fx.NOW, "dashboard")
        val team = TeamState(Fx.twoUsers().machines.map { it.copy(rules = listOf(rule)) })
        showLandscape(fakeViewModel(team = team, actions = RecordingPauseActions(paused = setOf("all"))))

        compose.onNodeWithText("Resume all").assertExists()
    }

    @Test
    fun theGearSitsInTheStatusBar() {
        showLandscape(fakeViewModel())
        compose.onNodeWithContentDescription(SETTINGS_CHIP).performClick()
        assertEquals(listOf<Route>(Route.Settings), opened)
    }

    @Test
    fun withNothingPairedTheRailOffersPairInsteadOfProjects() {
        showLandscape(fakeViewModel(team = TeamState(emptyList())))
        compose.onNodeWithText("Projects").assertDoesNotExist()
        compose.onNodeWithText("Pair").assertExists()
    }

    @Test
    fun rowsSwapPlacesWhenAProjectOvertakesAnother() {
        val flow = MutableStateFlow(Fx.twoUsers())
        showLandscape(fakeViewModel(teamFlow = flow))
        val calendarBefore = compose.onNodeWithText("plannerapp").fetchSemanticsNode().positionInRoot.y
        val audioBefore = compose.onNodeWithText("audioleveler").fetchSemanticsNode().positionInRoot.y
        assertTrue(calendarBefore < audioBefore)

        // audioleveler's session burns past plannerapp's: projects rank by live tokens.
        flow.value = TeamState(
            listOf(
                Fx.machine(
                    id = "m1",
                    name = "Adam",
                    email = "adam@example.com",
                    fiveHour = 42,
                    sevenDay = 18,
                    sessions = listOf(Fx.session("a1b2c3d4"))
                ),
                Fx.machine(
                    id = "m2",
                    name = "Sam",
                    email = "sam@example.com",
                    fiveHour = 77,
                    sevenDay = 31,
                    sessions = listOf(
                        Fx.session(
                            "e5f6a7b8",
                            projectKey = "/repo/audioleveler",
                            projectName = "audioleveler",
                            tokens = 99_000_000
                        )
                    )
                )
            )
        )
        compose.mainClock.advanceTimeBy(2_000)
        compose.waitForIdle()

        val calendarAfter = compose.onNodeWithText("plannerapp").fetchSemanticsNode().positionInRoot.y
        val audioAfter = compose.onNodeWithText("audioleveler").fetchSemanticsNode().positionInRoot.y
        assertTrue(audioAfter < calendarAfter)
        compose.onNodeWithText("plannerapp").assertIsDisplayed()
        compose.onNodeWithText("audioleveler").assertIsDisplayed()
    }

    @Test
    fun aMachineWithoutDataShowsAShortNameAndNoAddressInTheRail() {
        val waiting = MachineState(config = MachineConfig("m9", "studio.tail0fake.ts.net", "100.1.1.9", 8787, "token"))
        showLandscape(fakeViewModel(team = TeamState(listOf(waiting))))
        // Short name twice: the status-bar chip and the rail card. The right pane's full-width
        // card keeps the full hostname and the address, so each of those appears exactly once.
        compose.onAllNodesWithText("studio").assertCountEquals(2)
        compose.onAllNodesWithText("studio.tail0fake.ts.net").assertCountEquals(1)
        compose.onAllNodesWithText("100.1.1.9", substring = true).assertCountEquals(1)
        compose.onAllNodesWithText("connecting…").assertCountEquals(2)
    }

    @Test
    fun eachAccountCarriesItsOwnRingsAndResetCard() {
        // Two accounts, two windows: neither page may borrow the other's figures or reset time.
        val esp = Fx.machine(
            id = "m1",
            name = "ESP Testing",
            email = "adam@example.com",
            fiveHour = 24,
            sevenDay = 95
        ).let {
            it.copy(
                user = User("adam@example.com", "account-esp", "ESP Testing"),
                limits = listOf(
                    Fx.limit("session", 24, resetsAt = Fx.NOW.plusSeconds(5_400)),
                    Fx.limit("weekly_all", 95, resetsAt = Fx.NOW.plusSeconds(31_200))
                )
            )
        }
        val adam = Fx.machine(
            id = "m2",
            name = "Adam",
            email = "adam@other.example",
            fiveHour = 7,
            sevenDay = 12
        ).let {
            it.copy(
                user = User("adam@other.example", "account-adam", "Adam"),
                limits = listOf(
                    Fx.limit("session", 7, resetsAt = Fx.NOW.plusSeconds(600)),
                    Fx.limit("weekly_all", 12, resetsAt = Fx.NOW.plusSeconds(180_000))
                )
            )
        }
        showLandscape(fakeViewModel(team = TeamState(listOf(esp, adam))))

        compose.onNodeWithText("24").assertIsDisplayed()
        compose.onNodeWithText("95").assertIsDisplayed()
        compose.onNodeWithText("1h30m").assertIsDisplayed()
        compose.onNodeWithText("8h40m").assertIsDisplayed()

        compose.onNodeWithContentDescription(ACCOUNT_PAGER).performTouchInput { swipeLeft() }
        compose.waitForIdle()

        compose.onNodeWithText("7").assertIsDisplayed()
        compose.onNodeWithText("12").assertIsDisplayed()
        compose.onNodeWithText("10m00s").assertIsDisplayed()
        compose.onNodeWithText("2d02h").assertIsDisplayed()
        // The first account's window must not follow the swipe.
        compose.onNodeWithText("1h30m").assertDoesNotExist()
    }

    @Test
    fun oneAccountOnTwoMachinesIsOneBlockWithNoPager() {
        val account = User("adam@example.com", "account-1", "Adam")
        val team = TeamState(
            Fx.twoUsers().machines.map { it.copy(user = account) }
        )
        showLandscape(fakeViewModel(team = team))

        compose.onNodeWithContentDescription(ACCOUNT_PAGER).assertDoesNotExist()
        // The freshest copy of the one quota, shown once rather than dealt out per machine.
        compose.onAllNodesWithText("42").assertCountEquals(1)
        compose.onNodeWithText("77").assertDoesNotExist()
    }

    @Test
    fun noMachinesShowsThePairingPromptInBothPanes() {
        compose.setContent {
            DeckTheme {
                WideDockScreen(
                    vm = fakeViewModel(team = TeamState(emptyList())),
                    onOpen = {}
                )
            }
        }

        compose.onNodeWithText("No machines paired").assertExists()
        compose.onNodeWithText("nothing paired").assertExists()
        compose.onNodeWithText("Pair").assertExists()
    }

    @Test
    fun rowsLeadWithTheProjectNameAndCarryTheColumnCaptions() {
        compose.setContent { DeckTheme { WideDockScreen(vm = fakeViewModel(), onOpen = {}) } }

        compose.onNodeWithText("plannerapp").assertExists()
        compose.onNodeWithText("audioleveler").assertExists()
        compose.onNodeWithText("tok/min · 30m").assertExists()
        compose.onNodeWithText("a1b2… · 1.9M today", substring = true).assertExists()
    }
}
