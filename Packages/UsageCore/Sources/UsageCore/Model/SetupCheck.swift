// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// The device detail checklist, derived from one `/health` read plus the live limits.
public struct SetupCheck: Sendable, Equatable {
    public enum Status: String, Sendable, Equatable {
        case ok
        /// Unknown or not yet applicable: rendered neutral, never red.
        case neutral
        case failing
    }

    public struct Item: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var status: Status
        /// The command (or action) that fixes a failing row.
        public var fix: String?
    }

    public var items: [Item]

    public var allGood: Bool {
        !items.contains { $0.status == .failing }
    }

    /// `limitsFresh` is whether this device's account has a limit reading at all; a brand-new
    /// install has none until a Claude Code session runs, which is neutral, not a failure.
    public static func evaluate(health: HealthDTO?, error: DaemonError?, limitsFresh: Bool) -> SetupCheck {
        guard let health else {
            let fix = error?.needsRepair == true ? "Re-pair this device" : "Is the device awake and on this local network?"
            return SetupCheck(items: [Item(id: "reachable", title: "Reachable", status: .failing, fix: fix)])
        }
        var items = [Item(id: "reachable", title: "Reachable", status: .ok, fix: nil)]
        guard let install = health.install else {
            items.append(Item(id: "version", title: "Daemon up to date", status: .failing, fix: "claude-usage update"))
            return SetupCheck(items: items)
        }
        items.append(Item(id: "version", title: "Daemon up to date", status: .ok, fix: nil))
        let signedIn = health.user?.accountUuid != nil || health.user?.emailAddress != nil
        items.append(Item(
            id: "signedIn",
            title: "Signed in to Claude",
            status: signedIn ? .ok : .failing,
            fix: signedIn ? nil : "claude /login"
        ))
        let spend = health.stats?.spendReady ?? false
        items.append(Item(id: "spend", title: "Token spend indexed", status: spend ? .ok : .neutral, fix: nil))
        items.append(Item(
            id: "limits",
            title: "Usage limits",
            status: limitsFresh ? .ok : .neutral,
            fix: limitsFresh ? nil : "Open a Claude Code session on the device"
        ))
        let hooks = install.hooks
        items.append(Item(
            id: "hooks",
            title: "Session hooks",
            status: hooks == true ? .ok : hooks == false ? .failing : .neutral,
            fix: hooks == false ? "claude-usage install" : nil
        ))
        let statusline: Status = switch install.statusline {
        case "ours", "includes-ours": .ok
        case "other", "none": .failing
        default: .neutral
        }
        items.append(Item(
            id: "statusline",
            title: "Status line",
            status: statusline,
            fix: statusline == .failing ? "claude-usage install" : nil
        ))
        let mcp: Status = install.mcp == true ? .ok : install.mcp == false ? .failing : .neutral
        items.append(Item(id: "mcp", title: "MCP server", status: mcp, fix: mcp == .failing ? "claude-usage install" : nil))
        return SetupCheck(items: items)
    }
}

public extension HealthDTO {
    /// TLS listeners the daemon reports, as candidate addresses in its order (for refreshing a
    /// pairing's `addrs` after the LAN IP moves).
    var tlsAddrs: [String] {
        (install?.listeners ?? []).filter(\.tls).map(\.addr)
    }
}
