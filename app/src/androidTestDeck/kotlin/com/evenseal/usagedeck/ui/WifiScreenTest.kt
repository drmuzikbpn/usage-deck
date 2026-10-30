// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.ui.theme.DeckTheme
import com.evenseal.usagedeck.ui.wifi.RESCAN
import com.evenseal.usagedeck.ui.wifi.RESCAN_THROTTLED
import com.evenseal.usagedeck.ui.wifi.WifiScreen
import com.evenseal.usagedeck.wifi.WifiNetwork
import com.evenseal.usagedeck.wifi.WifiStatus
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WifiScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val now: Instant = Instant.parse("2026-09-13T12:00:00Z")

    private val networks = listOf(
        WifiNetwork("strong-open", -35, WifiNetwork.Security.OPEN, saved = false, connected = false),
        WifiNetwork("middling-wpa", -60, WifiNetwork.Security.WPA, saved = true, connected = true),
        WifiNetwork("weak-sae", -80, WifiNetwork.Security.WPA3, saved = false, connected = false),
        WifiNetwork("office-eap", -88, WifiNetwork.Security.EAP_UNSUPPORTED, saved = false, connected = false)
    )

    private val connects = mutableListOf<Pair<String, String?>>()
    private val forgets = mutableListOf<String>()
    private var rescans = 0

    private fun show(lastScanAt: Instant? = now.minusSeconds(5), canRescan: Boolean = false) {
        compose.setContent {
            DeckTheme {
                WifiScreen(
                    status = WifiStatus(true, "middling-wpa", -60, "10.0.0.7", 2),
                    networks = networks,
                    lastScanAt = lastScanAt,
                    now = now,
                    canRescan = canRescan,
                    onRescan = { rescans++ },
                    onConnect = { ssid, pass -> connects += ssid to pass },
                    onForget = { forgets += it },
                    onCaptivePortal = {},
                    onBack = {}
                )
            }
        }
    }

    @Test
    fun listsEveryNetworkWithItsSecurityTag() {
        show()
        compose.onNodeWithText("strong-open").assertExists()
        compose.onNodeWithText("open · -35 dBm").assertExists()
        compose.onNodeWithText("WPA2 · -60 dBm · connected").assertExists()
        compose.onNodeWithText("WPA3 · -80 dBm").assertExists()
        compose.onNodeWithText("enterprise · not supported · -88 dBm").assertExists()
    }

    @Test
    fun showsHowOldTheScanIs() {
        show()
        compose.onNodeWithText("scanned 5s ago").assertExists()
    }

    @Test
    fun rescanIsDisabledWhileThrottled() {
        show(canRescan = false)
        compose.onNodeWithText(RESCAN_THROTTLED).assertIsNotEnabled()
    }

    @Test
    fun rescanIsEnabledOnceTheWindowHasPassed() {
        show(lastScanAt = now.minusSeconds(31), canRescan = true)
        compose.onNodeWithText(RESCAN).assertIsEnabled()
        compose.onNodeWithText(RESCAN).performClick()
        assertEquals(1, rescans)
    }

    @Test
    fun tappingAnOpenNetworkConnectsWithoutAskingForAPassphrase() {
        show()
        compose.onNodeWithText("strong-open").performClick()
        assertEquals(listOf<Pair<String, String?>>("strong-open" to null), connects)
    }

    @Test
    fun tappingASecuredNetworkAsksForAPassphraseFirst() {
        show()
        compose.onNodeWithText("weak-sae").performClick()

        compose.onNodeWithText("Connect").assertIsNotEnabled()
        assertEquals(emptyList<Pair<String, String?>>(), connects)
    }

    @Test
    fun savedNetworksOfferForget() {
        show()
        compose.onNodeWithText("Forget").performClick()
        assertEquals(listOf("middling-wpa"), forgets)
    }
}
