// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.widedock

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.UserView
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.ui.Route
import com.evenseal.usagedeck.ui.components.DeckButton
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.components.HomeEmpty
import com.evenseal.usagedeck.ui.components.HomeEmptyBody
import com.evenseal.usagedeck.ui.components.MachineWaitRow
import com.evenseal.usagedeck.ui.components.PauseVisual
import com.evenseal.usagedeck.ui.components.PrimaryButton
import com.evenseal.usagedeck.ui.components.REORDER_SLIDE
import com.evenseal.usagedeck.ui.components.RepairCard
import com.evenseal.usagedeck.ui.components.SessionRow
import com.evenseal.usagedeck.ui.components.StatusBar
import com.evenseal.usagedeck.ui.components.liftOnReorder
import com.evenseal.usagedeck.ui.components.usersWithData
import com.evenseal.usagedeck.ui.ledger.homeNavigation
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant
import java.time.ZoneId

/**
 * Landscape home (spec §11.2). The rail carries numbers big enough to read from the other side
 * of the room plus the home actions; the gear sits in the status bar and the sessions list takes
 * the whole right pane. Alerts land in the status bar rather than as a banner so nothing reflows.
 */
@Composable
fun WideDockScreen(vm: DeckViewModel, onOpen: (Route) -> Unit) {
    val team by vm.team.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    val wifi by vm.wifi.collectAsStateWithLifecycle()
    val chip by vm.alertChip.collectAsStateWithLifecycle()
    val prefs by vm.settings.collectAsStateWithLifecycle()
    val empty = HomeEmpty.of(team)
    val showMachine = team.machines.size > 1

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        StatusBar(
            wifi = wifi,
            machines = team.machines,
            clock = now,
            alertChip = chip,
            onWifi = { onOpen(Route.Wifi) },
            onMachine = { id -> onOpen(Route.Machine(id)) },
            use24h = prefs.clock24h,
            onSettings = { onOpen(Route.Settings) }
        )

        Row(modifier = Modifier.weight(1f)) {
            Rail(
                team = team,
                now = now,
                nameOf = prefs::nameFor,
                use24h = prefs.clock24h,
                modifier = Modifier.width(RAIL_WIDTH).fillMaxHeight()
            ) {
                RailActions(
                    paused = vm.visual(PauseTarget.All).let { it is PauseVisual.Soft || it is PauseVisual.Frozen },
                    onPauseAll = { vm.tap(PauseTarget.All) },
                    onPauseAllHold = { vm.hold(PauseTarget.All) },
                    navigation = homeNavigation(empty, onOpen)
                )
            }

            Column(modifier = Modifier.weight(1f).fillMaxHeight()) {
                team.needsRepair.forEach { machine ->
                    RepairCard(machine = machine, onRepair = { id -> onOpen(Route.Repair(id)) })
                }
                if (empty != null) {
                    HomeEmptyBody(
                        empty = empty,
                        now = now,
                        onPair = { onOpen(Route.Pairing) },
                        modifier = Modifier.weight(1f)
                    )
                } else {
                    ColumnHeader(liveCount = team.liveSessionCount)
                    // One flat list, busiest session first; a row's rank is its place in it.
                    val rows = vm.sessionsByActivity(
                        team
                    ).mapIndexed { rank, row -> Triple(row.project, row.session, rank) }
                    LazyColumn(modifier = Modifier.weight(1f)) {
                        items(
                            rows,
                            key = { (project, session, _) -> "${project.machineId}:${session.sessionId}" }
                        ) { (project, session, rank) ->
                            val target = PauseTarget.Session(project.machineId, session.sessionId)
                            SessionRow(
                                session = session,
                                rate = vm.rate(project.machineId, session.sessionId),
                                series = vm.series(project.machineId, session.sessionId),
                                machineName = if (showMachine) team.machine(project.machineId)?.name else null,
                                visual = vm.visual(target),
                                now = now,
                                onTap = { vm.tap(target) },
                                onHold = { vm.hold(target) },
                                onOpen = { onOpen(Route.Project(project.machineId, project.key)) },
                                modifier = Modifier.animateItem(placementSpec = REORDER_SLIDE).liftOnReorder(rank),
                                headline = project.name,
                                compact = true
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The mockup's column captions: what the list is, and what the two numeric columns mean. */
@Composable
private fun ColumnHeader(liveCount: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(DeckColors.surface2)
            .padding(horizontal = 10.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "Sessions · $liveCount",
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.Medium,
            fontSize = 11.sp,
            modifier = Modifier.weight(1f)
        )
        Text(
            text = "tok/min · 30m",
            color = DeckColors.dim,
            fontFamily = DeckType.text,
            fontSize = 10.sp
        )
    }
}

@Composable
private fun Rail(
    team: TeamState,
    now: Instant,
    nameOf: (UserView) -> String,
    use24h: Boolean,
    modifier: Modifier,
    actions: @Composable () -> Unit
) {
    Column(
        modifier = modifier
            .drawBehind {
                drawLine(
                    color = DeckColors.line,
                    start = Offset(size.width, 0f),
                    end = Offset(size.width, size.height),
                    strokeWidth = 1.dp.toPx()
                )
            }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        val users = team.usersWithData()
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // Quotas are per account, so only separate accounts are worth paging between. Several
            // machines signed into one account are one quota and stay one block: swiping there
            // would deal the same two numbers twice.
            when {
                users.isEmpty() -> {
                    Text(
                        text = if (team.machines.isEmpty()) "nothing paired" else "waiting for data",
                        color = DeckColors.dim,
                        fontFamily = DeckType.text,
                        fontSize = 12.sp
                    )
                    team.machines.forEach { MachineWaitRow(machine = it, now = now, compact = true) }
                }
                users.size == 1 ->
                    RailUser(user = users.first(), name = nameOf(users.first()), now = now, use24h = use24h)
                else -> AccountPager(users = users, nameOf = nameOf, now = now, use24h = use24h)
            }
        }

        actions()

        Text(
            text = "team today ${Format.tokens(team.teamToday.total)} · ${team.liveSessionCount} live",
            color = DeckColors.dim,
            fontFamily = DeckType.mono,
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/**
 * The home actions live at the foot of the rail rather than under the sessions list, so the
 * list runs the full height of the screen. Stacked, because the rail is too narrow for both
 * labels side by side at a readable size.
 */
@Composable
private fun RailActions(
    paused: Boolean,
    onPauseAll: () -> Unit,
    onPauseAllHold: () -> Unit,
    navigation: Pair<String, () -> Unit>
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        PrimaryButton(
            label = if (paused) "Resume all" else "Pause all",
            danger = false,
            onPrimary = onPauseAll,
            onPrimaryHold = if (paused) null else onPauseAllHold,
            modifier = Modifier.fillMaxWidth(),
            pad = 6.dp,
            centered = true
        )
        DeckButton(
            label = navigation.first,
            onClick = navigation.second,
            modifier = Modifier.fillMaxWidth(),
            pad = 6.dp
        )
    }
}

/**
 * One page per account, because each carries its own quota. The name sits above the rings on every
 * page, and the dots say how many accounts there are and which one is in hand.
 */
@Composable
private fun AccountPager(users: List<UserView>, nameOf: (UserView) -> String, now: Instant, use24h: Boolean) {
    val state = rememberPagerState(pageCount = { users.size })
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HorizontalPager(
            state = state,
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = ACCOUNT_PAGER }
        ) { page ->
            val user = users[page]
            RailUser(user = user, name = nameOf(user), now = now, use24h = use24h)
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally)
        ) {
            users.indices.forEach { i ->
                Box(
                    modifier = Modifier
                        .size(PAGE_DOT)
                        .clip(CircleShape)
                        .background(if (i == state.currentPage) DeckColors.muted else DeckColors.line)
                )
            }
        }
    }
}

@Composable
private fun RailUser(user: UserView, name: String, now: Instant, use24h: Boolean) {
    val faded = user.health != Health.FRESH
    Column(modifier = Modifier.fillMaxWidth().alpha(if (faded) STALE_ALPHA else 1f)) {
        Text(
            text = name.uppercase(),
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.SemiBold,
            fontSize = 11.sp,
            letterSpacing = 1.2.sp
        )
        // Each figure sits centred in a ring that closes as the window fills (a full circle is
        // 100 %); the two rings share a bottom edge and each counts down to its own reset.
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RingNumber(limit = user.fiveHour, size = FIVE_HOUR_SP, ring = FIVE_HOUR_RING, now = now, use24h = use24h)
            RingNumber(limit = user.sevenDay, size = SEVEN_DAY_SP, ring = SEVEN_DAY_RING, now = now, use24h = use24h)
        }
    }
}

/**
 * The percent alone is the headline; no `%` sign, colour carries the state (mockup D). The ring
 * behind it is the same percent as an arc from twelve o'clock, on a faint full-circle track.
 */
@Composable
private fun RingNumber(
    limit: Limit?,
    size: Int,
    ring: Dp,
    now: Instant,
    use24h: Boolean,
    modifier: Modifier = Modifier
) {
    val color = limit?.let { DeckColors.of(it.status) } ?: DeckColors.dim
    val fraction = (limit?.percent ?: 0).coerceIn(0, 100) / 100f
    val track = DeckColors.line
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Box(modifier = Modifier.size(ring), contentAlignment = Alignment.Center) {
            Canvas(modifier = Modifier.matchParentSize()) {
                val stroke = RING_STROKE.toPx()
                val inset = stroke / 2
                val arcSize = Size(this.size.width - stroke, this.size.height - stroke)
                drawArc(track, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
                if (fraction > 0f) {
                    drawArc(
                        color,
                        -90f,
                        360f * fraction,
                        false,
                        Offset(inset, inset),
                        arcSize,
                        style = Stroke(stroke, cap = StrokeCap.Round)
                    )
                }
            }
            Text(
                text = limit?.percent?.toString() ?: "—",
                color = color,
                fontFamily = DeckType.numeral,
                fontWeight = FontWeight.SemiBold,
                fontSize = size.sp,
                lineHeight = size.sp
            )
        }
        Text(
            text = Format.resetCountdown(limit?.resetsAt, now),
            color = DeckColors.dim,
            fontFamily = DeckType.mono,
            fontSize = 11.sp,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier
                .wrapContentWidth(unbounded = true)
                .semantics { contentDescription = "$RESET_COUNTDOWN ${limit?.id ?: "none"}" }
        )
        Text(
            text = Format.resetAt(limit?.resetsAt, now, ZoneId.systemDefault(), use24h),
            color = DeckColors.dim,
            fontFamily = DeckType.mono,
            fontSize = 10.sp,
            maxLines = 1,
            softWrap = false,
            // "Thu 2:00 AM" is wider than the 7 d ring; let it centre under the ring rather than clip.
            modifier = Modifier.wrapContentWidth(unbounded = true)
        )
    }
}

/** Content description of the account pager; absent entirely when there is only one account. */
const val ACCOUNT_PAGER = "accounts"

private val RAIL_WIDTH = 200.dp
private val PAGE_DOT = 5.dp
private const val STALE_ALPHA = 0.55f
private const val FIVE_HOUR_SP = 56
private const val SEVEN_DAY_SP = 26
private val FIVE_HOUR_RING = 104.dp
private val SEVEN_DAY_RING = 60.dp
private val RING_STROKE = 5.dp

/** Content description prefix of a ring's reset countdown; the limit id follows. */
const val RESET_COUNTDOWN = "resets in"
