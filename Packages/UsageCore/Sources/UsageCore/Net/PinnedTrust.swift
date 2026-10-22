// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import CryptoKit
import Foundation
import Security
import Synchronization

/// When PinnedTrust last refused a certificate, per pinned fingerprint: a refusal on one device
/// says nothing about another, and must never mark it. URLSession reports a refused challenge as a plain
/// `URLError.cancelled`, which is also what any cancelled request looks like (a stream being
/// replaced, a scene going to the background, a group losing its race). Only a cancellation
/// shortly after a real refusal is a pin mismatch; reading every cancel as one marked a healthy
/// device "Needs re-pair" the first time a request was cancelled.
public final class PinRejections: Sendable {
    public static let shared = PinRejections()
    public static let window: TimeInterval = 10

    private let last = Mutex<[String: Date]>([:])

    public init() {}

    /// `pin` is the fingerprint the refusing session was pinned to.
    public func note(pin: String, at date: Date = Date()) {
        last.withLock { refusals in
            // Only the last few seconds matter; nothing older is kept.
            refusals = refusals.filter { date.timeIntervalSince($0.value) < Self.window }
            refusals[pin.lowercased()] = date
        }
    }

    public func recent(pin: String, now: Date = Date()) -> Bool {
        last.withLock { $0[pin.lowercased()].map { now.timeIntervalSince($0) < Self.window } ?? false }
    }

    var count: Int {
        last.withLock { $0.count }
    }
}

/// Accepts a server's TLS certificate **iff** the SHA-256 of its SubjectPublicKeyInfo equals the
/// fingerprint the pairing link carried. Every other challenge is refused.
///
/// The daemon's certificate is self-signed (ECDSA P-256), so there is no chain to evaluate: the
/// pin is the whole of trust, and it holds on every candidate address. Host names are not
/// checked — the LAN IP, `.local` name and tailnet IP all present the same key.
///
/// It also refuses every HTTP redirect: a device is only ever asked for its own paths, and a
/// redirect would carry the request (a daemon could aim it anywhere) off the pinned address.
public final class PinnedTrust: NSObject, URLSessionTaskDelegate, Sendable {
    /// DER prefix of a P-256 SubjectPublicKeyInfo, up to the BIT STRING holding the X9.63 point.
    /// `SecKeyCopyExternalRepresentation` returns only that point, so the header is prepended to
    /// rebuild the bytes Node's `spki` export and `openssl pkey -pubin -outform der` hash.
    static let p256SPKIHeader: [UInt8] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
        0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ]

    public let fingerprint: String

    /// `fingerprint` is lowercased; anything that is not 64 hex digits can never match.
    public init(fingerprint: String) {
        self.fingerprint = fingerprint.lowercased()
    }

    /// The pinned `URLSession` for one device. Ephemeral: no cookies, no cache, no credential store.
    public static func session(fingerprint: String, configuration: URLSessionConfiguration = .ephemeral) -> URLSession {
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration, delegate: PinnedTrust(fingerprint: fingerprint), delegateQueue: nil)
    }

    public func urlSession(
        _: URLSession,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        answer(challenge)
    }

    /// The same answer at task level. iOS 26 delivers a task's server-trust challenge here when
    /// the delegate is a task delegate (`bytes(for:)`), never consulting the session-level method
    /// above; without this the system's own trust evaluation ran and refused every self-signed
    /// daemon, which the app read as "certificate changed" on the very first pairing.
    public func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        answer(challenge)
    }

    private func answer(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard let trust = accepted(challenge) else {
            if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
                PinRejections.shared.note(pin: fingerprint)
            }
            return (.cancelAuthenticationChallenge, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }

    /// Never follow a redirect; the 3xx itself becomes the response (and so an error).
    public func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest _: URLRequest
    ) async -> URLRequest? {
        nil
    }

    /// The trust to answer with, or nil to refuse.
    private func accepted(_ challenge: URLAuthenticationChallenge) -> SecTrust? {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
              let presented = Self.fingerprint(of: leaf),
              Self.constantTimeEqual(presented, fingerprint)
        else { return nil }
        return trust
    }

    /// SHA-256 over the leaf's SubjectPublicKeyInfo, as lowercase hex. Nil for anything that is
    /// not a P-256 key — the daemon only ever mints P-256.
    public static func fingerprint(of certificate: SecCertificate) -> String? {
        guard let key = SecCertificateCopyKey(certificate),
              let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
              (attributes[kSecAttrKeyType] as? String) == (kSecAttrKeyTypeECSECPrimeRandom as String),
              (attributes[kSecAttrKeySizeInBits] as? Int) == 256,
              let point = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              point.count == 65
        else { return nil }
        return hex(SHA256.hash(data: Data(p256SPKIHeader) + point))
    }

    /// The same fingerprint from a DER-encoded certificate.
    public static func fingerprint(ofCertificateDER der: Data) -> String? {
        guard let certificate = SecCertificateCreateWithData(nil, der as CFData) else { return nil }
        return fingerprint(of: certificate)
    }

    static func hex(_ digest: some Sequence<UInt8>) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }

    static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8)
        let y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in x.indices {
            diff |= x[i] ^ y[i]
        }
        return diff == 0
    }
}
