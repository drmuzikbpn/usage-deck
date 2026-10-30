// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck

import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.evenseal.usagedeck.update.ApkRules
import com.evenseal.usagedeck.update.PackageApkGate
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The update gate against a real package manager: it must be able to read the package, version
 * and signing certificate out of an APK file on this Android version, or it would refuse every
 * update. The only real APK to hand is the app's own.
 */
@RunWith(AndroidJUnit4::class)
class ApkGateOnDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Suppress("DEPRECATION")
    private val flags = PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES

    private val ownApk = File(context.packageCodePath)

    @Test
    fun readsPackageVersionAndSignerFromAnApkFile() {
        val archive = PackageApkGate.factsOf(context.packageManager.getPackageArchiveInfo(ownApk.path, flags)!!)
        val installed = PackageApkGate.factsOf(context.packageManager.getPackageInfo(context.packageName, flags))

        assertEquals(context.packageName, archive.packageName)
        assertEquals(installed.versionCode, archive.versionCode)
        assertTrue("no signer read from the archive", archive.signers.isNotEmpty())
        assertEquals(installed.signers, archive.signers)
    }

    @Test
    fun theSameBuildIsRefusedOnlyForNotBeingNewer() {
        val reason = PackageApkGate(context).refuse(ownApk)
        assertTrue("was: $reason", reason!!.contains("is not newer"))

        // With the version out of the way the same file passes: package and signer both match.
        val installed = PackageApkGate.factsOf(context.packageManager.getPackageInfo(context.packageName, flags))
        val archive = PackageApkGate.factsOf(context.packageManager.getPackageArchiveInfo(ownApk.path, flags)!!)
        assertNull(ApkRules.refuse(archive.copy(versionCode = installed.versionCode + 1), installed))
    }
}
