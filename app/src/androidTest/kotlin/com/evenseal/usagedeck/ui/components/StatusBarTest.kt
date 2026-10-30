// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.components

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.ui.Fx
import com.evenseal.usagedeck.ui.theme.DeckTheme
import com.evenseal.usagedeck.wifi.WifiStatus
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StatusBarTest {
    @get:Rule
    val compose = createComposeRule()

    private val opened = mutableListOf<String>()

    private var settingsOpened = 0

    private fun show(machines: List<MachineState>, alertChip: String? = null, gear: Boolean = false) {
        compose.setContent {
            DeckTheme {
                StatusBar(
                    showWifi = true,
                    wifi = WifiStatus(connected = true, ssid = "deck", rssi = -50, ip = "10.0.0.2", bars = 3),
                    machines = machines,
                    clock = Fx.NOW,
                    alertChip = alertChip,
                    onWifi = {},
                    onMachine = { opened += it },
                    zone = ZoneId.of("UTC"),
                    onSettings = if (gear) ({ settingsOpened++ }) else null
                )
            }
        }
    }

    private fun machines(n: Int) = (1..n).map { i ->
        Fx.machine("m$i", "Machine-Number-$i", "u$i@example.com", 10, 20, if (i == 2) Health.STALE else Health.FRESH)
    }

    @Test
    fun theGearAppearsOnlyWhenAScreenAsksForIt() {
        show(emptyList())
        compose.onNodeWithContentDescription(SETTINGS_CHIP).assertDoesNotExist()
    }

    @Test
    fun theGearOpensSettings() {
        show(emptyList(), gear = true)
        compose.onNodeWithContentDescription(SETTINGS_CHIP).assertIsDisplayed()
        compose.onNodeWithText(GEAR).performClick()
        assertEquals(1, settingsOpened)
    }

    @Test
    fun noMachinesStillShowsWifiAndClock() {
        show(emptyList())

        compose.onNodeWithText("▂▄▆·").assertIsDisplayed()
        compose.onNodeWithText("deck", substring = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("$WIFI_CHIP deck").assertIsDisplayed()
        compose.onNodeWithText("12:00").assertIsDisplayed()
        compose.onAllNodesWithContentDescription(MACHINE_CHIP, substring = true).assertCountEquals(0)
    }

    @Test
    fun eachMachineGetsAChipThatOpensIt() {
        show(machines(3))

        compose.onAllNodesWithContentDescription(MACHINE_CHIP, substring = true).assertCountEquals(3)
        compose.onNodeWithContentDescription("$MACHINE_CHIP Machine-Number-2").performClick()
        assertEquals(listOf("m2"), opened)
        compose.onNodeWithText("12:00").assertIsDisplayed()
    }

    @Test
    fun anAlertKeepsTheMachinesReachableAsDots() {
        show(machines(2), alertChip = "adam 5h 91%")

        compose.onNodeWithText("adam 5h 91%").assertIsDisplayed()
        compose.onAllNodesWithContentDescription(MACHINE_CHIP, substring = true).assertCountEquals(2)
        compose.onNodeWithContentDescription("$MACHINE_CHIP Machine-Number-1").performClick()
        assertEquals(listOf("m1"), opened)
        compose.onNodeWithText("12:00").assertIsDisplayed()
    }
}
