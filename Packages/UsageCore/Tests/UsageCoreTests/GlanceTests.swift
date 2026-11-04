// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Testing
@testable import UsageCore

private let utc = TimeZone(identifier: "UTC")!

private func account(
    _ key: String,
    _ name: String,
    five: Int?,
    seven: Int?,
    health: Health = .fresh,
    resetsIn: TimeInterval? = 96 * 60
) -> WatchSnapshot.Account {
    WatchSnapshot.Account(
        key: key,
        name: name,
        fiveHour: five.map { .init(percent: $0, resetsAt: resetsIn.map { t0.addingTimeInterval($0) }, status: $0 >= 80 ? .warn : .ok) },
        sevenDay: seven.map { .init(percent: $0, resetsAt: t0.addingTimeInterval(3 * 86400), status: .ok) },
        fetchedAt: t0,
        health: health
    )
}

private func snapshot(
    accounts: [WatchSnapshot.Account],
    devices: [WatchSnapshot.Device] = [.init(id: "m1", name: "m1", health: .fresh, lastSeenAt: t0, needsRepair: false, pausedAll: false)],
    projects: [WatchSnapshot.Project] = [],
    escalations: [Escalation] = [],
    at: Date = t0
) -> WatchSnapshot {
    WatchSnapshot(generatedAt: at, accounts: accounts, devices: devices, projects: projects, escalations: escalations)
}

private func project(_ key: String, device: String = "m1", today: Int64?, live: Bool) -> WatchSnapshot.Project {
    WatchSnapshot.Project(
        deviceId: device,
        key: key,
        name: key,
        todayTokens: today,
        liveTokens: 0,
        ratePerMin: 0,
        burn: [],
        sessions: live ? [.init(
            id: "s-\(key)",
            label: "s",
            model: nil,
            tokens: 0,
            ratePerMin: 0,
            pause: nil,
            freezes: 0,
            canHardPause: true
        )] : [],
        pause: nil
    )
}

struct RingFaceTests {
    @Test func drawsThePercentWithoutItsSignAndClampsTheArc() {
        let ring = RingFace(.init(percent: 112, resetsAt: nil, status: .critical))
        #expect(ring.label == "112")
        #expect(ring.fraction == 1)
        #expect(ring.status == .critical)
        #expect(RingFace(.init(percent: 42, resetsAt: nil, status: .ok)).fraction == 0.42)
    }

    @Test func aLimitDrawsTheSameFaceAsItsHeadline() {
        let limit = Limit(
            id: "five_hour", kind: "session", group: "five_hour", percent: 87, severity: "warn",
            resetsAt: nil, scopeModel: nil, isActive: true, status: .warn
        )
        #expect(RingFace(limit: limit) == RingFace(.init(percent: 87, resetsAt: nil, status: .warn)))
        #expect(RingFace(limit: nil) == RingFace(nil))
    }

    @Test func noHeadlineIsAnEmptyDimRing() {
        let ring = RingFace(nil)
        #expect(ring.label == "—")
        #expect(ring.fraction == 0)
        #expect(ring.status == nil)
    }
}

struct GlanceFaceTests {
    let two = [account("a", "Work", five: 82, seven: 41), account("b", "home", five: 23, seven: 67)]

    @Test func highestPicksTheAccountNearestALimitAndWearsItsInitial() {
        let face = GlanceFace.make(snapshot: snapshot(accounts: two), choice: .highest, now: t0, timeZone: utc)
        #expect(face.state == .account)
        #expect(face.name == "Work")
        #expect(face.initial == "W")
        #expect(face.isHighest)
        #expect(face.fiveHour.label == "82")
        #expect(face.sevenDay.label == "41")
        #expect(face.fiveHourCountdown == "1h36m")
        #expect(face.fiveHourResetAt == "15:36")
        #expect(face.sevenDayResetAt == "Wed 14:00")
        #expect(face.relevance == 0.82)
        #expect(face.age == nil)
    }

    @Test func aFixedChoiceShowsThatAccountAndFallsBackWhenItIsGone() {
        let home = GlanceFace.make(snapshot: snapshot(accounts: two), choice: .account(key: "b"), now: t0)
        #expect(home.name == "home")
        #expect(home.initial == "H")
        #expect(!home.isHighest)
        #expect(home.relevance == 0.67)
        let gone = GlanceFace.make(snapshot: snapshot(accounts: two), choice: .account(key: "zzz"), now: t0)
        #expect(gone.name == "Work")
    }

    @Test func staleDataShowsItsAgeAndAgesFurtherOnTheWrist() {
        let fresh = snapshot(accounts: [account("a", "Work", five: 10, seven: 10)])
        #expect(GlanceFace.make(snapshot: fresh, choice: .highest, now: t0.addingTimeInterval(10)).age == nil)
        // Widget entries step every 5 min and iOS refreshes the snapshot a few times an hour, so
        // a glance ages on its own, slower clock: a 4-minute-old snapshot is still current.
        let entry = GlanceFace.make(snapshot: fresh, choice: .highest, now: t0.addingTimeInterval(240))
        #expect(entry.health == .fresh)
        #expect(entry.age == nil)
        let older = GlanceFace.make(snapshot: fresh, choice: .highest, now: t0.addingTimeInterval(25 * 60))
        #expect(older.health == .stale)
        #expect(older.age == "25m ago")
        let later = GlanceFace.make(snapshot: fresh, choice: .highest, now: t0.addingTimeInterval(2 * 3600))
        #expect(later.health == .dead)
        // The watch app itself refreshes every 10 s, so it keeps the deck's 30 s / 2 min clock.
        let work = fresh.accounts[0]
        #expect(fresh.health(of: work, now: t0.addingTimeInterval(240)) == .dead)
        let staleAtSource = snapshot(accounts: [account("a", "Work", five: 10, seven: 10, health: .stale)])
        let face = GlanceFace.make(snapshot: staleAtSource, choice: .highest, now: t0)
        #expect(face.health == .stale)
        #expect(face.age == "0s ago")
    }

    @Test func aSnapshotADayOldShowsNoReadings() {
        let stored = snapshot(accounts: two, projects: [project("/g", today: 10, live: true)])
        let almost = t0.addingTimeInterval(86399)
        #expect(stored.current(now: almost) == stored)
        #expect(GlanceFace.make(snapshot: stored, choice: .highest, now: almost).state == .account)

        let dayLater = t0.addingTimeInterval(86400)
        let expired = stored.current(now: dayLater)
        #expect(expired.accounts.isEmpty)
        #expect(expired.projects.isEmpty)
        #expect(expired.teamTodayTokens == 0)
        #expect(expired.liveSessionCount == 0)
        #expect(expired.devices == stored.devices)
        #expect(expired.generatedAt == stored.generatedAt)
        let face = GlanceFace.make(snapshot: stored, choice: .highest, now: dayLater)
        #expect(face.state == .noData)
        #expect(face.fiveHour.label == "—")
    }

    @Test func emptyStatesSayWhy() {
        #expect(GlanceFace.make(snapshot: nil, choice: .highest, now: t0).state == .noData)
        #expect(GlanceFace.make(snapshot: snapshot(accounts: two, devices: []), choice: .highest, now: t0).state == .noDevices)
        #expect(GlanceFace.make(snapshot: snapshot(accounts: []), choice: .highest, now: t0).state == .noData)
    }

    @Test func countdownsDropSecondsAndReadDueOnceTheResetPasses() {
        #expect(GlanceFace.countdown(t0.addingTimeInterval(42 * 60 + 30), now: t0) == "42m")
        #expect(GlanceFace.countdown(t0.addingTimeInterval(2 * 86400 + 3 * 3600), now: t0) == "2d03h")
        #expect(GlanceFace.countdown(t0.addingTimeInterval(-5), now: t0) == "due")
        #expect(GlanceFace.countdown(nil, now: t0) == "—")
    }
}

struct GlanceTimelineTests {
    @Test func stepsEveryFiveMinutesForAnHourSoCountdownsMove() {
        let s = snapshot(accounts: [account("a", "Work", five: 50, seven: 10, resetsIn: 30 * 60)])
        let moments = GlanceTimeline.moments(snapshot: s, choice: .highest, now: t0)
        #expect(moments.count == 13)
        #expect(moments.first?.date == t0)
        #expect(moments.last?.date == t0.addingTimeInterval(3600))
        #expect(moments.map(\.face.fiveHourCountdown).prefix(7) == ["30m", "25m", "20m", "15m", "10m", "5m", "due"])
    }
}

struct GlanceReloadTests {
    @Test func onlyAFaceChangeIsWorthATimelineReload() {
        let a = snapshot(accounts: [account("a", "Work", five: 50, seven: 10)])
        var later = a
        later.generatedAt = t0.addingTimeInterval(10)
        later.accounts[0].fetchedAt = t0.addingTimeInterval(10)
        later.teamTodayTokens = 999
        #expect(later.drawsSameGlance(as: a))
        var moved = later
        moved.accounts[0].fiveHour?.percent = 51
        #expect(!moved.drawsSameGlance(as: a))
        var aged = later
        aged.accounts[0].health = .stale
        #expect(!aged.drawsSameGlance(as: a))
        #expect(!a.drawsSameGlance(as: nil))
    }

    @Test func anOlderReplyNeverOverwritesAFresherSnapshot() {
        let now = snapshot(accounts: [], at: t0)
        #expect(now.isSuperseded(by: snapshot(accounts: [], at: t0.addingTimeInterval(1))))
        #expect(!now.isSuperseded(by: snapshot(accounts: [], at: t0.addingTimeInterval(-1))))
    }
}

struct AccountOptionsTests {
    @Test func listsHighestFirstThenEachAccountOnce() {
        let s = snapshot(accounts: [
            account("a", "Work", five: 1, seven: 1),
            account("b", "Home", five: 1, seven: 1),
            account("a", "dup", five: 1, seven: 1),
        ])
        #expect(AccountOptions.list(s).map(\.title) == ["Highest", "Work", "Home"])
        #expect(AccountOptions.list(s).map(\.choice) == [.highest, .account(key: "a"), .account(key: "b")])
        #expect(AccountOptions.list(nil).map(\.id) == ["highest"])
    }

    @Test func lookupKeepsAnAccountThatLeftConfigured() {
        let s = snapshot(accounts: [account("a", "Work", five: 1, seven: 1)])
        let found = AccountOptions.lookup(["a", "highest", "gone"], in: s)
        #expect(found.map(\.title) == ["Work", "Highest", "Account"])
        #expect(found.last?.choice == .account(key: "gone"))
    }

    @Test func choiceIdsRoundTrip() {
        #expect(AccountChoice(id: AccountChoice.highestId) == .highest)
        #expect(AccountChoice(id: "uuid/org") == .account(key: "uuid/org"))
        #expect(AccountChoice.account(key: "uuid/org").id == "uuid/org")
    }
}

struct WatchPresentationTests {
    @Test func footerAndBannerCopy() {
        var s = snapshot(accounts: [])
        s.teamTodayTokens = 4_200_000
        s.liveSessionCount = 3
        #expect(s.footer == "today 4.2M · 3 live")
        #expect(s.unreachableBanner(now: t0.addingTimeInterval(250)) == "iPhone not reachable · updated 4m ago")
        #expect(WatchSnapshot.empty.unreachableBanner(now: t0) == "iPhone not reachable · updated never")
    }

    @Test func liveProjectsComeFirstAndShareIsOfTheTeamToday() {
        var s = snapshot(accounts: [], projects: [
            project("idle", today: 100, live: false),
            project("busy", today: 300, live: true),
            project("new", today: nil, live: true),
        ])
        s.teamTodayTokens = 400
        #expect(s.projectsLiveFirst.map(\.key) == ["busy", "new", "idle"])
        #expect(s.share(of: s.projects[1]) == 75)
        #expect(s.share(of: s.projects[2]) == nil)
        s.teamTodayTokens = 0
        #expect(s.share(of: s.projects[0]) == nil)
    }

    @Test func controlsNeedALiveAndPairedDevice() {
        let s = snapshot(accounts: [], devices: [
            .init(id: "ok", name: "ok", health: .stale, lastSeenAt: t0, needsRepair: false, pausedAll: false),
            .init(id: "dead", name: "dead", health: .dead, lastSeenAt: t0, needsRepair: false, pausedAll: false),
            .init(id: "repair", name: "repair", health: .fresh, lastSeenAt: t0, needsRepair: true, pausedAll: false),
        ])
        #expect(s.canControl(.project(deviceId: "ok", projectKey: "p")))
        #expect(!s.canControl(.project(deviceId: "dead", projectKey: "p")))
        #expect(!s.canControl(.session(deviceId: "repair", sessionId: "x")))
        #expect(!s.canControl(.session(deviceId: "unknown", sessionId: "x")))
        #expect(s.canControl(.all))
        #expect(!snapshot(accounts: [], devices: [s.devices[1]]).canControl(.all))
    }

    @Test func findsTheEscalationOnATargetAndTheNextOneOverall() {
        let s = snapshot(accounts: [], escalations: [
            Escalation(deviceId: "m1", scope: "session:x", fireAt: t0.addingTimeInterval(80)),
            Escalation(deviceId: "m2", scope: "session:x", fireAt: t0.addingTimeInterval(30)),
            Escalation(deviceId: "m1", scope: "all", fireAt: t0.addingTimeInterval(60)),
        ])
        #expect(s.escalation(for: .session(deviceId: "m1", sessionId: "x"))?.fireAt == t0.addingTimeInterval(80))
        #expect(s.escalation(for: .all)?.deviceId == "m1")
        #expect(s.escalation(for: .project(deviceId: "m1", projectKey: "x")) == nil)
        #expect(s.nextEscalation?.deviceId == "m2")
    }
}

struct PauseStateLookupTests {
    @Test func readsThePauseOnEachKindOfTarget() {
        let sample = WatchSnapshot.sample(now: t0)
        #expect(sample.pauseMode(for: .session(deviceId: "studio", sessionId: "b81e0d44-sample")) == .soft)
        #expect(sample.pauseMode(for: .session(deviceId: "laptop", sessionId: "c0ffee12-sample")) == .hard)
        #expect(sample.pauseMode(for: .session(deviceId: "laptop", sessionId: "b81e0d44-sample")) == nil, "same id, other device")
        #expect(sample.pauseMode(for: .project(deviceId: "studio", projectKey: "/code/usage/.git")) == nil)
        #expect(sample.pauseMode(for: .all) == nil)
        var paused = sample
        paused.devices[0].pausedAll = true
        #expect(paused.pauseMode(for: .all) == .soft)
        #expect(paused.reflects(.hard, on: .all), "all compares paused-ness only")
        #expect(!paused.reflects(nil, on: .all))
        #expect(sample.reflects(.soft, on: .session(deviceId: "studio", sessionId: "b81e0d44-sample")))
        #expect(!sample.reflects(.hard, on: .session(deviceId: "studio", sessionId: "b81e0d44-sample")))
    }
}

struct PauseGrammarTests {
    let target = PauseTarget.session(deviceId: "m1", sessionId: "s1")

    @Test func tapIsSoftHoldIsHardAndTapOnPausedResumes() {
        #expect(PauseGrammar.request(.tap, current: nil, target: target) == .pause(target, mode: .soft))
        #expect(PauseGrammar.request(.hold, current: nil, target: target) == .pause(target, mode: .hard))
        #expect(PauseGrammar.request(.hold, current: .soft, target: target) == .pause(target, mode: .hard))
        #expect(PauseGrammar.request(.tap, current: .soft, target: target) == .resume(target))
        #expect(PauseGrammar.request(.tap, current: .hard, target: target) == .resume(target))
        #expect(PauseGrammar.request(.hold, current: .hard, target: target) == nil)
    }

    @Test func aSessionWithoutARegisteredPidCannotBeFrozen() {
        #expect(PauseGrammar.request(.hold, current: nil, target: target, canHardPause: false) == nil)
        #expect(PauseGrammar.request(.tap, current: nil, target: target, canHardPause: false) == .pause(target, mode: .soft))
    }

    @Test func optimisticStateFollowsTheRequest() {
        #expect(PauseGrammar.expected(after: .pause(.all, mode: .hard)) == .hard)
        #expect(PauseGrammar.expected(after: .resume(.all)) == nil)
    }

    @Test func failureTextComesFromTheOutcomes() {
        let pause = WatchRequest.pause(.all, mode: .soft)
        #expect(PauseGrammar.failure(of: pause, outcomes: []) == nil)
        #expect(PauseGrammar.failure(of: pause, outcomes: [.init(deviceId: "a", ok: true, error: nil)]) == nil)
        #expect(PauseGrammar.failure(of: pause, outcomes: [
            .init(deviceId: "a", ok: true, error: nil),
            .init(deviceId: "b", ok: true, error: nil),
            .init(deviceId: "c", ok: false, error: "device unreachable"),
        ]) == "paused 2 of 3")
        #expect(PauseGrammar
            .failure(of: .resume(.all), outcomes: [.init(deviceId: "a", ok: false, error: "rule not found")]) == "rule not found")
        #expect(PauseGrammar
            .failure(of: .pause(.all, mode: .hard), outcomes: [.init(deviceId: "a", ok: false, error: nil)]) == "freeze failed")
    }
}

struct SampleSnapshotTests {
    @Test func sampleIsDrawableAndFitsTheWire() throws {
        let sample = WatchSnapshot.sample(now: t0)
        #expect(sample.hasDevices)
        #expect(sample.accounts.count == 2)
        #expect(sample.projects.contains { !$0.isLive })
        #expect(try WatchSnapshotCodec.decode(WatchSnapshotCodec.encode(sample)) == sample)
    }

    @Test func sessionRowsCarryStartAndLastTool() throws {
        var s = session("s1")
        s.lastTool = LastTool(name: "Bash", at: t0)
        let snap = WatchSnapshot.make(team: TeamState(devices: [device("m1", user: adam, sessions: [s])]), escalations: [], now: t0)
        let row = try #require(snap.projects.first?.sessions.first)
        #expect(row.startedAt == t0)
        #expect(row.lastTool == "Bash")
    }
}

/// Daemon §23.68: Anthropic reports a week and no 5-hour window for a plan without one.
struct NoFiveHourLimitTests {
    private func user(_ limits: [Limit]) -> UserView {
        UserView(
            key: "k", displayName: "Adam", emailAddress: nil, organizationName: nil,
            deviceIds: [], limits: limits, limitsFetchedAt: t0, health: .fresh
        )
    }

    @Test func aWeekWithNoFiveHourWindowIsAPlanWithoutOne() {
        #expect(user([limit("weekly_all", 6)]).noFiveHourLimit)
        #expect(!user([limit("session", 3), limit("weekly_all", 6)]).noFiveHourLimit)
        #expect(!user([]).noFiveHourLimit)
        #expect(account("a", "Work", five: nil, seven: 6).noFiveHourLimit)
        #expect(!account("a", "Work", five: 3, seven: 6).noFiveHourLimit)
        #expect(!account("a", "Work", five: nil, seven: nil).noFiveHourLimit)
    }

    @Test func theRingSaysNoneRatherThanADash() {
        let ring = RingFace.noLimit
        #expect(ring.label == NoLimit.short)
        #expect(ring.fraction == 0)
        #expect(ring.status == nil)
        #expect(ring.percent == nil)
    }

    @Test func aGlanceLeadsWithTheWeekAndSaysTheFiveHourWindowIsNone() {
        let face = GlanceFace.make(
            snapshot: snapshot(accounts: [account("a", "Work", five: nil, seven: 6)]),
            choice: .highest, now: t0, timeZone: utc
        )
        #expect(face.noFiveHour)
        #expect(face.fiveHour == .noLimit)
        #expect(face.fiveHourCountdown == NoLimit.ringCaption)
        #expect(face.fiveHourResetAt == NoLimit.caption)
        #expect(face.headline == face.sevenDay)
        #expect(face.headlineTitle == "7d")
        #expect(face.headlineCountdown == face.sevenDayCountdown)
    }

    @Test func aGlanceWithAFiveHourWindowStillLeadsWithIt() {
        let face = GlanceFace.make(
            snapshot: snapshot(accounts: [account("a", "Work", five: 82, seven: 41)]),
            choice: .highest, now: t0, timeZone: utc
        )
        #expect(!face.noFiveHour)
        #expect(face.headline == face.fiveHour)
        #expect(face.headlineTitle == "5h")
        #expect(face.headlineCountdown == "1h36m")
    }

    @Test func aWindowNotReadYetIsStillADash() {
        let face = GlanceFace.make(
            snapshot: snapshot(accounts: [account("a", "Work", five: nil, seven: nil)]),
            choice: .highest, now: t0, timeZone: utc
        )
        #expect(!face.noFiveHour)
        #expect(face.fiveHour.label == "—")
    }
}
