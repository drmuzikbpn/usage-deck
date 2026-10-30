// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.evenseal.usagedeck.settings.Settings
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The kiosk's wifi, PIN and updates must not reach a phone, and the phone's switch not the kiosk. */
@RunWith(RobolectricTestRunner::class)
class SettingsChannelTest {
    @get:Rule
    val rule = createComposeRule()

    private var settings by mutableStateOf(Settings())

    private fun show(kiosk: Boolean) = rule.setContent {
        SettingsScreen(
            settings = settings,
            version = "1.0.1",
            updateState = "up to date",
            onUpdate = { settings = it(settings) },
            onSetPin = { _, _ -> null },
            onCheckUpdate = {},
            onBack = {},
            kiosk = kiosk
        )
    }

    @Test
    fun `a phone has no wifi, exit pin or update controls`() {
        show(kiosk = false)
        listOf("Wifi", "Kiosk exit PIN", "Updates", "Check for update now").forEach {
            rule.onNodeWithText(it).assertDoesNotExist()
        }
    }

    @Test
    fun `the kiosk keeps them and has no background switch`() {
        show(kiosk = true)
        rule.onNodeWithText("Wifi").assertExists()
        rule.onNodeWithText("Keep watching in the background").assertDoesNotExist()
    }

    @Test
    fun `background watching is off until the user turns it on`() {
        show(kiosk = false)
        assertEquals(false, settings.keepWatching)
        rule.onNodeWithText("Keep watching in the background").performScrollTo().performClick()
        rule.waitForIdle()
        assertEquals(true, settings.keepWatching)
    }
}
