// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.wifi

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import com.evenseal.usagedeck.wifi.WifiNetwork
import com.evenseal.usagedeck.wifi.WifiStatus
import java.time.Instant

/**
 * Spec §6.1. Android throttles `startScan()` hard, so the list carries its own age and the
 * rescan button says so rather than pretending a tap did something.
 */
@Composable
fun WifiScreen(
    status: WifiStatus,
    networks: List<WifiNetwork>,
    lastScanAt: Instant?,
    now: Instant,
    canRescan: Boolean,
    onRescan: () -> Unit,
    onConnect: (ssid: String, passphrase: String?) -> Unit,
    onForget: (ssid: String) -> Unit,
    onCaptivePortal: () -> Unit,
    onBack: () -> Unit
) {
    var pending by remember { mutableStateOf<WifiNetwork?>(null) }

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(DeckColors.surface)
                .clickable(onClick = onBack)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(text = "‹", color = DeckColors.accent, fontFamily = DeckType.text, fontSize = 18.sp)
            Text(
                text = "Wifi",
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp
            )
        }

        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text(
                text = if (status.connected) "${status.ssid} · ${status.rssi} dBm" else "not connected",
                color = if (status.connected) DeckColors.fg else DeckColors.crit,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp
            )
            Text(
                text = status.ip ?: "no address",
                color = DeckColors.dim,
                fontFamily = DeckType.mono,
                fontSize = 11.sp
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(DeckColors.surface2)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "scanned ${Format.age(lastScanAt, now)}",
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = 12.sp
            )
            TextButton(enabled = canRescan, onClick = onRescan) {
                Text(
                    text = if (canRescan) RESCAN else RESCAN_THROTTLED,
                    color = if (canRescan) DeckColors.accent else DeckColors.dim,
                    fontFamily = DeckType.text,
                    fontSize = 13.sp
                )
            }
        }

        LazyColumn(modifier = Modifier.weight(1f)) {
            items(networks, key = { it.ssid }) { network ->
                NetworkRow(
                    network = network,
                    onClick = {
                        if (network.security == WifiNetwork.Security.OPEN) {
                            onConnect(network.ssid, null)
                        } else {
                            pending = network
                        }
                    },
                    onForget = { onForget(network.ssid) }
                )
            }
        }

        TextButton(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            onClick = onCaptivePortal
        ) {
            Text(
                text = "Open captive portal",
                color = DeckColors.accent,
                fontFamily = DeckType.text,
                fontSize = 14.sp
            )
        }
    }

    pending?.let { network ->
        PassphraseDialog(
            network = network,
            onDismiss = { pending = null },
            onConnect = { passphrase ->
                pending = null
                onConnect(network.ssid, passphrase)
            }
        )
    }
}

@Composable
private fun NetworkRow(network: WifiNetwork, onClick: () -> Unit, onForget: () -> Unit) {
    val unsupported = network.security == WifiNetwork.Security.EAP_UNSUPPORTED
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !unsupported, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = network.ssid,
                color = if (unsupported) DeckColors.dim else DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp
            )
            Text(
                text = buildString {
                    append(securityLabel(network.security))
                    append(" · ")
                    append(network.rssi)
                    append(" dBm")
                    if (network.connected) append(" · connected")
                },
                color = DeckColors.dim,
                fontFamily = DeckType.mono,
                fontSize = 11.sp
            )
        }
        if (network.saved) {
            TextButton(onClick = onForget) {
                Text(text = "Forget", color = DeckColors.crit, fontFamily = DeckType.text, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun PassphraseDialog(network: WifiNetwork, onDismiss: () -> Unit, onConnect: (String) -> Unit) {
    var passphrase by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = DeckColors.surface,
        title = { Text(network.ssid, color = DeckColors.fg, fontFamily = DeckType.text) },
        text = {
            OutlinedTextField(
                value = passphrase,
                onValueChange = { passphrase = it },
                label = { Text("Passphrase") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password)
            )
        },
        confirmButton = {
            TextButton(
                enabled = passphrase.length >= MIN_PASSPHRASE,
                onClick = { onConnect(passphrase) }
            ) {
                Text("Connect", color = DeckColors.accent)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = DeckColors.muted) }
        }
    )
}

internal fun securityLabel(security: WifiNetwork.Security): String = when (security) {
    WifiNetwork.Security.OPEN -> "open"
    WifiNetwork.Security.WPA -> "WPA2"
    WifiNetwork.Security.WPA3 -> "WPA3"
    WifiNetwork.Security.EAP_UNSUPPORTED -> "enterprise · not supported"
}

const val RESCAN = "Rescan"
const val RESCAN_THROTTLED = "Rescan (wait)"

private const val MIN_PASSPHRASE = 8
