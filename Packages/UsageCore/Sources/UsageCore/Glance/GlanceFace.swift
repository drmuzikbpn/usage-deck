// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// One headline drawn as a ring: an arc from twelve o'clock on a faint track, the percent
/// without its sign in the middle, coloured by status (deck WideDock `RingNumber`). No headline
/// draws an empty, dim ring labelled `—`.
/// Daemon §23.68: how a window the plan does not have reads, as opposed to `—` (not read yet).
public enum NoLimit {
    public static let short = "none"
    public static let caption = "on this plan"
    public static let ringCaption = "no 5h limit"
}

public struct RingFace: Sendable, Equatable {
    public var percent: Int?
    /// 0…1, clamped.
    public var fraction: Double
    public var label: String
    /// Nil without a headline: the ring is drawn dim.
    public var status: LimitStatus?

    public init(_ headline: WatchSnapshot.Headline?) {
        percent = headline?.percent
        fraction = headline.map { Double(min(max($0.percent, 0), 100)) / 100 } ?? 0
        label = headline.map { String($0.percent) } ?? "—"
        status = headline?.status
    }

    /// A window the plan does not have: an empty, dim ring that says "none".
    public static let noLimit: RingFace = {
        var ring = RingFace(nil)
        ring.label = NoLimit.short
        return ring
    }()

    /// The same face from a limit window, for the iPhone's own rings.
    public init(limit: Limit?) {
        percent = limit?.percent
        fraction = limit.map { Double(min(max($0.percent, 0), 100)) / 100 } ?? 0
        label = limit.map { String($0.percent) } ?? "—"
        status = limit?.status
    }
}

public extension WatchSnapshot {
    /// An account's health as the watch or a widget sees it now: the iPhone's verdict, aged
    /// further by how long ago the iPhone built this snapshot (same 30 s / 2 min thresholds).
    func health(of account: Account, now: Date) -> Health {
        max(account.health, Aging.health(lastHeartbeatAt: generatedAt, now: now))
    }

    /// The same verdict on a widget's clock. Widgets and complications redraw every 5 minutes from
    /// a snapshot iOS refreshes a few times an hour, so the deck's 30 s heartbeat rule would grey
    /// out every glance almost all the time. A glance is current under 20 minutes, stale under an
    /// hour, dead after that.
    func glanceHealth(of account: Account, now: Date) -> Health {
        let age = now.timeIntervalSince(generatedAt)
        let byAge: Health = age < GlanceAging.fresh ? .fresh : age < GlanceAging.dead ? .stale : .dead
        return max(account.health, byAge)
    }

    /// This snapshot as it may be drawn at `now`. The iPhone already leaves out devices silent
    /// for a day when it builds one; a snapshot that is itself a day old (`Aging.gone`) means no
    /// device behind it has been heard from since, so its readings go too. Devices stay listed.
    func current(now: Date) -> WatchSnapshot {
        guard now.timeIntervalSince(generatedAt) >= Aging.gone else { return self }
        var expired = self
        expired.accounts = []
        expired.projects = []
        expired.teamTodayTokens = 0
        expired.liveSessionCount = 0
        return expired
    }

    /// Whether `other` should replace this snapshot: never let an older reply (the phone's cached
    /// copy) overwrite a fresher application context.
    func isSuperseded(by other: WatchSnapshot) -> Bool {
        other.generatedAt >= generatedAt
    }

    /// True when the two snapshots draw the same widgets and complications, so a timeline reload
    /// would be wasted. Fetch times are left out: they move on every refresh while the faces
    /// only change with a percent, a status, a reset, a name or a health transition.
    func drawsSameGlance(as other: WatchSnapshot?) -> Bool {
        guard let other else { return false }
        return hasDevices == other.hasDevices && accounts.map(GlanceKey.init) == other.accounts.map(GlanceKey.init)
    }
}

/// Widget-clock aging thresholds (see `glanceHealth(of:now:)`).
public enum GlanceAging {
    public static let fresh: TimeInterval = 20 * 60
    public static let dead: TimeInterval = 60 * 60
}

private struct GlanceKey: Equatable {
    let key: String
    let name: String
    let fiveHour: WatchSnapshot.Headline?
    let sevenDay: WatchSnapshot.Headline?
    let health: Health

    init(_ account: WatchSnapshot.Account) {
        key = account.key
        name = account.name
        fiveHour = account.fiveHour
        sevenDay = account.sevenDay
        health = account.health
    }
}

/// Everything one widget or complication draws at one moment, built from the shared snapshot.
public struct GlanceFace: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        case account
        /// The iPhone has no paired devices.
        case noDevices
        /// Nothing has been written to the App Group yet.
        case noData
    }

    public var state: State
    public var name: String
    /// The single letter the face wears so the wrist knows whose numbers these are.
    public var initial: String
    /// The face follows "Highest" rather than a fixed account.
    public var isHighest: Bool
    public var fiveHour: RingFace
    public var sevenDay: RingFace
    /// `1h36m`, `42m`, `2d03h`; minute resolution because entries step every 5 minutes.
    public var fiveHourCountdown: String
    public var sevenDayCountdown: String
    /// `16:35`, `Thu 09:00`.
    public var fiveHourResetAt: String
    public var sevenDayResetAt: String
    /// Daemon §23.68: the plan has no 5-hour window; `fiveHour` is `RingFace.noLimit` and its
    /// countdown and reset lines say so.
    public var noFiveHour: Bool = false
    public var health: Health
    /// `4m ago` while stale or dead; nil while fresh.
    public var age: String?
    /// 0…1, how close the account is to its nearest limit (WidgetKit relevance).
    public var relevance: Double

    public static func make(
        snapshot: WatchSnapshot?,
        choice: AccountChoice,
        now: Date,
        timeZone: TimeZone = .current
    ) -> GlanceFace {
        guard let snapshot = snapshot?.current(now: now) else { return blank(.noData) }
        guard snapshot.hasDevices else { return blank(.noDevices) }
        guard let account = snapshot.account(for: choice) else { return blank(.noData) }
        let health = snapshot.glanceHealth(of: account, now: now)
        let nearest = max(account.fiveHour?.percent ?? 0, account.sevenDay?.percent ?? 0)
        let none = account.noFiveHourLimit
        return GlanceFace(
            state: .account,
            name: account.name,
            initial: account.initial,
            isHighest: choice == .highest,
            fiveHour: none ? .noLimit : RingFace(account.fiveHour),
            sevenDay: RingFace(account.sevenDay),
            fiveHourCountdown: none ? NoLimit.ringCaption : countdown(account.fiveHour?.resetsAt, now: now),
            sevenDayCountdown: countdown(account.sevenDay?.resetsAt, now: now),
            fiveHourResetAt: none
                ? NoLimit.caption
                : Format.resetAt(account.fiveHour?.resetsAt, now: now, timeZone: timeZone, use24h: snapshot.use24h),
            sevenDayResetAt: Format.resetAt(account.sevenDay?.resetsAt, now: now, timeZone: timeZone, use24h: snapshot.use24h),
            noFiveHour: none,
            health: health,
            age: health == .fresh ? nil : Format.age(snapshot.generatedAt, now: now),
            relevance: Double(min(max(nearest, 0), 100)) / 100
        )
    }

    /// The window a one-gauge face (circular, corner, the small widget's ring) leads with: the
    /// 5 h window, or the week when the plan has no 5-hour window (§23.68).
    public var headline: RingFace {
        noFiveHour ? sevenDay : fiveHour
    }

    public var headlineTitle: String {
        noFiveHour ? "7d" : "5h"
    }

    public var headlineCountdown: String {
        noFiveHour ? sevenDayCountdown : fiveHourCountdown
    }

    private static func blank(_ state: State) -> GlanceFace {
        GlanceFace(
            state: state,
            name: "",
            initial: "?",
            isHighest: false,
            fiveHour: RingFace(nil),
            sevenDay: RingFace(nil),
            fiveHourCountdown: "—",
            sevenDayCountdown: "—",
            fiveHourResetAt: "—",
            sevenDayResetAt: "—",
            health: .dead,
            age: nil,
            relevance: 0
        )
    }

    /// `Format.resetCountdown` without the seconds a stepped timeline cannot keep true.
    static func countdown(_ until: Date?, now: Date) -> String {
        guard let until else { return "—" }
        let seconds = until.timeIntervalSince(now)
        if seconds > 0, seconds < 3600 {
            return "\(Int(seconds / 60))m"
        }
        return Format.resetCountdown(until, now: now)
    }
}

/// When a widget timeline's entries fall: now, then every 5 minutes for an hour, so the
/// countdowns step without the extension waking.
public enum GlanceTimeline {
    public static let step: TimeInterval = 300
    public static let horizon: TimeInterval = 3600

    public struct Moment: Sendable, Equatable {
        public var date: Date
        public var face: GlanceFace

        public init(date: Date, face: GlanceFace) {
            self.date = date
            self.face = face
        }
    }

    public static func moments(
        snapshot: WatchSnapshot?,
        choice: AccountChoice,
        now: Date,
        timeZone: TimeZone = .current
    ) -> [Moment] {
        stride(from: 0, through: horizon, by: step).map { offset in
            let date = now.addingTimeInterval(offset)
            return Moment(date: date, face: GlanceFace.make(snapshot: snapshot, choice: choice, now: date, timeZone: timeZone))
        }
    }
}
