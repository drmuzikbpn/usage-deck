// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.update

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.update.ReleaseChecker
import com.evenseal.usagedeck.core.update.ReleaseInfo
import com.evenseal.usagedeck.core.update.Sha256
import com.evenseal.usagedeck.core.update.Version
import com.evenseal.usagedeck.service.UpdateChecks
import java.io.File
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

sealed interface UpdaterState {
    object Idle : UpdaterState

    object Checking : UpdaterState

    data class Downloading(val version: Version) : UpdaterState

    data class Deferred(val version: Version, val reason: String) : UpdaterState

    data class Installing(val version: Version) : UpdaterState

    data class Failed(val message: String) : UpdaterState

    /** The newest release failed to verify or install before; it is not fetched again. */
    data class Skipped(val version: Version, val reason: String) : UpdaterState
}

/**
 * Polls GitHub for a newer APK and installs it — but never while the user is mid-gesture or an
 * escalation is armed (spec §12). An update that lands in the middle of a hold would lose the
 * hold, so the download waits, already verified, until the deck is idle.
 *
 * Before the installer sees a file it must be no larger than [maxApkBytes], match the release's
 * sha256, and pass [gate]: this app's package, a higher version code, this app's signing key.
 * A release that fails any of those, or whose install fails, is remembered in [skips] and not
 * downloaded again until a newer one appears or someone taps "Check now".
 */
class Updater(
    private val checker: ReleaseChecker,
    private val installed: Version,
    private val installer: ApkInstaller,
    private val cacheDir: File,
    private val client: OkHttpClient,
    /** Returns null when it is safe to install, otherwise the reason to wait. */
    private val deferWhile: () -> String?,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val gate: ApkGate,
    private val skips: UpdateSkips,
    private val maxApkBytes: Long = MAX_APK_BYTES,
    private val intervalMs: Long = 600_000
) : UpdateChecks {
    private val _state = MutableStateFlow<UpdaterState>(UpdaterState.Idle)
    val state: StateFlow<UpdaterState> = _state.asStateFlow()

    override val label: StateFlow<String> = _state
        .map(::describe)
        .stateIn(scope, SharingStarted.Eagerly, describe(UpdaterState.Idle))

    private var job: Job? = null

    /** A verified APK waiting for the deck to go quiet. */
    private var staged: Staged? = null

    private data class Staged(val version: Version, val apk: File)

    fun start() {
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                val waiting = staged
                if (waiting != null) installOrDefer(waiting) else checkPeriodically()
                // A verified APK that is only waiting for the deck to go quiet re-checks every
                // 30 s; everything else waits out the full jittered cycle.
                delay(if (staged != null) DEFER_RETRY_MS else jittered())
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    /** "Check now" in Settings: forgets a skipped version and tries it again. */
    override suspend fun checkNow() = check(forget = true)

    /** The timer's check: a version that already failed to verify or install is left alone. */
    suspend fun checkPeriodically() = check(forget = false)

    private suspend fun check(forget: Boolean) {
        _state.value = UpdaterState.Checking

        val info = checker.latest()
        if (info == null) {
            _state.value = UpdaterState.Failed("Could not reach GitHub.")
            return
        }
        if (!checker.isNewer(info.version, installed)) {
            _state.value = UpdaterState.Idle
            return
        }
        if (forget) skips.clear()
        skips.reasonFor(info.version.toString())?.let { reason ->
            _state.value = UpdaterState.Skipped(info.version, reason)
            return
        }

        // The checksum first: it is a few bytes, and without it the APK is not worth fetching.
        val expected = checker.expectedSha256(info)
        if (expected == null) {
            _state.value = UpdaterState.Failed("Release ${info.version} has no checksum.")
            return
        }

        _state.value = UpdaterState.Downloading(info.version)
        val apk = when (val download = download(info)) {
            Download.Failed -> {
                _state.value = UpdaterState.Failed("Download failed for ${info.version}.")
                return
            }
            Download.TooLarge -> return reject(info.version, null, "it is larger than $maxApkBytes bytes")
            is Download.Done -> download.apk
        }

        if (!Sha256.hexOf(apk).equals(expected, ignoreCase = true)) {
            return reject(
                info.version,
                apk,
                "checksum mismatch",
                "Checksum mismatch for ${info.version}; not installing."
            )
        }
        gate.refuse(apk)?.let { return reject(info.version, apk, it) }

        val ready = Staged(info.version, apk)
        staged = ready
        installOrDefer(ready)
    }

    /** The release is not installable as published: drop the file and do not fetch it again. */
    private fun reject(
        version: Version,
        apk: File?,
        reason: String,
        message: String = "Not installing $version: $reason."
    ) {
        apk?.delete()
        skips.skip(version.toString(), reason)
        _state.value = UpdaterState.Failed(message)
    }

    private suspend fun installOrDefer(ready: Staged) {
        val reason = deferWhile()
        if (reason != null) {
            _state.value = UpdaterState.Deferred(ready.version, reason)
            return
        }
        _state.value = UpdaterState.Installing(ready.version)
        installer.install(ready.apk, ready.version.toString())
            .onSuccess { staged = null }
            .onFailure {
                staged = null
                val why = "install failed: ${it.message ?: "unknown error"}"
                skips.skip(ready.version.toString(), why)
                _state.value = UpdaterState.Failed("Install failed: ${it.message ?: "unknown error"}")
            }
    }

    private sealed interface Download {
        data class Done(val apk: File) : Download

        object TooLarge : Download

        object Failed : Download
    }

    /**
     * The APK is kept at a stable name so a technician can `adb install -r` it after a failed
     * self-update; older downloads are removed so the cache cannot grow without bound. Nothing
     * past [maxApkBytes] is written, whatever the server claims or sends.
     */
    private suspend fun download(info: ReleaseInfo): Download = withContext(Dispatchers.IO) {
        runCatching {
            cacheDir.mkdirs()
            cacheDir.listFiles()
                ?.filter { it.name.endsWith(".apk") && it.name != APK_NAME }
                ?.forEach { it.delete() }

            val target = File(cacheDir, APK_NAME)
            val request = Request.Builder().url(info.apkUrl).get().build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@runCatching Download.Failed
                val body = response.body
                if (body.contentLength() > maxApkBytes) return@runCatching Download.TooLarge
                val complete = target.outputStream().use { out -> copyCapped(body.byteStream(), out) }
                if (!complete) {
                    target.delete()
                    return@runCatching Download.TooLarge
                }
            }
            Download.Done(target)
        }.getOrDefault(Download.Failed)
    }

    /** False when the stream ran past [maxApkBytes]. */
    private fun copyCapped(input: java.io.InputStream, out: java.io.OutputStream): Boolean {
        val buffer = ByteArray(COPY_BUFFER_BYTES)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return true
            total += read
            if (total > maxApkBytes) return false
            out.write(buffer, 0, read)
        }
    }

    /** ±10 % so a fleet of decks does not stampede the GitHub API on the same second. */
    private fun jittered(): Long {
        val spread = (intervalMs * JITTER).toLong().coerceAtLeast(1L)
        return intervalMs - spread + Random(clock.now().toEpochMilli()).nextLong(2 * spread)
    }

    private fun describe(state: UpdaterState): String = when (state) {
        UpdaterState.Idle -> "up to date ($installed)"
        UpdaterState.Checking -> "checking…"
        is UpdaterState.Downloading -> "downloading ${state.version}"
        is UpdaterState.Deferred -> "${state.version} ready · waiting (${state.reason})"
        is UpdaterState.Installing -> "installing ${state.version}"
        is UpdaterState.Failed -> state.message
        is UpdaterState.Skipped -> "skipping ${state.version}: ${state.reason} · Check now retries"
    }

    companion object {
        const val APK_NAME = "last-update.apk"

        /** Spec §12: a deferred update re-checks every 30 s rather than waiting a whole cycle. */
        const val DEFER_RETRY_MS = 30_000L

        /** Several times the size of any real build; a download past this is not our APK. */
        const val MAX_APK_BYTES = 150L * 1024 * 1024

        private const val COPY_BUFFER_BYTES = 64 * 1024

        private const val JITTER = 0.10
    }
}
