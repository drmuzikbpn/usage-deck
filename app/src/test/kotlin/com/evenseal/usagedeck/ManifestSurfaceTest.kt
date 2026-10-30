// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The merged manifest — the app's own plus whatever its libraries contribute. A dependency bump
 * that adds an exported component or a permission fails here instead of shipping unnoticed.
 */
@RunWith(RobolectricTestRunner::class)
class ManifestSurfaceTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Suppress("DEPRECATION")
    private val info = context.packageManager.getPackageInfo(
        context.packageName,
        PackageManager.GET_ACTIVITIES or PackageManager.GET_RECEIVERS or PackageManager.GET_SERVICES or
            PackageManager.GET_PROVIDERS or PackageManager.GET_PERMISSIONS
    )

    @Test
    fun `only the launcher, and on the kiosk the device admin receiver, are exported`() {
        val exported = mutableListOf<String>()
        info.activities?.forEach { if (it.exported) exported += it.name }
        info.receivers?.forEach { if (it.exported) exported += it.name }
        info.services?.forEach { if (it.exported) exported += it.name }
        info.providers?.forEach { if (it.exported) exported += it.name }

        assertEquals(
            setOf("com.evenseal.usagedeck.MainActivity") +
                if (BuildConfig.KIOSK) setOf("com.evenseal.usagedeck.kiosk.DeviceAdminReceiver") else emptySet(),
            exported.filterNot { it.startsWith("androidx.activity.ComponentActivity") }.toSet()
        )
    }

    @Test
    fun `the device admin receiver can only be invoked by the system`() {
        assumeTrue(BuildConfig.KIOSK)
        val admin = info.receivers.orEmpty().single { it.name.endsWith("DeviceAdminReceiver") }
        assertEquals("android.permission.BIND_DEVICE_ADMIN", admin.permission)
    }

    @Test
    fun `the phone app is never a launcher or a device admin`() {
        assumeFalse(BuildConfig.KIOSK)
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setPackage(context.packageName)
        assertEquals(emptyList<Any>(), context.packageManager.queryIntentActivities(home, 0))
        assertEquals(emptyList<String>(), info.receivers.orEmpty().map { it.name }.filter { "usagedeck.kiosk" in it })
    }

    @Test
    fun `no library activity rides along`() {
        val foreign = info.activities.orEmpty().map { it.name }
            .filterNot { it.startsWith("com.evenseal.usagedeck.") || it.startsWith("androidx.") }
        assertEquals(emptyList<String>(), foreign)
    }

    @Test
    fun `the app asks for exactly the permissions it uses`() {
        val requested = info.requestedPermissions.orEmpty().toSet()
        val own = requested.filter { it.startsWith("android.permission.") }.toSet()

        assertEquals(
            setOf(
                "android.permission.INTERNET",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.CAMERA",
                "android.permission.FOREGROUND_SERVICE",
                "android.permission.VIBRATE"
            ) + if (BuildConfig.KIOSK) {
                setOf(
                    "android.permission.ACCESS_WIFI_STATE",
                    "android.permission.CHANGE_WIFI_STATE",
                    // Android 10 returns an empty wifi scan list without it.
                    "android.permission.ACCESS_FINE_LOCATION",
                    "android.permission.REQUEST_INSTALL_PACKAGES",
                    "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"
                )
            } else {
                setOf(
                    "android.permission.POST_NOTIFICATIONS",
                    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE"
                )
            },
            own
        )
        // Anything else must be the app's own signature-level permission, never a system one.
        assertTrue((requested - own).all { it.startsWith(context.packageName) })
    }
}
