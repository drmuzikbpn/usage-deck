// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.daemon

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val DaemonJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    coerceInputValues = true
}

@Serializable
data class TokensCountsDto(
    val input: Long = 0,
    val output: Long = 0,
    val cacheCreate: Long = 0,
    val cacheRead: Long = 0,
    val messages: Long = 0,
    /** `summary.today` carries this; session/spend counts omit it and default to true. */
    val ready: Boolean = true
)

@Serializable
data class UserDto(
    val emailAddress: String? = null,
    val accountUuid: String? = null,
    val organizationUuid: String? = null,
    val organizationName: String? = null,
    val displayName: String? = null
)

@Serializable
data class UpdateDto(
    val channel: String = "stable",
    val current: String = "",
    val available: String? = null,
    val state: String = "idle",
    val deferredReason: String? = null
)

@Serializable
data class HealthDto(
    val ok: Boolean = true,
    val version: String = "",
    val uptimeMs: Long = 0,
    val pid: Int = 0,
    val name: String? = null,
    val user: UserDto? = null,
    val update: UpdateDto? = null
)

@Serializable
data class LimitScopeDto(val model: String? = null, val surface: String? = null)

@Serializable
data class LimitDto(
    val id: String,
    val kind: String,
    val group: String = "",
    /** `null` when the daemon has no current number for this row (§23.40, §23.67). */
    val percent: Int? = null,
    val severity: String = "normal",
    val resetsAt: String? = null,
    val scope: LimitScopeDto? = null,
    val isActive: Boolean = false
)

@Serializable
data class StatusDto(val byId: Map<String, String> = emptyMap(), val overall: String = "ok")

/**
 * The normalized limits body. It is the whole of `GET /v1/limits` and is nested under
 * `limits` in `GET /v1/summary`. `legacyWindows` and `extraUsage` are deliberately ignored.
 */
@Serializable
data class LimitsBodyDto(
    val limits: List<LimitDto> = emptyList(),
    val fetchedAt: String? = null,
    val stale: Boolean = false,
    val error: ErrorBodyDto? = null
)

@Serializable
data class ThresholdsDto(val warn: Int = 80, val critical: Int = 95)

@Serializable
data class SummaryDto(
    val limits: LimitsBodyDto = LimitsBodyDto(),
    val status: StatusDto = StatusDto(),
    val thresholds: ThresholdsDto = ThresholdsDto(),
    val today: TokensCountsDto = TokensCountsDto()
) {
    val fetchedAt: String? get() = limits.fetchedAt
    val stale: Boolean get() = limits.stale
}

@Serializable
data class ProjectRefDto(val gitCommonDir: String? = null, val name: String = "")

@Serializable
data class PauseStateDto(
    val mode: String,
    val ruleId: String,
    val scope: String,
    val since: String,
    val frozenPids: List<Int> = emptyList(),
    val freezes: Int = 0
)

@Serializable
data class LastToolDto(val name: String, val at: String)

@Serializable
data class SessionDto(
    val sessionId: String,
    val pid: Int? = null,
    val alive: Boolean = true,
    val discovered: String = "hook",
    val cwd: String,
    val transcriptPath: String? = null,
    val project: ProjectRefDto = ProjectRefDto(),
    val worktree: String? = null,
    val model: String? = null,
    val startedAt: String,
    val lastActivityAt: String,
    val tokens: TokensCountsDto = TokensCountsDto(),
    val pause: PauseStateDto? = null,
    val lastTool: LastToolDto? = null,
    val title: String? = null
)

@Serializable
data class SessionsDto(val rev: Long = 0, val sessions: List<SessionDto> = emptyList())

@Serializable
data class PauseRuleDto(
    val id: String,
    /** The daemon's grammar: `all | project:<gitCommonDir> | session:<sessionId>` (spec §18.1). */
    val scope: String,
    val mode: String,
    val reason: String? = null,
    val createdAt: String,
    val createdBy: String = ""
)

@Serializable
data class PauseResponseDto(val rule: PauseRuleDto, val affected: List<String> = emptyList())

@Serializable
data class ResumeResponseDto(val removed: List<String> = emptyList(), val resumed: List<String> = emptyList())

@Serializable
data class RulesDto(val rev: Long = 0, val rules: List<PauseRuleDto> = emptyList())

@Serializable
data class TokensGroupDto(
    val key: String,
    val label: String = "",
    val input: Long = 0,
    val output: Long = 0,
    val cacheCreate: Long = 0,
    val cacheRead: Long = 0,
    val messages: Long = 0
)

@Serializable
data class TokensDto(val ready: Boolean = true, val groups: List<TokensGroupDto> = emptyList())

@Serializable
data class ErrorBodyDto(val code: String, val message: String? = null, val hint: String? = null)

@Serializable
data class ErrorEnvelopeDto(val error: ErrorBodyDto)

@Serializable
data class PauseRequestDto(val scope: String, val mode: String, val reason: String)

@Serializable
data class ResumeRequestDto(val scope: String)
