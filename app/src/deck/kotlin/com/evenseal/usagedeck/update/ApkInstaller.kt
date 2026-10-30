// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.update

import android.content.Context
import android.content.pm.PackageInstaller
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Installs an APK over the running app through [PackageInstaller].
 *
 * As Device Owner the commit is silent — no user prompt, which is the whole point on a phone
 * sitting in a dock with nobody near it. The class is open so tests can substitute a recording
 * installer without touching the real package manager.
 */
open class ApkInstaller(private val context: Context) {
    /** [version] travels with the result, so a failure reported later can be pinned on it. */
    open suspend fun install(apk: File, version: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite(APK_ENTRY, 0, apk.length()).use { output ->
                    apk.inputStream().use { input -> input.copyTo(output) }
                    session.fsync(output)
                }
                session.commit(InstallResultReceiver.pendingIntent(context, sessionId, version).intentSender)
            }
        }
    }

    private companion object {
        const val APK_ENTRY = "usage-deck.apk"
    }
}
