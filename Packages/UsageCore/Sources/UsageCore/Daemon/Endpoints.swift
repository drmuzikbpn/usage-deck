// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Synchronization

/// The ordered candidate base URLs for one device, with a memory of which one answered last.
///
/// Pairing hands over `addrs` in the daemon's preferred order (LAN IP, `<host>.local`, tailnet
/// IP). Each request tries the address that worked last time first and then the rest in their
/// original order, so a phone that walks from Wi-Fi onto a private network finds the device again without
/// re-pairing. The same certificate pin applies to every address.
public final class Endpoints: Sendable {
    private struct State {
        var urls: [URL]
        var preferred: URL?
    }

    private let state: Mutex<State>
    /// The fingerprint these addresses are pinned to: a refused certificate is only ever this
    /// device's when the refusal was for this pin.
    private let pin: String?

    public init(_ urls: [URL], pin: String? = nil) {
        state = Mutex(State(urls: urls, preferred: nil))
        self.pin = pin
    }

    public convenience init(record: DeviceRecord) {
        self.init(record.baseURLs, pin: record.fingerprint)
    }

    /// Candidates in the order to try them now.
    public func ordered() -> [URL] {
        state.withLock { s in
            guard let preferred = s.preferred, s.urls.contains(preferred) else { return s.urls }
            return [preferred] + s.urls.filter { $0 != preferred }
        }
    }

    /// The base URL that answered most recently, if any did.
    public var current: URL? {
        state.withLock { $0.preferred }
    }

    public func succeeded(_ url: URL) {
        let changed = state.withLock { s in
            defer { s.preferred = url }
            return s.preferred != url
        }
        if changed {
            DiagLog.shared.log(.network, "\(DiagLog.host(url.host() ?? "?")) answers")
        }
    }

    /// Replaces the candidate list (pairing refresh from `/health.install.listeners`),
    /// keeping the preferred address when it is still a candidate.
    public func replace(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        state.withLock { s in
            s.urls = urls
            if let preferred = s.preferred, !urls.contains(preferred) {
                s.preferred = nil
            }
        }
    }

    /// Tries `attempt` against each candidate in turn. Moves on only for transport failures
    /// (unreachable, wrong certificate on that address); an HTTP error from a daemon that did
    /// answer is final. When every candidate fails, the error is `pinning` only if every one
    /// of them presented the wrong certificate, otherwise `network`.
    public func first<T>(_ attempt: (URL) async throws -> T) async throws -> T {
        var sawNetwork = false
        var sawPinning = false
        for base in ordered() {
            do {
                let value = try await attempt(base)
                succeeded(base)
                return value
            } catch {
                if Task.isCancelled {
                    throw CancellationError()
                }
                let mapped = DaemonError.from(transport: error, pin: pin)
                DiagLog.shared.log(
                    .network,
                    "\(DiagLog.host(base.host() ?? "?")) failed: \(DiagLog.describe(error)) → \(DiagLog.safeCode(mapped.code))"
                )
                switch mapped.code {
                case "network": sawNetwork = true
                case "pinning": sawPinning = true
                default: throw mapped
                }
            }
        }
        throw sawPinning && !sawNetwork ? DaemonError(code: "pinning") : DaemonError.network
    }
}
