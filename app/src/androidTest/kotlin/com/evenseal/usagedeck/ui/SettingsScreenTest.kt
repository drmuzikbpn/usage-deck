// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.core.model.UserView
import com.evenseal.usagedeck.settings.Settings
import com.evenseal.usagedeck.settings.normalised
import com.evenseal.usagedeck.ui.components.RENAME_FIELD
import com.evenseal.usagedeck.ui.components.RENAME_RESET
import com.evenseal.usagedeck.ui.components.RENAME_SAVE
import com.evenseal.usagedeck.ui.settings.CRITICAL_SLIDER
import com.evenseal.usagedeck.ui.settings.SettingsScreen
import com.evenseal.usagedeck.ui.theme.DeckTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SettingsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var latest: () -> Settings

    /** Mirrors `SettingsStore.update`, which normalises before it persists. */
    private fun show(initial: Settings = Settings(), users: List<UserView> = emptyList()) {
        compose.setContent {
            var state by androidx.compose.runtime.remember { mutableStateOf(initial) }
            latest = { state }
            DeckTheme {
                SettingsScreen(
                    kiosk = true,
                    settings = state,
                    version = "0.1.417+abc1234",
                    updateState = "up to date",
                    onUpdate = { transform -> state = transform(state).normalised() },
                    onSetPin = { _, _ -> null },
                    onCheckUpdate = {},
                    onBack = {},
                    users = users
                )
            }
        }
    }

    @Test
    fun showsTheCurrentThresholds() {
        show()
        compose.onNodeWithText("warn 80").assertExists()
        compose.onNodeWithText("critical 95").assertExists()
    }

    @Test
    fun theCriticalSliderCannotGoBelowWarnPlusOne() {
        show(Settings(warn = 80, critical = 95))

        compose.onNodeWithContentDescription(CRITICAL_SLIDER)
            .performSemanticsAction(SemanticsActions.SetProgress) { it(50f) }

        assertEquals(81, latest().critical)
        assertTrue(latest().critical > latest().warn)
    }

    @Test
    fun raisingWarnPushesCriticalUpWithIt() {
        show(Settings(warn = 80, critical = 81))

        compose.onNodeWithContentDescription(com.evenseal.usagedeck.ui.settings.WARN_SLIDER)
            .performSemanticsAction(SemanticsActions.SetProgress) { it(90f) }

        assertTrue(
            "critical ${latest().critical} must stay above warn ${latest().warn}",
            latest().critical > latest().warn
        )
    }

    @Test
    fun escalationOffWritesNull() {
        show()
        compose.onNodeWithText("off").performScrollTo().performClick()
        assertNull(latest().escalationSeconds)
    }

    @Test
    fun escalationOffersTheSpecTimeouts() {
        show()
        listOf("off", "30s", "60s", "90s", "120s", "300s", "600s").forEach {
            compose.onNodeWithText(it).assertExists()
        }
    }

    @Test
    fun pickingAnEscalationTimeoutWritesTheSeconds() {
        show()
        compose.onNodeWithText("300s").performScrollTo().performClick()
        assertEquals(300, latest().escalationSeconds)
    }

    @Test
    fun theVersionFooterShowsTheBuild() {
        show()
        compose.onNodeWithText("0.1.417+abc1234").assertExists()
        compose.onNodeWithText("Check for update now").assertExists()
    }

    @Test
    fun quietHoursCanBeShifted() {
        show()
        compose.onNodeWithText("23:00").assertExists()
        compose.onNodeWithText("07:00").assertExists()
    }

    @Test
    fun displayAndSoundTogglesWriteTheirSettings() {
        show(Settings(autoDim = true, keepScreenOn = true))
        compose.onNodeWithText("Wifi").assertExists()
        compose.onNodeWithText("24-hour clock").performScrollTo().performClick()
        assertEquals(false, latest().clock24h)
        compose.onNodeWithText("Auto-dim at night").performScrollTo().performClick()
        assertEquals(false, latest().autoDim)
        compose.onNodeWithText("Alert sound").performScrollTo().performClick()
        assertEquals(false, latest().sound)
        compose.onNodeWithText("Keep screen on").performScrollTo().performClick()
        assertEquals(false, latest().keepScreenOn)
    }

    @Test
    fun renamingAUserWritesTheOverrideAndResettingClearsIt() {
        show(users = Fx.twoUsers().users)

        compose.onNodeWithContentDescription("rename Adam").performScrollTo().performClick()
        compose.onNodeWithContentDescription(RENAME_FIELD).performTextClearance()
        compose.onNodeWithContentDescription(RENAME_FIELD).performTextInput("Studio")
        compose.onNodeWithText(RENAME_SAVE).performClick()
        assertEquals(mapOf("uuid-m1" to "Studio"), latest().userNames)
        compose.onNodeWithContentDescription("rename Studio").assertExists()

        compose.onNodeWithContentDescription("rename Studio").performClick()
        compose.onNodeWithText(RENAME_RESET).performClick()
        assertTrue(latest().userNames.isEmpty())
    }
}
