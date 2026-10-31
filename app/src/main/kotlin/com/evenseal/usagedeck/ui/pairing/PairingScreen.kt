// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.pairing

import android.app.Activity
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.pairing.PairingInvite
import com.evenseal.usagedeck.pairing.QrScanActivity
import com.evenseal.usagedeck.pairing.ReplaceCheck
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/** What the pairing screen shows under the button; [busy] while a redeem or probe is running. */
data class PairingStatus(val message: String, val busy: Boolean = false)

/** The row a Re-pair card asked to replace, with every name it goes by. */
data class ReplaceTarget(val id: String, val names: List<String>)

/** A scanned link held back until the person at the screen says what to do with it. */
private data class Held(val invite: PairingInvite, val target: ReplaceTarget)

/**
 * Spec §6.3, daemon §23.47. The QR comes from `claude-usage pair` and carries a one-time code
 * that is redeemed over HTTPS pinned to the fingerprint beside it; it never carries the token.
 *
 * [onScanned] gets the id of the row to replace (null to pair normally) and whether a normal
 * pairing may still replace a row it matches. Nothing swaps one machine's key for another's
 * without a question first: from a Re-pair card when the QR names a different machine, and from
 * the plain pairing screen when the QR would overwrite a paired machine that has a different
 * certificate ([conflictOf]).
 */
@Composable
fun PairingScreen(
    onScanned: (PairingInvite, replaceId: String?, mayReplace: Boolean, report: (PairingStatus) -> Unit) -> Unit,
    onBack: () -> Unit,
    redeeming: Boolean = false,
    replacing: ReplaceTarget? = null,
    conflictOf: (PairingInvite) -> ReplaceTarget? = { null }
) {
    val context = LocalContext.current
    var status by remember { mutableStateOf<PairingStatus?>(null) }
    var confirming by remember { mutableStateOf<Held?>(null) }
    val accept: (PairingInvite) -> Unit = { scanned ->
        val conflict = if (replacing == null) conflictOf(scanned) else null
        when {
            replacing != null && ReplaceCheck.needsConfirm(replacing.names, scanned.name) ->
                confirming = Held(scanned, replacing)
            replacing != null -> onScanned(scanned, replacing.id, true) { status = it }
            conflict != null -> confirming = Held(scanned, conflict)
            else -> onScanned(scanned, null, true) { status = it }
        }
    }

    val scan = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val raw = result.data?.getStringExtra(QrScanActivity.EXTRA_PAYLOAD).orEmpty()
        PairingInvite.parse(raw)
            .onSuccess(accept)
            .onFailure { status = PairingStatus(it.message ?: "That QR is not a pairing code.") }
    }
    // [redeeming] comes from the graph, so a rotated or re-entered screen still knows a code is
    // being redeemed and cannot start a second one.
    val busy = status?.busy == true || redeeming

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
                text = replacing?.let { "Re-pair ${it.names.firstOrNull() ?: "machine"}" } ?: "Pair a machine",
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp
            )
        }

        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Text(
                modifier = Modifier.padding(10.dp),
                text = QrScanActivity.WARNING,
                color = DeckColors.warn,
                fontFamily = DeckType.text,
                fontSize = 13.sp
            )

            Text(
                modifier = Modifier.padding(horizontal = 10.dp),
                text = "On the Mac: claude-usage pair",
                color = DeckColors.muted,
                fontFamily = DeckType.mono,
                fontSize = 12.sp
            )

            TextButton(
                modifier = Modifier.padding(6.dp),
                enabled = !busy,
                onClick = { scan.launch(Intent(context, QrScanActivity::class.java)) }
            ) {
                Text("Scan QR", color = DeckColors.accent, fontFamily = DeckType.text, fontSize = 15.sp)
            }

            if (busy) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                    color = DeckColors.accent,
                    trackColor = DeckColors.surface
                )
            }

            status?.let {
                Text(
                    modifier = Modifier.padding(10.dp),
                    text = it.message,
                    color = DeckColors.fg,
                    fontFamily = DeckType.text,
                    fontSize = 13.sp
                )
            }
        }
    }

    confirming?.let { held ->
        ReplaceConfirmDialog(
            oldName = held.target.names.firstOrNull() ?: "this machine",
            newName = held.invite.name,
            reRepairing = replacing != null,
            onReplace = {
                confirming = null
                onScanned(held.invite, held.target.id, true) { status = it }
            },
            onKeepBoth = {
                confirming = null
                // From a Re-pair card "keep both" pairs normally, as it always has. From the plain
                // screen the conflicting row must survive, so nothing at all may be replaced.
                onScanned(held.invite, null, replacing != null) { status = it }
            },
            onCancel = { confirming = null }
        )
    }
}

/**
 * Asked when a scanned QR would swap one paired machine for another: from a Re-pair card whose QR
 * names a different machine ([reRepairing]), or from the pairing screen when the QR's address
 * belongs to a machine paired with a different certificate.
 */
@Composable
fun ReplaceConfirmDialog(
    oldName: String,
    newName: String,
    onReplace: () -> Unit,
    onKeepBoth: () -> Unit,
    onCancel: () -> Unit,
    reRepairing: Boolean = true
) {
    AlertDialog(
        onDismissRequest = onCancel,
        containerColor = DeckColors.surface,
        title = { Text("Replace $oldName with $newName?", color = DeckColors.fg, fontFamily = DeckType.text) },
        text = {
            Text(
                text = if (reRepairing) {
                    "This QR is from $newName, but you were re-pairing $oldName. Replace swaps " +
                        "$oldName for $newName; Keep both pairs $newName as another machine."
                } else {
                    "This QR is from $newName, at an address this deck has paired as $oldName with a " +
                        "different certificate. Replace swaps $oldName for $newName; Keep both pairs " +
                        "$newName as another machine."
                },
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = 13.sp
            )
        },
        confirmButton = {
            TextButton(onClick = onReplace) { Text("Replace", color = DeckColors.warn) }
        },
        dismissButton = {
            TextButton(onClick = onKeepBoth) { Text("Keep both", color = DeckColors.muted) }
        }
    )
}

/**
 * Asked before a sideloaded pairing file replaces a machine. Whoever dropped the file is not
 * necessarily whoever is at the screen, so there is no "keep both" shortcut here: replace, or not.
 */
@Composable
fun ImportConfirmDialog(oldName: String, newName: String, onReplace: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        containerColor = DeckColors.surface,
        title = { Text("Replace $oldName with $newName?", color = DeckColors.fg, fontFamily = DeckType.text) },
        text = {
            Text(
                text = "A pairing file was copied onto this deck. It would replace $oldName with $newName. " +
                    "Replace only if you put it there; otherwise cancel and nothing changes.",
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = 13.sp
            )
        },
        confirmButton = {
            TextButton(onClick = onReplace) { Text("Replace", color = DeckColors.warn) }
        },
        dismissButton = {
            TextButton(onClick = onCancel) { Text("Cancel", color = DeckColors.muted) }
        }
    )
}
