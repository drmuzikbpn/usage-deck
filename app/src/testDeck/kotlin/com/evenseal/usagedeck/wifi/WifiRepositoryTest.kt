// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.wifi

import android.content.Context
import android.content.Intent
import android.net.wifi.ScanResult
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.FakeClock
import java.net.InetAddress
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowScanResult
import org.robolectric.shadows.ShadowWifiInfo
import org.robolectric.shadows.ShadowWifiManager

@RunWith(RobolectricTestRunner::class)
class WifiRepositoryTest {
    private lateinit var context: Context
    private lateinit var wifi: WifiManager
    private lateinit var shadowWifi: ShadowWifiManager
    private lateinit var scope: CoroutineScope
    private lateinit var clock: FakeClock
    private lateinit var repo: WifiRepository

    private val t0: Instant = Instant.parse("2026-09-13T10:00:00Z")

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        wifi = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
        shadowWifi = shadowOf(wifi)
        scope = CoroutineScope(Dispatchers.Unconfined)
        clock = FakeClock(t0)
        repo = WifiRepository(context, scope, clock)
    }

    @After
    fun tearDown() {
        repo.stop()
        scope.cancel()
    }

    private fun scan(ssid: String, rssi: Int, caps: String = "[WPA2-PSK-CCMP][ESS]"): ScanResult =
        ShadowScanResult.newInstance(ssid, "00:00:00:00:00:00", caps, rssi, 2412)

    private fun publishScan(vararg results: ScanResult) {
        shadowWifi.setScanResults(results.toList())
        context.sendBroadcast(Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION))
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun `scan results are deduped by ssid keeping the strongest signal`() {
        repo.start()
        publishScan(
            scan("office", -70),
            scan("office", -41),
            scan("office", -55),
            scan("guest", -80)
        )

        val ssids = repo.scanResults.value.map { it.ssid }
        assertEquals(listOf("office", "guest"), ssids)
        assertEquals(-41, repo.scanResults.value.first { it.ssid == "office" }.rssi)
    }

    @Test
    fun `scan results are sorted by rssi descending`() {
        repo.start()
        publishScan(scan("weak", -88), scan("strong", -35), scan("middling", -60))

        assertEquals(
            listOf("strong", "middling", "weak"),
            repo.scanResults.value.map { it.ssid }
        )
    }

    @Test
    fun `security is read from the scan capabilities`() {
        repo.start()
        publishScan(
            scan("open-net", -40, "[ESS]"),
            scan("psk-net", -41, "[WPA2-PSK-CCMP][ESS]"),
            scan("sae-net", -42, "[RSN-SAE-CCMP][ESS]"),
            scan("eap-net", -43, "[WPA2-EAP-CCMP][ESS]")
        )

        val bySsid = repo.scanResults.value.associateBy { it.ssid }
        assertEquals(WifiNetwork.Security.OPEN, bySsid.getValue("open-net").security)
        assertEquals(WifiNetwork.Security.WPA, bySsid.getValue("psk-net").security)
        assertEquals(WifiNetwork.Security.WPA3, bySsid.getValue("sae-net").security)
        assertEquals(WifiNetwork.Security.EAP_UNSUPPORTED, bySsid.getValue("eap-net").security)
    }

    @Test
    fun `lastScanAt records when the results arrived`() {
        repo.start()
        assertNull(repo.lastScanAt.value)
        clock.advance(5)
        publishScan(scan("office", -50))
        assertEquals(t0.plusSeconds(5), repo.lastScanAt.value)
    }

    @Test
    fun `connect to an open network adds a config with key management NONE`() {
        assertTrue(repo.connect("open-net", null).isSuccess)

        val enabled = shadowWifi.lastEnabledNetwork
        assertTrue(enabled.second)
        val config = shadowWifi.getWifiConfiguration(enabled.first)
        assertEquals("\"open-net\"", config.SSID)
        assertTrue(config.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.NONE))
        assertFalse(config.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.WPA_PSK))
        assertNull(config.preSharedKey)
    }

    @Test
    fun `connect to a wpa network quotes the passphrase`() {
        assertTrue(repo.connect("psk-net", "hunter2hunter2").isSuccess)

        val enabled = shadowWifi.lastEnabledNetwork
        val config = shadowWifi.getWifiConfiguration(enabled.first)
        assertEquals("\"psk-net\"", config.SSID)
        assertEquals("\"hunter2hunter2\"", config.preSharedKey)
        assertTrue(config.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.WPA_PSK))
    }

    @Test
    fun `forget removes the saved configuration for that ssid`() {
        repo.connect("psk-net", "hunter2hunter2")
        assertTrue(repo.forget("psk-net").isSuccess)
        assertTrue(wifi.configuredNetworks.none { it.SSID == "\"psk-net\"" })
    }

    @Test
    fun `forget fails when the ssid was never saved`() {
        assertTrue(repo.forget("never-seen").isFailure)
    }

    @Test
    fun `requestScan is throttled to once per thirty seconds`() {
        assertTrue(repo.requestScan())
        assertFalse(repo.requestScan())
        clock.advance(29)
        assertFalse(repo.requestScan())
        clock.advance(1)
        assertTrue(repo.requestScan())
    }

    @Test
    fun `status reflects the current connection info`() {
        val info = ShadowWifiInfo.newInstance()
        shadowOf(info).setSSID("office")
        shadowOf(info).setRssi(-55)
        shadowOf(info).setNetworkId(7)
        shadowOf(info).setInetAddress(InetAddress.getByName("10.0.0.42"))
        shadowWifi.setConnectionInfo(info)

        repo.start()

        val status = repo.status.value
        assertTrue(status.connected)
        assertEquals("office", status.ssid)
        assertEquals(-55, status.rssi)
        assertEquals("10.0.0.42", status.ip)
        assertEquals(WifiManager.calculateSignalLevel(-55, 5), status.bars)
    }

    @Test
    fun `status is disconnected when there is no connection info`() {
        repo.start()
        val status = repo.status.value
        assertFalse(status.connected)
        assertNull(status.ssid)
        assertEquals(0, status.bars)
    }

    @Test
    fun `saved networks are flagged in the scan list`() {
        repo.connect("psk-net", "hunter2hunter2")
        repo.start()
        publishScan(scan("psk-net", -50), scan("other", -60))

        val bySsid = repo.scanResults.value.associateBy { it.ssid }
        assertTrue(bySsid.getValue("psk-net").saved)
        assertFalse(bySsid.getValue("other").saved)
    }
}
