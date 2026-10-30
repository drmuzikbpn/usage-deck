// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

/**
 * Receives the outcome of a [PackageInstaller] commit.
 *
 * A successful install replaces this very process, so the only outcome worth handling here is a
 * failure: it is logged and the version is remembered in [PrefsUpdateSkips], so the next
 * ten-minute check does not download and attempt the very same APK again. The deck keeps running
 * the build it has, which is why a broken release cannot brick it.
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val version = intent.getStringExtra(EXTRA_VERSION)
        val failure = when (status) {
            PackageInstaller.STATUS_SUCCESS -> null
            // Nobody is at a docked kiosk to answer a prompt, so this is a failure too.
            PackageInstaller.STATUS_PENDING_USER_ACTION -> "the install needs a prompt (not Device Owner?)"
            else -> "install failed ($status): ${message.orEmpty().filterNot(Char::isISOControl)}"
        }
        if (failure == null) {
            Log.i(TAG, "update installed")
            return
        }
        Log.w(TAG, failure)
        if (version != null) PrefsUpdateSkips.open(context).skip(version, failure)
    }

    companion object {
        const val ACTION = "com.evenseal.usagedeck.INSTALL_RESULT"

        const val EXTRA_VERSION = "com.evenseal.usagedeck.extra.VERSION"

        /** Mutable because the installer adds its status extras; explicit, so only this receiver gets it. */
        fun pendingIntent(context: Context, sessionId: Int, version: String): PendingIntent =
            PendingIntent.getBroadcast(
                context,
                sessionId,
                Intent(context, InstallResultReceiver::class.java).setAction(ACTION).putExtra(EXTRA_VERSION, version),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )

        private const val TAG = "UsageDeckUpdate"
    }
}
