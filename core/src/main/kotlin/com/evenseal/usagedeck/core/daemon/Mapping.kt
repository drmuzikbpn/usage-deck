// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.Discovered
import com.evenseal.usagedeck.core.model.LastTool
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.LimitStatus
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.PauseRule
import com.evenseal.usagedeck.core.model.PauseState
import com.evenseal.usagedeck.core.model.ProjectTokens
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.core.model.Tokens
import com.evenseal.usagedeck.core.model.UpdateState
import com.evenseal.usagedeck.core.model.User
import java.time.Instant

internal fun String?.toInstantOrNull(): Instant? = this?.let { runCatching { Instant.parse(it) }.getOrNull() }

internal fun String.toInstantOr(default: Instant): Instant = toInstantOrNull() ?: default

fun TokensCountsDto.toModel() = Tokens(input, output, cacheCreate, cacheRead, messages)

fun TokensGroupDto.toModel() = ProjectTokens(key, label, Tokens(input, output, cacheCreate, cacheRead, messages))

fun UserDto.toModel() = User(emailAddress, accountUuid, displayName, organizationUuid, organizationName)

fun UpdateDto.toModel() = UpdateState(channel, current, available, state, deferredReason)

fun statusOf(s: String?): LimitStatus = when (s?.lowercase()) {
    "warn" -> LimitStatus.WARN
    "critical" -> LimitStatus.CRITICAL
    else -> LimitStatus.OK
}

private val CRITICAL_SEVERITIES = setOf(
    "critical",
    "severe",
    "exceeded",
    "exhausted",
    "blocked",
    "locked",
    "limit_reached",
    "over_limit"
)

/**
 * Status for a row of a bare `limits` event, which has no `status.byId` map.
 * Mirrors daemon spec §23.3: critical on percent or a critical-like severity, warn on percent
 * or any non-`normal` severity.
 */
fun statusFor(limit: LimitDto, thresholds: ThresholdsDto): LimitStatus {
    val severity = limit.severity.lowercase()
    val percent = limit.percent ?: 0
    return when {
        percent >= thresholds.critical || severity in CRITICAL_SEVERITIES -> LimitStatus.CRITICAL
        percent >= thresholds.warn || severity != "normal" -> LimitStatus.WARN
        else -> LimitStatus.OK
    }
}

fun LimitDto.toModel(status: LimitStatus) =
    Limit(id, kind, group, percent ?: 0, severity, resetsAt.toInstantOrNull(), scope?.model, isActive, status)

/** A scoped row with no number is left out: it would otherwise read as a confident 0%. */
fun List<LimitDto>.withoutUnknownScoped() = filterNot { it.kind == "weekly_scoped" && it.percent == null }

fun SummaryDto.toLimits(): List<Limit> =
    limits.limits.withoutUnknownScoped().map { it.toModel(statusOf(status.byId[it.id])) }

fun PauseStateDto.toModel() = PauseState(
    if (mode == "hard") PauseMode.HARD else PauseMode.SOFT,
    ruleId,
    scope,
    since.toInstantOr(Instant.EPOCH),
    frozenPids,
    freezes
)

fun PauseRuleDto.toModel() = PauseRule(
    id,
    scope,
    if (mode == "hard") PauseMode.HARD else PauseMode.SOFT,
    reason,
    createdAt.toInstantOr(Instant.EPOCH),
    createdBy
)

fun SessionDto.toModel() = Session(
    sessionId = sessionId,
    pid = pid,
    alive = alive,
    discovered = if (discovered == "transcript") Discovered.TRANSCRIPT else Discovered.HOOK,
    cwd = cwd,
    transcriptPath = transcriptPath,
    projectKey = project.gitCommonDir ?: cwd,
    projectName = project.name.ifBlank { cwd.substringAfterLast('/') },
    worktree = worktree,
    model = model,
    startedAt = startedAt.toInstantOr(Instant.EPOCH),
    lastActivityAt = lastActivityAt.toInstantOr(Instant.EPOCH),
    tokens = tokens.toModel(),
    pause = pause?.toModel(),
    lastTool = lastTool?.let { LastTool(it.name, it.at.toInstantOr(Instant.EPOCH)) },
    title = title?.takeIf { it.isNotBlank() }
)
