// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck

import android.Manifest.permission.POST_NOTIFICATIONS
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.evenseal.usagedeck.kiosk.DeckMode
import com.evenseal.usagedeck.kiosk.KioskManager
import com.evenseal.usagedeck.kiosk.LockTaskReceiver
import com.evenseal.usagedeck.kiosk.ScreenHold
import com.evenseal.usagedeck.service.DeckEngine
import com.evenseal.usagedeck.service.DeckService
import com.evenseal.usagedeck.ui.DeckNav
import com.evenseal.usagedeck.ui.alerts.AlertOverlay
import com.evenseal.usagedeck.ui.components.DemoBanner
import com.evenseal.usagedeck.ui.kiosk.ExitGate
import com.evenseal.usagedeck.ui.kiosk.StorageErrorScreen
import com.evenseal.usagedeck.ui.pairing.ImportConfirmDialog
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckColorsTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The whole app is one activity: it is the launcher, the kiosk and the dashboard. Lock task is
 * entered here, and the only way out is the [ExitGate] corner.
 */
class MainActivity : ComponentActivity() {
    private val graph by lazy { (application as UsageDeckApp).graph }

    /** The encrypted store could not be opened; nothing here may touch [graph]. */
    private var failed = false

    private val askForNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) DeckService.start(this) else graph.settings.update { it.copy(keepWatching = false) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if ((application as UsageDeckApp).storageFailure != null) {
            // Fail closed: no graph, no service, no clients. The kiosk still locks, so a deck
            // with a broken keystore shows this to a passer-by instead of the launcher.
            failed = true
            KioskManager(this).run {
                applyPolicies()
                startLockTask(this@MainActivity)
            }
            setContent { StorageErrorScreen() }
            return
        }

        if (!BuildConfig.KIOSK) {
            // Dark app, so light system-bar icons whatever the phone's own theme is.
            enableEdgeToEdge(
                statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
                navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
            )
        }
        if (graph.kiosk.isDeviceOwner) {
            graph.kiosk.applyPolicies()
            graph.kiosk.startLockTask(this)
            // One tap, on first launch only, and only on a provisioned kiosk: Device Owner cannot
            // write the battery whitelist itself on API 29 (spec §4).
            if (!graph.kiosk.dozeExempt) graph.kiosk.requestDozeExemption(this)
        }
        if (BuildConfig.KIOSK) DeckService.start(this) else followBackgroundWatching()
        watchForPairingImport()
        lifecycleScope.launch {
            combine(graph.settings.settings, graph.mode.mode) { prefs, mode ->
                // "On power" is a dock on the kiosk; a phone on a charger is just a phone.
                ScreenHold.shouldHold(if (BuildConfig.KIOSK) mode else DeckMode.BATTERY, prefs.keepScreenOn)
            }.collect { hold ->
                if (hold) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        setContent {
            // The dialogs here sit outside DeckNav's DeckTheme, so they need the colours too.
            DeckColorsTheme {
                Box(modifier = Modifier.fillMaxSize().background(DeckColors.bg).safeArea()) {
                    Column(modifier = Modifier.fillMaxSize()) {
                        DemoBanner(graph.demo)
                        Box(modifier = Modifier.weight(1f)) { DeckNav(graph) }
                    }

                    val overlay by graph.notifier.overlay.collectAsStateWithLifecycle()
                    val mode by graph.mode.mode.collectAsStateWithLifecycle()
                    AlertOverlay(
                        alert = overlay,
                        mode = mode,
                        onDismiss = { graph.notifier.dismissOverlay() }
                    )

                    val importQuestion by graph.imports.pending.collectAsStateWithLifecycle()
                    importQuestion?.let { asked ->
                        ImportConfirmDialog(
                            oldName = asked.oldName,
                            newName = asked.newName,
                            onReplace = { graph.imports.confirm() },
                            onCancel = { graph.imports.decline() }
                        )
                    }

                    if (BuildConfig.KIOSK) {
                        ExitGate(
                            pin = graph.exitPin,
                            clock = graph.clock,
                            onUnlocked = ::openMaintenanceWindow,
                            modifier = Modifier.align(Alignment.TopStart)
                        )
                    }
                }
            }
        }
    }

    /** A phone streams while it is on screen; [DeckService] carries it further only if asked to. */
    override fun onStart() {
        super.onStart()
        if (!failed && !BuildConfig.KIOSK) graph.engine.acquire(DeckEngine.Hold.UI)
    }

    override fun onStop() {
        if (!failed && !BuildConfig.KIOSK) graph.engine.release(DeckEngine.Hold.UI)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        if (failed) return
        // Coming back from the captive portal or the QR scanner must re-pin the deck, unless a
        // maintenance window is deliberately open.
        if (graph.kiosk.isDeviceOwner && System.currentTimeMillis() >= maintenanceUntil) {
            graph.kiosk.startLockTask(this)
        }
    }

    /**
     * Ten minutes out of lock task (spec §4). The re-arm is an alarm rather than a timer here,
     * so it survives this activity being backgrounded or the process being killed.
     */
    private fun openMaintenanceWindow() {
        maintenanceUntil = System.currentTimeMillis() + LockTaskReceiver.WINDOW_MILLIS
        graph.kiosk.stopLockTask(this)
        LockTaskReceiver.scheduleRelock(this, maintenanceUntil)
    }

    private companion object {
        /** Process-wide, so a config change cannot reopen the kiosk by accident. */
        @Volatile
        var maintenanceUntil: Long = 0L
    }

    /**
     * Keeps the service in step with the Settings switch. Android only allows the start from the
     * foreground, so this runs while resumed, which also re-arms a service the system has killed.
     * The ongoing notification is the point of the switch, so a refused permission turns it off.
     */
    private fun followBackgroundWatching() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                graph.settings.settings.map { it.keepWatching }.distinctUntilChanged().collect { watching ->
                    when {
                        !watching -> DeckService.stop(this@MainActivity)
                        needsNotificationPermission() -> askForNotifications.launch(POST_NOTIFICATIONS)
                        else -> DeckService.start(this@MainActivity)
                    }
                }
            }
        }
    }

    private fun needsNotificationPermission(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(this, POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    /**
     * A sideloaded pairing file is looked for every few seconds while the deck is in the
     * foreground, not only on resume: a kiosk that nobody leaves never resumes again, and its
     * process is protected, so it cannot be relaunched to pick one up either.
     */
    private fun watchForPairingImport() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (isActive) {
                    withContext(Dispatchers.IO) { graph.imports.poll() }
                    delay(IMPORT_POLL_MILLIS)
                }
            }
        }
    }
}

private const val IMPORT_POLL_MILLIS = 5_000L

/** The kiosk owns the whole screen; a phone keeps clear of its bars, cut-out and keyboard. */
@Composable
private fun Modifier.safeArea(): Modifier = if (BuildConfig.KIOSK) this else safeDrawingPadding()
