// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// One person's quota across however many devices they are signed in on. Limits are per account
/// **and** organisation, so the same account on two devices in one org collapses (the copy with
/// the freshest `limitsFetchedAt` wins), while one account in two orgs is two quotas.
public struct UserView: Sendable, Equatable, Identifiable {
    /// `accountUuid ?? emailAddress ?? deviceId`, suffixed with `/organizationUuid` when known.
    public var key: String
    public var displayName: String
    public var emailAddress: String?
    public var organizationName: String?
    public var deviceIds: [String]
    public var limits: [Limit]
    public var limitsFetchedAt: Date?
    /// Best health of the devices behind this user.
    public var health: Health

    public init(
        key: String,
        displayName: String,
        emailAddress: String?,
        organizationName: String?,
        deviceIds: [String],
        limits: [Limit],
        limitsFetchedAt: Date?,
        health: Health
    ) {
        self.key = key
        self.displayName = displayName
        self.emailAddress = emailAddress
        self.organizationName = organizationName
        self.deviceIds = deviceIds
        self.limits = limits
        self.limitsFetchedAt = limitsFetchedAt
        self.health = health
    }

    public var id: String {
        key
    }

    public var fiveHour: Limit? {
        limits.first { $0.id == LimitID.session }
    }

    /// Daemon §23.68: a week but no 5-hour window means the plan has none (Anthropic dropped it
    /// for verified accounts on its top plan). Drawn as "none", not the `—` of a reading not yet
    /// in. Derived from `limits[]` exactly as the daemon derives `noSessionLimit`, so it holds for
    /// older daemons too.
    public var noFiveHourLimit: Bool {
        fiveHour == nil && sevenDay != nil
    }

    public var sevenDay: Limit? {
        limits.first { $0.id == LimitID.weeklyAll }
    }

    public var scoped: [Limit] {
        limits.filter { $0.kind == LimitID.weeklyScopedKind }
    }
}

/// One repo on one device. Worktrees of a repo roll up because the daemon keys projects by
/// `gitCommonDir`; the same repo cloned on two devices is deliberately two projects.
public struct ProjectView: Sendable, Equatable, Identifiable {
    public var deviceId: String
    public var key: String
    public var name: String
    public var sessions: [Session]
    public var todayTokens: Tokens?
    public var worktreeCount: Int

    public init(deviceId: String, key: String, name: String, sessions: [Session], todayTokens: Tokens?, worktreeCount: Int) {
        self.deviceId = deviceId
        self.key = key
        self.name = name
        self.sessions = sessions
        self.todayTokens = todayTokens
        self.worktreeCount = worktreeCount
    }

    public var id: String {
        "\(deviceId)|\(key)"
    }

    public var liveTokens: Tokens {
        sessions.reduce(.zero) { $0 + $1.tokens }
    }

    public var isIdle: Bool {
        !sessions.contains { $0.alive }
    }

    /// The most severe pause across the project's sessions; hard beats soft.
    public var pause: PauseState? {
        let paused = sessions.compactMap(\.pause)
        return paused.first { $0.mode == .hard } ?? paused.first
    }
}

/// The merged view of every paired device. Derived lists are computed once at construction.
/// A device that is `gone` (silent for a day) stays in `devices` but is left out of everything
/// derived from them: users, projects and the totals.
public struct TeamState: Sendable, Equatable {
    public let devices: [DeviceState]
    public let users: [UserView]
    /// Live projects first (by live tokens, descending), then idle ones (by today's tokens).
    public let projects: [ProjectView]

    public init(devices: [DeviceState] = []) {
        self.devices = devices
        let reporting = devices.filter { !$0.gone }
        users = Self.buildUsers(reporting)
        projects = Self.buildProjects(reporting)
    }

    public static func == (lhs: TeamState, rhs: TeamState) -> Bool {
        lhs.devices == rhs.devices
    }

    public var liveSessionCount: Int {
        devices.reduce(0) { $0 + ($1.gone ? 0 : $1.sessions.count(where: \.alive)) }
    }

    public var teamToday: Tokens {
        devices.reduce(.zero) { $1.gone ? $0 : $0 + $1.today }
    }

    public func device(_ id: String) -> DeviceState? {
        devices.first { $0.id == id }
    }

    public func session(deviceId: String, sessionId: String) -> Session? {
        device(deviceId)?.sessions.first { $0.sessionId == sessionId }
    }

    public func user(key: String) -> UserView? {
        users.first { $0.key == key }
    }

    // MARK: - building

    static func userKey(_ d: DeviceState) -> String {
        let account = nonBlank(d.user?.accountUuid) ?? nonBlank(d.user?.emailAddress) ?? d.id
        if let org = nonBlank(d.user?.organizationUuid) {
            return "\(account)/\(org)"
        }
        return account
    }

    /// A bare e-mail is a poor headline; its local part reads like a name and fits the rail.
    private static func displayName(_ d: DeviceState) -> String? {
        if let name = nonBlank(d.user?.displayName), !name.contains("@") {
            return name
        }
        if let email = d.user?.emailAddress {
            return String(email.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        }
        return d.name ?? d.record.name
    }

    private static func nonBlank(_ s: String?) -> String? {
        guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }

    private static func buildUsers(_ devices: [DeviceState]) -> [UserView] {
        var order: [String] = []
        var groups: [String: [DeviceState]] = [:]
        for d in devices {
            let key = userKey(d)
            if groups[key] == nil {
                order.append(key)
            }
            groups[key, default: []].append(d)
        }
        return order.map { key in
            let group = groups[key] ?? []
            // Each daemon caches the account's usage for its own span, so the copy to show is the
            // one fetched latest — and a device with no limits never wins, or one failed fetch
            // would blank a headline another device can still supply.
            let withLimits = group.filter { !$0.limits.isEmpty }
            let candidates = withLimits.isEmpty ? group : withLimits
            var freshest: DeviceState?
            for d in candidates where freshest == nil
                || (d.limitsFetchedAt ?? .distantPast) > (freshest?.limitsFetchedAt ?? .distantPast) {
                freshest = d
            }
            return UserView(
                key: key,
                displayName: group.lazy.compactMap(displayName).first ?? key,
                emailAddress: group.lazy.compactMap { $0.user?.emailAddress }.first,
                organizationName: group.lazy.compactMap { $0.user?.organizationName }.first,
                deviceIds: group.map(\.id),
                limits: freshest?.limits ?? [],
                limitsFetchedAt: freshest?.limitsFetchedAt,
                health: group.map(\.health).min() ?? .dead
            )
        }
    }

    private static func buildProjects(_ devices: [DeviceState]) -> [ProjectView] {
        var live: [ProjectView] = []
        var idle: [ProjectView] = []
        for d in devices {
            // Only sessions the daemon reports alive make the board; transcript back-fill of
            // finished sessions is history, and history belongs to the tokens endpoint.
            let alive = d.sessions.filter(\.alive)
            let liveCwds = Set(alive.map(\.cwd))
            var keys: [String] = []
            var byKey: [String: [Session]] = [:]
            for s in alive {
                if byKey[s.projectKey] == nil {
                    keys.append(s.projectKey)
                }
                byKey[s.projectKey, default: []].append(s)
            }
            for key in keys {
                let sessions = byKey[key] ?? []
                let cwds = Set(sessions.map(\.cwd))
                let matching = d.projectTokens.filter { cwds.contains($0.label) }
                live.append(ProjectView(
                    deviceId: d.id,
                    key: key,
                    name: sessions.first?.projectName ?? Path.lastComponent(key),
                    sessions: sessions,
                    todayTokens: matching.isEmpty ? nil : matching.reduce(.zero) { $0 + $1.tokens },
                    worktreeCount: Set(sessions.map { $0.worktree ?? "" }).count
                ))
            }
            for p in d.projectTokens where !liveCwds.contains(p.label) {
                idle.append(ProjectView(
                    deviceId: d.id,
                    key: p.label,
                    name: Path.lastComponent(p.label),
                    sessions: [],
                    todayTokens: p.tokens,
                    worktreeCount: 0
                ))
            }
        }
        let active = live.filter { !$0.isIdle }.stableSorted { $0.liveTokens.total > $1.liveTokens.total }
        let quiet = (live.filter(\.isIdle) + idle)
            .filter { ($0.todayTokens?.total ?? 0) > 0 }
            .stableSorted { ($0.todayTokens?.total ?? 0) > ($1.todayTokens?.total ?? 0) }
        return active + quiet
    }
}

extension Array {
    /// `sorted(by:)` is not guaranteed stable; ties must keep arrival order or rows jump.
    func stableSorted(by before: (Element, Element) -> Bool) -> [Element] {
        enumerated()
            .sorted { a, b in
                if before(a.element, b.element) {
                    return true
                }
                if before(b.element, a.element) {
                    return false
                }
                return a.offset < b.offset
            }
            .map(\.element)
    }
}
