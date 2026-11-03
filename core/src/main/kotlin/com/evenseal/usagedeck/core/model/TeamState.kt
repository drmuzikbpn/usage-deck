// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.model

import java.time.Instant

/**
 * One person's quota across however many machines they are logged into. Limits are per account
 * and organisation, so when the same account appears on two machines in the same org the copy
 * with the freshest `limitsFetchedAt` wins and both machine ids are listed; the same account in
 * two organisations is two quotas and stays two users.
 */
data class UserView(
    /** `accountUuid ?: emailAddress ?: machineId`, suffixed with `/organizationUuid` when known. */
    val key: String,
    val displayName: String,
    val emailAddress: String?,
    val organizationName: String?,
    val machineIds: List<String>,
    val limits: List<Limit>,
    val limitsFetchedAt: Instant?,
    /** Best health of the machines behind this user. */
    val health: Health
) {
    val fiveHour: Limit? get() = limits.firstOrNull { it.id == "session" }
    val sevenDay: Limit? get() = limits.firstOrNull { it.id == "weekly_all" }

    /**
     * Daemon §23.68: a week but no 5-hour window means the plan has none (Anthropic dropped it for
     * verified accounts on its top plan). Show "no limit", not the `—` of a reading not yet in.
     * Derived from `limits[]` exactly as the daemon derives its `noSessionLimit`, so older daemons
     * get it too.
     */
    val noFiveHourLimit: Boolean get() = fiveHour == null && sevenDay != null
    val scoped: List<Limit> get() = limits.filter { it.kind == "weekly_scoped" }
}

/**
 * One repo on one machine. Worktrees of the same repo roll up because the daemon keys projects
 * by `gitCommonDir`; the same repo cloned on two machines is deliberately two projects.
 */
data class ProjectView(
    val machineId: String,
    val key: String,
    val name: String,
    val sessions: List<Session>,
    val todayTokens: Tokens?,
    val worktreeCount: Int
) {
    val liveTokens: Tokens get() = sessions.fold(Tokens.ZERO) { a, s -> a + s.tokens }
    val isIdle: Boolean get() = sessions.none { it.alive }

    /** The most severe pause across the project's sessions; HARD beats SOFT. */
    val pause: PauseState? get() = sessions.mapNotNull { it.pause }.maxByOrNull { it.mode.ordinal }
}

/**
 * The merged view of every paired machine. A machine that is [MachineState.gone] (silent for a
 * day) stays in [machines] but is left out of everything derived from them: users, projects and
 * the totals.
 */
data class TeamState(val machines: List<MachineState> = emptyList()) {
    private val reporting: List<MachineState> get() = machines.filterNot { it.gone }

    val users: List<UserView> by lazy { buildUsers() }

    /** Live projects first (by live tokens, descending), then idle ones (by today's tokens). */
    val projects: List<ProjectView> by lazy { buildProjects() }

    val liveSessionCount: Int get() = reporting.sumOf { m -> m.sessions.count { it.alive } }

    val teamToday: Tokens get() = reporting.fold(Tokens.ZERO) { a, m -> a + m.today }

    /** Machines that rejected this deck (token rotated, certificate changed): the home card lists them. */
    val needsRepair: List<MachineState> get() = machines.filter { it.needsRepair != null }

    fun machine(id: String): MachineState? = machines.firstOrNull { it.config.id == id }

    fun session(machineId: String, sessionId: String): Session? =
        machine(machineId)?.sessions?.firstOrNull { it.sessionId == sessionId }

    private fun buildUsers(): List<UserView> = reporting.groupBy { userKey(it) }.map { (key, group) ->
        // Both daemons poll the same account and cache the answer for different lengths of time,
        // so the copy to show is the one fetched latest — and a machine that has no limits at all
        // never wins, or a failed fetch would blank a headline the other machine can still supply.
        val freshest = group.filter { it.limits.isNotEmpty() }.ifEmpty { group }
            .maxByOrNull { it.limitsFetchedAt ?: Instant.EPOCH }
        UserView(
            key = key,
            displayName = group.firstNotNullOfOrNull { displayNameOf(it) } ?: key,
            emailAddress = group.firstNotNullOfOrNull { it.user?.emailAddress },
            organizationName = group.firstNotNullOfOrNull { it.user?.organizationName },
            machineIds = group.map { it.config.id },
            limits = freshest?.limits.orEmpty(),
            limitsFetchedAt = freshest?.limitsFetchedAt,
            health = group.minOf { it.health }
        )
    }

    private fun userKey(m: MachineState): String {
        val account = m.user?.accountUuid?.takeIf { it.isNotBlank() }
            ?: m.user?.emailAddress?.takeIf { it.isNotBlank() }
            ?: m.config.id
        return m.user?.organizationUuid?.takeIf { it.isNotBlank() }?.let { "$account/$it" } ?: account
    }

    /** A bare e-mail is a poor headline; its local part reads like a name and fits the rail. */
    private fun displayNameOf(m: MachineState): String? = m.user?.displayName?.takeIf { it.isNotBlank() && '@' !in it }
        ?: m.user?.emailAddress?.substringBefore('@')
        ?: m.name
        ?: m.config.name

    private fun buildProjects(): List<ProjectView> {
        val live = mutableListOf<ProjectView>()
        val idle = mutableListOf<ProjectView>()
        reporting.forEach { m ->
            // Only sessions the daemon reports alive make it onto the board; transcript back-fill of
            // finished sessions is history, and history belongs to the tokens endpoint, not the rows.
            val byKey = m.sessions.filter { it.alive }.groupBy { it.projectKey }
            val liveCwds = m.sessions.filter { it.alive }.map { it.cwd }.toSet()
            byKey.forEach { (key, sessions) ->
                val cwds = sessions.map { it.cwd }.toSet()
                val today = m.projectTokens
                    .filter { it.label in cwds }
                    .fold(Tokens.ZERO) { a, p -> a + p.tokens }
                    .takeIf { m.projectTokens.any { p -> p.label in cwds } }
                live += ProjectView(
                    machineId = m.config.id,
                    key = key,
                    name = sessions.first().projectName,
                    sessions = sessions,
                    todayTokens = today,
                    worktreeCount = sessions.map { it.worktree }.distinct().size
                )
            }
            m.projectTokens.filter { it.label !in liveCwds }.forEach { p ->
                idle += ProjectView(
                    machineId = m.config.id,
                    key = p.label,
                    name = p.label.substringAfterLast('/'),
                    sessions = emptyList(),
                    todayTokens = p.tokens,
                    worktreeCount = 0
                )
            }
        }
        val (active, quiet) = live.partition { !it.isIdle }
        return active.sortedByDescending { it.liveTokens.total } +
            (quiet + idle)
                .filter { (it.todayTokens?.total ?: 0L) > 0L }
                .sortedByDescending { it.todayTokens?.total ?: 0L }
    }
}
