// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// The pure half of `DeviceClient`: folds stream events and REST bodies into one `DeviceState`.
///
/// Kept apart from the connection loops so every rule here is tested synchronously.
public struct DeviceReducer: Sendable {
    public private(set) var state: DeviceState
    /// The weak ETag to send on the next `/v1/sessions` poll.
    public private(set) var etag: String?
    private var thresholds = ThresholdsDTO()
    private let burn: BurnHistory

    public init(record: DeviceRecord, burn: BurnHistory) {
        state = DeviceState(record: record)
        self.burn = burn
    }

    public static func burnKey(deviceId: String, session: String) -> String {
        "\(deviceId)/s/\(session)"
    }

    public static func burnKey(deviceId: String, project: String) -> String {
        "\(deviceId)/p/\(project)"
    }

    public static func burnKey(device: String) -> String {
        "\(device)/m"
    }

    // MARK: - connection

    public mutating func opened(now: Date) {
        state.transport = .sse
        state.lastHeartbeatAt = now
        state.health = .fresh
        state.gone = false
        state.lastError = nil
        state.needsRepair = false
    }

    public mutating func closed(error: DaemonError?, polling: Bool) {
        state.transport = polling ? .polling : .disconnected
        if let error {
            fail(error)
        }
    }

    public mutating func setTransport(_ transport: DeviceState.Transport) {
        state.transport = transport
    }

    public mutating func setActiveAddr(_ addr: String?) {
        state.activeAddr = addr
    }

    public mutating func fail(_ error: DaemonError) {
        if let reason = error.repairReason {
            state.repairReason = reason
            state.lastError = error.userMessage
        } else if state.repairReason == nil {
            // While the pairing is lost, that is the message that matters, not a later outage.
            state.lastError = error.userMessage
        }
    }

    /// Re-derives health off the local clock; aging never trusts the daemon's clock.
    public mutating func age(now: Date) {
        let aged = state.aged(now: now)
        if aged.gone, !state.gone {
            // The sessions it forgot must come back in full, not as a 304 against the old ETag.
            etag = nil
        }
        state = aged
    }

    /// Every event, heartbeat included, and every successful poll proves the daemon is alive.
    public mutating func touch(now: Date) {
        state.lastHeartbeatAt = now
        state.health = Aging.health(lastHeartbeatAt: now, now: now)
        state.gone = false
        state.needsRepair = false
    }

    // MARK: - events

    /// Applies one stream event. Returns true when the caller should re-read `/v1/sessions`
    /// (a `pause` event: pause state lives on the sessions).
    @discardableResult
    public mutating func apply(_ event: DaemonEvent, now: Date) -> Bool {
        touch(now: now)
        switch event {
        case let .snapshot(snapshot):
            applySnapshot(snapshot, now: now)
        case let .limits(limits, fetchedAt, _):
            state.limits = limitsOf(limits)
            state.limitsFetchedAt = ISODate.parse(fetchedAt)
        case let .spend(today, _):
            // `today` is the cumulative authority; the per-event delta is deliberately unused.
            state.today = today.toModel()
            burn.record(Self.burnKey(device: state.id), at: now, cumulative: state.today.total)
        case let .session(type, dto):
            let session = dto.toModel()
            state.sessions.removeAll { $0.sessionId == session.sessionId }
            if type == "end" {
                burn.forget(Self.burnKey(deviceId: state.id, session: session.sessionId))
            } else {
                state.sessions.append(session)
            }
            recordSessionBurn(now: now)
        case let .pause(rules, _):
            state.rules = rules.map { $0.toModel() }
            return true
        case let .update(update):
            state.update = update.toModel()
        case let .heartbeat(rev, _):
            if rev > 0 {
                etag = Self.weakETag(rev)
                if rev > state.rev {
                    state.rev = rev
                }
            }
        case .unknown:
            break
        }
        return false
    }

    public mutating func applySummary(_ summary: SummaryDTO, now: Date) {
        thresholds = summary.thresholds
        state.limits = summary.toLimits()
        state.limitsFetchedAt = ISODate.parse(summary.fetchedAt)
        state.today = summary.today.toModel()
        state.summaryLoaded = true
        burn.record(Self.burnKey(device: state.id), at: now, cumulative: state.today.total)
    }

    public mutating func applySessions(_ result: SessionsResult, now: Date) {
        guard case let .changed(dto, newETag) = result else { return }
        etag = newETag
        state.sessions = dto.sessions.map { $0.toModel() }
        state.rev = dto.rev
        recordSessionBurn(now: now)
    }

    public mutating func applyTokens(_ dto: TokensDTO) {
        state.projectTokens = dto.groups.map { $0.toModel() }
    }

    public mutating func applyHealth(_ health: HealthDTO) {
        if let name = health.name.map(DeviceName.clean), !name.isEmpty {
            state.name = name
        }
        if !health.version.isEmpty {
            state.version = health.version
        }
        if let user = health.user {
            state.user = user.toModel()
        }
        if let update = health.update {
            state.update = update.toModel()
        }
    }

    public mutating func applyRules(_ dto: RulesDTO) {
        state.rules = dto.rules.map { $0.toModel() }
    }

    private mutating func applySnapshot(_ s: DaemonEvent.Snapshot, now: Date) {
        thresholds = s.thresholds
        etag = Self.weakETag(s.rev)
        state.name = s.name
        state.version = s.version
        state.user = s.user?.toModel()
        state.limits = limitsOf(s.limits)
        // The daemon's fetch time, never `now`: the team merge ranks two devices' copies of one
        // account against each other, and stamping the local clock lets a stale copy win.
        state.limitsFetchedAt = ISODate.parse(s.fetchedAt)
        state.today = s.today.toModel()
        state.sessions = s.sessions.map { $0.toModel() }
        state.rules = s.rules.map { $0.toModel() }
        state.update = s.update?.toModel()
        state.rev = s.rev
        state.summaryLoaded = true
        state.transport = .sse
        burn.record(Self.burnKey(device: state.id), at: now, cumulative: state.today.total)
        recordSessionBurn(now: now)
    }

    private func recordSessionBurn(now: Date) {
        var byProject: [String: Int64] = [:]
        for s in state.sessions {
            burn.record(Self.burnKey(deviceId: state.id, session: s.sessionId), at: now, cumulative: s.tokens.total)
            byProject[s.projectKey, default: 0] += s.tokens.total
        }
        for (key, total) in byProject {
            burn.record(Self.burnKey(deviceId: state.id, project: key), at: now, cumulative: total)
        }
    }

    /// A bare `limits` payload has no status map, so derive each status from the row itself.
    /// The last summary's map must not be reused: it describes the old percents, so a week that
    /// reset from 99% to 0% stayed red until the next snapshot.
    private func limitsOf(_ limits: [LimitDTO]) -> [Limit] {
        limits.map { $0.toModel(status: LimitStatusMapping.status(for: $0, thresholds: thresholds)) }
    }

    static func weakETag(_ rev: Int64) -> String {
        "W/\"\(rev)\""
    }
}
