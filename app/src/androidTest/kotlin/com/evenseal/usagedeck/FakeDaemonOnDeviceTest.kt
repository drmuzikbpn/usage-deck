// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.core.daemon.DaemonEvent
import com.evenseal.usagedeck.core.daemon.DaemonEventSource
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.daemon.OkHttpDaemonApi
import com.evenseal.usagedeck.core.daemon.SessionsResult
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingClient
import com.evenseal.usagedeck.core.pairing.PairingInvite
import com.evenseal.usagedeck.fakedaemon.FakeDaemon
import com.evenseal.usagedeck.fakedaemon.Scenarios
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Proves the `fakedaemon` module really serves the deck from inside an Android process, the way
 * the deck talks to any daemon: a pairing link redeemed over pinned HTTPS, then REST and the
 * event stream over the same pin, with the app's own clients.
 */
@RunWith(AndroidJUnit4::class)
class FakeDaemonOnDeviceTest {
    private lateinit var daemon: FakeDaemon

    private val client = OkHttpClient.Builder()
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    @Before
    fun setUp() {
        daemon = FakeDaemon(port = PORT, scenario = Scenarios.idle)
        daemon.start()
    }

    @After
    fun tearDown() {
        daemon.stop()
    }

    /** A failed redeem says why: the exception alone carries only its code. */
    private fun pair(): MachineConfig = runBlocking {
        try {
            PairingClient(client).redeem(PairingInvite.parse(daemon.pairingLink()).getOrThrow())
        } catch (e: DaemonException) {
            throw AssertionError("redeem failed: code=${e.code} message=${e.message}", e)
        }
    }

    @Test
    fun pairsOverPinnedHttpsFromInsideTheAppProcess() {
        val config = pair()
        assertEquals(daemon.token, config.token)
        assertEquals(daemon.fingerprint, config.fp)
    }

    @Test
    fun servesRestToThePairedDeck() = runBlocking {
        val api = OkHttpDaemonApi(pair(), client)
        assertEquals("fake-mbp", api.health().name)
        val sessions = api.sessions(null) as SessionsResult.Changed
        assertTrue("no sessions in ${sessions.dto}", sessions.dto.sessions.isNotEmpty())
    }

    /** The whole `snapshot` frame arrives and parses: the stream is usable on-device. */
    @Test
    fun streamsASnapshotToThePairedDeck() = runBlocking {
        val events = DaemonEventSource(pair(), client).events()
        val snapshot = withTimeout(STREAM_TIMEOUT_MS) { events.first { it is DaemonEvent.Snapshot } }
        assertEquals("fake-mbp", (snapshot as DaemonEvent.Snapshot).name)
        assertTrue(snapshot.sessions.isNotEmpty())
    }

    /** The plain listener is loopback only and still wants the bearer for anything but liveness. */
    @Test
    fun anUnauthenticatedLoopbackReadIsRefusedButLivenessAnswers() {
        assumeTrue(BuildConfig.KIOSK) // The Play build refuses cleartext outright, even on loopback.

        fun status(path: String) =
            client.newCall(Request.Builder().url("http://127.0.0.1:$PORT$path").get().build()).execute().use { it.code }
        assertEquals(200, status("/health"))
        assertEquals(401, status("/v1/sessions"))
    }

    private companion object {
        const val PORT = 47298
        const val STREAM_TIMEOUT_MS = 15_000L
    }
}
