// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.service

import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.core.alerts.Alert
import com.evenseal.usagedeck.core.alerts.AlertKind
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.kiosk.DeckMode
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.launch

/**
 * The machine clients, the escalation timer and the alert loop. They run while anything holds
 * them: [DeckService] on the kiosk and for a phone's background watching, the visible activity
 * otherwise. Restarting is cheap, and the ledger keeps a restart from re-announcing a limit.
 */
class DeckEngine(private val graph: DeckGraph) {
    enum class Hold { UI, SERVICE }

    private val holds = mutableSetOf<Hold>()
    private var alertLoop: Job? = null

    /** Last time each alert key was shown, for the per-key debounce. */
    private val lastRaisedAt = mutableMapOf<String, Instant>()

    @Synchronized
    fun acquire(hold: Hold) {
        val idle = holds.isEmpty()
        holds += hold
        if (idle) start()
    }

    @Synchronized
    fun release(hold: Hold) {
        if (holds.remove(hold) && holds.isEmpty()) stop()
    }

    private fun start() {
        graph.mode.start()
        graph.wifi.start()
        graph.startClients()
        graph.pause.start()
        graph.updateChecks = graph.channel.updateChecks
        graph.channel.startUpdates()
        alertLoop = graph.scope.launch(Dispatchers.Main) { alertLoop() }
    }

    private fun stop() {
        alertLoop?.cancel()
        alertLoop = null
        graph.channel.stopUpdates()
        graph.updateChecks = null
        graph.pause.stop()
        graph.stopClients()
        graph.wifi.stop()
        graph.mode.stop()
    }

    /**
     * Evaluates every state transition and decides what actually reaches the user. A limit alert
     * speaks **once per window**: the ledger remembers it across process death, so a self-update
     * cannot turn one crossing into a notification every few hours for the rest of the week.
     * Falling back under a threshold forgets it, so a real re-crossing is still announced.
     */
    private suspend fun alertLoop() {
        graph.alertSource
            .scan<TeamState, Pair<TeamState?, TeamState>>(null to TeamState()) { (_, prev), next ->
                prev to next
            }
            .collect { (prev, next) ->
                val now = graph.clock.now()
                graph.evaluator.evaluate(prev, next).forEach { alert -> raise(alert, now) }
                forgetSettledLimits(next)
            }
    }

    /** A limit back under a threshold clears its ledger entry, so crossing it again is news. */
    private fun forgetSettledLimits(state: TeamState) {
        val prefs = graph.settings.settings.value
        state.users.forEach { user ->
            user.limits.forEach { limit ->
                if (limit.percent < prefs.critical) graph.alerts.forget("${AlertKind.CRITICAL}|${user.key}|${limit.id}")
                if (limit.percent < prefs.warn) graph.alerts.forget("${AlertKind.WARN}|${user.key}|${limit.id}")
            }
        }
    }

    private fun raise(alert: Alert, now: Instant) {
        // A limit crossing is announced once for its window, whatever the process has forgotten.
        val window = alert.window
        if (window != null && !graph.alerts.markFired(alert.key, window)) return
        val last = lastRaisedAt[alert.key]
        if (last != null && Duration.between(last, now) < DEBOUNCE) return
        deliver(alert, now)
    }

    private fun deliver(alert: Alert, now: Instant) {
        lastRaisedAt[alert.key] = now
        val quiet = graph.settings.isQuiet(now.atZone(ZoneId.systemDefault()).toLocalTime())
        graph.notifier.raise(alert, alertMode(), quiet, sound = graph.settings.settings.value.sound)
    }

    /** On a phone the overlay needs the app on screen, whatever the charger is doing. */
    @Synchronized
    private fun alertMode(): DeckMode = when {
        BuildConfig.KIOSK -> graph.mode.mode.value
        Hold.UI in holds -> DeckMode.DOCK
        else -> DeckMode.BATTERY
    }

    private companion object {
        val DEBOUNCE: Duration = Duration.ofSeconds(60)
    }
}
