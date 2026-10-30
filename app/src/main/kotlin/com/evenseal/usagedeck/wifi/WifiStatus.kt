// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.wifi

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The status chip's view of the radio. [bars] is 0..4. */
data class WifiStatus(
    val connected: Boolean,
    val ssid: String?,
    val rssi: Int?,
    val ip: String?,
    val bars: Int
) {
    companion object {
        val DISCONNECTED = WifiStatus(connected = false, ssid = null, rssi = null, ip = null, bars = 0)
    }
}

/** What the shared screens read from the radio. Only the kiosk build manages wifi. */
interface WifiMonitor {
    val status: StateFlow<WifiStatus>

    fun start()

    fun stop()
}

/** The Play build leaves wifi to the phone, so it reports nothing and hides the chip. */
object NoWifi : WifiMonitor {
    override val status: StateFlow<WifiStatus> = MutableStateFlow(WifiStatus.DISCONNECTED).asStateFlow()

    override fun start() = Unit

    override fun stop() = Unit
}
