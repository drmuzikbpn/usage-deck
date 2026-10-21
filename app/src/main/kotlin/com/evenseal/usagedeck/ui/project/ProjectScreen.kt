// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.project

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.core.model.ProjectView
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.core.model.Tokens
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.ui.components.BottomBar
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.components.PauseButton
import com.evenseal.usagedeck.ui.components.PauseChoiceDefaults
import com.evenseal.usagedeck.ui.components.PauseChoiceDialog
import com.evenseal.usagedeck.ui.components.PauseVisual
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

private val SINCE: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", Locale.UK)

/**
 * One repo on one machine (spec §11.3). The three tiles deliberately stop at what the daemon
 * can actually answer: the 5 h window is account-wide and rolling, so there is no honest
 * per-project share of it and the screen does not invent one.
 */
@Composable
fun ProjectScreen(vm: DeckViewModel, machineId: String, key: String, onBack: () -> Unit) {
    val team by vm.team.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    val project = team.projects.firstOrNull { it.machineId == machineId && it.key == key }
    val target = PauseTarget.Project(machineId, key)

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        Header(project = project, key = key, onBack = onBack)

        if (project == null) {
            Text(
                modifier = Modifier.padding(10.dp),
                text = "That project is no longer reported by this machine.",
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = 13.sp
            )
            return@Column
        }

        Tiles(vm = vm, project = project)

        BurnChart(
            series = vm.projectSeries(machineId, key),
            modifier = Modifier.fillMaxWidth().height(120.dp).padding(horizontal = 10.dp, vertical = 6.dp)
        )

        TokenBreakdown(tokens = project.liveTokens)

        LazyColumn(modifier = Modifier.weight(1f)) {
            items(project.sessions, key = { it.sessionId }) { session ->
                SessionDetailRow(vm = vm, machineId = machineId, session = session, now = now)
            }
        }

        val visual = vm.visual(target)
        val inherited = visual as? PauseVisual.Inherited
        val paused = visual is PauseVisual.Soft || visual is PauseVisual.Frozen
        var choosing by remember { mutableStateOf(false) }
        BottomBar(
            primary = when (inherited?.source) {
                PauseVisual.Inherited.ALL -> "Resume all"
                PauseVisual.Inherited.PROJECT -> "Paused by project"
                else -> if (paused) PauseChoiceDefaults.RESUME else PauseChoiceDefaults.BUTTON
            },
            primaryDanger = !paused && inherited == null,
            onPrimary = {
                when (inherited?.source) {
                    PauseVisual.Inherited.ALL -> vm.tap(PauseTarget.All)
                    PauseVisual.Inherited.PROJECT -> Unit
                    else -> if (paused) vm.tap(target) else choosing = true
                }
            },
            onPrimaryHold = null,
            secondary = emptyList()
        )
        if (choosing) {
            PauseChoiceDialog(
                subject = "${project.name} · ${project.sessions.size} " +
                    if (project.sessions.size == 1) "session" else "sessions",
                onSoft = { vm.tap(target) },
                onFreeze = { vm.hold(target) },
                onDismiss = { choosing = false }
            )
        }
    }
}

@Composable
private fun Header(project: ProjectView?, key: String, onBack: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(DeckColors.surface)
            .clickable(onClick = onBack)
            .padding(horizontal = 10.dp, vertical = 6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = "‹",
                color = DeckColors.accent,
                fontFamily = DeckType.text,
                fontSize = 18.sp
            )
            Text(
                text = project?.name ?: key.substringAfterLast('/'),
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp
            )
            if (project != null && project.worktreeCount > 1) {
                Text(
                    text = "${project.worktreeCount} worktrees",
                    color = DeckColors.muted,
                    fontFamily = DeckType.mono,
                    fontSize = 11.sp
                )
            }
        }
        Text(
            text = key,
            color = DeckColors.dim,
            fontFamily = DeckType.mono,
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun Tiles(vm: DeckViewModel, project: ProjectView) {
    val today = project.todayTokens?.total ?: project.liveTokens.total
    val rate = project.sessions.sumOf { vm.rate(project.machineId, it.sessionId) }
    val machineToday = vm.machineToday(project.machineId)?.total ?: 0L

    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Tile(label = "today", value = Format.tokens(today), modifier = Modifier.weight(1f))
        Tile(label = "rate", value = Format.ratePerMin(rate), modifier = Modifier.weight(1f))
        Tile(label = "share of today", value = share(today, machineToday), modifier = Modifier.weight(1f))
    }
}

/** `—` rather than a divide-by-zero fiction when the machine has not reported today's spend. */
internal fun share(projectToday: Long, machineToday: Long): String =
    if (machineToday <= 0L) "—" else "${(projectToday * 100.0 / machineToday).roundToInt()}%"

@Composable
private fun Tile(label: String, value: String, modifier: Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(DeckColors.surface)
            .padding(horizontal = 8.dp, vertical = 6.dp)
    ) {
        Text(
            text = label,
            color = DeckColors.dim,
            fontFamily = DeckType.text,
            fontSize = 10.sp
        )
        Text(
            text = value,
            color = DeckColors.fg,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.SemiBold,
            fontSize = 24.sp
        )
    }
}

@Composable
private fun TokenBreakdown(tokens: Tokens) {
    val cacheShare = if (tokens.total == 0L) 0 else ((tokens.cacheRead + tokens.cacheCreate) * 100 / tokens.total)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(DeckColors.surface2)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        listOf(
            "in ${Format.tokens(tokens.input)}",
            "out ${Format.tokens(tokens.output)}",
            "cache $cacheShare%",
            "msgs ${tokens.messages}"
        ).forEach { text ->
            Text(text = text, color = DeckColors.muted, fontFamily = DeckType.mono, fontSize = 11.sp)
        }
    }
}

@Composable
private fun SessionDetailRow(vm: DeckViewModel, machineId: String, session: Session, now: Instant) {
    val target = PauseTarget.Session(machineId, session.sessionId)
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "${Format.shortId(session.sessionId)} · since ${SINCE.format(
                    session.startedAt.atZone(ZoneId.systemDefault())
                )}",
                color = DeckColors.fg,
                fontFamily = DeckType.mono,
                fontSize = 12.sp
            )
            Text(
                text = activityLine(session, now),
                color = DeckColors.dim,
                fontFamily = DeckType.text,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        PauseButton(
            visual = vm.visual(target),
            onTap = { vm.tap(target) },
            onHold = { vm.hold(target) }
        )
    }
}

/** The daemon does not always report `lastTool`; falling back to raw activity is honest. */
internal fun activityLine(session: Session, now: Instant): String {
    val tool = session.lastTool
    return if (tool != null) {
        "last tool ${tool.name} ${Format.age(tool.at, now)}"
    } else {
        "last activity ${Format.age(session.lastActivityAt, now)}"
    }
}
