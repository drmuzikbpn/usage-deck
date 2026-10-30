// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import SwiftUI
import UsageCore

/// The one-line header both home screens carry: the gear (landscape only), the alert chip, one
/// chip per device (dot + short name; tap for the device), and the clock. Alerts appear here
/// rather than as a banner so nothing reflows. While an alert is up the devices shrink to dots.
struct StatusBar: View {
    @Bindable var store: DeckStore
    var showsGear = false

    var body: some View {
        HStack(spacing: 6) {
            if showsGear {
                Button { store.path.append(.settings) } label: {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(DeckColor.fg.opacity(0.85))
                        .frame(width: 42, height: 42)
                        .contentShape(Circle())
                        .deckGlass(in: Circle(), interactive: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
            }
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                if let chip = store.alertChip {
                    Chip(text: chip, dot: DeckColor.warn, tint: DeckColor.warn)
                        .layoutPriority(1)
                }
                ForEach(store.team.devices, id: \.id) { device in
                    let name = Format.hostShort(device.displayName)
                    Chip(
                        text: store.alertChip == nil ? (device.needsRepair ? "\(name) · re-pair" : name) : "",
                        dot: DeckColor.dot(device.health, needsRepair: device.needsRepair)
                    ) {
                        store.path.append(.device(device.id))
                    }
                    .accessibilityLabel(Text(verbatim: "device \(name), \(device.needsRepair ? "needs re-pair" : "\(device.health)")"))
                }
            }
            Text(Format.clock(store.now, use24h: store.settings.use24h))
                .font(DeckFont.numeral(16, .medium))
                .foregroundStyle(DeckColor.fg)
                .lineLimit(1)
                .fixedSize()
                .rolling(Format.clock(store.now, use24h: store.settings.use24h))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

/// One row per paired device while it has not delivered anything: name, state, last error.
struct DeviceWaitRow: View {
    var device: DeviceState
    var now: Date
    var compact = false

    var body: some View {
        let label = compact ? Format.hostShort(device.displayName) : device.displayName
        let status: String = if device.needsRepair {
            "Needs re-pair"
        } else if let error = device.lastError {
            error
        } else if device.lastHeartbeatAt == nil {
            "connecting…"
        } else if device.health == .dead {
            "last heard \(Format.age(device.lastHeartbeatAt, now: now))"
        } else {
            "waiting for first snapshot…"
        }
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(DeckFont.text(13, .medium))
                    .foregroundStyle(DeckColor.fg)
                    .lineLimit(1)
                Text(status)
                    .font(DeckFont.mono(11))
                    .foregroundStyle(device.lastError != nil || device.needsRepair ? DeckColor.warn : DeckColor.muted)
                    .lineLimit(compact ? 2 : nil)
            }
            Spacer(minLength: 8)
            if !compact, let addr = device.activeAddr ?? device.record.addrs.first {
                Text(verbatim: "\(addr):\(device.record.port)")
                    .font(DeckFont.mono(10))
                    .foregroundStyle(DeckColor.dim)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .deckCard(radius: 14)
    }
}

/// The empty states both home screens share, decided by `HomeEmpty`.
struct HomeEmptyView: View {
    @Bindable var store: DeckStore
    var empty: HomeEmpty
    var compact = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                switch empty {
                case .noDevices:
                    NoDevicesView(store: store)
                case .connecting:
                    title(store.team.devices.count == 1 ? "Waiting for device" : "Waiting for devices")
                    paragraph("Paired, but no data yet. Check the daemon is running and this iPhone is on its local network.")
                    VStack(spacing: 6) {
                        // Devices that lost their pairing have their own card above.
                        ForEach(store.team.devices.filter { !$0.needsRepair }, id: \.id) { device in
                            Button { store.path.append(.device(device.id)) } label: {
                                DeviceWaitRow(device: device, now: store.now, compact: compact)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 16)
                case .needsRepair:
                    title(store.team.devices.count == 1 ? "Pairing lost" : "Pairings lost")
                    paragraph("Re-pair above to see usage again. Nothing is lost on this iPhone: the device keeps its name and settings.")
                case let .noSessions(names):
                    title("No live sessions")
                    paragraph("Start a Claude Code session on \(names.joined(separator: " or ")) and it appears here.")
                }
            }
            .padding(.horizontal, compact ? 12 : 28)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity)
        }
    }

    private func title(_ text: String) -> some View {
        Text(text)
            .font(DeckFont.numeral(26))
            .foregroundStyle(DeckColor.fg)
            .multilineTextAlignment(.center)
    }

    private func paragraph(_ text: String) -> some View {
        Text(text)
            .font(DeckFont.text(13))
            .foregroundStyle(DeckColor.muted)
            .multilineTextAlignment(.center)
            .lineSpacing(4)
            .padding(.top, 8)
    }
}

/// Nothing paired (D13): how to get the daemon, and the way into pairing.
struct NoDevicesView: View {
    @Bindable var store: DeckStore

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "gauge.with.dots.needle.67percent")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(LinearGradient(
                    colors: [DeckColor.accent, DeckColor.ok],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                .symbolEffect(.wiggle, options: .repeat(.periodic(delay: 4)))
                .padding(.bottom, 4)
                .accessibilityHidden(true)
            Text("No paired devices")
                .font(DeckFont.numeral(26))
                .foregroundStyle(DeckColor.fg)
            Text(LocalizedStringKey(
                "Usage Deck reads your Claude usage from claude-usage, a small daemon on the computer where you run "
                    + "Claude Code. Install it there, then run `claude-usage pair` and scan its QR code."
            ))
            .font(DeckFont.text(13))
            .foregroundStyle(DeckColor.muted)
            .multilineTextAlignment(.center)
            .lineSpacing(4)
            Button { store.beginPairing() } label: {
                Label("Pair a device", systemImage: "qrcode.viewfinder")
                    .font(DeckFont.text(15, .semibold))
                    .foregroundStyle(DeckColor.fg)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 14)
                    .deckGlass(in: Capsule(), tint: DeckColor.accent, interactive: true)
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
            Button("Try the demo") { store.startDemo() }
                .font(DeckFont.text(14, .medium))
                .foregroundStyle(DeckColor.accent)
                .accessibilityHint("Shows made-up devices and sessions, with nothing paired")
            InstallLinks()
        }
    }
}

/// "Get the Mac app" and the install commands as a share sheet (D13).
struct InstallLinks: View {
    var body: some View {
        HStack(spacing: 10) {
            Link(destination: DeckLinks.project) {
                Label("Get the Mac app", systemImage: "arrow.up.right.square")
                    .font(DeckFont.text(13, .medium))
            }
            ShareLink(item: DeckLinks.installCommands, preview: SharePreview("Install claude-usage")) {
                Label("Share install commands", systemImage: "square.and.arrow.up")
                    .font(DeckFont.text(13, .medium))
            }
        }
        .foregroundStyle(DeckColor.accent)
        .labelStyle(.titleAndIcon)
    }
}
