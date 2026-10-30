// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.update

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.update.ReleaseChecker
import com.evenseal.usagedeck.core.update.Sha256
import com.evenseal.usagedeck.core.update.Version
import java.io.File
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class UpdaterTest {
    private lateinit var server: MockWebServer
    private lateinit var cacheDir: File
    private lateinit var client: OkHttpClient

    private val installed = Version(0, 1, 400, "aaa1111")
    private val apkBytes = "this-is-an-apk".toByteArray()
    private val apkSha = Sha256.hex(apkBytes)
    private val clock = Clock { Instant.parse("2026-09-13T12:00:00Z") }

    /** Records what it was asked to install instead of touching the package manager. */
    private class FakeInstaller(context: Context) : ApkInstaller(context) {
        val installed = mutableListOf<String>()
        var result: Result<Unit> = Result.success(Unit)

        val versions = mutableListOf<String>()

        override suspend fun install(apk: File, version: String): Result<Unit> {
            installed += apk.readText()
            versions += version
            return result
        }
    }

    private lateinit var fakeInstaller: FakeInstaller

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        fakeInstaller = FakeInstaller(context)
        cacheDir = File(context.cacheDir, "updates-${System.nanoTime()}")
        client = OkHttpClient.Builder().build()
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        // MockWebServer refuses to stop while OkHttp still holds pooled connections, so drain the
        // client first rather than racing its shutdown timeout.
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
        cacheDir.deleteRecursively()
    }

    private fun serve(tag: String, sha: String = apkSha, apkStatus: Int = 200) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path.contains("/releases?") -> MockResponse().setBody(releaseJson(tag))
                    path.endsWith("/SHA256SUMS") ->
                        MockResponse().setBody("$sha  usage-deck-$tag.apk\n")
                    path.endsWith(".apk") ->
                        if (apkStatus == 200) {
                            MockResponse().setBody(okio.Buffer().write(apkBytes))
                        } else {
                            MockResponse().setResponseCode(apkStatus)
                        }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    private fun releaseJson(tag: String): String {
        val base = server.url("/").toString().trimEnd('/')
        return """
            [{
              "tag_name": "deck-$tag",
              "prerelease": true,
              "assets": [
                { "name": "usage-deck-$tag.apk", "browser_download_url": "$base/dl/usage-deck-$tag.apk" },
                { "name": "SHA256SUMS", "browser_download_url": "$base/dl/SHA256SUMS" }
              ]
            }]
        """.trimIndent()
    }

    /** Remembers skips in memory, as `PrefsUpdateSkips` does on disk. */
    private class FakeSkips : UpdateSkips {
        val reasons = linkedMapOf<String, String>()

        override fun reasonFor(version: String): String? = reasons[version]

        override fun skip(version: String, reason: String) {
            reasons.clear()
            reasons[version] = reason
        }

        override fun clear() = reasons.clear()
    }

    private val skips = FakeSkips()
    private var gateAnswer: String? = null
    private var maxApkBytes = Updater.MAX_APK_BYTES

    /** How many APK downloads the server has seen since this was last asked. */
    private fun apkRequests(): Int {
        var count = 0
        while (true) {
            val request = server.takeRequest(50, java.util.concurrent.TimeUnit.MILLISECONDS) ?: return count
            if (request.path.orEmpty().endsWith(".apk")) count++
        }
    }

    private fun updater(scope: TestScope, deferWhile: () -> String? = { null }) = Updater(
        checker = ReleaseChecker(
            repo = "drmuzikbpn/usage-deck",
            client = client,
            baseUrl = server.url("/").toString().trimEnd('/')
        ),
        installed = installed,
        installer = fakeInstaller,
        cacheDir = cacheDir,
        client = client,
        deferWhile = deferWhile,
        clock = clock,
        scope = scope,
        gate = { gateAnswer },
        skips = skips,
        maxApkBytes = maxApkBytes
    )

    @Test
    fun `a newer release is downloaded, verified and installed`() = runTest {
        serve("0.1.417+bbb2222")
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkNow()

        assertEquals(listOf(String(apkBytes)), fakeInstaller.installed)
        assertEquals(UpdaterState.Installing(Version(0, 1, 417, "bbb2222")), updater.state.value)
    }

    @Test
    fun `the same version leaves the updater idle and installs nothing`() = runTest {
        serve("0.1.400+aaa1111")
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkNow()

        assertEquals(UpdaterState.Idle, updater.state.value)
        assertTrue(fakeInstaller.installed.isEmpty())
    }

    @Test
    fun `an older release is ignored`() = runTest {
        serve("0.1.399+ccc3333")
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkNow()

        assertEquals(UpdaterState.Idle, updater.state.value)
        assertTrue(fakeInstaller.installed.isEmpty())
    }

    @Test
    fun `a checksum mismatch fails and deletes the apk`() = runTest {
        serve("0.1.417+bbb2222", sha = "0".repeat(64))
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkNow()

        val state = updater.state.value
        assertTrue("expected Failed but was $state", state is UpdaterState.Failed)
        assertTrue((state as UpdaterState.Failed).message.contains("Checksum mismatch"))
        assertTrue(fakeInstaller.installed.isEmpty())
        assertFalse(File(cacheDir, Updater.APK_NAME).exists())
    }

    @Test
    fun `an unreachable GitHub fails without installing`() = runTest {
        server.shutdown()
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkNow()

        assertEquals(UpdaterState.Failed("Could not reach GitHub."), updater.state.value)
        assertTrue(fakeInstaller.installed.isEmpty())
    }

    @Test
    fun `a failed apk download fails without installing`() = runTest {
        serve("0.1.417+bbb2222", apkStatus = 500)
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkNow()

        val state = updater.state.value
        assertTrue("expected Failed but was $state", state is UpdaterState.Failed)
        assertTrue(fakeInstaller.installed.isEmpty())
    }

    @Test
    fun `an armed escalation defers the install until it clears`() = runTest {
        serve("0.1.417+bbb2222")
        var reason: String? = "escalation_pending"
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val updater = updater(scope) { reason }

        updater.checkNow()

        assertEquals(
            UpdaterState.Deferred(Version(0, 1, 417, "bbb2222"), "escalation_pending"),
            updater.state.value
        )
        assertTrue(fakeInstaller.installed.isEmpty())
        // The verified APK is kept, so clearing the deferral installs without downloading again.
        assertTrue(File(cacheDir, Updater.APK_NAME).exists())

        updater.start()
        reason = null
        advanceTimeBy(Updater.DEFER_RETRY_MS + 1_000)
        runCurrent()

        assertEquals(listOf(String(apkBytes)), fakeInstaller.installed)
        updater.stop()
    }

    @Test
    fun `a mid-gesture hold defers with its own reason`() = runTest {
        serve("0.1.417+bbb2222")
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler))) { "gesture" }

        updater.checkNow()

        assertEquals(
            UpdaterState.Deferred(Version(0, 1, 417, "bbb2222"), "gesture"),
            updater.state.value
        )
    }

    @Test
    fun `an install failure is reported and does not loop on the same file`() = runTest {
        serve("0.1.417+bbb2222")
        fakeInstaller.result = Result.failure(IllegalStateException("no device owner"))
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkNow()

        val state = updater.state.value
        assertTrue("expected Failed but was $state", state is UpdaterState.Failed)
        assertTrue((state as UpdaterState.Failed).message.contains("no device owner"))
    }

    @Test
    fun `an apk the package gate refuses is deleted, never installed, and its version skipped`() = runTest {
        serve("0.1.417+bbb2222")
        gateAnswer = "it is signed by a different key"
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkNow()

        assertTrue(fakeInstaller.installed.isEmpty())
        assertTrue(File(cacheDir, Updater.APK_NAME).exists().not())
        assertEquals("it is signed by a different key", skips.reasons["0.1.417+bbb2222"])
        assertTrue((updater.state.value as UpdaterState.Failed).message.contains("different key"))
    }

    @Test
    fun `a skipped version is not downloaded again by the periodic check`() = runTest {
        serve("0.1.417+bbb2222", sha = "0".repeat(64))
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))
        updater.checkNow()
        assertEquals(1, apkRequests())

        updater.checkPeriodically()
        updater.checkPeriodically()

        assertEquals(0, apkRequests())
        val state = updater.state.value
        assertTrue("was $state", state is UpdaterState.Skipped)
        assertEquals("checksum mismatch", (state as UpdaterState.Skipped).reason)
    }

    @Test
    fun `a newer release than the skipped one is tried`() = runTest {
        serve("0.1.417+bbb2222", sha = "0".repeat(64))
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))
        updater.checkPeriodically()

        serve("0.1.418+ccc3333")
        updater.checkPeriodically()

        assertEquals(listOf("0.1.418+ccc3333"), fakeInstaller.versions)
    }

    @Test
    fun `check now from settings forgets the skip and tries again`() = runTest {
        serve("0.1.417+bbb2222", sha = "0".repeat(64))
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))
        updater.checkPeriodically()

        serve("0.1.417+bbb2222")
        updater.checkNow()

        assertEquals(listOf("0.1.417+bbb2222"), fakeInstaller.versions)
        assertTrue(skips.reasons.isEmpty())
    }

    @Test
    fun `an install that fails is remembered, so it is not downloaded every ten minutes`() = runTest {
        serve("0.1.417+bbb2222")
        fakeInstaller.result = Result.failure(IllegalStateException("no device owner"))
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkPeriodically()
        updater.checkPeriodically()

        assertEquals(1, fakeInstaller.installed.size)
        assertTrue(skips.reasons.getValue("0.1.417+bbb2222").contains("no device owner"))
    }

    @Test
    fun `a download that fails on the network is not a reason to skip the version`() = runTest {
        serve("0.1.417+bbb2222", apkStatus = 503)
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkPeriodically()

        assertTrue(skips.reasons.isEmpty())
    }

    @Test
    fun `an apk larger than the cap is abandoned and skipped`() = runTest {
        serve("0.1.417+bbb2222")
        maxApkBytes = (apkBytes.size - 1).toLong()
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkPeriodically()

        assertTrue(fakeInstaller.installed.isEmpty())
        assertTrue(File(cacheDir, Updater.APK_NAME).exists().not())
        assertTrue(skips.reasons.getValue("0.1.417+bbb2222").contains("larger than"))
    }

    @Test
    fun `the checksum is fetched before the apk, so a release without one costs no download`() = runTest {
        serve("0.1.417+bbb2222")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path.orEmpty().contains("/releases?") -> MockResponse().setBody(releaseJson("0.1.417+bbb2222"))
                else -> MockResponse().setResponseCode(404)
            }
        }
        val updater = updater(TestScope(StandardTestDispatcher(testScheduler)))

        updater.checkPeriodically()

        assertEquals(0, apkRequests())
        assertTrue(skips.reasons.isEmpty())
    }

    @Test
    fun `the label describes the state for the settings screen`() = runTest {
        serve("0.1.417+bbb2222")
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val updater = updater(scope) { "gesture" }

        updater.checkNow()
        runCurrent()

        assertTrue(updater.label.value.contains("waiting (gesture)"))
    }
}
