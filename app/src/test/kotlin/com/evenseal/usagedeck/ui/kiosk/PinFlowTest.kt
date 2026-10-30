// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.kiosk

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.UsageDeckApp
import com.evenseal.usagedeck.settings.Settings
import com.evenseal.usagedeck.ui.removePin
import com.evenseal.usagedeck.ui.setOrChangePin
import com.evenseal.usagedeck.ui.settings.CURRENT_PIN_FIELD
import com.evenseal.usagedeck.ui.settings.PIN_AGAIN_FIELD
import com.evenseal.usagedeck.ui.settings.PIN_FIELD
import com.evenseal.usagedeck.ui.settings.PIN_MESSAGE
import com.evenseal.usagedeck.ui.settings.SettingsScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class PinFlowTest {
    @get:Rule
    val compose = createComposeRule()

    private val app = ApplicationProvider.getApplicationContext<UsageDeckApp>()
    private val graph get() = app.graph

    @Before
    fun clean() {
        app.getSharedPreferences("exit_pin", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun `with no pin the corner hold alone opens the exit`() {
        var unlocked = false
        compose.setContent { ExitGate(pin = graph.exitPin, clock = graph.clock, onUnlocked = { unlocked = true }) }

        compose.onNodeWithContentDescription(ExitGateDefaults.CONTENT_DESCRIPTION).performTouchInput {
            down(center)
            advanceEventTime(ExitGateDefaults.HOLD_MILLIS + 100)
            moveBy(Offset(1f, 0f))
            up()
        }

        compose.runOnIdle { assertTrue(unlocked) }
        compose.onNodeWithText("Maintenance exit").assertDoesNotExist()
    }

    @Test
    fun `with a pin the corner hold asks for it`() {
        graph.exitPin.set("123456")
        var unlocked = false
        compose.setContent { ExitGate(pin = graph.exitPin, clock = graph.clock, onUnlocked = { unlocked = true }) }

        compose.onNodeWithContentDescription(ExitGateDefaults.CONTENT_DESCRIPTION).performTouchInput {
            down(center)
            advanceEventTime(ExitGateDefaults.HOLD_MILLIS + 100)
            moveBy(Offset(1f, 0f))
            up()
        }

        compose.onNodeWithText("Maintenance exit").assertExists()
        assertFalse(unlocked)
    }

    @Test
    fun `a short tap on the corner does nothing`() {
        var unlocked = false
        compose.setContent { ExitGate(pin = graph.exitPin, clock = graph.clock, onUnlocked = { unlocked = true }) }

        compose.onNodeWithContentDescription(ExitGateDefaults.CONTENT_DESCRIPTION).performClick()

        compose.runOnIdle { assertFalse(unlocked) }
    }

    @Test
    fun `settings turns the pin on only once both entries match`() {
        val calls = mutableListOf<Pair<String?, String>>()
        compose.setContent {
            settingsScreen(pinSet = false, onSetPin = { c, n ->
                calls += c to n
                null
            })
        }

        compose.onNodeWithContentDescription(PIN_FIELD).performScrollTo().performTextInput("123456")
        compose.onNodeWithContentDescription(PIN_AGAIN_FIELD).performScrollTo().performTextInput("123457")
        compose.onNodeWithText("Turn on").performScrollTo().assertIsNotEnabled()

        compose.onNodeWithContentDescription(PIN_AGAIN_FIELD).performTextReplacement("123456")
        compose.onNodeWithText("Turn on").assertIsEnabled().performClick()

        assertEquals(listOf<Pair<String?, String>>(null to "123456"), calls)
    }

    @Test
    fun `settings removes the pin with the current one`() {
        val removed = mutableListOf<String>()
        compose.setContent {
            settingsScreen(pinSet = true, onRemovePin = {
                removed += it
                null
            })
        }

        compose.onNodeWithText("Remove PIN").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithContentDescription(CURRENT_PIN_FIELD).performScrollTo().performTextInput("123456")
        compose.onNodeWithText("Remove PIN").performScrollTo().assertIsEnabled().performClick()

        assertEquals(listOf("123456"), removed)
        compose.onNodeWithContentDescription(PIN_MESSAGE).assertExists()
    }

    @Test
    fun `removing the pin needs the current one and opens the gate`() {
        setOrChangePin(graph, null, "123456")

        assertEquals("Current PIN is wrong · 4 left", removePin(graph, "000000"))
        assertTrue(graph.exitPin.isSet())
        assertTrue(graph.settings.settings.value.pinSet)

        assertNull(removePin(graph, "123456"))
        assertFalse(graph.exitPin.isSet())
        assertFalse(graph.settings.settings.value.pinSet)
    }

    @Composable
    private fun settingsScreen(
        pinSet: Boolean,
        onSetPin: (String?, String) -> String? = { _, _ -> null },
        onRemovePin: (String) -> String? = { null }
    ) = SettingsScreen(
        settings = Settings(pinSet = pinSet),
        version = "0.1.1+test",
        updateState = "up to date",
        onUpdate = {},
        onSetPin = onSetPin,
        onRemovePin = onRemovePin,
        onCheckUpdate = {},
        onBack = {},
        kiosk = true
    )

    @Test
    fun `settings can set the first pin but cannot replace it without the current one`() {
        assertNull(setOrChangePin(graph, null, "123456"))
        assertTrue(graph.settings.settings.value.pinSet)

        assertEquals("Current PIN is wrong · 4 left", setOrChangePin(graph, null, "999999"))
        assertEquals("Current PIN is wrong · 3 left", setOrChangePin(graph, "000000", "999999"))
        assertEquals(com.evenseal.usagedeck.kiosk.ExitPin.Result.Ok, graph.exitPin.verify("123456"))

        assertNull(setOrChangePin(graph, "123456", "654321"))
        assertEquals(com.evenseal.usagedeck.kiosk.ExitPin.Result.Ok, graph.exitPin.verify("654321"))
    }

    @Test
    fun `guessing the current pin from settings ends in the gate's lockout`() {
        setOrChangePin(graph, null, "123456")
        val answers = (1..5).map { setOrChangePin(graph, "000000", "999999") }

        assertTrue(answers.last()!!.startsWith("Locked out for "))
        assertTrue(setOrChangePin(graph, "123456", "999999")!!.startsWith("Locked out for "))
    }
}
