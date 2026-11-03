// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant
import java.time.ZoneId

/**
 * One utilisation window as a single row, the way the Ledger mockup draws it:
 * `5h | ████░░░░ | 42% | 2h33 left`. A null [limit] means the daemon has not reported that window
 * yet and renders as `—`, unless [noLimit] says the plan has no such window at all (daemon
 * §23.68): then it reads `none · on this plan`.
 */
@Composable
fun LimitBar(
    label: String,
    limit: Limit?,
    now: Instant,
    use24h: Boolean = true,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault(),
    noLimit: Boolean = false
) {
    val none = noLimit && limit == null
    val percent = limit?.percent?.coerceIn(0, 100)
    val color = limit?.let { DeckColors.of(it.status) } ?: DeckColors.dim

    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(
            text = label,
            color = DeckColors.muted,
            fontFamily = DeckType.mono,
            fontSize = 11.sp,
            modifier = Modifier.width(LABEL_WIDTH)
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .height(8.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(DeckColors.surface2)
        ) {
            if (percent != null && percent > 0) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(percent / 100f)
                        .height(8.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(color)
                )
            }
        }
        Text(
            text = percent?.let { "$it%" } ?: if (none) NoLimit.SHORT else EMPTY,
            color = color,
            fontFamily = DeckType.numeral,
            fontSize = if (none) 13.sp else 18.sp,
            textAlign = TextAlign.End,
            modifier = Modifier.width(PERCENT_WIDTH)
        )
        Text(
            text = when {
                limit != null -> Format.resetsShort(limit.resetsAt, now, zone, use24h)
                none -> NoLimit.CAPTION
                else -> EMPTY
            },
            color = DeckColors.muted,
            fontFamily = DeckType.mono,
            // "on this plan" is a hair wider than the column at 10 sp.
            fontSize = if (none) 9.sp else 10.sp,
            textAlign = TextAlign.End,
            maxLines = 1,
            modifier = Modifier.width(RESET_WIDTH)
        )
    }
}

private val LABEL_WIDTH = 28.dp
private val PERCENT_WIDTH = 44.dp
private val RESET_WIDTH = 76.dp
private const val EMPTY = "—"

/** Daemon §23.68: how a window the plan does not have reads, as opposed to `—` (not reported yet). */
object NoLimit {
    const val SHORT = "none"
    const val CAPTION = "on this plan"
    const val RING_CAPTION = "no 5h limit"
}
