// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.update

import android.content.Context
import android.content.SharedPreferences

/**
 * The one release that failed to verify or install. Without this the updater would download the
 * same broken APK again every ten minutes for as long as it stayed the newest release. A newer
 * release is tried as usual, and "Check now" in Settings forgets the skip.
 */
interface UpdateSkips {
    /** Why [version] is being skipped, or null when it is not. */
    fun reasonFor(version: String): String?

    fun skip(version: String, reason: String)

    fun clear()
}

class PrefsUpdateSkips(private val prefs: SharedPreferences) : UpdateSkips {
    override fun reasonFor(version: String): String? =
        prefs.getString(KEY_REASON, null)?.takeIf { prefs.getString(KEY_VERSION, null) == version }

    override fun skip(version: String, reason: String) {
        prefs.edit().putString(KEY_VERSION, version).putString(KEY_REASON, reason.take(MAX_REASON)).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_VERSION).remove(KEY_REASON).apply()
    }

    companion object {
        private const val PREFS = "update_skips"
        private const val KEY_VERSION = "version"
        private const val KEY_REASON = "reason"
        private const val MAX_REASON = 200

        fun open(context: Context): PrefsUpdateSkips =
            PrefsUpdateSkips(context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
