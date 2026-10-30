// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.settings

import android.content.SharedPreferences
import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.core.alerts.AlertThresholds
import com.evenseal.usagedeck.core.model.UserView
import com.evenseal.usagedeck.core.pause.PauseSettings
import java.time.LocalTime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/** Everything the Settings screen owns (spec §11.5). */
data class Settings(
    val warn: Int = 80,
    val critical: Int = 95,
    /** null turns soft→hard escalation off entirely. */
    val escalationSeconds: Int? = 90,
    val quietStart: LocalTime = LocalTime.of(23, 0),
    val quietEnd: LocalTime = LocalTime.of(7, 0),
    val nightDim: Float = 0.35f,
    val pinSet: Boolean = false,
    /** Dim to [nightDim] during quiet hours. Off keeps full brightness around the clock. */
    val autoDim: Boolean = BuildConfig.KIOSK,
    /** Hold the screen on even off the charger. Only a desk display wants that by default. */
    val keepScreenOn: Boolean = BuildConfig.KIOSK,
    /** Phone only: keep streaming with the app closed, behind an ongoing notification. */
    val keepWatching: Boolean = false,
    /** `18:21` versus `6:21 PM` in the status bar. */
    val clock24h: Boolean = true,
    /** Play the chime when an alert shows (quiet hours still silence it). */
    val sound: Boolean = true,
    /** Names the deck's owner chose for people, keyed by [UserView.key]. Blank entries are dropped. */
    val userNames: Map<String, String> = emptyMap()
) {
    /** The name to draw for [user]: the deck's own rename first, the daemon's display name otherwise. */
    fun nameFor(user: UserView): String = renameFor(user) ?: user.displayName

    /**
     * The rename stored for [user], if any. A name given before the daemon started reporting the
     * organisation lives under the bare account key, so that key is tried second rather than lost.
     */
    fun renameFor(user: UserView): String? =
        (userNames[user.key] ?: userNames[user.key.substringBefore('/')])?.takeIf { it.isNotBlank() }

    /** Sets or, with a blank [name], clears the rename for [key]. */
    fun renamed(key: String, name: String): Settings {
        val trimmed = name.trim()
        return copy(userNames = if (trimmed.isEmpty()) userNames - key else userNames + (key to trimmed))
    }
}

/**
 * Clamps the Settings screen's controls to ranges that cannot produce nonsense: critical always
 * sits at least one point above warn, and escalation is either off or inside 30..600 s (spec §9).
 */
internal fun Settings.normalised(): Settings {
    val clampedWarn = warn.coerceIn(WARN_MIN, WARN_MAX)
    return copy(
        warn = clampedWarn,
        critical = critical.coerceIn(clampedWarn + 1, CRITICAL_MAX),
        escalationSeconds = escalationSeconds?.coerceIn(ESCALATION_MIN, ESCALATION_MAX),
        nightDim = nightDim.coerceIn(DIM_MIN, 1f),
        userNames = userNames.mapValues { it.value.trim() }.filterValues { it.isNotEmpty() }
    )
}

const val WARN_MIN = 50
const val WARN_MAX = 94
const val CRITICAL_MAX = 99
const val ESCALATION_MIN = 30
const val ESCALATION_MAX = 600
const val DIM_MIN = 0.1f

/** The escalation timeouts the Settings screen offers; null is "off". */
val ESCALATION_CHOICES: List<Int?> = listOf(null, 30, 60, 90, 120, 300, 600)

/**
 * Settings persisted in plain prefs — none of this is a credential, and the kiosk needs them
 * before the keystore is warm.
 */
class SettingsStore(private val prefs: SharedPreferences) {
    private val _settings = MutableStateFlow(load())
    val settings: StateFlow<Settings> = _settings.asStateFlow()

    /** The slice `AlertEvaluator` wants. */
    val thresholds: StateFlow<AlertThresholds> = derive { AlertThresholds(it.warn, it.critical) }

    /** The slice `PauseController` wants. */
    val pauseSettings: StateFlow<PauseSettings> = derive { PauseSettings(it.escalationSeconds) }

    fun update(f: (Settings) -> Settings) {
        val next = f(_settings.value).normalised()
        prefs.edit()
            .putInt(KEY_WARN, next.warn)
            .putInt(KEY_CRITICAL, next.critical)
            .putInt(KEY_ESCALATION, next.escalationSeconds ?: ESCALATION_OFF)
            .putString(KEY_QUIET_START, next.quietStart.toString())
            .putString(KEY_QUIET_END, next.quietEnd.toString())
            .putFloat(KEY_NIGHT_DIM, next.nightDim)
            .putBoolean(KEY_PIN_SET, next.pinSet)
            .putBoolean(KEY_AUTO_DIM, next.autoDim)
            .putBoolean(KEY_KEEP_SCREEN_ON, next.keepScreenOn)
            .putBoolean(KEY_KEEP_WATCHING, next.keepWatching)
            .putBoolean(KEY_CLOCK_24H, next.clock24h)
            .putBoolean(KEY_SOUND, next.sound)
            .putString(KEY_USER_NAMES, json.encodeToString(NAMES, next.userNames))
            .apply()
        _settings.value = next
    }

    /**
     * Quiet hours wrap midnight by default (23:00–07:00): the window is `[start, end)` when it
     * does not wrap, and `[start, 24:00) ∪ [00:00, end)` when it does. start == end means off.
     */
    fun isQuiet(now: LocalTime): Boolean {
        val s = _settings.value
        val start = s.quietStart
        val end = s.quietEnd
        return when {
            start == end -> false
            start.isBefore(end) -> !now.isBefore(start) && now.isBefore(end)
            else -> !now.isBefore(start) || now.isBefore(end)
        }
    }

    private fun <T> derive(f: (Settings) -> T): StateFlow<T> = _settings.map(f).stateIn(
        CoroutineScope(Dispatchers.Unconfined),
        SharingStarted.Eagerly,
        f(_settings.value)
    )

    private fun load(): Settings {
        val defaults = Settings()
        if (!prefs.contains(KEY_WARN)) return defaults
        val escalation = prefs.getInt(KEY_ESCALATION, defaults.escalationSeconds ?: ESCALATION_OFF)
        return Settings(
            warn = prefs.getInt(KEY_WARN, defaults.warn),
            critical = prefs.getInt(KEY_CRITICAL, defaults.critical),
            escalationSeconds = escalation.takeIf { it != ESCALATION_OFF },
            quietStart = prefs.timeOf(KEY_QUIET_START, defaults.quietStart),
            quietEnd = prefs.timeOf(KEY_QUIET_END, defaults.quietEnd),
            nightDim = prefs.getFloat(KEY_NIGHT_DIM, defaults.nightDim),
            pinSet = prefs.getBoolean(KEY_PIN_SET, defaults.pinSet),
            autoDim = prefs.getBoolean(KEY_AUTO_DIM, defaults.autoDim),
            keepScreenOn = prefs.getBoolean(KEY_KEEP_SCREEN_ON, defaults.keepScreenOn),
            keepWatching = prefs.getBoolean(KEY_KEEP_WATCHING, defaults.keepWatching),
            clock24h = prefs.getBoolean(KEY_CLOCK_24H, defaults.clock24h),
            sound = prefs.getBoolean(KEY_SOUND, defaults.sound),
            userNames = prefs.names()
        )
    }

    private fun SharedPreferences.names(): Map<String, String> {
        val raw = getString(KEY_USER_NAMES, null) ?: return emptyMap()
        return runCatching { json.decodeFromString(NAMES, raw) }.getOrDefault(emptyMap())
    }

    private fun SharedPreferences.timeOf(key: String, fallback: LocalTime): LocalTime {
        val raw = getString(key, null) ?: return fallback
        return runCatching { LocalTime.parse(raw) }.getOrDefault(fallback)
    }

    private companion object {
        const val ESCALATION_OFF = -1
        val json = Json { ignoreUnknownKeys = true }
        val NAMES = MapSerializer(String.serializer(), String.serializer())

        const val KEY_WARN = "warn"
        const val KEY_AUTO_DIM = "auto_dim"
        const val KEY_KEEP_SCREEN_ON = "keep_screen_on"
        const val KEY_KEEP_WATCHING = "keep_watching"
        const val KEY_CLOCK_24H = "clock_24h"
        const val KEY_SOUND = "sound"
        const val KEY_USER_NAMES = "user_names"
        const val KEY_CRITICAL = "critical"
        const val KEY_ESCALATION = "escalation_seconds"
        const val KEY_QUIET_START = "quiet_start"
        const val KEY_QUIET_END = "quiet_end"
        const val KEY_NIGHT_DIM = "night_dim"
        const val KEY_PIN_SET = "pin_set"
    }
}
