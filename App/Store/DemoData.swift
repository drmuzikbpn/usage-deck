// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import UsageCore

/// Two made-up devices instead of real ones: "Try the demo" on the empty home screen (how App
/// Review and anyone without the daemon can see the app), and in Debug builds the
/// `-UsageDeckDemo` launch arguments, so the UI smoke test and screenshots run with no daemon.
enum DemoData {
    static let launchArgument = "-UsageDeckDemo"

    /// Also `-UsageDeckDemoConnecting`: open on "Connecting to studio…", which lands after
    /// `connectingDelay` (the post-pairing overlay, for the smoke test and screenshots).
    static let connectingArgument = "-UsageDeckDemoConnecting"
    static let connectingDelay: Duration = .seconds(3)

    /// Also `-UsageDeckDemoNeedsRepair`: studio has stopped accepting this iPhone (its token
    /// was changed), for the re-pair banner.
    static let needsRepairArgument = "-UsageDeckDemoNeedsRepair"

    static var needsRepair: Bool {
        launched(with: needsRepairArgument)
    }

    /// Also `-UsageDeckDemoNoFiveHour`: studio's account has no 5-hour window (daemon §23.68),
    /// for the "none" faces.
    static let noFiveHourArgument = "-UsageDeckDemoNoFiveHour"

    static var noFiveHour: Bool {
        launched(with: noFiveHourArgument)
    }

    /// Launch arguments switch the demo on only in Debug: an App Store build has none.
    private static func launched(with argument: String) -> Bool {
        #if DEBUG
            ProcessInfo.processInfo.arguments.contains(argument)
        #else
            false
        #endif
    }

    static var isEnabled: Bool {
        launched(with: launchArgument)
    }

    /// With `-UsageDeckDemoConnectingHold` the overlay never lands by itself (a 600 s timeout):
    /// the smoke test proves Skip, not the auto-land, is what closed it.
    static let holdArgument = "-UsageDeckDemoConnectingHold"

    static var opensConnecting: Bool {
        launched(with: connectingArgument) || holdsConnecting
    }

    static var holdsConnecting: Bool {
        launched(with: holdArgument)
    }

    /// What studio's `/health` would say once it answers: everything installed.
    static func health(_ device: DeviceState) -> HealthDTO {
        HealthDTO(
            version: device.version ?? "",
            name: device.name,
            user: UserDTO(emailAddress: device.user?.emailAddress, accountUuid: device.user?.accountUuid),
            stats: HealthStatsDTO(spendReady: true),
            install: InstallDTO(hooks: true, statusline: "ours", mcp: true)
        )
    }

    static func devices(now: Date) -> [DeviceState] {
        let adam = User(emailAddress: "adam@example.com", accountUuid: "uuid-adam", displayName: "Adam", organizationUuid: "org")
        let jules = User(emailAddress: "jules@example.com", accountUuid: "uuid-jules", displayName: "Jules", organizationUuid: "org")
        var studio = DeviceState(record: DeviceRecord(
            id: "demo-studio",
            name: "studio",
            addrs: ["192.168.1.20", "studio.local"],
            port: 47292,
            fingerprint: String(repeating: "0", count: 64)
        ))
        studio.health = .fresh
        studio.lastHeartbeatAt = now
        studio.name = "studio"
        studio.version = "0.1.140+demo"
        studio.user = adam
        studio.transport = .sse
        studio.limits = [
            limit("session", 62, resetsAt: now.addingTimeInterval(2 * 3600 + 33 * 60), status: .ok),
            limit("weekly_all", 84, resetsAt: now.addingTimeInterval(3 * 86400), status: .warn),
        ]
        studio.limitsFetchedAt = now.addingTimeInterval(-20)
        studio.today = Tokens(input: 420_000, output: 180_000, cacheCreate: 900_000, cacheRead: 7_400_000, messages: 312)
        studio.sessions = [
            session("7f3a91c2", project: "garden-planner", tokens: 3_100_000, now: now, title: "seed calendar"),
            session("b2e40d17", project: "garden-planner", tokens: 1_250_000, now: now, worktree: "frost-dates"),
            session(
                "c9d1aa03",
                project: "recipe-box",
                tokens: 640_000,
                now: now,
                pause: PauseState(mode: .soft, ruleId: "r1", scope: "session:c9d1aa03", since: now, frozenPids: [])
            ),
        ]
        studio.projectTokens = [ProjectTokens(
            key: "/src/photo-archive",
            label: "/src/photo-archive",
            tokens: Tokens(input: 90000, output: 30000)
        )]

        var laptop = DeviceState(record: DeviceRecord(
            id: "demo-laptop",
            name: "laptop",
            addrs: ["192.168.1.31"],
            port: 47292,
            fingerprint: String(repeating: "1", count: 64)
        ))
        laptop.health = .fresh
        laptop.lastHeartbeatAt = now
        laptop.name = "laptop"
        laptop.user = jules
        laptop.limits = [
            limit("session", 97, resetsAt: now.addingTimeInterval(40 * 60), status: .critical),
            limit("weekly_all", 41, resetsAt: now.addingTimeInterval(5 * 86400), status: .ok),
        ]
        laptop.limitsFetchedAt = now.addingTimeInterval(-45)
        laptop.sessions = [
            session(
                "e5f60718",
                project: "tide-tables",
                tokens: 2_000_000,
                now: now,
                pause: PauseState(
                    mode: .hard,
                    ruleId: "r2",
                    scope: "session:e5f60718",
                    since: now.addingTimeInterval(-300),
                    frozenPids: [4242]
                )
            ),
        ]
        if noFiveHour {
            studio.limits.removeAll { $0.id == LimitID.session }
        }
        return [studio, laptop]
    }

    private static func limit(_ id: String, _ percent: Int, resetsAt: Date, status: LimitStatus) -> Limit {
        Limit(
            id: id,
            kind: id,
            group: id == "session" ? "session" : "weekly",
            percent: percent,
            severity: "normal",
            resetsAt: resetsAt,
            scopeModel: nil,
            isActive: false,
            status: status
        )
    }

    private static func session(
        _ id: String,
        project: String,
        tokens: Int64,
        now: Date,
        title: String? = nil,
        worktree: String? = nil,
        pause: PauseState? = nil
    ) -> Session {
        Session(
            sessionId: id,
            pid: 4242,
            alive: true,
            discovered: .hook,
            cwd: "/src/\(project)",
            transcriptPath: nil,
            projectKey: "/src/\(project)/.git",
            projectName: project,
            worktree: worktree,
            model: "claude-opus-5",
            startedAt: now.addingTimeInterval(-3600),
            lastActivityAt: now.addingTimeInterval(-4),
            tokens: Tokens(
                input: tokens / 10,
                output: tokens / 20,
                cacheCreate: tokens / 5,
                cacheRead: tokens - tokens / 10 - tokens / 20 - tokens / 5
            ),
            pause: pause,
            lastTool: LastTool(name: "Edit", at: now.addingTimeInterval(-4)),
            title: title
        )
    }

    /// Plausible burn so sparklines and the five-hour chart have a shape. Cumulative counters
    /// only grow, as the daemon's do.
    static func seedBurn(_ burn: BurnHistory, devices: [DeviceState], now: Date) {
        var totals: [String: Double] = [:]
        for step in stride(from: 300.0, through: 0, by: -0.5) {
            let at = now.addingTimeInterval(-step * 60)
            let wave = 1 + 0.6 * sin(step / 17)
            for device in devices {
                var projects: [String: Double] = [:]
                for session in device.sessions {
                    let key = DeviceReducer.burnKey(deviceId: device.id, session: session.sessionId)
                    let rate = Double(session.tokens.total) / 600 * wave
                    totals[key, default: 0] += rate
                    projects[session.projectKey, default: 0] += rate
                    burn.record(key, at: at, cumulative: Int64(totals[key] ?? 0))
                }
                for (project, rate) in projects {
                    let key = DeviceReducer.burnKey(deviceId: device.id, project: project)
                    totals[key, default: 0] += rate
                    burn.record(key, at: at, cumulative: Int64(totals[key] ?? 0))
                }
            }
        }
    }
}
