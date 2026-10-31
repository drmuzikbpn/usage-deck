// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck

import android.content.ComponentName
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.pairing.QrScanActivity
import com.evenseal.usagedeck.service.DeckGraph
import com.evenseal.usagedeck.ui.components.PauseChoiceDefaults
import com.evenseal.usagedeck.ui.components.SETTINGS_CHIP
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real activity turned through the real orientations, with the demo as its data. Asking the
 * activity for an orientation goes through the same configuration change a turned phone does, and
 * unlike a frozen display rotation it also reaches the kiosk, which follows the sensor.
 */
@RunWith(AndroidJUnit4::class)
class RotationTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var graph: DeckGraph
    private lateinit var scenario: ActivityScenario<MainActivity>

    /** Whatever this phone was already paired with, put back in [tearDown]. */
    private var preexisting: List<MachineConfig> = emptyList()

    @Before
    fun setUp() {
        val app = InstrumentationRegistry.getInstrumentation()
            .targetContext.applicationContext as UsageDeckApp
        graph = app.graph
        preexisting = graph.machineStore.machines.value
        preexisting.forEach { graph.machineStore.remove(it.id) }
        graph.demo.start()
        scenario = ActivityScenario.launch(MainActivity::class.java)
        leaveLockTask()
    }

    @After
    fun tearDown() {
        leaveLockTask()
        scenario.close()
        graph.demo.stop()
        preexisting.forEach { graph.machineStore.add(it) }
    }

    @Test
    fun homeIsTheLedgerUprightAndTheDockSideways() {
        var first: MainActivity? = null
        scenario.onActivity { first = it }

        listOf(PORTRAIT, LANDSCAPE, SEASCAPE, PORTRAIT, SEASCAPE, LANDSCAPE, PORTRAIT).forEach { turn(it) }

        scenario.onActivity { assertSame("a turn must not recreate the activity", first, it) }
        assertEquals("the demo must survive being turned", 2, graph.team.value.machines.size)
    }

    @Test
    fun anOpenScreenStaysOpenThroughEveryTurn() {
        turn(LANDSCAPE)
        tapUntil(hasContentDescription(SETTINGS_CHIP), "Settings to open") { settingsShown() }

        listOf(PORTRAIT, SEASCAPE, PORTRAIT, LANDSCAPE).forEach {
            turn(it, home = false)
            assertTrue("Settings closed on turning to $it", settingsShown())
        }
    }

    @Test
    fun nothingTappableSitsUnderTheBarsOrTheCutOutSideways() {
        assumeFalse("the kiosk owns the whole screen", BuildConfig.KIOSK)

        listOf(LANDSCAPE, SEASCAPE).forEach { assertTappableClearOfInsets(it) }
        tapUntil(hasContentDescription(SETTINGS_CHIP), "Settings to open") { settingsShown() }
        listOf(SEASCAPE, LANDSCAPE).forEach { assertTappableClearOfInsets(it, home = false) }
    }

    @Test
    fun aProjectKeepsItsSessionsAndPauseButtonSideways() {
        turn(LANDSCAPE)
        tapUntil(hasText("Projects"), "the project list") {
            compose.onAllNodesWithText("2 live").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("garden-planner").performClick()
        await("the project") { compose.onAllNodesWithText("share of today").fetchSemanticsNodes().isNotEmpty() }

        val pause = compose.onNodeWithText(PauseChoiceDefaults.BUTTON).fetchSemanticsNode().boundsInWindow
        assertTrue("the pause button is cut to ${pause.height}px", pause.height >= MIN_BUTTON_DP * density())
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("b2e4", substring = true))
        compose.onNode(hasText("b2e4", substring = true)).assertIsDisplayed()
    }

    @Test
    fun theWholePauseChoiceCanBeReadSideways() {
        turn(LANDSCAPE)
        tapUntil(hasText("Projects"), "the project list") {
            compose.onAllNodesWithText("2 live").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("garden-planner").performClick()
        await(
            "the project"
        ) { compose.onAllNodesWithText(PauseChoiceDefaults.BUTTON).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(PauseChoiceDefaults.BUTTON).performClick()

        compose.onNode(hasText("ends the tool that was running", substring = true))
            .performScrollTo()
            .assertIsDisplayed()
    }

    @Test
    fun aPhoneKeepsToTheRotationLock() {
        assumeFalse("the kiosk follows the sensor", BuildConfig.KIOSK)
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        listOf(MainActivity::class.java, QrScanActivity::class.java).forEach {
            val info = context.packageManager.getActivityInfo(ComponentName(context, it), 0)
            assertEquals(it.simpleName, ActivityInfo.SCREEN_ORIENTATION_USER, info.screenOrientation)
        }
    }

    private fun density(): Float =
        InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density

    private fun assertTappableClearOfInsets(orientation: Int, home: Boolean = true) {
        turn(orientation, home)
        var safe = Insets.NONE
        var width = 0
        scenario.onActivity {
            val view = it.window.decorView
            val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            safe = checkNotNull(ViewCompat.getRootWindowInsets(view)).getInsets(types)
            width = view.width
        }
        val tappable = compose.onAllNodes(hasClickAction()).fetchSemanticsNodes()
        assertTrue("no tappable nodes in orientation $orientation", tappable.isNotEmpty())
        tappable.map { it.boundsInWindow }.filterNot { it.isEmpty }.forEach { box ->
            assertTrue("$box under the top inset ${safe.top}", box.top >= safe.top)
            assertTrue("$box under the left inset ${safe.left}", box.left >= safe.left)
            assertTrue("$box under the right inset ${safe.right} of $width", box.right <= width - safe.right)
        }
    }

    private fun settingsShown(): Boolean =
        compose.onAllNodesWithText("Pair a machine").fetchSemanticsNodes().isNotEmpty()

    /** Turns the phone and waits for the configuration; on Home, for the layout that goes with it. */
    private fun turn(orientation: Int, home: Boolean = true) {
        scenario.onActivity { it.requestedOrientation = orientation }
        val sideways = orientation != PORTRAIT
        await("orientation $orientation") {
            var now = Configuration.ORIENTATION_UNDEFINED
            scenario.onActivity { now = it.resources.configuration.orientation }
            now == if (sideways) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
        }
        if (home) {
            await("the dock to be ${if (sideways) "shown" else "gone"}") {
                compose.onAllNodesWithContentDescription(SETTINGS_CHIP).fetchSemanticsNodes().isNotEmpty() == sideways
            }
        }
    }

    /** The system drops a touch while a window is still turning, a test's as it would a finger's. */
    private fun tapUntil(target: SemanticsMatcher, what: String, done: () -> Boolean) {
        await(what) {
            if (!done()) {
                compose.onAllNodes(target).onFirst().performClick()
                compose.waitForIdle()
                Thread.sleep(TAP_SETTLE_MS)
            }
            done()
        }
    }

    private fun await(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (condition()) return
            Thread.sleep(POLL_MS)
        }
        throw AssertionError("Timed out waiting for $what")
    }

    /** See [EndToEndTest]: a provisioned phone pins the activity, which nothing here can then drive. */
    private fun leaveLockTask() {
        if (!graph.kiosk.isDeviceOwner) return
        runCatching { scenario.onActivity { graph.kiosk.stopLockTask(it) } }
    }

    private companion object {
        const val PORTRAIT = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        const val LANDSCAPE = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        const val SEASCAPE = ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
        const val TIMEOUT_MS = 10_000L
        const val POLL_MS = 100L
        const val TAP_SETTLE_MS = 500L
        const val MIN_BUTTON_DP = 24
    }
}
