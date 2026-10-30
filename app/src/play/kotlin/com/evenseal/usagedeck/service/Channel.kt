// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.service

import android.app.Application
import androidx.navigation.NavGraphBuilder
import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.wifi.NoWifi
import com.evenseal.usagedeck.wifi.WifiMonitor
import kotlinx.coroutines.CoroutineScope
import okhttp3.OkHttpClient

/** A phone leaves wifi to Android and updates to Google Play, so there is nothing here. */
@Suppress("UNUSED_PARAMETER")
class Channel(
    app: Application,
    http: OkHttpClient,
    clock: Clock,
    scope: CoroutineScope,
    deferUpdatesWhile: () -> String?
) {
    val wifi: WifiMonitor = NoWifi

    val updateChecks: UpdateChecks? = null

    fun startUpdates() = Unit

    fun stopUpdates() = Unit
}

@Suppress("UNUSED_PARAMETER", "UnusedReceiverParameter")
internal fun NavGraphBuilder.channelRoutes(graph: DeckGraph, vm: DeckViewModel, onBack: () -> Unit) = Unit
