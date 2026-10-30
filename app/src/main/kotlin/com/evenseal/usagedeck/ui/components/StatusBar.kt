// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import com.evenseal.usagedeck.wifi.WifiStatus
import java.time.Instant
import java.time.ZoneId

/**
 * The one-line header every screen carries, drawn as the mockups' pill chips: wifi (dot + bars),
 * the gear when the screen has no bottom bar, the alert chip when something needs attention, one chip per machine (dot + short name),
 * and the clock. Alerts appear here rather than as a banner so the wide dock never reflows.
 */
@Composable
fun StatusBar(
    wifi: WifiStatus,
    machines: List<MachineState>,
    clock: Instant,
    alertChip: String?,
    onWifi: () -> Unit,
    onMachine: (String) -> Unit,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault(),
    use24h: Boolean = true,
    onSettings: (() -> Unit)? = null,
    /** Only the kiosk manages its own wifi; a phone already shows that in its own status bar. */
    showWifi: Boolean = BuildConfig.KIOSK
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(DeckColors.bg)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        // Bars only: the network's name is on the Wifi screen a tap away and only crowds the bar.
        if (showWifi) {
            Chip(
                text = if (wifi.connected) bars(wifi.bars) else "no wifi",
                dot = if (wifi.connected) DeckColors.ok else DeckColors.crit,
                onClick = onWifi,
                modifier = Modifier.semantics { contentDescription = "$WIFI_CHIP ${wifi.ssid ?: "off"}" }
            )
        }
        // The wide dock has no bottom bar, so its gear lives up here beside the wifi chip.
        if (onSettings != null) {
            Chip(
                text = GEAR,
                dot = null,
                onClick = onSettings,
                modifier = Modifier.semantics { contentDescription = SETTINGS_CHIP }
            )
        }

        // Everything between wifi and the clock shares one flexible region, so the clock keeps its
        // width and never wraps a character per line when two machine chips crowd it. While an
        // alert is up it takes the words and the machines shrink to their dots, so the drill-in
        // and the health colours stay reachable at the moment they matter most.
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)
        ) {
            if (alertChip != null) {
                Chip(
                    text = alertChip,
                    dot = DeckColors.warn,
                    tint = DeckColors.warn,
                    modifier = Modifier.weight(1f, fill = false)
                )
            }
            machines.forEach { machine ->
                val name = Format.hostShort(machine.name ?: machine.config.name)
                Chip(
                    text = if (alertChip == null) name else "",
                    dot = dotColor(machine.health),
                    onClick = { onMachine(machine.config.id) },
                    modifier = Modifier
                        .then(if (alertChip == null) Modifier.weight(1f, fill = false) else Modifier)
                        .semantics { contentDescription = "$MACHINE_CHIP $name" }
                )
            }
        }

        Text(
            text = Format.clock(clock, zone, use24h),
            color = DeckColors.fg,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp,
            maxLines = 1,
            softWrap = false
        )
    }
}

/** A pill: 1 dp `line` border on `surface`, a 7 dp status dot, mono 11 sp text. */
@Composable
fun Chip(
    text: String,
    dot: Color?,
    modifier: Modifier = Modifier,
    tint: Color = DeckColors.fg,
    onClick: (() -> Unit)? = null
) {
    val shape = RoundedCornerShape(999.dp)
    Row(
        modifier = modifier
            .clip(shape)
            .background(DeckColors.surface)
            .border(1.dp, if (tint == DeckColors.fg) DeckColors.line else tint.copy(alpha = 0.35f), shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (dot != null) {
            Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(dot))
        }
        if (text.isNotEmpty()) {
            Text(
                text = text,
                color = tint,
                fontFamily = DeckType.mono,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

/** Prefix of every machine chip's content description, so tests and talkback can find one by name. */
const val MACHINE_CHIP = "machine"

/** Content description prefix of the wifi chip; the SSID follows it, since the text is bars only. */
const val WIFI_CHIP = "wifi"

/** Content description of the status-bar gear (wide dock only). */
const val SETTINGS_CHIP = "settings"

/** The gear glyph on the home screens; Settings is where wifi, display and sound live now. */
const val GEAR = "⚙"

private fun dotColor(health: Health): Color = when (health) {
    Health.FRESH -> DeckColors.ok
    Health.STALE -> DeckColors.warn
    Health.DEAD -> DeckColors.dim
}

/** Four signal bars as block characters, so the chip needs no icon assets. */
private fun bars(level: Int): String {
    val filled = level.coerceIn(0, 4)
    return "▂▄▆█".take(filled).padEnd(4, '·')
}
