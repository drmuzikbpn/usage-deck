// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.ledger

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.ProjectView
import com.evenseal.usagedeck.core.model.UserView
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.ui.Route
import com.evenseal.usagedeck.ui.components.BottomBar
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.components.GEAR
import com.evenseal.usagedeck.ui.components.HoldTimeout
import com.evenseal.usagedeck.ui.components.HomeEmpty
import com.evenseal.usagedeck.ui.components.HomeEmptyBody
import com.evenseal.usagedeck.ui.components.LimitBar
import com.evenseal.usagedeck.ui.components.PauseButton
import com.evenseal.usagedeck.ui.components.PauseVisual
import com.evenseal.usagedeck.ui.components.REORDER_SLIDE
import com.evenseal.usagedeck.ui.components.RenameDialog
import com.evenseal.usagedeck.ui.components.RepairCard
import com.evenseal.usagedeck.ui.components.SessionRow
import com.evenseal.usagedeck.ui.components.Sparkline
import com.evenseal.usagedeck.ui.components.StatusBar
import com.evenseal.usagedeck.ui.components.Tag
import com.evenseal.usagedeck.ui.components.identity
import com.evenseal.usagedeck.ui.components.liftOnReorder
import com.evenseal.usagedeck.ui.components.rowRank
import com.evenseal.usagedeck.ui.components.usersWithData
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant

/** Portrait home (spec §11.1): who is burning what, right now, grouped by project. */
@Composable
fun LedgerScreen(vm: DeckViewModel, onOpen: (Route) -> Unit) {
    val team by vm.team.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    val wifi by vm.wifi.collectAsStateWithLifecycle()
    val chip by vm.alertChip.collectAsStateWithLifecycle()
    val prefs by vm.settings.collectAsStateWithLifecycle()
    val expanded by vm.expanded.collectAsStateWithLifecycle()

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        StatusBar(
            wifi = wifi,
            machines = team.machines,
            clock = now,
            alertChip = chip,
            onWifi = { onOpen(Route.Wifi) },
            onMachine = { id -> onOpen(Route.Machine(id)) },
            use24h = prefs.clock24h
        )

        val empty = HomeEmpty.of(team)

        // A machine that rejected this deck is the first thing to see, above the quotas.
        team.needsRepair.forEach { machine ->
            RepairCard(
                machine = machine,
                onRepair = { id -> onOpen(Route.Repair(id)) }
            )
        }

        var renaming by remember { mutableStateOf<UserView?>(null) }
        renaming?.let { user ->
            RenameDialog(
                user = user,
                current = prefs.renameFor(user).orEmpty(),
                onSave = { name ->
                    vm.renameUser(user.key, name)
                    renaming = null
                },
                onDismiss = { renaming = null }
            )
        }
        team.usersWithData().forEach { user ->
            UserBlock(
                user = user,
                name = prefs.nameFor(user),
                now = now,
                use24h = prefs.clock24h,
                expanded = DeckViewModel.userId(user.key) in expanded,
                onToggle = { vm.toggleUserExpanded(user.key) },
                onRename = { renaming = user }
            )
        }

        if (empty is HomeEmpty.NoMachines || empty is HomeEmpty.Connecting || empty is HomeEmpty.AllNeedRepair) {
            HomeEmptyBody(
                empty = empty,
                now = now,
                onPair = { onOpen(Route.Pairing) },
                modifier = Modifier.weight(1f)
            )
        } else {
            SessionsHeader(liveCount = team.liveSessionCount)

            if (empty is HomeEmpty.NoSessions) {
                HomeEmptyBody(
                    empty = empty,
                    now = now,
                    onPair = { onOpen(Route.Pairing) },
                    modifier = Modifier.weight(1f)
                )
            } else {
                LazyColumn(modifier = Modifier.weight(1f)) {
                    // Rows rank by project so folding a block or a new session elsewhere does not
                    // register as a move for everything beneath it.
                    vm.projectsByActivity(team).forEachIndexed { rank, project ->
                        val open = DeckViewModel.projectId(project.machineId, project.key) in expanded
                        item(key = "h:${project.machineId}:${project.key}") {
                            ProjectHeader(
                                vm = vm,
                                project = project,
                                now = now,
                                expanded = open,
                                onToggle = { vm.toggleExpanded(project.machineId, project.key) },
                                onOpen = onOpen,
                                modifier = Modifier.animateItem(
                                    placementSpec = REORDER_SLIDE
                                ).liftOnReorder(rowRank(rank, 0))
                            )
                        }
                        if (!open) return@forEachIndexed
                        itemsIndexed(
                            project.sessions,
                            key = { _, it -> "${project.machineId}:${it.sessionId}" }
                        ) { i, session ->
                            val target = PauseTarget.Session(project.machineId, session.sessionId)
                            SessionRow(
                                session = session,
                                rate = vm.rate(project.machineId, session.sessionId),
                                series = vm.series(project.machineId, session.sessionId),
                                machineName = null,
                                visual = vm.visual(target),
                                now = now,
                                onTap = { vm.tap(target) },
                                onHold = { vm.hold(target) },
                                onOpen = { onOpen(Route.Project(project.machineId, project.key)) },
                                modifier = Modifier.animateItem(
                                    placementSpec = REORDER_SLIDE
                                ).liftOnReorder(rowRank(rank, i + 1))
                            )
                        }
                    }
                }
            }
        }

        val allVisual = vm.visual(PauseTarget.All)
        val allPaused = allVisual is PauseVisual.Soft || allVisual is PauseVisual.Frozen
        BottomBar(
            primary = if (allPaused) "Resume all" else "Pause all",
            primaryDanger = false,
            onPrimary = { vm.tap(PauseTarget.All) },
            onPrimaryHold = if (allPaused) null else ({ vm.hold(PauseTarget.All) }),
            secondary = homeSecondary(empty, onOpen)
        )
    }
}

/** With nothing paired, "Projects" is a dead end; offer "Pair" in its place. */
internal fun homeNavigation(empty: HomeEmpty?, onOpen: (Route) -> Unit): Pair<String, () -> Unit> =
    if (empty is HomeEmpty.NoMachines) {
        "Pair" to { onOpen(Route.Pairing) }
    } else {
        "Projects" to { onOpen(Route.Projects) }
    }

/** The portrait bottom bar's secondaries: the navigation button, then the gear (wifi lives in Settings). */
internal fun homeSecondary(empty: HomeEmpty?, onOpen: (Route) -> Unit): List<Pair<String, () -> Unit>> =
    listOf(homeNavigation(empty, onOpen), GEAR to { onOpen(Route.Settings) })

/**
 * A person's quota. Long-press renames the person. Folded (the default) it is one line — name, then the 5 h and 7 d percentages —
 * so two people cost the sessions list two rows, not half the screen. Tapping unfolds the full
 * block: e-mail, both bars with their resets, and any model-scoped windows. A teammate's block
 * fades to 55 % once their machine stops checking in (spec §11.1).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun UserBlock(
    user: UserView,
    name: String,
    now: Instant,
    expanded: Boolean,
    onToggle: () -> Unit,
    /** Reset times follow the deck's clock style. */
    use24h: Boolean = true,
    modifier: Modifier = Modifier,
    /** Long-press on the row; the Ledger opens the rename dialog. */
    onRename: () -> Unit = {}
) {
    val faded = user.health != Health.FRESH
    HoldTimeout {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .alpha(if (faded) STALE_ALPHA else 1f)
                .combinedClickable(onClick = onToggle, onLongClick = onRename)
                .semantics { contentDescription = "${if (expanded) "collapse" else "expand"} $name" }
                .padding(
                    start = 6.dp,
                    end = 10.dp,
                    top = if (expanded) 8.dp else 5.dp,
                    bottom = if (expanded) 8.dp else 5.dp
                ),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = if (expanded) "▾" else "▸",
                    color = DeckColors.dim,
                    fontFamily = DeckType.text,
                    fontSize = 12.sp,
                    modifier = Modifier.width(12.dp)
                )
                Text(
                    text = name,
                    color = DeckColors.fg,
                    fontFamily = DeckType.text,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 15.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (expanded) {
                    Text(
                        text = if (faded) "last seen ${Format.age(user.limitsFetchedAt, now)}" else user.identity,
                        color = DeckColors.dim,
                        fontFamily = DeckType.mono,
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.End,
                        modifier = Modifier.weight(1f)
                    )
                } else {
                    Spacer(modifier = Modifier.weight(1f))
                    if (faded) {
                        Text(
                            text = "last seen ${Format.age(user.limitsFetchedAt, now)}",
                            color = DeckColors.dim,
                            fontFamily = DeckType.mono,
                            fontSize = 10.sp,
                            maxLines = 1
                        )
                    }
                    QuotaGlance(label = "5h", limit = user.fiveHour)
                    QuotaGlance(label = "7d", limit = user.sevenDay)
                }
            }
            if (expanded) {
                LimitBar(label = "5h", limit = user.fiveHour, now = now, use24h = use24h)
                LimitBar(label = "7d", limit = user.sevenDay, now = now, use24h = use24h)
                if (user.scoped.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        user.scoped.forEach { limit ->
                            Tag(
                                text = "${limit.scopeModel ?: limit.id} ${limit.percent}%",
                                color = DeckColors.of(limit.status)
                            )
                        }
                    }
                }
            }
        }
    }
}

/** `5h 42%` at a glance for the folded user row; colour carries the window's status. */
@Composable
private fun QuotaGlance(label: String, limit: Limit?) {
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(text = label, color = DeckColors.muted, fontFamily = DeckType.mono, fontSize = 11.sp)
        Text(
            text = limit?.percent?.let { "$it%" } ?: "—",
            color = limit?.let { DeckColors.of(it.status) } ?: DeckColors.dim,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier.width(QUOTA_WIDTH)
        )
    }
}

@Composable
private fun SessionsHeader(liveCount: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(DeckColors.surface2)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            text = "Sessions · $liveCount live",
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.Medium,
            fontSize = 12.sp
        )
        Text(
            text = "tokens/min · 30m",
            color = DeckColors.dim,
            fontFamily = DeckType.text,
            fontSize = 11.sp
        )
    }
}

/**
 * A project row is the collapsed summary of its sessions: name, worktree count, live count, the
 * project's own burn rate and 30-minute sparkline, and a pause control for the whole project.
 * Tapping the row expands it to the individual sessions; `›` opens the drill-in.
 */
@Composable
internal fun ProjectHeader(
    vm: DeckViewModel,
    project: ProjectView,
    now: Instant,
    expanded: Boolean,
    onToggle: () -> Unit,
    onOpen: (Route) -> Unit,
    modifier: Modifier = Modifier
) {
    val target = PauseTarget.Project(project.machineId, project.key)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .semantics { contentDescription = "${if (expanded) "collapse" else "expand"} ${project.name}" }
            .padding(start = 6.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(
            text = if (expanded) "▾" else "▸",
            color = DeckColors.dim,
            fontFamily = DeckType.text,
            fontSize = 12.sp,
            modifier = Modifier.width(12.dp)
        )
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = project.name,
                    color = DeckColors.fg,
                    fontFamily = DeckType.text,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (project.worktreeCount > 1) Tag(text = "${project.worktreeCount} wt")
                Tag(text = "${project.sessions.size} live")
            }
            if (!expanded) {
                Text(
                    text = "${Format.tokens(project.liveTokens.total)} today",
                    color = DeckColors.muted,
                    fontFamily = DeckType.text,
                    fontSize = 11.sp
                )
            }
        }
        Text(
            text = Format.ratePerMin(vm.projectRate(project.machineId, project.key)),
            color = DeckColors.muted,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp,
            textAlign = TextAlign.End,
            modifier = Modifier.width(74.dp)
        )
        Sparkline(
            series = vm.projectSparkline(project.machineId, project.key),
            modifier = Modifier.width(64.dp).height(20.dp)
        )
        PauseButton(
            visual = vm.visual(target),
            onTap = { vm.tap(target) },
            onHold = { vm.hold(target) }
        )
        Text(
            text = "›",
            color = DeckColors.accent,
            fontFamily = DeckType.text,
            fontSize = 22.sp,
            modifier = Modifier
                .clickable { onOpen(Route.Project(project.machineId, project.key)) }
                .semantics { contentDescription = "open ${project.name}" }
                .padding(horizontal = 8.dp, vertical = 4.dp)
        )
    }
}

private const val STALE_ALPHA = 0.55f
private val QUOTA_WIDTH = 44.dp
