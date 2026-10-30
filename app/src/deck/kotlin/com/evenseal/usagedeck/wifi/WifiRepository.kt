// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.wifi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.ScanResult
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.SystemClock
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** One access point as the Wifi screen shows it. */
data class WifiNetwork(
    val ssid: String,
    val rssi: Int,
    val security: Security,
    val saved: Boolean,
    val connected: Boolean
) {
    enum class Security { OPEN, WPA, WPA3, EAP_UNSUPPORTED }
}

/**
 * Device Owner on Android 10 gets unrestricted `WifiManager`, so the deck manages wifi itself
 * rather than dropping the user into Settings (which lock task hides anyway). Spec §6.1.
 *
 * Everything that can throw [SecurityException] on a phone that is *not* Device Owner is wrapped,
 * so a non-provisioned build degrades to an empty list rather than crashing.
 */
class WifiRepository(
    private val context: Context,
    private val scope: CoroutineScope,
    private val clock: Clock = SystemClock
) : WifiMonitor {
    private val wifi: WifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    private val _status = MutableStateFlow(WifiStatus.DISCONNECTED)
    override val status: StateFlow<WifiStatus> = _status.asStateFlow()

    private val _scanResults = MutableStateFlow<List<WifiNetwork>>(emptyList())
    val scanResults: StateFlow<List<WifiNetwork>> = _scanResults.asStateFlow()

    private val _lastScanAt = MutableStateFlow<Instant?>(null)
    val lastScanAt: StateFlow<Instant?> = _lastScanAt.asStateFlow()

    private var receiver: BroadcastReceiver? = null
    private var pollJob: Job? = null
    private var lastScanRequestedAt: Instant? = null

    override fun start() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    WifiManager.SCAN_RESULTS_AVAILABLE_ACTION -> {
                        _lastScanAt.value = clock.now()
                        refreshStatus()
                        refreshScanResults()
                    }

                    else -> {
                        refreshStatus()
                        refreshScanResults()
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)
            addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION)
            addAction(WifiManager.RSSI_CHANGED_ACTION)
            addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
        }
        context.registerReceiver(r, filter)
        receiver = r
        refreshStatus()
        refreshScanResults()
        pollJob = scope.launch {
            while (isActive) {
                delay(STATUS_POLL_MILLIS)
                refreshStatus()
            }
        }
    }

    override fun stop() {
        pollJob?.cancel()
        pollJob = null
        val r = receiver ?: return
        receiver = null
        runCatching { context.unregisterReceiver(r) }
    }

    /**
     * Android 9+ throttles `startScan()` to roughly four calls per two minutes even for
     * privileged callers, so the UI rescan button is rate-limited to one call per 30 s.
     *
     * @return false when the request was swallowed by the rate limit or refused by the framework.
     */
    fun requestScan(): Boolean {
        val now = clock.now()
        val last = lastScanRequestedAt
        if (last != null && Duration.between(last, now) < SCAN_INTERVAL) return false
        lastScanRequestedAt = now
        return runCatching { wifi.startScan() }.getOrDefault(false)
    }

    /**
     * Adds (or updates) the configuration for [ssid] and makes it the active network.
     * A null or blank [passphrase] means an open network.
     */
    fun connect(ssid: String, passphrase: String?): Result<Unit> = runCatching {
        val config = WifiConfiguration().apply {
            SSID = ssid.quoted()
            if (passphrase.isNullOrEmpty()) {
                allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
            } else {
                preSharedKey = passphrase.quoted()
                allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
            }
        }
        val existing = savedNetworkId(ssid)
        val netId = if (existing != null) {
            config.networkId = existing
            wifi.updateNetwork(config)
        } else {
            wifi.addNetwork(config)
        }
        check(netId != -1) { "wifi refused the configuration for $ssid" }
        check(wifi.enableNetwork(netId, true)) { "wifi refused to enable $ssid" }
        refreshStatus()
        refreshScanResults()
    }

    fun forget(ssid: String): Result<Unit> = runCatching {
        val netId = savedNetworkId(ssid) ?: error("no saved network named $ssid")
        check(wifi.removeNetwork(netId)) { "wifi refused to remove $ssid" }
        refreshScanResults()
    }

    private fun refreshStatus() {
        _status.value = readStatus()
    }

    private fun refreshScanResults() {
        val current = _status.value.ssid
        val saved = savedSsids()
        val results = runCatching { wifi.scanResults }.getOrNull().orEmpty()
        _scanResults.value = results
            .mapNotNull { it.toNetwork(saved, current) }
            .groupBy { it.ssid }
            .map { (_, group) -> group.maxBy { it.rssi } }
            .sortedByDescending { it.rssi }
    }

    private fun readStatus(): WifiStatus {
        val info = runCatching { wifi.connectionInfo }.getOrNull() ?: return WifiStatus.DISCONNECTED
        val ssid = info.ssid?.unquoted()
            ?.takeIf { it.isNotBlank() && it != WifiManager.UNKNOWN_SSID }
            ?: return WifiStatus.DISCONNECTED
        val enabled = runCatching { wifi.isWifiEnabled }.getOrDefault(true)
        if (!enabled) return WifiStatus.DISCONNECTED
        val rssi = info.rssi
        return WifiStatus(
            connected = true,
            ssid = ssid,
            rssi = rssi,
            ip = info.ipAddress.toIpv4(),
            bars = WifiManager.calculateSignalLevel(rssi, BAR_LEVELS)
        )
    }

    private fun savedConfigs(): List<WifiConfiguration> = runCatching { wifi.configuredNetworks }.getOrNull().orEmpty()

    private fun savedSsids(): Set<String> = savedConfigs().mapNotNull { it.SSID?.unquoted() }.toSet()

    private fun savedNetworkId(ssid: String): Int? =
        savedConfigs().firstOrNull { it.SSID?.unquoted() == ssid }?.networkId

    private fun ScanResult.toNetwork(saved: Set<String>, connectedSsid: String?): WifiNetwork? {
        val name = SSID?.unquoted()?.takeIf { it.isNotBlank() } ?: return null
        return WifiNetwork(
            ssid = name,
            rssi = level,
            security = securityOf(capabilities.orEmpty()),
            saved = name in saved,
            connected = name == connectedSsid
        )
    }

    private companion object {
        val SCAN_INTERVAL: Duration = Duration.ofSeconds(30)
        const val STATUS_POLL_MILLIS = 10_000L
        const val BAR_LEVELS = 5

        fun securityOf(capabilities: String): WifiNetwork.Security = when {
            capabilities.contains("SAE") -> WifiNetwork.Security.WPA3
            capabilities.contains("EAP") -> WifiNetwork.Security.EAP_UNSUPPORTED
            capabilities.contains("PSK") || capabilities.contains("WPA") -> WifiNetwork.Security.WPA
            else -> WifiNetwork.Security.OPEN
        }

        fun String.quoted(): String = "\"$this\""

        fun String.unquoted(): String = removeSurrounding("\"")

        /** `WifiInfo.ipAddress` is a little-endian IPv4 address packed into an int. */
        fun Int.toIpv4(): String? {
            if (this == 0) return null
            return "${this and 0xFF}.${this shr 8 and 0xFF}.${this shr 16 and 0xFF}.${this shr 24 and 0xFF}"
        }
    }
}
