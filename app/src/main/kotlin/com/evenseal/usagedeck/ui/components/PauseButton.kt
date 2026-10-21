// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/** What a pause control is showing right now. */
sealed interface PauseVisual {
    /** Nothing is paused; a tap soft-pauses, a hold freezes. */
    object Idle : PauseVisual

    /** Soft-paused; [countdown] is the escalation countdown, or null when escalation is off. */
    data class Soft(val countdown: String?) : PauseVisual

    /** Hard-paused (SIGSTOP); [elapsed] is how long it has been frozen. */
    data class Frozen(val elapsed: String) : PauseVisual

    /** Paused by a broader project/all rule; this narrower control cannot resume it. */
    data class Inherited(val source: String) : PauseVisual {
        companion object {
            const val ALL = "Pause all"
            const val PROJECT = "project pause"
        }
    }

    /** The machine is dead or the session cannot be paused. */
    object Disabled : PauseVisual

    /** A request is in flight; the optimistic state is already drawn elsewhere. */
    object InFlight : PauseVisual
}

/**
 * The one gesture grammar the whole deck uses (spec §9): tap = soft, hold 600 ms = hard, tap on a
 * paused control = resume. The red ring is drawn only while a hold is actually in progress, so red
 * never appears for a tap.
 */
@Composable
fun PauseButton(visual: PauseVisual, size: Dp = 34.dp, onTap: () -> Unit, onHold: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val enabled = visual !is PauseVisual.Disabled && visual !is PauseVisual.InFlight &&
        visual !is PauseVisual.Inherited
    var holding by remember { mutableStateOf(false) }

    val ring = when {
        holding -> DeckColors.crit
        visual is PauseVisual.Frozen -> DeckColors.frozen
        visual is PauseVisual.Inherited -> DeckColors.warn
        visual is PauseVisual.Soft -> DeckColors.warn
        visual is PauseVisual.Disabled -> DeckColors.line
        else -> DeckColors.dim
    }
    val label = when (visual) {
        is PauseVisual.Soft -> visual.countdown ?: PLAY_GLYPH
        is PauseVisual.Frozen -> visual.elapsed
        is PauseVisual.Inherited -> LOCK_GLYPH
        else -> PAUSE_GLYPH
    }
    val fill = when {
        visual is PauseVisual.Frozen -> DeckColors.frozen.copy(alpha = 0.12f)
        visual is PauseVisual.Soft -> DeckColors.warn.copy(alpha = 0.10f)
        visual is PauseVisual.Inherited -> DeckColors.warn.copy(alpha = 0.10f)
        else -> DeckColors.surface
    }
    val labelColor = when {
        !enabled -> DeckColors.dim
        visual is PauseVisual.Frozen -> DeckColors.frozen
        visual is PauseVisual.Soft -> DeckColors.warn
        visual is PauseVisual.Inherited -> DeckColors.warn
        else -> DeckColors.muted
    }

    HoldTimeout {
        Box(
            modifier = Modifier
                .size(size)
                .semantics {
                    contentDescription = if (visual is PauseVisual.Inherited) {
                        "paused by ${visual.source}"
                    } else {
                        PauseButtonDefaults.CONTENT_DESCRIPTION
                    }
                    if (!enabled) disabled()
                }
                .pointerInput(enabled) {
                    if (!enabled) return@pointerInput
                    detectTapGestures(
                        onPress = {
                            holding = true
                            tryAwaitRelease()
                            holding = false
                        },
                        onTap = { onTap() },
                        onLongPress = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onHold()
                        }
                    )
                },
            contentAlignment = Alignment.Center
        ) {
            Canvas(modifier = Modifier.size(size)) {
                val stroke = if (holding) 2.5.dp.toPx() else 1.5.dp.toPx()
                drawCircle(
                    color = fill,
                    radius = (this.size.minDimension - stroke) / 2f,
                    center = Offset(this.size.width / 2f, this.size.height / 2f)
                )
                drawCircle(
                    color = ring,
                    radius = (this.size.minDimension - stroke) / 2f,
                    center = Offset(this.size.width / 2f, this.size.height / 2f),
                    style = Stroke(width = stroke)
                )
            }
            Text(
                text = label,
                color = if (holding) DeckColors.crit else labelColor,
                fontFamily = if (label == PAUSE_GLYPH || label == PLAY_GLYPH) DeckType.text else DeckType.mono,
                fontWeight = FontWeight.Medium,
                fontSize = if (label == PAUSE_GLYPH || label == PLAY_GLYPH) 13.sp else 10.sp
            )
        }
    }
}

object PauseButtonDefaults {
    /** Semantics label every pause control carries, so TalkBack and UI tests can find it. */
    const val CONTENT_DESCRIPTION = "pause control"

    /** The hold threshold from the gesture grammar. */
    const val HOLD_MILLIS = 600L
}

private const val PAUSE_GLYPH = "❚❚"
private const val PLAY_GLYPH = "▶"
private const val LOCK_GLYPH = "↳"
