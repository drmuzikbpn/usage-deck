// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// Parses the daemon's ISO-8601 instants, with or without fractional seconds.
public enum ISODate {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()

    public static func parse(_ string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        if let date = try? fractional.parse(string) {
            return date
        }
        return try? whole.parse(string)
    }

    public static func parse(_ string: String?, or fallback: Date) -> Date {
        parse(string) ?? fallback
    }

    public static func format(_ date: Date) -> String {
        fractional.format(date)
    }
}

public extension TokensCountsDTO {
    func toModel() -> Tokens {
        Tokens(input: input, output: output, cacheCreate: cacheCreate, cacheRead: cacheRead, messages: messages)
    }
}

public extension TokensGroupDTO {
    func toModel() -> ProjectTokens {
        ProjectTokens(
            key: key,
            label: label,
            tokens: Tokens(input: input, output: output, cacheCreate: cacheCreate, cacheRead: cacheRead, messages: messages)
        )
    }
}

public extension UserDTO {
    func toModel() -> User {
        User(
            emailAddress: emailAddress,
            accountUuid: accountUuid,
            displayName: displayName,
            organizationUuid: organizationUuid,
            organizationName: organizationName
        )
    }
}

public extension UpdateDTO {
    func toModel() -> UpdateState {
        UpdateState(channel: channel, current: current, available: available, state: state, deferredReason: deferredReason)
    }
}

public enum LimitStatusMapping {
    private static let criticalSeverities: Set<String> = [
        "critical", "severe", "exceeded", "exhausted", "blocked", "locked", "limit_reached", "over_limit",
    ]

    /// The daemon's `status.byId` value for a limit.
    public static func status(of string: String?) -> LimitStatus {
        switch string?.lowercased() {
        case "warn": .warn
        case "critical": .critical
        default: .ok
        }
    }

    /// Status for a row of a bare `limits` event, which has no `status.byId` map. Mirrors daemon
    /// spec §23.3: critical on percent or a critical-like severity, warn on percent or any
    /// non-`normal` severity.
    public static func status(for limit: LimitDTO, thresholds: ThresholdsDTO) -> LimitStatus {
        let severity = limit.severity.lowercased()
        if limit.percent >= thresholds.critical || criticalSeverities.contains(severity) {
            return .critical
        }
        if limit.percent >= thresholds.warn || severity != "normal" {
            return .warn
        }
        return .ok
    }
}

public extension LimitDTO {
    func toModel(status: LimitStatus) -> Limit {
        Limit(
            id: id,
            kind: kind,
            group: group,
            percent: percent,
            severity: severity,
            resetsAt: ISODate.parse(resetsAt),
            scopeModel: scope?.model,
            isActive: isActive,
            status: status
        )
    }
}

public extension SummaryDTO {
    func toLimits() -> [Limit] {
        limits.limits.map { $0.toModel(status: LimitStatusMapping.status(of: status.byId[$0.id])) }
    }
}

private func pauseMode(_ string: String) -> PauseMode {
    string == "hard" ? .hard : .soft
}

public extension PauseStateDTO {
    func toModel() -> PauseState {
        PauseState(
            mode: pauseMode(mode),
            ruleId: ruleId,
            scope: scope,
            since: ISODate.parse(since, or: .distantPast),
            frozenPids: frozenPids,
            freezes: freezes
        )
    }
}

public extension PauseRuleDTO {
    func toModel() -> PauseRule {
        PauseRule(
            id: id,
            scope: scope,
            mode: pauseMode(mode),
            reason: reason,
            createdAt: ISODate.parse(createdAt, or: .distantPast),
            createdBy: createdBy
        )
    }
}

public extension SessionDTO {
    func toModel() -> Session {
        let trimmedName = project.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Session(
            sessionId: sessionId,
            pid: pid,
            alive: alive,
            discovered: discovered == "transcript" ? .transcript : .hook,
            cwd: cwd,
            transcriptPath: transcriptPath,
            projectKey: project.gitCommonDir ?? cwd,
            projectName: trimmedName.isEmpty ? Path.lastComponent(cwd) : project.name,
            worktree: worktree,
            model: model,
            startedAt: ISODate.parse(startedAt, or: .distantPast),
            lastActivityAt: ISODate.parse(lastActivityAt, or: .distantPast),
            tokens: tokens.toModel(),
            pause: pause?.toModel(),
            lastTool: lastTool.map { LastTool(name: $0.name, at: ISODate.parse($0.at, or: .distantPast)) },
            title: (trimmedTitle?.isEmpty ?? true) ? nil : title
        )
    }
}

enum Path {
    /// `"/Users/adam/code/foo"` → `"foo"`; a path with no slash is returned whole.
    static func lastComponent(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: slash)...])
    }
}
