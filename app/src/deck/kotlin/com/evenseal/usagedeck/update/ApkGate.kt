// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import java.io.File
import java.security.MessageDigest

/** Decides whether a downloaded APK may be handed to the installer. Null means yes; otherwise why not. */
fun interface ApkGate {
    fun refuse(apk: File): String?
}

/**
 * What matters about an APK. [signers] are the SHA-256 digests of the certificates that sign it
 * now; [lineage] adds every earlier certificate its signing history proves (a v3 rotation).
 */
data class ApkFacts(
    val packageName: String,
    val versionCode: Long,
    val signers: Set<String>,
    val lineage: Set<String>
)

/**
 * The checks made before an update reaches `PackageInstaller`. The installer would refuse a
 * wrong package or signer itself, but only after the deck has committed to the install; and it
 * would happily take an older build. Doing it here means a release that is not ours, not newer,
 * or not signed by the key this phone already trusts is deleted without ever being offered.
 */
object ApkRules {
    fun refuse(candidate: ApkFacts, installed: ApkFacts): String? = when {
        candidate.packageName != installed.packageName ->
            "it is package ${candidate.packageName}, not ${installed.packageName}"
        candidate.versionCode <= installed.versionCode ->
            "its version code ${candidate.versionCode} is not newer than the installed ${installed.versionCode}"
        candidate.signers.isEmpty() -> "it carries no readable signature"
        // Same signer, or one side's history vouches for the other's current key.
        candidate.signers.none { it in installed.lineage } && installed.signers.none { it in candidate.lineage } ->
            "it is not signed by this app's key"
        else -> null
    }
}

/** [ApkRules] fed from the package manager: the archive on disk against the app that is running. */
class PackageApkGate(private val context: Context) : ApkGate {
    override fun refuse(apk: File): String? {
        val pm = context.packageManager
        val archive = runCatching { pm.getPackageArchiveInfo(apk.path, FLAGS) }.getOrNull()
            ?: return "it is not a readable APK"
        val installed = runCatching { pm.getPackageInfo(context.packageName, FLAGS) }.getOrNull()
            ?: return "the installed app could not be inspected"
        return ApkRules.refuse(factsOf(archive), factsOf(installed))
    }

    companion object {
        /**
         * Both flags on purpose: some Android versions only collect an archive's certificates
         * when the older `GET_SIGNATURES` is asked for, and leave `signingInfo` null otherwise.
         */
        @Suppress("DEPRECATION")
        private const val FLAGS = PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES

        fun factsOf(info: PackageInfo): ApkFacts {
            val signing = info.signingInfo
            val current = signing?.apkContentsSigners.orEmpty().map(::digest).toSet()
            val history = signing?.signingCertificateHistory.orEmpty().map(::digest).toSet()

            // With a rotated key this is the oldest certificate in the history.
            @Suppress("DEPRECATION")
            val legacy = info.signatures.orEmpty().map(::digest).toSet()
            return ApkFacts(
                packageName = info.packageName.orEmpty(),
                versionCode = info.longVersionCode,
                signers = current.ifEmpty { legacy },
                lineage = current + history + legacy
            )
        }

        private fun digest(signature: Signature): String =
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
