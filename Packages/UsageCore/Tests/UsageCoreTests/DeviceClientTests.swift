// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Synchronization
import Testing
@testable import UsageCore

struct DeviceReducerTests {
    let burn = BurnHistory()
    let rec = record(id: "m1", addrs: ["192.168.1.20"])

    func snapshotEvent(_ name: String = "snapshot.json") -> DaemonEvent {
        SSEDecoder.decode(event: "snapshot", data: Fixtures.text(name))
    }

    @Test func aSnapshotPopulatesStateWithTheDaemonsFetchTime() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.apply(snapshotEvent(), now: t0)
        #expect(r.state.name == "adams-mbp")
        #expect(r.state.limits.count == 3)
        #expect(r.state.sessions.count == 46)
        #expect(r.state.rules.count == 1)
        #expect(r.state.rev == 3)
        #expect(r.state.transport == .sse)
        #expect(r.state.health == .fresh)
        #expect(r.state.limitsFetchedAt != t0)
        #expect(r.state.limitsFetchedAt == date("2026-09-13T19:01:38.189Z"))
        #expect(r.etag == #"W/"3""#)
    }

    @Test func aSnapshotWithoutAFetchTimeLeavesItUnknown() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.apply(SSEDecoder.decode(event: "snapshot", data: #"{"rev":1}"#), now: t0)
        #expect(r.state.limitsFetchedAt == nil)
    }

    @Test func aHeartbeatRefreshesAgingAndMovesTheRevisionForward() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.age(now: t0)
        #expect(r.state.health == .dead)
        r.apply(.heartbeat(rev: 9, at: nil), now: t0)
        #expect(r.state.health == .fresh)
        #expect(r.state.lastHeartbeatAt == t0)
        #expect(r.state.rev == 9)
        #expect(r.etag == #"W/"9""#)
        r.age(now: t0.addingTimeInterval(120))
        #expect(r.state.health == .dead)
    }

    @Test func aDayOfSilenceForgetsTheReadingsAndACheckInBringsTheDeviceBack() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.apply(.heartbeat(rev: 9, at: nil), now: t0)
        r.applySummary(SummaryDTO(), now: t0)
        #expect(r.state.summaryLoaded)
        #expect(r.etag == #"W/"9""#)

        r.age(now: t0.addingTimeInterval(86400))
        #expect(r.state.gone)
        #expect(!r.state.summaryLoaded)
        // The sessions it forgot must be re-read in full, not answered with a 304.
        #expect(r.etag == nil)

        r.apply(.heartbeat(rev: 0, at: nil), now: t0.addingTimeInterval(90000))
        #expect(!r.state.gone)
        #expect(r.state.health == .fresh)
    }

    @Test func aStreamThatOpensEndsTheSilence() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.apply(.heartbeat(rev: 1, at: nil), now: t0)
        r.age(now: t0.addingTimeInterval(86400))
        #expect(r.state.gone)
        r.opened(now: t0.addingTimeInterval(86401))
        #expect(!r.state.gone)
    }

    @Test func sessionUpdatesUpsertEndsRemoveAndBurnIsRecorded() {
        var r = DeviceReducer(record: rec, burn: burn)
        let json = #"{"type":"update","session":{"sessionId":"s1","cwd":"/x","#
            + #""startedAt":"2026-09-13T11:20:00Z","lastActivityAt":"2026-09-13T11:21:00Z","tokens":{"input":100}}}"#
        r.apply(SSEDecoder.decode(event: "session", data: json), now: t0)
        let later = json.replacingOccurrences(of: #""input":100"#, with: #""input":700"#)
        r.apply(SSEDecoder.decode(event: "session", data: later), now: t0.addingTimeInterval(60))
        #expect(r.state.sessions.map(\.sessionId) == ["s1"])
        #expect(r.state.sessions.first?.tokens.input == 700)
        #expect(burn.ratePerMinute(DeviceReducer.burnKey(deviceId: "m1", session: "s1"), now: t0.addingTimeInterval(60)) == 600)
        #expect(burn.ratePerMinute(DeviceReducer.burnKey(deviceId: "m1", project: "/x"), now: t0.addingTimeInterval(60)) == 600)

        r.apply(
            SSEDecoder.decode(event: "session", data: json.replacingOccurrences(of: "update", with: "end")),
            now: t0.addingTimeInterval(61)
        )
        #expect(r.state.sessions.isEmpty)
        #expect(burn.ratePerMinute(DeviceReducer.burnKey(deviceId: "m1", session: "s1"), now: t0.addingTimeInterval(61)) == 0)
    }

    @Test func spendReplacesTodayFromTheCumulativeFieldNeverTheDelta() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.apply(.spend(today: TokensCountsDTO(input: 50), delta: TokensCountsDTO(input: 7)), now: t0)
        #expect(r.state.today.input == 50)
    }

    @Test func aPauseEventReplacesRulesAndAsksForASessionsRefetch() {
        var r = DeviceReducer(record: rec, burn: burn)
        let refetch = r.apply(
            .pause(rules: [PauseRuleDTO(id: "r", scope: "all", mode: "soft", createdAt: "2026-09-13T00:00:00Z")], affected: []),
            now: t0
        )
        #expect(refetch)
        #expect(r.state.rules.map(\.scope) == ["all"])
    }

    @Test func limitsAndSpendNeverMoveTheSessionsRevision() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.apply(snapshotEvent(), now: t0)
        r.apply(.limits([LimitDTO(id: "session", kind: "session", percent: 99)], fetchedAt: nil, stale: false), now: t0)
        r.apply(.spend(today: TokensCountsDTO(), delta: TokensCountsDTO()), now: t0)
        #expect(r.state.rev == 3)
        #expect(r.etag == #"W/"3""#)
    }

    @Test func aBareLimitsEventRecomputesStatusSoAResetWeekStopsBeingRed() {
        var r = DeviceReducer(record: rec, burn: burn)
        let snap = #"{"summary":{"status":{"byId":{"session":"critical"}},"thresholds":{"warn":50,"critical":60}},"rev":1}"#
        r.apply(SSEDecoder.decode(event: "snapshot", data: snap), now: t0)
        r.apply(
            .limits(
                [LimitDTO(id: "session", kind: "session", percent: 1), LimitDTO(id: "weekly_all", kind: "weekly_all", percent: 55)],
                fetchedAt: nil,
                stale: false
            ),
            now: t0
        )
        #expect(r.state.limits.map(\.status) == [.ok, .warn])
    }

    @Test func aScopedLimitWithNoNumberIsLeftOutRatherThanShownAsZero() throws {
        var r = DeviceReducer(record: rec, burn: burn)
        let json = #"{"id":"weekly_scoped:fable","kind":"weekly_scoped","percent":null,"severity":null}"#
        let unknown = try JSONDecoder().decode(LimitDTO.self, from: Data(json.utf8))
        r.apply(.limits([LimitDTO(id: "weekly_all", kind: "weekly_all", percent: 3), unknown], fetchedAt: nil, stale: false), now: t0)
        #expect(r.state.limits.map(\.id) == ["weekly_all"])
    }

    @Test func anUnauthorizedFailureMarksTheDeviceForRepairUntilItAnswersAgain() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.fail(DaemonError(code: "unauthorized", httpStatus: 401))
        #expect(r.state.needsRepair)
        #expect(r.state.lastError == "Token rejected. Re-pair this device.")
        r.opened(now: t0)
        #expect(!r.state.needsRepair)
        #expect(r.state.lastError == nil)
    }

    @Test func notModifiedSessionsKeepState() {
        var r = DeviceReducer(record: rec, burn: burn)
        r.applySessions(.changed(SessionsDTO(rev: 5, sessions: []), etag: #"W/"5""#), now: t0)
        r.applySessions(.unchanged, now: t0)
        #expect(r.state.rev == 5)
        #expect(r.etag == #"W/"5""#)
    }
}

/// Feeds `DeviceClient` scripted connections.
final class ScriptedEvents: Sendable {
    private let scripts: Mutex<[[StreamItem]]>
    private let connects = Mutex(0)

    init(_ scripts: [[StreamItem]]) {
        self.scripts = Mutex(scripts)
    }

    var count: Int {
        connects.withLock { $0 }
    }

    func next() -> AsyncStream<StreamItem> {
        connects.withLock { $0 += 1 }
        let items = scripts.withLock { s -> [StreamItem] in
            s.isEmpty ? [.closed(.network)] : s.removeFirst()
        }
        return AsyncStream { continuation in
            for item in items {
                continuation.yield(item)
            }
            continuation.finish()
        }
    }
}

struct DeviceClientTests {
    var fast: DeviceClient.Timing {
        var t = DeviceClient.Timing()
        t.backoffMin = .milliseconds(5)
        t.backoffMax = .milliseconds(20)
        t.pollForeground = .milliseconds(5)
        t.pollBackground = .seconds(30)
        t.projectTokens = .seconds(30)
        t.ticker = .milliseconds(5)
        return t
    }

    func waitFor(_ timeout: Duration = .seconds(3), _ condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if await condition() {
                return true
            }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return false
    }

    @Test func aSnapshotOverSSEPopulatesStateAndObserversSeeIt() async {
        let api = FakeAPI("m1")
        let snapshot = SSEDecoder.decode(event: "snapshot", data: Fixtures.text("snapshot.json"))
        let events = ScriptedEvents([[.open, .event(snapshot)]])
        let clock = ManualClock(t0)
        let client = DeviceClient(
            record: record(id: "m1", addrs: ["a"]),
            api: api,
            events: { events.next() },
            burn: BurnHistory(),
            clock: clock,
            timing: fast
        )
        let states = await client.states()
        await client.start()
        var seen: DeviceState?
        for await state in states where state.sessions.count == 46 {
            seen = state
            break
        }
        await client.stop()
        #expect(seen?.name == "adams-mbp")
    }

    @Test func twoFailedConnectsSwitchToPollingWithTheETag() async throws {
        let api = FakeAPI("m1")
        let summary = try Fixtures.decode(SummaryDTO.self, "summary.json")
        let sessions = try Fixtures.decode(SessionsDTO.self, "sessions.json")
        api.edit {
            $0.summary = summary
            $0.sessions = .changed(sessions, etag: #"W/"812""#)
        }
        let events = ScriptedEvents([])
        let client = DeviceClient(
            record: record(id: "m1", addrs: ["a"]),
            api: api,
            events: { events.next() },
            burn: BurnHistory(),
            clock: ManualClock(t0),
            timing: fast
        )
        await client.start()
        let polled = await waitFor { api.calls.filter { $0.hasPrefix("sessions:") }.count >= 2 }
        let state = await client.state
        await client.stop()
        #expect(polled)
        #expect(state.transport == .polling)
        #expect(state.sessions.count == 3)
        #expect(state.limits.contains { $0.id == "weekly_all" && $0.status == .warn })
        #expect(api.calls.contains(#"sessions:W/"812""#), "the second poll is conditional")
        #expect(events.count >= 2)
    }

    @Test func aSuccessfulReconnectReturnsToSSEAndStopsPolling() async {
        let api = FakeAPI("m1")
        let events = ScriptedEvents([[.closed(.network)], [.closed(.network)], [.open, .event(.heartbeat(rev: 2, at: nil))]])
        let client = DeviceClient(
            record: record(id: "m1", addrs: ["a"]),
            api: api,
            events: { events.next() },
            burn: BurnHistory(),
            clock: ManualClock(t0),
            timing: fast
        )
        await client.start()
        let backToSSE = await waitFor {
            let s = await client.state
            return s.rev == 2
        }
        await client.stop()
        #expect(backToSSE)
        #expect(api.calls.contains("summary"), "it polled while SSE was down")
    }

    @Test func pollingErrorsLandInLastErrorAndNeverCrash() async {
        let api = FakeAPI("m1")
        api.edit { $0.down = true }
        let client = DeviceClient(
            record: record(id: "m1", addrs: ["a"]),
            api: api,
            events: { ScriptedEvents([]).next() },
            burn: BurnHistory(),
            clock: ManualClock(t0),
            timing: fast
        )
        await client.start()
        let failed = await waitFor { await client.state.lastError == "Device unreachable." }
        await client.stop()
        #expect(failed)
    }

    @Test func refreshIsAOneShotRESTBootstrap() async throws {
        let api = FakeAPI("m1")
        let health = try Fixtures.decode(HealthDTO.self, "health-v2.json")
        let summary = try Fixtures.decode(SummaryDTO.self, "summary.json")
        let tokens = try Fixtures.decode(TokensDTO.self, "tokens-project.json")
        api.edit {
            $0.health = health
            $0.summary = summary
            $0.tokens = tokens
        }
        let clock = ManualClock(t0)
        let client = DeviceClient(
            record: record(id: "m1", addrs: ["a"]),
            api: api,
            events: { ScriptedEvents([]).next() },
            burn: BurnHistory(),
            clock: clock,
            timing: fast
        )
        await client.refresh()
        let state = await client.state
        #expect(state.name == "studio")
        #expect(state.health == .fresh)
        #expect(state.lastHeartbeatAt == t0)
        #expect(state.projectTokens.count == 1)
        #expect(api.calls == ["health", "summary", "sessions:-", "rules", "tokens"])
    }
}
