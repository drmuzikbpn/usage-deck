// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// Everything the watch, complications and widgets draw, built on the iPhone from the live team
/// state. It carries no token, no address and no fingerprint: the watch only ever talks to the
/// iPhone, and the iPhone talks to the devices.
public struct WatchSnapshot: Codable, Sendable, Equatable {
    public struct Headline: Codable, Sendable, Equatable {
        public var percent: Int
        public var resetsAt: Date?
        public var status: LimitStatus

        public init(percent: Int, resetsAt: Date?, status: LimitStatus) {
            self.percent = percent
            self.resetsAt = resetsAt
            self.status = status
        }

        init(_ limit: Limit) {
            self.init(percent: limit.percent, resetsAt: limit.resetsAt, status: limit.status)
        }
    }

    public struct Account: Codable, Sendable, Equatable, Identifiable, HeadlineAccount {
        public var key: String
        public var name: String
        public var fiveHour: Headline?
        public var sevenDay: Headline?
        /// When the daemon last read this account's usage; the staleness age is always shown.
        public var fetchedAt: Date?
        public var health: Health

        public init(key: String, name: String, fiveHour: Headline?, sevenDay: Headline?, fetchedAt: Date?, health: Health) {
            self.key = key
            self.name = name
            self.fiveHour = fiveHour
            self.sevenDay = sevenDay
            self.fetchedAt = fetchedAt
            self.health = health
        }

        public var id: String {
            key
        }

        public var initial: String {
            Highest.initial(name)
        }

        /// Daemon §23.68: see `UserView.noFiveHourLimit`.
        public var noFiveHourLimit: Bool {
            fiveHour == nil && sevenDay != nil
        }

        public var accountKey: String {
            key
        }

        public var fiveHourPercent: Int? {
            fiveHour?.percent
        }

        public var sevenDayPercent: Int? {
            sevenDay?.percent
        }
    }

    public struct Device: Codable, Sendable, Equatable, Identifiable {
        public var id: String
        public var name: String
        public var health: Health
        public var lastSeenAt: Date?
        public var needsRepair: Bool
        /// Any rule standing on this device (an `all` rule makes "Resume all" the action).
        public var pausedAll: Bool

        public init(id: String, name: String, health: Health, lastSeenAt: Date?, needsRepair: Bool, pausedAll: Bool) {
            self.id = id
            self.name = name
            self.health = health
            self.lastSeenAt = lastSeenAt
            self.needsRepair = needsRepair
            self.pausedAll = pausedAll
        }
    }

    public struct SessionRow: Codable, Sendable, Equatable, Identifiable {
        public var id: String
        public var label: String
        public var model: String?
        public var tokens: Int64
        public var ratePerMin: Double
        public var pause: PauseMode?
        public var freezes: Int
        public var canHardPause: Bool
        /// When the session started; the watch shows it as "since 14:02".
        public var startedAt: Date?
        /// The last tool the session ran, e.g. `Bash`.
        public var lastTool: String?

        public init(
            id: String,
            label: String,
            model: String?,
            tokens: Int64,
            ratePerMin: Double,
            pause: PauseMode?,
            freezes: Int,
            canHardPause: Bool,
            startedAt: Date? = nil,
            lastTool: String? = nil
        ) {
            self.id = id
            self.label = label
            self.model = model
            self.tokens = tokens
            self.ratePerMin = ratePerMin
            self.pause = pause
            self.freezes = freezes
            self.canHardPause = canHardPause
            self.startedAt = startedAt
            self.lastTool = lastTool
        }
    }

    public struct Project: Codable, Sendable, Equatable, Identifiable {
        public var deviceId: String
        public var key: String
        public var name: String
        public var todayTokens: Int64?
        public var liveTokens: Int64
        public var ratePerMin: Double
        /// Tokens/min over the last 5 h, oldest first (the watch sparkline). Trimmed first.
        public var burn: [Double]
        public var sessions: [SessionRow]
        public var pause: PauseMode?

        public init(
            deviceId: String,
            key: String,
            name: String,
            todayTokens: Int64?,
            liveTokens: Int64,
            ratePerMin: Double,
            burn: [Double],
            sessions: [SessionRow],
            pause: PauseMode?
        ) {
            self.deviceId = deviceId
            self.key = key
            self.name = name
            self.todayTokens = todayTokens
            self.liveTokens = liveTokens
            self.ratePerMin = ratePerMin
            self.burn = burn
            self.sessions = sessions
            self.pause = pause
        }

        public var id: String {
            "\(deviceId)|\(key)"
        }

        public var target: PauseTarget {
            .project(deviceId: deviceId, projectKey: key)
        }
    }

    public var generatedAt: Date
    public var accounts: [Account]
    public var devices: [Device]
    public var projects: [Project]
    public var teamTodayTokens: Int64
    public var liveSessionCount: Int
    public var escalations: [Escalation]
    public var use24h: Bool

    public init(
        generatedAt: Date,
        accounts: [Account] = [],
        devices: [Device] = [],
        projects: [Project] = [],
        teamTodayTokens: Int64 = 0,
        liveSessionCount: Int = 0,
        escalations: [Escalation] = [],
        use24h: Bool = true
    ) {
        self.generatedAt = generatedAt
        self.accounts = accounts
        self.devices = devices
        self.projects = projects
        self.teamTodayTokens = teamTodayTokens
        self.liveSessionCount = liveSessionCount
        self.escalations = escalations
        self.use24h = use24h
    }

    public static let empty = WatchSnapshot(generatedAt: .distantPast)

    /// No paired devices: the watch shows "No paired devices — pair one in the iPhone app".
    public var hasDevices: Bool {
        !devices.isEmpty
    }

    /// Any non-dead device has an `all` rule: the action is "Resume all".
    public var allPaused: Bool {
        devices.contains { $0.pausedAll && $0.health != .dead }
    }

    public func account(for choice: AccountChoice) -> Account? {
        Highest.resolve(choice, in: accounts)
    }
}

public extension WatchSnapshot {
    static let sparklineBuckets = 30
    static let sparklineWindow: TimeInterval = 5 * 3600

    /// Builds the snapshot from the iPhone's live state.
    static func make(
        team: TeamState,
        escalations: [Escalation],
        names: UserNames = UserNames(),
        burn: BurnHistory? = nil,
        use24h: Bool = true,
        now: Date
    ) -> WatchSnapshot {
        let accounts = team.users.map { user in
            Account(
                key: user.key,
                name: names.name(for: user),
                fiveHour: user.fiveHour.map(Headline.init),
                sevenDay: user.sevenDay.map(Headline.init),
                fetchedAt: user.limitsFetchedAt,
                health: user.health
            )
        }
        let devices = team.devices.map { d in
            Device(
                id: d.id,
                name: d.displayName,
                health: d.health,
                lastSeenAt: d.lastHeartbeatAt,
                needsRepair: d.needsRepair,
                pausedAll: d.rules.contains { $0.scope == PauseTarget.all.scope }
            )
        }
        let projects = team.projects.map { p in
            let projectKey = DeviceReducer.burnKey(deviceId: p.deviceId, project: p.key)
            return Project(
                deviceId: p.deviceId,
                key: p.key,
                name: p.name,
                todayTokens: p.todayTokens?.total,
                liveTokens: p.liveTokens.total,
                ratePerMin: burn?.ratePerMinute(projectKey, now: now) ?? 0,
                burn: burn?.series(projectKey, now: now, window: sparklineWindow, buckets: sparklineBuckets) ?? [],
                sessions: p.sessions.map { s in
                    SessionRow(
                        id: s.sessionId,
                        label: s.title ?? s.worktree ?? Format.shortId(s.sessionId),
                        model: Format.modelShort(s.model),
                        tokens: s.tokens.total,
                        ratePerMin: burn?.ratePerMinute(DeviceReducer.burnKey(deviceId: p.deviceId, session: s.sessionId), now: now) ?? 0,
                        pause: s.pause?.mode,
                        freezes: s.pause?.freezes ?? 0,
                        canHardPause: s.canHardPause,
                        startedAt: s.startedAt,
                        lastTool: s.lastTool?.name
                    )
                },
                pause: p.pause?.mode
            )
        }
        return WatchSnapshot(
            generatedAt: now,
            accounts: accounts,
            devices: devices,
            projects: projects,
            teamTodayTokens: team.teamToday.total,
            liveSessionCount: team.liveSessionCount,
            escalations: escalations,
            use24h: use24h
        )
    }
}

/// JSON for `updateApplicationContext` / `sendMessage` replies, kept under WatchConnectivity's
/// practical budget by trimming the least important data first.
public enum WatchSnapshotCodec {
    /// Application context tops out around 65 KB; stay clear of it.
    public static let byteLimit = 60000
    public static let maxProjects = 20

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    public static func decode(_ data: Data) throws -> WatchSnapshot {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try decoder.decode(WatchSnapshot.self, from: data)
    }

    /// Encodes `snapshot` in under `limit` bytes. In order: keep the top 20 projects (already
    /// sorted live-first), drop sparklines, cap sessions per project, then halve the project
    /// list until it fits. Accounts, devices and escalations are never trimmed.
    public static func encode(_ snapshot: WatchSnapshot, limit: Int = byteLimit) throws -> Data {
        var trimmed = snapshot
        trimmed.projects = Array(trimmed.projects.prefix(maxProjects))
        var data = try encoder().encode(trimmed)
        if data.count < limit {
            return data
        }

        trimmed.projects = trimmed.projects.map { var p = $0; p.burn = []; return p }
        data = try encoder().encode(trimmed)
        for cap in [12, 6, 3, 1, 0] where data.count >= limit {
            trimmed.projects = trimmed.projects.map { var p = $0; p.sessions = Array(p.sessions.prefix(cap)); return p }
            data = try encoder().encode(trimmed)
        }
        while data.count >= limit, !trimmed.projects.isEmpty {
            trimmed.projects = Array(trimmed.projects.prefix(trimmed.projects.count / 2))
            data = try encoder().encode(trimmed)
        }
        return data
    }
}
