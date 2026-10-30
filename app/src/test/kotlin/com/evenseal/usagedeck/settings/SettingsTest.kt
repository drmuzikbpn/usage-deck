// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.settings

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.UserView
import java.time.LocalTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SettingsTest {
    private lateinit var prefs: SharedPreferences
    private lateinit var store: SettingsStore

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        prefs = context.getSharedPreferences("settings_test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        store = SettingsStore(prefs)
    }

    @Test
    fun `defaults match the spec`() {
        val s = store.settings.value
        assertEquals(80, s.warn)
        assertEquals(95, s.critical)
        assertEquals(90, s.escalationSeconds)
        assertEquals(LocalTime.of(23, 0), s.quietStart)
        assertEquals(LocalTime.of(7, 0), s.quietEnd)
        assertEquals(0.35f, s.nightDim, 0.0001f)
        assertFalse(s.pinSet)
    }

    @Test
    fun `update persists and survives a reopen`() {
        store.update { it.copy(warn = 70, critical = 90, escalationSeconds = 300, nightDim = 0.5f) }

        assertEquals(70, store.settings.value.warn)
        val reopened = SettingsStore(prefs)
        assertEquals(70, reopened.settings.value.warn)
        assertEquals(90, reopened.settings.value.critical)
        assertEquals(300, reopened.settings.value.escalationSeconds)
        assertEquals(0.5f, reopened.settings.value.nightDim, 0.0001f)
    }

    @Test
    fun `escalation off round-trips as null`() {
        store.update { it.copy(escalationSeconds = null) }
        assertNull(store.settings.value.escalationSeconds)
        assertNull(SettingsStore(prefs).settings.value.escalationSeconds)
    }

    @Test
    fun `quiet hours wrap across midnight`() {
        assertTrue(store.isQuiet(LocalTime.of(23, 30)))
        assertTrue(store.isQuiet(LocalTime.of(23, 0)))
        assertTrue(store.isQuiet(LocalTime.of(0, 1)))
        assertTrue(store.isQuiet(LocalTime.of(6, 59)))
        assertFalse(store.isQuiet(LocalTime.of(7, 0)))
        assertFalse(store.isQuiet(LocalTime.of(12, 0)))
        assertFalse(store.isQuiet(LocalTime.of(22, 59)))
    }

    @Test
    fun `quiet hours inside one day do not wrap`() {
        store.update { it.copy(quietStart = LocalTime.of(1, 0), quietEnd = LocalTime.of(5, 0)) }
        assertFalse(store.isQuiet(LocalTime.of(0, 30)))
        assertTrue(store.isQuiet(LocalTime.of(1, 0)))
        assertTrue(store.isQuiet(LocalTime.of(4, 59)))
        assertFalse(store.isQuiet(LocalTime.of(5, 0)))
        assertFalse(store.isQuiet(LocalTime.of(23, 0)))
    }

    @Test
    fun `quiet hours are off when start equals end`() {
        store.update { it.copy(quietStart = LocalTime.of(7, 0), quietEnd = LocalTime.of(7, 0)) }
        assertFalse(store.isQuiet(LocalTime.of(7, 0)))
        assertFalse(store.isQuiet(LocalTime.of(2, 0)))
    }

    @Test
    fun `critical is always kept above warn`() {
        store.update { it.copy(warn = 80, critical = 50) }
        assertEquals(81, store.settings.value.critical)

        store.update { it.copy(warn = 90) }
        assertTrue(store.settings.value.critical > store.settings.value.warn)
    }

    @Test
    fun `warn is clamped to the slider range`() {
        store.update { it.copy(warn = 10) }
        assertEquals(50, store.settings.value.warn)

        store.update { it.copy(warn = 99) }
        assertEquals(94, store.settings.value.warn)
    }

    @Test
    fun `escalation seconds are clamped to the supported window`() {
        store.update { it.copy(escalationSeconds = 5) }
        assertEquals(30, store.settings.value.escalationSeconds)

        store.update { it.copy(escalationSeconds = 9_000) }
        assertEquals(600, store.settings.value.escalationSeconds)
    }

    @Test
    fun `thresholds feed the core alert evaluator`() {
        store.update { it.copy(warn = 60, critical = 85) }
        assertEquals(60, store.thresholds.value.warn)
        assertEquals(85, store.thresholds.value.critical)
    }

    @Test
    fun `escalation seconds feed the core pause settings`() {
        store.update { it.copy(escalationSeconds = 120) }
        assertEquals(120, store.pauseSettings.value.escalationSeconds)
    }

    @Test
    fun `display defaults follow the build, sound defaults on, and all round-trip off`() {
        val store = SettingsStore(prefs)
        val d = store.settings.value
        assertEquals(BuildConfig.KIOSK, d.autoDim && d.keepScreenOn)
        assertTrue(d.clock24h && d.sound)
        store.update { it.copy(autoDim = false, keepScreenOn = false, clock24h = false, sound = false) }
        val again = SettingsStore(prefs).settings.value
        assertFalse(again.autoDim)
        assertFalse(again.keepScreenOn)
        assertFalse(again.clock24h)
        assertFalse(again.sound)
    }

    @Test
    fun `user renames round-trip and a blank name clears the entry`() {
        store.update { it.renamed("uuid-1", "  Studio  ") }
        assertEquals(mapOf("uuid-1" to "Studio"), SettingsStore(prefs).settings.value.userNames)
        store.update { it.renamed("uuid-1", " ") }
        assertTrue(SettingsStore(prefs).settings.value.userNames.isEmpty())
    }

    @Test
    fun `nameFor prefers the rename and falls back to the daemon's display name`() {
        val user = UserView("uuid-1", "adam", "adam@example.com", null, listOf("m1"), emptyList(), null, Health.FRESH)
        assertEquals("adam", Settings().nameFor(user))
        assertEquals("Testing", Settings().renamed("uuid-1", "Testing").nameFor(user))
        assertEquals("adam", Settings(userNames = mapOf("uuid-1" to "   ")).nameFor(user))
    }

    @Test
    fun `a rename made before the daemon reported the organisation still applies`() {
        val user =
            UserView(
                "uuid-1/org-a",
                "adam",
                "adam@example.com",
                "Even Seal",
                listOf("m1"),
                emptyList(),
                null,
                Health.FRESH
            )
        val old = Settings().renamed("uuid-1", "Studio")
        assertEquals("Studio", old.nameFor(user))
        assertEquals("Studio", old.renameFor(user))
        // A rename under the full key wins over the old one.
        assertEquals("Team seat", old.renamed("uuid-1/org-a", "Team seat").nameFor(user))
        assertNull(Settings().renameFor(user))
    }
}
