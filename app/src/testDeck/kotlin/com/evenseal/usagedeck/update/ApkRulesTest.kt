// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ApkRulesTest {
    private val debugKey = "d".repeat(64)
    private val releaseKey = "e".repeat(64)
    private val strangerKey = "f".repeat(64)

    /** The provisioned phone: installed with the debug key, since updated to the rotated release key. */
    private val installed = ApkFacts(
        packageName = "com.evenseal.usagedeck",
        versionCode = 400,
        signers = setOf(releaseKey),
        lineage = setOf(debugKey, releaseKey)
    )
    private val update = installed.copy(versionCode = 401)

    @Test
    fun `a newer build of this app signed by the same key is accepted`() {
        assertNull(ApkRules.refuse(update, installed))
    }

    @Test
    fun `a build rotated from the installed key is accepted through its lineage`() {
        val stillDebug = installed.copy(signers = setOf(debugKey), lineage = setOf(debugKey))
        assertNull(ApkRules.refuse(update, stillDebug))
    }

    @Test
    fun `another package is refused whatever its signature`() {
        val reason = ApkRules.refuse(update.copy(packageName = "com.example.other"), installed)
        assertTrue(reason!!.contains("com.example.other"))
    }

    @Test
    fun `the same or an older version code is refused`() {
        assertNotNull(ApkRules.refuse(update.copy(versionCode = 400), installed))
        assertNotNull(ApkRules.refuse(update.copy(versionCode = 12), installed))
    }

    @Test
    fun `a stranger's signature is refused`() {
        val forged = update.copy(signers = setOf(strangerKey), lineage = setOf(strangerKey))
        assertTrue(ApkRules.refuse(forged, installed)!!.contains("signed"))
    }

    @Test
    fun `an apk with no readable signature is refused`() {
        assertNotNull(ApkRules.refuse(update.copy(signers = emptySet(), lineage = emptySet()), installed))
    }

    @Test
    fun `a file the package manager cannot parse is refused`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val junk = java.io.File(context.cacheDir, "junk.apk").apply { writeText("not an apk") }
        assertNotNull(PackageApkGate(context).refuse(junk))
    }

    // ---- remembering a version that failed ---------------------------------------------------

    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun `a skip survives a new instance and names only the version it was given`() {
        PrefsUpdateSkips.open(context).skip("0.1.417+bbb2222", "checksum mismatch")

        val reopened = PrefsUpdateSkips.open(context)
        assertEquals("checksum mismatch", reopened.reasonFor("0.1.417+bbb2222"))
        assertNull(reopened.reasonFor("0.1.418+ccc3333"))

        reopened.clear()
        assertNull(PrefsUpdateSkips.open(context).reasonFor("0.1.417+bbb2222"))
    }

    private fun result(status: Int, version: String? = "0.1.417+bbb2222") =
        Intent(context, InstallResultReceiver::class.java)
            .setAction(InstallResultReceiver.ACTION)
            .putExtra(PackageInstaller.EXTRA_STATUS, status)
            .putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, "INSTALL_FAILED_UPDATE_INCOMPATIBLE")
            .apply { version?.let { putExtra(InstallResultReceiver.EXTRA_VERSION, it) } }

    @Test
    fun `the installer reporting a failure skips that version`() {
        PrefsUpdateSkips.open(context).clear()

        InstallResultReceiver().onReceive(context, result(PackageInstaller.STATUS_FAILURE_INCOMPATIBLE))

        val reason = PrefsUpdateSkips.open(context).reasonFor("0.1.417+bbb2222")
        assertTrue(reason!!.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE"))
    }

    @Test
    fun `an install that would need a prompt is skipped too, and a success is not`() {
        PrefsUpdateSkips.open(context).clear()
        InstallResultReceiver().onReceive(context, result(PackageInstaller.STATUS_SUCCESS))
        assertNull(PrefsUpdateSkips.open(context).reasonFor("0.1.417+bbb2222"))

        InstallResultReceiver().onReceive(context, result(PackageInstaller.STATUS_PENDING_USER_ACTION))
        assertNotNull(PrefsUpdateSkips.open(context).reasonFor("0.1.417+bbb2222"))
    }
}
