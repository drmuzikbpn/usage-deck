// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.kiosk

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class KioskManagerTest {
    private lateinit var context: Context
    private lateinit var dpm: DevicePolicyManager
    private lateinit var admin: ComponentName
    private lateinit var kiosk: KioskManager

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        admin = ComponentName(context, DeviceAdminReceiver::class.java)
        kiosk = KioskManager(context)
    }

    private fun becomeDeviceOwner() {
        shadowOf(dpm).setDeviceOwner(admin)
    }

    @Test
    fun `is not device owner by default`() {
        assertFalse(kiosk.isDeviceOwner)
    }

    @Test
    fun `applyPolicies does nothing and does not throw when not device owner`() {
        kiosk.applyPolicies()
        assertFalse(dpm.isLockTaskPermitted(context.packageName))
    }

    @Test
    fun `applyPolicies whitelists this app and tailscale for lock task when device owner`() {
        becomeDeviceOwner()
        assertTrue(kiosk.isDeviceOwner)

        kiosk.applyPolicies()

        assertEquals(
            listOf(context.packageName, KioskManager.TAILSCALE_PACKAGE),
            dpm.getLockTaskPackages(admin).toList()
        )
        assertTrue(dpm.isLockTaskPermitted(context.packageName))
        assertTrue(dpm.isLockTaskPermitted(KioskManager.TAILSCALE_PACKAGE))
    }

    @Test
    fun `applyPolicies clears every lock task feature and is idempotent when device owner`() {
        becomeDeviceOwner()
        kiosk.applyPolicies()
        kiosk.applyPolicies()
        assertEquals(
            DevicePolicyManager.LOCK_TASK_FEATURE_NONE,
            dpm.getLockTaskFeatures(admin)
        )
        assertEquals(1, dpm.getLockTaskPackages(admin).count { it == context.packageName })
    }

    @Test
    fun `applyPolicies grants location and camera so the wifi scan is not empty`() {
        assumeTrue(BuildConfig.KIOSK) // Only the kiosk declares the location permission.
        becomeDeviceOwner()
        kiosk.applyPolicies()

        KioskManager.RUNTIME_PERMISSIONS.forEach { permission ->
            assertEquals(
                "$permission should be granted outright",
                DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                dpm.getPermissionGrantState(admin, context.packageName, permission)
            )
        }
    }

    @Test
    fun `permission grants are skipped entirely when not device owner`() {
        kiosk.applyPolicies()

        // Reading the grant state is itself an owner-only call, so ask only after provisioning:
        // anything granted by the earlier no-op run would show up here.
        becomeDeviceOwner()
        KioskManager.RUNTIME_PERMISSIONS.forEach { permission ->
            assertEquals(
                DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT,
                dpm.getPermissionGrantState(admin, context.packageName, permission)
            )
        }
    }

    @Test
    fun `dozeExempt is false before the exemption is granted`() {
        assertFalse(kiosk.dozeExempt)
    }
}
