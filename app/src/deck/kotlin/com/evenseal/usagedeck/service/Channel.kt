// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.service

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.update.ReleaseChecker
import com.evenseal.usagedeck.core.update.Version
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.ui.Dest
import com.evenseal.usagedeck.ui.wifi.WifiScreen
import com.evenseal.usagedeck.update.ApkInstaller
import com.evenseal.usagedeck.update.PackageApkGate
import com.evenseal.usagedeck.update.PrefsUpdateSkips
import com.evenseal.usagedeck.update.Updater
import com.evenseal.usagedeck.wifi.CaptivePortalActivity
import com.evenseal.usagedeck.wifi.WifiRepository
import java.io.File
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import okhttp3.OkHttpClient

/** What only the kiosk has: it manages its own wifi and installs its own updates. */
class Channel(
    app: Application,
    http: OkHttpClient,
    clock: Clock,
    scope: CoroutineScope,
    deferUpdatesWhile: () -> String?
) {
    val wifi: WifiRepository = WifiRepository(app, scope, clock)

    val updater: Updater = Updater(
        checker = ReleaseChecker(BuildConfig.RELEASE_REPO, http),
        installed = Version.parse(BuildConfig.VERSION_NAME) ?: Version(0, 0, 0, ""),
        installer = ApkInstaller(app),
        cacheDir = File(app.cacheDir, "updates"),
        client = http,
        deferWhile = deferUpdatesWhile,
        clock = clock,
        scope = scope,
        gate = PackageApkGate(app),
        skips = PrefsUpdateSkips.open(app)
    )

    val updateChecks: UpdateChecks = updater

    fun startUpdates() = updater.start()

    fun stopUpdates() = updater.stop()
}

internal fun NavGraphBuilder.channelRoutes(graph: DeckGraph, vm: DeckViewModel, onBack: () -> Unit) {
    composable(Dest.WIFI) { WifiRoute(graph.channel.wifi, vm, onBack) }
}

@Composable
private fun WifiRoute(wifi: WifiRepository, vm: DeckViewModel, onBack: () -> Unit) {
    val context = LocalContext.current
    val status by wifi.status.collectAsStateWithLifecycle()
    val networks by wifi.scanResults.collectAsStateWithLifecycle()
    val lastScanAt by wifi.lastScanAt.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()

    WifiScreen(
        status = status,
        networks = networks,
        lastScanAt = lastScanAt,
        now = now,
        canRescan = lastScanAt == null || Duration.between(lastScanAt, now) >= RESCAN_INTERVAL,
        onRescan = { wifi.requestScan() },
        onConnect = { ssid, passphrase -> wifi.connect(ssid, passphrase) },
        onForget = { ssid -> wifi.forget(ssid) },
        onCaptivePortal = { context.openCaptivePortal() },
        onBack = onBack
    )
}

private fun Context.openCaptivePortal() {
    runCatching {
        startActivity(
            Intent(this, CaptivePortalActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}

private val RESCAN_INTERVAL: Duration = Duration.ofSeconds(30)
