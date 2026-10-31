// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.machine

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.UpdateState
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.components.RepairCard
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant

/** Spec §6.3: who this machine is, whether we can reach it, and how to stop trying. */
@Composable
fun MachineScreen(
    vm: DeckViewModel,
    machineId: String,
    onUnpair: (String) -> Unit,
    onBack: () -> Unit,
    onRepair: (String) -> Unit = {}
) {
    val team by vm.team.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    val machine = team.machine(machineId)
    var confirming by remember { mutableStateOf(false) }

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
                text = machine?.name ?: machine?.config?.name ?: "Machine",
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp
            )
        }

        if (machine == null) {
            Text(
                modifier = Modifier.padding(10.dp),
                text = "This machine is no longer paired.",
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = 13.sp
            )
            return@Column
        }

        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            RepairCard(machine = machine, onRepair = onRepair)

            Field("user", machine.user?.emailAddress ?: machine.user?.displayName ?: "unknown")
            Field("address", "${machine.config.addr}:${machine.config.port}")
            Field("daemon version", machine.version ?: "unknown")
            Field("health", healthLine(machine, now))
            Field("transport", transportLabel(machine.transport))
            Field("update", updateLine(machine.update))
            machine.lastError?.let { Field("last error", it) }

            TextButton(onClick = { confirming = true }, modifier = Modifier.padding(6.dp)) {
                Text("Unpair", color = DeckColors.crit, fontFamily = DeckType.text)
            }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            containerColor = DeckColors.surface,
            title = { Text("Unpair this machine?", color = DeckColors.fg, fontFamily = DeckType.text) },
            text = {
                Text(
                    text = "The token is deleted from this phone. Pair again with a fresh QR to " +
                        "come back.",
                    color = DeckColors.muted,
                    fontFamily = DeckType.text,
                    fontSize = 13.sp
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirming = false
                        onUnpair(machineId)
                        onBack()
                    }
                ) {
                    Text("Unpair", color = DeckColors.crit)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) {
                    Text("Cancel", color = DeckColors.muted)
                }
            }
        )
    }
}

@Composable
private fun Field(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(text = label, color = DeckColors.dim, fontFamily = DeckType.text, fontSize = 12.sp)
        Text(
            text = value,
            color = DeckColors.fg,
            fontFamily = DeckType.mono,
            fontSize = 12.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

internal fun healthLine(machine: MachineState, now: Instant): String =
    "${machine.health.name.lowercase()} · ${Format.age(machine.lastHeartbeatAt, now)}"

internal fun transportLabel(transport: MachineState.Transport): String = when (transport) {
    MachineState.Transport.SSE -> "SSE"
    MachineState.Transport.POLLING -> "polling"
    MachineState.Transport.DISCONNECTED -> "disconnected"
}

/**
 * The daemon defers its own updates while a session is frozen; saying so beats showing a state
 * that looks stuck.
 */
internal fun updateLine(update: UpdateState?): String {
    if (update == null) return "unknown"
    val available = update.available?.let { " → $it" }.orEmpty()
    val reason = when {
        update.state == "deferred" && update.deferredReason == "frozen" -> " (waiting on frozen session)"
        update.state == "deferred" -> " (deferred: ${update.deferredReason ?: "unknown"})"
        else -> ""
    }
    return "${update.current}$available · ${update.state}$reason"
}
