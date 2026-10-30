// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.demo.DemoDeck
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/** The one line that says these numbers are made up, and the way out of them. */
@Composable
fun DemoBanner(demo: DemoDeck) {
    val active by demo.active.collectAsStateWithLifecycle()
    if (!active) return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(DeckColors.surface)
            .padding(start = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "Demo · made-up data",
            color = DeckColors.warn,
            fontFamily = DeckType.text,
            fontSize = 12.sp,
            modifier = Modifier.weight(1f)
        )
        Text(
            text = "Exit",
            color = DeckColors.accent,
            fontFamily = DeckType.text,
            fontSize = 12.sp,
            modifier = Modifier
                .clickable { demo.stop() }
                .padding(horizontal = 14.dp, vertical = 8.dp)
        )
    }
}
