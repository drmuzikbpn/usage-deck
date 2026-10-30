// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.service

import android.app.Application
import android.content.Context
import android.util.Log
import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.UsageDeckApp
import com.evenseal.usagedeck.alerts.AlertLedger
import com.evenseal.usagedeck.alerts.Notifier
import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.SystemClock
import com.evenseal.usagedeck.core.alerts.AlertEvaluator
import com.evenseal.usagedeck.core.daemon.DaemonApi
import com.evenseal.usagedeck.core.daemon.DaemonEventSource
import com.evenseal.usagedeck.core.daemon.Endpoints
import com.evenseal.usagedeck.core.daemon.MachineClient
import com.evenseal.usagedeck.core.daemon.OkHttpDaemonApi
import com.evenseal.usagedeck.core.daemon.PinnedTls
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.pairing.PairingClient
import com.evenseal.usagedeck.core.pause.PauseController
import com.evenseal.usagedeck.demo.DemoDeck
import com.evenseal.usagedeck.kiosk.AndroidUptime
import com.evenseal.usagedeck.kiosk.ExitPin
import com.evenseal.usagedeck.kiosk.KioskManager
import com.evenseal.usagedeck.kiosk.ModeController
import com.evenseal.usagedeck.pairing.InvitePairing
import com.evenseal.usagedeck.pairing.MachineStore
import com.evenseal.usagedeck.pairing.PairingImport
import com.evenseal.usagedeck.pairing.PairingImports
import com.evenseal.usagedeck.pairing.encryptedPrefs
import com.evenseal.usagedeck.pause.PrefsEscalationStore
import com.evenseal.usagedeck.settings.SettingsStore
import com.evenseal.usagedeck.wifi.WifiMonitor
import java.time.ZoneId
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * The whole object graph, wired by hand and owned by [com.evenseal.usagedeck.UsageDeckApp].
 * There is no DI framework: the graph is small, singleton-shaped and easier to read as one file.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeckGraph(private val app: Application) {
    val clock: Clock = SystemClock

    /**
     * Long-lived work (clients, redeems, updates). A last-resort handler logs anything that
     * escapes a launch rather than letting it take the kiosk process down.
     */
    val scope: CoroutineScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, e ->
            Log.e(TAG, "uncaught failure in background work", e)
        }
    )

    /**
     * The one HTTP client, for daemons and for GitHub alike. It has no cleartext connection spec,
     * so nothing built from it can speak plain HTTP even though the manifest has to permit
     * cleartext for the captive-portal WebView (see `res/xml/network_security_config.xml`).
     */
    val http: OkHttpClient = OkHttpClient.Builder().connectionSpecs(PinnedTls.TLS_ONLY).build()

    val installId: String = UsageDeckApp.installIdOf(app)

    val machineStore: MachineStore = MachineStore.open(app)

    /** Pairing: redeems a scanned or sideloaded invite over pinned HTTPS and stores the machine. */
    val invitePairing: InvitePairing = InvitePairing({ PairingClient(http).redeem(it) }, machineStore, scope)

    /** The sideloaded pairing file, which a release build accepts only from its private files dir. */
    val imports: PairingImports = PairingImports(
        PairingImport(PairingImport.watched(app.filesDir, app.getExternalFilesDir(null), BuildConfig.DEBUG)),
        machineStore,
        invitePairing,
        scope,
        log = { Log.i(TAG, it) }
    )

    val settings: SettingsStore = SettingsStore(app.getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE))

    /** The parts only one build has: the kiosk's wifi and self-update. See `Channel.kt` in each flavor. */
    val channel: Channel = Channel(app, http, clock, scope, ::updateDeferralReason)

    val wifi: WifiMonitor = channel.wifi

    val mode: ModeController = ModeController(app)

    val kiosk: KioskManager = KioskManager(app)

    val exitPin: ExitPin = ExitPin(encryptedPrefs(app, PIN_PREFS), clock, AndroidUptime(app))

    val burn: BurnHistory = BurnHistory()

    private val _clients = MutableStateFlow<Map<String, MachineClient>>(emptyMap())
    val clients: StateFlow<Map<String, MachineClient>> = _clients.asStateFlow()

    private val apis = mutableMapOf<String, DaemonApi>()

    private var clientSync: Job? = null

    /** What the paired machines report. Pauses and alerts run on this, never on the demo. */
    private val liveTeam: StateFlow<TeamState> = clients
        .flatMapLatest { map ->
            if (map.isEmpty()) {
                flowOf(TeamState())
            } else {
                combine(map.values.map { it.state }) { states -> TeamState(states.toList()) }
            }
        }
        .stateIn(scope, SharingStarted.Eagerly, TeamState())

    /** "Try the demo": made-up machines for anyone without a daemon, App Review included. */
    val demo: DemoDeck = DemoDeck(clock, scope, burn)

    /** What the screens draw: the demo while it runs, the paired machines otherwise. */
    val team: StateFlow<TeamState> = combine(liveTeam, demo.team) { live, shown -> shown ?: live }
        .stateIn(scope, SharingStarted.Eagerly, TeamState())

    val pause: PauseController = PauseController(
        team = liveTeam,
        apis = { machineId -> apis[machineId] },
        installId = installId,
        store = PrefsEscalationStore(app.getSharedPreferences(ESCALATION_PREFS, Context.MODE_PRIVATE)),
        clock = clock,
        scope = scope,
        settings = settings.pauseSettings
    )

    val evaluator: AlertEvaluator = AlertEvaluator(settings.thresholds, ZoneId.systemDefault())

    /** Which limit alerts have already spoken, per window, across process death. */
    val alerts: AlertLedger = AlertLedger(app.getSharedPreferences(ALERT_PREFS, Context.MODE_PRIVATE))

    val notifier: Notifier = Notifier(app, scope)

    /** Filled in by [DeckEngine]; null while it is idle, and always on a build with no self-update. */
    var updateChecks: UpdateChecks? = null

    /** Clients, pause timer and alerts, running for as long as something holds them. */
    val engine: DeckEngine = DeckEngine(this)

    init {
        // A real pairing ends the demo: from then on the screens show that machine.
        scope.launch { machineStore.machines.collect { if (it.isNotEmpty()) demo.stop() } }
    }

    /**
     * Spec §12: never swap the APK out from under a gesture or an armed escalation — the user
     * would lose the hold they are halfway through, or the freeze they are counting on.
     */
    private fun updateDeferralReason(): String? = when {
        pause.inFlight.value.isNotEmpty() -> "gesture"
        pause.pending.value.isNotEmpty() -> "escalation_pending"
        else -> null
    }

    /** Keeps one [MachineClient] per paired machine, following [MachineStore] as it changes. */
    fun startClients() {
        if (clientSync != null) return
        clientSync = scope.launch {
            machineStore.machines.collect { configs -> syncClients(configs) }
        }
    }

    fun stopClients() {
        clientSync?.cancel()
        clientSync = null
        _clients.value.values.forEach { it.stop() }
        _clients.value = emptyMap()
        apis.clear()
    }

    fun apiFor(machineId: String): DaemonApi? = apis[machineId]

    private fun syncClients(configs: List<MachineConfig>) {
        val wanted = configs.associateBy { it.id }
        val current = _clients.value

        current.filterKeys { it !in wanted.keys }.forEach { (id, client) ->
            client.stop()
            apis.remove(id)
        }

        val next = wanted.mapValues { (id, config) ->
            val existing = current[id]
            if (existing != null && existing.config == config) {
                existing
            } else {
                existing?.stop()
                newClient(config).also { it.start() }
            }
        }
        _clients.value = next
    }

    /** The alert loop's source; separate from [team] so the demo never alerts. */
    val alertSource: StateFlow<TeamState> get() = liveTeam

    private fun newClient(config: MachineConfig): MachineClient {
        // A row from the retired plain-HTTP pairing: shown with a Re-pair card, never contacted.
        if (!config.isPinned) {
            return MachineClient.retired(config, burn, clock, scope, mode.screenOn).also { apis[config.id] = it.api }
        }
        // One address memory per machine, shared so an SSE stream that finds the Mac on another
        // address steers REST there too.
        val endpoints = Endpoints(config.candidates)
        val source = DaemonEventSource(config, http, endpoints)
        val client = MachineClient(
            config = config,
            api = OkHttpDaemonApi(config, http, endpoints),
            eventSource = source::events,
            burn = burn,
            clock = clock,
            scope = scope,
            screenOn = mode.screenOn,
            tickerMs = TICKER_MS
        )
        // The client's watched API, so a 401 on a pause or resume also marks the machine lost.
        apis[config.id] = client.api
        return client
    }

    private companion object {
        const val SETTINGS_PREFS = "settings"
        const val ESCALATION_PREFS = "escalations"
        const val ALERT_PREFS = "alerts"
        const val PIN_PREFS = "exit_pin"
        const val TICKER_MS = 1_000L
        const val TAG = "UsageDeckGraph"
    }
}
