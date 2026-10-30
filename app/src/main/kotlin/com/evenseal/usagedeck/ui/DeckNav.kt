// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.evenseal.usagedeck.service.DeckGraph
import com.evenseal.usagedeck.service.channelRoutes
import com.evenseal.usagedeck.ui.ledger.LedgerScreen
import com.evenseal.usagedeck.ui.project.ProjectScreen
import com.evenseal.usagedeck.ui.projects.ProjectsScreen
import com.evenseal.usagedeck.ui.theme.DeckTheme
import com.evenseal.usagedeck.ui.widedock.WideDockScreen

/** Every destination the deck has. Portrait and landscape share all of them but Home. */
sealed interface Route {
    object Home : Route

    data class Project(val machineId: String, val key: String) : Route

    object Projects : Route

    data class Machine(val id: String) : Route

    object Wifi : Route

    object Settings : Route

    object Pairing : Route

    /** Pairing started from a machine's Re-pair card: the result replaces machine [id]'s row. */
    data class Repair(val id: String) : Route

    /** "Try the demo": not a screen, it fills Home with made-up machines. */
    object Demo : Route
}

internal object Dest {
    const val HOME = "home"
    const val PROJECTS = "projects"
    const val WIFI = "wifi"
    const val SETTINGS = "settings"
    const val PAIRING = "pairing"
    const val PROJECT = "project/{machineId}/{key}"
    const val MACHINE = "machine/{id}"
    const val REPAIR = "repair/{id}"
    const val DEMO = "demo"

    fun path(route: Route): String = when (route) {
        Route.Home -> HOME
        Route.Projects -> PROJECTS
        Route.Wifi -> WIFI
        Route.Settings -> SETTINGS
        Route.Pairing -> PAIRING
        Route.Demo -> DEMO
        is Route.Project -> "project/${route.machineId.encode()}/${route.key.encode()}"
        is Route.Machine -> "machine/${route.id.encode()}"
        is Route.Repair -> "repair/${route.id.encode()}"
    }

    /** Project keys are filesystem paths, so they must not be read as extra path segments. */
    private fun String.encode(): String = java.net.URLEncoder.encode(this, Charsets.UTF_8.name())

    fun decode(raw: String?): String = raw?.let { java.net.URLDecoder.decode(it, Charsets.UTF_8.name()) }.orEmpty()
}

/**
 * Home follows the orientation sensor: portrait is the Ledger, landscape is the Wide dock
 * (spec §5). Everything else is orientation-agnostic.
 */
@Composable
fun DeckNav(graph: DeckGraph, navController: NavHostController = rememberNavController()) {
    val vm = remember(graph) { DeckViewModel(graph) }
    // A kiosk has no back button and no crash dialog worth showing, so a navigation request for
    // a destination this build does not register is ignored rather than thrown.
    val open: (Route) -> Unit = { route ->
        val path = Dest.path(route)
        when {
            route == Route.Demo -> graph.demo.start()
            navController.graph.findNode(path) != null -> navController.navigate(path)
        }
    }
    val back: () -> Unit = { navController.popBackStack() }

    val dim by vm.dimLevel.collectAsStateWithLifecycle()

    DeckTheme(dimLevel = dim) {
        NavHost(navController = navController, startDestination = Dest.HOME) {
            composable(Dest.HOME) {
                val landscape =
                    LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
                if (landscape) WideDockScreen(vm, open) else LedgerScreen(vm, open)
            }
            composable(Dest.PROJECTS) { ProjectsScreen(vm, open, back) }
            channelRoutes(graph, vm, back)
            composable(Dest.SETTINGS) {
                SettingsRoute(graph, back, onWifi = { open(Route.Wifi) }, onPair = { open(Route.Pairing) })
            }
            composable(Dest.PAIRING) { PairingRoute(graph, back) }
            composable(
                Dest.REPAIR,
                arguments = listOf(navArgument("id") { type = NavType.StringType })
            ) { entry ->
                PairingRoute(graph, back, replacing = Dest.decode(entry.arguments?.getString("id")))
            }
            composable(
                Dest.MACHINE,
                arguments = listOf(navArgument("id") { type = NavType.StringType })
            ) { entry ->
                MachineRoute(graph, vm, Dest.decode(entry.arguments?.getString("id")), back) { open(Route.Repair(it)) }
            }
            composable(
                Dest.PROJECT,
                arguments = listOf(
                    navArgument("machineId") { type = NavType.StringType },
                    navArgument("key") { type = NavType.StringType }
                )
            ) { entry ->
                ProjectScreen(
                    vm = vm,
                    machineId = Dest.decode(entry.arguments?.getString("machineId")),
                    key = Dest.decode(entry.arguments?.getString("key")),
                    onBack = back
                )
            }
        }
    }
}
