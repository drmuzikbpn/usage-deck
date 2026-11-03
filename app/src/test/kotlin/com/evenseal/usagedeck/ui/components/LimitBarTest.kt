// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.components

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class LimitBarTest {
    @get:Rule
    val compose = createComposeRule()

    private val now = Instant.parse("2026-11-03T04:00:00Z")

    @Test
    fun `a window the plan does not have says so (daemon 23_68)`() {
        compose.setContent { LimitBar(label = "5h", limit = null, now = now, noLimit = true) }

        compose.onNodeWithText(NoLimit.SHORT).assertExists()
        compose.onNodeWithText(NoLimit.CAPTION).assertExists()
        compose.onNodeWithText("—").assertDoesNotExist()
    }

    @Test
    fun `a window not reported yet stays a dash`() {
        compose.setContent { LimitBar(label = "5h", limit = null, now = now) }

        compose.onNodeWithText(NoLimit.SHORT).assertDoesNotExist()
        assertEquals(2, compose.onAllNodesWithText("—").fetchSemanticsNodes().size)
    }
}
