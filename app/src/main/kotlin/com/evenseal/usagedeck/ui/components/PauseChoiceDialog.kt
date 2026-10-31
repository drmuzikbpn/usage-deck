// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * The confirm step behind a "Pause / Stop" button: the two stages of a pause spelled out in words,
 * so nobody has to remember the tap-versus-hold grammar to stop a project.
 */
@Composable
fun PauseChoiceDialog(subject: String, onSoft: () -> Unit, onFreeze: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = DeckColors.surface,
        title = {
            Text(
                text = "Pause $subject?",
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold
            )
        },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Choice(
                    title = PauseChoiceDefaults.SOFT,
                    body = "Holds at the next prompt or tool call. Nothing in flight is lost.",
                    color = DeckColors.warn,
                    onClick = {
                        onDismiss()
                        onSoft()
                    }
                )
                Choice(
                    title = PauseChoiceDefaults.FREEZE,
                    body = "Stops the running tool now and holds the next one; the session itself stays open. " +
                        "A freeze longer than a couple of minutes ends the tool that was running.",
                    color = DeckColors.crit,
                    onClick = {
                        onDismiss()
                        onFreeze()
                    }
                )
            }
        },
        confirmButton = {},
        dismissButton = {
            Text(
                text = "Cancel",
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                modifier = Modifier.clickable(onClick = onDismiss).padding(horizontal = 12.dp, vertical = 8.dp)
            )
        }
    )
}

@Composable
private fun Choice(title: String, body: String, color: Color, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(DeckColors.surface2)
            .border(1.dp, color.copy(alpha = 0.45f), shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Text(
            text = title,
            color = color,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.SemiBold,
            fontSize = 15.sp
        )
        Text(
            text = body,
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 3.dp)
        )
    }
}

object PauseChoiceDefaults {
    const val BUTTON = "Pause / Stop"
    const val RESUME = "Resume"
    const val SOFT = "Soft pause"
    const val FREEZE = "Freeze now"
}
