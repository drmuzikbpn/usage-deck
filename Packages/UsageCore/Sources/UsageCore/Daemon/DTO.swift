// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

// Wire shapes of the `claude-usage` daemon (daemon spec §17–§23, iOS contract v2).
//
// Every DTO decodes tolerantly, like the deck's `DaemonJson`: unknown keys are ignored, a
// missing or `null` optional field takes its default, and a field of the wrong type falls
// back to the default too. Only the fields a row cannot exist without (a session's id, cwd
// and timestamps; a rule's id, scope and mode) are required, and lists of rows, a session's
// pause and the nested limits body decode strictly, so a malformed row fails loudly instead of
// half-decoding into something that looks valid (a paused session reading as running).

extension KeyedDecodingContainer {
    /// The value at `key`, or `fallback` when it is absent, `null` or the wrong type.
    func value<T: Decodable>(_ key: Key, or fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)).flatMap(\.self) ?? fallback
    }

    /// The value at `key`, or `nil` when it is absent, `null` or the wrong type.
    func optional<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)).flatMap(\.self)
    }
}

public struct TokensCountsDTO: Codable, Sendable, Equatable {
    public var input: Int64
    public var output: Int64
    public var cacheCreate: Int64
    public var cacheRead: Int64
    public var messages: Int64
    /// `summary.today` carries this; session and spend counts omit it and default to true.
    public var ready: Bool

    public init(
        input: Int64 = 0,
        output: Int64 = 0,
        cacheCreate: Int64 = 0,
        cacheRead: Int64 = 0,
        messages: Int64 = 0,
        ready: Bool = true
    ) {
        self.input = input
        self.output = output
        self.cacheCreate = cacheCreate
        self.cacheRead = cacheRead
        self.messages = messages
        self.ready = ready
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        input = c.value(.input, or: 0)
        output = c.value(.output, or: 0)
        cacheCreate = c.value(.cacheCreate, or: 0)
        cacheRead = c.value(.cacheRead, or: 0)
        messages = c.value(.messages, or: 0)
        ready = c.value(.ready, or: true)
    }
}

public struct UserDTO: Codable, Sendable, Equatable {
    public var emailAddress: String?
    public var accountUuid: String?
    public var organizationUuid: String?
    public var organizationName: String?
    public var displayName: String?

    public init(
        emailAddress: String? = nil,
        accountUuid: String? = nil,
        organizationUuid: String? = nil,
        organizationName: String? = nil,
        displayName: String? = nil
    ) {
        self.emailAddress = emailAddress
        self.accountUuid = accountUuid
        self.organizationUuid = organizationUuid
        self.organizationName = organizationName
        self.displayName = displayName
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        emailAddress = c.optional(.emailAddress)
        accountUuid = c.optional(.accountUuid)
        organizationUuid = c.optional(.organizationUuid)
        organizationName = c.optional(.organizationName)
        displayName = c.optional(.displayName)
    }
}

public struct UpdateDTO: Codable, Sendable, Equatable {
    public var channel: String
    public var current: String
    public var available: String?
    public var state: String
    public var deferredReason: String?

    public init(
        channel: String = "stable",
        current: String = "",
        available: String? = nil,
        state: String = "idle",
        deferredReason: String? = nil
    ) {
        self.channel = channel
        self.current = current
        self.available = available
        self.state = state
        self.deferredReason = deferredReason
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channel = c.value(.channel, or: "stable")
        current = c.value(.current, or: "")
        available = c.optional(.available)
        state = c.value(.state, or: "idle")
        deferredReason = c.optional(.deferredReason)
    }
}

/// `/health.stats`. Only the field the setup check reads is modelled.
public struct HealthStatsDTO: Codable, Sendable, Equatable {
    public var spendReady: Bool
    public var lastScanAt: String?

    public init(spendReady: Bool = false, lastScanAt: String? = nil) {
        self.spendReady = spendReady
        self.lastScanAt = lastScanAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spendReady = c.value(.spendReady, or: false)
        lastScanAt = c.optional(.lastScanAt)
    }
}

/// One bound listener in `/health.install.listeners`.
public struct ListenerDTO: Codable, Sendable, Equatable {
    public var addr: String
    public var port: Int
    public var tls: Bool

    public init(addr: String, port: Int, tls: Bool) {
        self.addr = addr
        self.port = port
        self.tls = tls
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        addr = try c.decode(String.self, forKey: .addr)
        port = c.value(.port, or: 0)
        tls = c.value(.tls, or: false)
    }
}

/// `/health.install` (contract v2). Absent on daemons that predate it, which is how the app
/// tells "update the daemon" apart from a daemon that is merely misconfigured.
public struct InstallDTO: Codable, Sendable, Equatable {
    public var hooks: Bool?
    /// `ours | includes-ours | other | none`.
    public var statusline: String?
    /// `null` means the daemon could not tell; render it neutral, never red.
    public var mcp: Bool?
    public var listeners: [ListenerDTO]

    public init(hooks: Bool? = nil, statusline: String? = nil, mcp: Bool? = nil, listeners: [ListenerDTO] = []) {
        self.hooks = hooks
        self.statusline = statusline
        self.mcp = mcp
        self.listeners = listeners
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hooks = c.optional(.hooks)
        statusline = c.optional(.statusline)
        mcp = c.optional(.mcp)
        listeners = try c.decodeIfPresent([ListenerDTO].self, forKey: .listeners) ?? []
    }
}

public struct HealthDTO: Codable, Sendable, Equatable {
    public var ok: Bool
    public var version: String
    public var uptimeMs: Int64
    public var pid: Int
    public var name: String?
    public var user: UserDTO?
    public var update: UpdateDTO?
    public var stats: HealthStatsDTO?
    public var install: InstallDTO?

    public init(
        ok: Bool = true,
        version: String = "",
        uptimeMs: Int64 = 0,
        pid: Int = 0,
        name: String? = nil,
        user: UserDTO? = nil,
        update: UpdateDTO? = nil,
        stats: HealthStatsDTO? = nil,
        install: InstallDTO? = nil
    ) {
        self.ok = ok
        self.version = version
        self.uptimeMs = uptimeMs
        self.pid = pid
        self.name = name
        self.user = user
        self.update = update
        self.stats = stats
        self.install = install
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.value(.ok, or: true)
        version = c.value(.version, or: "")
        uptimeMs = c.value(.uptimeMs, or: 0)
        pid = c.value(.pid, or: 0)
        name = c.optional(.name)
        user = c.optional(.user)
        update = c.optional(.update)
        stats = c.optional(.stats)
        install = c.optional(.install)
    }
}

public struct LimitScopeDTO: Codable, Sendable, Equatable {
    public var model: String?
    public var surface: String?

    public init(model: String? = nil, surface: String? = nil) {
        self.model = model
        self.surface = surface
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = c.optional(.model)
        surface = c.optional(.surface)
    }
}

public struct LimitDTO: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var group: String
    /// `nil` when the daemon has no current number for this row (§23.40, §23.67).
    public var percent: Int?
    public var severity: String
    public var resetsAt: String?
    public var scope: LimitScopeDTO?
    public var isActive: Bool

    public init(
        id: String,
        kind: String,
        group: String = "",
        percent: Int? = nil,
        severity: String = "normal",
        resetsAt: String? = nil,
        scope: LimitScopeDTO? = nil,
        isActive: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.group = group
        self.percent = percent
        self.severity = severity
        self.resetsAt = resetsAt
        self.scope = scope
        self.isActive = isActive
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        group = c.value(.group, or: "")
        percent = try? c.decodeIfPresent(Int.self, forKey: .percent)
        severity = c.value(.severity, or: "normal")
        resetsAt = c.optional(.resetsAt)
        scope = c.optional(.scope)
        isActive = c.value(.isActive, or: false)
    }
}

public struct StatusDTO: Codable, Sendable, Equatable {
    public var byId: [String: String]
    public var overall: String

    public init(byId: [String: String] = [:], overall: String = "ok") {
        self.byId = byId
        self.overall = overall
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        byId = c.value(.byId, or: [:])
        overall = c.value(.overall, or: "ok")
    }
}

public struct ErrorBodyDTO: Codable, Sendable, Equatable {
    public var code: String
    public var message: String?
    public var hint: String?

    public init(code: String, message: String? = nil, hint: String? = nil) {
        self.code = code
        self.message = message
        self.hint = hint
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        message = c.optional(.message)
        hint = c.optional(.hint)
    }
}

public struct ErrorEnvelopeDTO: Codable, Sendable, Equatable {
    public var error: ErrorBodyDTO
}

/// The normalized limits body: the whole of `GET /v1/limits` and `summary.limits`.
/// `legacyWindows`, `extraUsage` and `raw` are deliberately never decoded — build only on `limits[]`.
public struct LimitsBodyDTO: Codable, Sendable, Equatable {
    public var limits: [LimitDTO]
    public var fetchedAt: String?
    public var stale: Bool
    public var error: ErrorBodyDTO?

    public init(limits: [LimitDTO] = [], fetchedAt: String? = nil, stale: Bool = false, error: ErrorBodyDTO? = nil) {
        self.limits = limits
        self.fetchedAt = fetchedAt
        self.stale = stale
        self.error = error
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        limits = try c.decodeIfPresent([LimitDTO].self, forKey: .limits) ?? []
        fetchedAt = c.optional(.fetchedAt)
        stale = c.value(.stale, or: false)
        error = c.optional(.error)
    }
}

public struct ThresholdsDTO: Codable, Sendable, Equatable {
    public var warn: Int
    public var critical: Int

    public init(warn: Int = 80, critical: Int = 95) {
        self.warn = warn
        self.critical = critical
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        warn = c.value(.warn, or: 80)
        critical = c.value(.critical, or: 95)
    }
}

public struct SummaryDTO: Codable, Sendable, Equatable {
    public var limits: LimitsBodyDTO
    public var status: StatusDTO
    public var thresholds: ThresholdsDTO
    public var today: TokensCountsDTO

    public var fetchedAt: String? {
        limits.fetchedAt
    }

    public var stale: Bool {
        limits.stale
    }

    public init(
        limits: LimitsBodyDTO = LimitsBodyDTO(),
        status: StatusDTO = StatusDTO(),
        thresholds: ThresholdsDTO = ThresholdsDTO(),
        today: TokensCountsDTO = TokensCountsDTO()
    ) {
        self.limits = limits
        self.status = status
        self.thresholds = thresholds
        self.today = today
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        limits = try c.decodeIfPresent(LimitsBodyDTO.self, forKey: .limits) ?? LimitsBodyDTO()
        status = c.value(.status, or: StatusDTO())
        thresholds = c.value(.thresholds, or: ThresholdsDTO())
        today = c.value(.today, or: TokensCountsDTO())
    }
}

public struct ProjectRefDTO: Codable, Sendable, Equatable {
    public var gitCommonDir: String?
    public var name: String

    public init(gitCommonDir: String? = nil, name: String = "") {
        self.gitCommonDir = gitCommonDir
        self.name = name
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        gitCommonDir = c.optional(.gitCommonDir)
        name = c.value(.name, or: "")
    }
}

public struct PauseStateDTO: Codable, Sendable, Equatable {
    public var mode: String
    public var ruleId: String
    public var scope: String
    public var since: String
    public var frozenPids: [Int]
    public var freezes: Int

    public init(mode: String, ruleId: String, scope: String, since: String, frozenPids: [Int] = [], freezes: Int = 0) {
        self.mode = mode
        self.ruleId = ruleId
        self.scope = scope
        self.since = since
        self.frozenPids = frozenPids
        self.freezes = freezes
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = try c.decode(String.self, forKey: .mode)
        ruleId = try c.decode(String.self, forKey: .ruleId)
        scope = try c.decode(String.self, forKey: .scope)
        since = try c.decode(String.self, forKey: .since)
        frozenPids = c.value(.frozenPids, or: [])
        freezes = c.value(.freezes, or: 0)
    }
}

public struct LastToolDTO: Codable, Sendable, Equatable {
    public var name: String
    public var at: String
}

public struct SessionDTO: Codable, Sendable, Equatable {
    public var sessionId: String
    public var pid: Int?
    public var alive: Bool
    public var discovered: String
    public var cwd: String
    public var transcriptPath: String?
    public var project: ProjectRefDTO
    public var worktree: String?
    public var model: String?
    public var startedAt: String
    public var lastActivityAt: String
    public var tokens: TokensCountsDTO
    public var pause: PauseStateDTO?
    public var lastTool: LastToolDTO?
    public var title: String?

    public init(
        sessionId: String,
        pid: Int? = nil,
        alive: Bool = true,
        discovered: String = "hook",
        cwd: String,
        transcriptPath: String? = nil,
        project: ProjectRefDTO = ProjectRefDTO(),
        worktree: String? = nil,
        model: String? = nil,
        startedAt: String,
        lastActivityAt: String,
        tokens: TokensCountsDTO = TokensCountsDTO(),
        pause: PauseStateDTO? = nil,
        lastTool: LastToolDTO? = nil,
        title: String? = nil
    ) {
        self.sessionId = sessionId
        self.pid = pid
        self.alive = alive
        self.discovered = discovered
        self.cwd = cwd
        self.transcriptPath = transcriptPath
        self.project = project
        self.worktree = worktree
        self.model = model
        self.startedAt = startedAt
        self.lastActivityAt = lastActivityAt
        self.tokens = tokens
        self.pause = pause
        self.lastTool = lastTool
        self.title = title
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        pid = c.optional(.pid)
        alive = c.value(.alive, or: true)
        discovered = c.value(.discovered, or: "hook")
        cwd = try c.decode(String.self, forKey: .cwd)
        transcriptPath = c.optional(.transcriptPath)
        project = try c.decodeIfPresent(ProjectRefDTO.self, forKey: .project) ?? ProjectRefDTO()
        worktree = c.optional(.worktree)
        model = c.optional(.model)
        startedAt = try c.decode(String.self, forKey: .startedAt)
        lastActivityAt = try c.decode(String.self, forKey: .lastActivityAt)
        tokens = c.value(.tokens, or: TokensCountsDTO())
        pause = try c.decodeIfPresent(PauseStateDTO.self, forKey: .pause)
        lastTool = c.optional(.lastTool)
        title = c.optional(.title)
    }
}

public struct SessionsDTO: Codable, Sendable, Equatable {
    public var rev: Int64
    public var sessions: [SessionDTO]

    public init(rev: Int64 = 0, sessions: [SessionDTO] = []) {
        self.rev = rev
        self.sessions = sessions
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rev = c.value(.rev, or: 0)
        sessions = try c.decodeIfPresent([SessionDTO].self, forKey: .sessions) ?? []
    }
}

public struct PauseRuleDTO: Codable, Sendable, Equatable {
    public var id: String
    /// The daemon's grammar: `all | project:<gitCommonDir> | session:<sessionId>` (spec §18.1).
    public var scope: String
    public var mode: String
    public var reason: String?
    public var createdAt: String
    public var createdBy: String

    public init(id: String, scope: String, mode: String, reason: String? = nil, createdAt: String, createdBy: String = "") {
        self.id = id
        self.scope = scope
        self.mode = mode
        self.reason = reason
        self.createdAt = createdAt
        self.createdBy = createdBy
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        scope = try c.decode(String.self, forKey: .scope)
        mode = try c.decode(String.self, forKey: .mode)
        reason = c.optional(.reason)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        createdBy = c.value(.createdBy, or: "")
    }
}

public struct PauseResponseDTO: Codable, Sendable, Equatable {
    public var rule: PauseRuleDTO
    public var affected: [String]

    public init(rule: PauseRuleDTO, affected: [String] = []) {
        self.rule = rule
        self.affected = affected
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rule = try c.decode(PauseRuleDTO.self, forKey: .rule)
        affected = c.value(.affected, or: [])
    }
}

public struct ResumeResponseDTO: Codable, Sendable, Equatable {
    public var removed: [String]
    public var resumed: [String]

    public init(removed: [String] = [], resumed: [String] = []) {
        self.removed = removed
        self.resumed = resumed
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        removed = c.value(.removed, or: [])
        resumed = c.value(.resumed, or: [])
    }
}

public struct RulesDTO: Codable, Sendable, Equatable {
    public var rev: Int64
    public var rules: [PauseRuleDTO]

    public init(rev: Int64 = 0, rules: [PauseRuleDTO] = []) {
        self.rev = rev
        self.rules = rules
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rev = c.value(.rev, or: 0)
        rules = try c.decodeIfPresent([PauseRuleDTO].self, forKey: .rules) ?? []
    }
}

public struct TokensGroupDTO: Codable, Sendable, Equatable {
    public var key: String
    /// For `groupBy=project` this is the session cwd.
    public var label: String
    public var input: Int64
    public var output: Int64
    public var cacheCreate: Int64
    public var cacheRead: Int64
    public var messages: Int64

    public init(
        key: String,
        label: String = "",
        input: Int64 = 0,
        output: Int64 = 0,
        cacheCreate: Int64 = 0,
        cacheRead: Int64 = 0,
        messages: Int64 = 0
    ) {
        self.key = key
        self.label = label
        self.input = input
        self.output = output
        self.cacheCreate = cacheCreate
        self.cacheRead = cacheRead
        self.messages = messages
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = c.value(.label, or: "")
        input = c.value(.input, or: 0)
        output = c.value(.output, or: 0)
        cacheCreate = c.value(.cacheCreate, or: 0)
        cacheRead = c.value(.cacheRead, or: 0)
        messages = c.value(.messages, or: 0)
    }
}

public struct TokensDTO: Codable, Sendable, Equatable {
    public var ready: Bool
    public var groups: [TokensGroupDTO]

    public init(ready: Bool = true, groups: [TokensGroupDTO] = []) {
        self.ready = ready
        self.groups = groups
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ready = c.value(.ready, or: true)
        groups = try c.decodeIfPresent([TokensGroupDTO].self, forKey: .groups) ?? []
    }
}

public struct PauseRequestDTO: Codable, Sendable, Equatable {
    public var scope: String
    public var mode: String
    public var reason: String
}

public struct ResumeRequestDTO: Codable, Sendable, Equatable {
    public var scope: String
}

/// `POST /v1/pair` body (contract v2).
public struct PairRequestDTO: Codable, Sendable, Equatable {
    public var code: String
}

/// `POST /v1/pair` success body. `token` is the bearer: it goes straight to the Keychain.
public struct PairResponseDTO: Decodable, Sendable {
    public var token: String
    public var name: String?
    public var fp: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        name = c.optional(.name)
        fp = c.optional(.fp)
    }

    enum CodingKeys: String, CodingKey {
        case token
        case name
        case fp
    }
}

extension PairResponseDTO: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "PairResponseDTO(name: \(name ?? "nil"), token: <redacted>)"
    }

    public var debugDescription: String {
        description
    }

    public var customMirror: Mirror {
        Mirror(self, children: ["name": name as Any, "fp": fp as Any])
    }
}
