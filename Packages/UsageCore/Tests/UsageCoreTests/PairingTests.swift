// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Synchronization
import Testing
@testable import UsageCore

struct PairingLinkTests {
    static let fp = "cb3a09129cb576bf40f3a36936242ea888568a2b31c235d2a00aa8b53419242c"
    static let code = "AbCdEfGhIjKlMnOpQrSt_-"

    static func link(
        v: String = "2",
        name: String = "studio",
        addrs: String = "192.168.1.20%2Cstudio.local%2C100.64.0.7",
        port: String = "47292",
        fp: String = fp,
        code: String = code
    ) -> String {
        "usagedeck://pair?v=\(v)&name=\(name)&addrs=\(addrs)&port=\(port)&fp=\(fp)&code=\(code)"
    }

    func invite(_ text: String) -> PairingInvite? {
        if case let .success(.invite(invite)) = PairingLink.parse(text) {
            return invite
        }
        return nil
    }

    func failure(_ text: String) -> String? {
        if case let .failure(error) = PairingLink.parse(text) {
            return error.message
        }
        return nil
    }

    @Test func parsesTheV2LinkWithItsOrderedCandidates() throws {
        let i = try #require(invite(Self.link()))
        #expect(i.name == "studio")
        #expect(i.addrs == ["192.168.1.20", "studio.local", "100.64.0.7"])
        #expect(i.port == 47292)
        #expect(i.fingerprint == Self.fp)
        #expect(i.code == Self.code)
    }

    @Test func acceptsAURLObjectSurroundingWhitespaceAndPercentEncodedNames() throws {
        #expect(invite("  \(Self.link())\n") != nil)
        let url = try #require(URL(string: Self.link(name: "Adam%27s%20Studio")))
        guard case let .success(.invite(i)) = PairingLink.parse(url) else { Issue.record("no invite"); return }
        #expect(i.name == "Adam's Studio")
    }

    @Test func normalisesAnUppercaseFingerprintAndDropsDuplicateAddresses() {
        let i = invite(Self.link(addrs: "192.168.1.20,STUDIO.local,studio.local,192.168.1.20", fp: Self.fp.uppercased()))
        #expect(i?.fingerprint == Self.fp)
        #expect(i?.addrs == ["192.168.1.20", "STUDIO.local"])
    }

    @Test func ignoresUnknownParametersSoTheDaemonCanAddSome() {
        #expect(invite(Self.link() + "&expires=2026-10-01T18%3A00%3A00Z") != nil)
    }

    @Test(arguments: [
        ("v=3", "version 3; update Usage Deck"),
        ("v=", "no version"),
    ])
    func rejectsOtherVersions(param: String, message: String) {
        let text = Self.link().replacingOccurrences(of: "v=2", with: param)
        #expect(failure(text)?.contains(message) == true)
    }

    @Test(arguments: ["0", "65536", "-1", "abc", ""])
    func rejectsABadPort(port: String) {
        #expect(failure(Self.link(port: port)) == "The pairing link has an invalid port.")
    }

    @Test(arguments: ["", "300.1.1.1", "100.1.1", "not%20a%20host", "http://1.2.3.4", "-bad.local", "a..b"])
    func rejectsABadAddress(addrs: String) {
        #expect(invite(Self.link(addrs: addrs)) == nil)
    }

    @Test(arguments: ["", "abc", String(repeating: "g", count: 64), String(repeating: "a", count: 63)])
    func rejectsABadFingerprint(fp: String) {
        #expect(failure(Self.link(fp: fp)) == "The pairing link has an invalid certificate fingerprint.")
    }

    @Test(arguments: ["", "short", "has+plus+signs+that+are+not+url+safe", "AbCdEfGhIjKlMnOpQrSt%3D%3D"])
    func rejectsABadCode(code: String) {
        #expect(failure(Self.link(code: code)) == "The pairing link has an invalid pairing code.")
    }

    @Test func rejectsAMissingName() {
        #expect(failure(Self.link(name: "%20")) == "The pairing link has no device name.")
        #expect(failure(Self.link(name: "%0A%1B%E2%80%AE")) == "The pairing link has no device name.", "nothing printable")
    }

    @Test func capsTheNameAt64PrintableCharacters() throws {
        let long = String(repeating: "n", count: 300)
        #expect(try #require(invite(Self.link(name: long))).name.count == 64)
        #expect(try #require(invite(Self.link(name: "stu%0Adio%1B%5B31m%E2%80%AE"))).name == "studio[31m")
    }

    @Test func keepsOnlyTheFirstEightAddresses() throws {
        let many = (1 ... 20).map { "h\($0).example.test" }.joined(separator: ",")
        let i = try #require(invite(Self.link(addrs: many)))
        #expect(i.addrs == (1 ... 8).map { "h\($0).example.test" })
    }

    @Test func neverEchoesTheOffendingValue() {
        let evil = "%5Btap%5D%28https%3A%2F%2Fexample.test%29"
        #expect(failure(Self.link(addrs: evil)) == "The pairing link has an invalid address.")
        let json = #"{"v":1,"name":"mbp","addr":"[tap](https://example.test)","port":8787,"token":"t"}"#
        #expect(failure(json) == "The pairing code has an invalid address.")
        #expect(failure(#"{"v":1,"name":"mbp","addr":"studio.local","port":70000,"token":"t"}"#) == "The pairing code has an invalid port.")
    }

    @Test(arguments: ["", "not a link", "https://example.com/pair?v=2", "usagedeck://open?v=2", "{}", "{\"v\":1}"])
    func rejectsTextThatIsNotAPairing(text: String) {
        #expect(failure(text) != nil)
    }

    @Test func aV2LinkNeverCarriesOrPrintsABearer() throws {
        let i = try #require(invite(Self.link()))
        var dumped = ""
        dump(i, to: &dumped)
        for text in [String(describing: i), String(reflecting: i), dumped] {
            #expect(!text.contains(Self.code))
        }
    }

    // MARK: v1 JSON paste (accepted for completeness; the app pairs only over pinned HTTPS)

    let v1 = #"{"v":1,"name":"macbook-pro-10","addr":"100.101.102.103","port":8787,"token":"tok-abc"}"#

    @Test func parsesTheV1JSONThatConfigurePairingPrints() {
        guard case let .success(.legacy(p)) = PairingLink.parse(v1) else { Issue.record("not legacy"); return }
        #expect(p == LegacyPairing(name: "macbook-pro-10", addr: "100.101.102.103", port: 8787, token: "tok-abc"))
        #expect(!String(describing: p).contains("tok-abc"))
    }

    @Test func v1IgnoresUnknownFieldsAndAcceptsATailnetHostname() {
        let text = #"{"v":1,"name":"mbp","addr":"macbook-pro-10.tail0fake.ts.net","port":8787,"token":"t","issuedAt":"x"}"#
        guard case .success(.legacy) = PairingLink.parse(text) else { Issue.record("not legacy"); return }
    }

    @Test(arguments: [
        #"{"v":2,"name":"mbp","addr":"100.1.1.1","port":8787,"token":"t"}"#,
        #"{"v":1,"name":"mbp","addr":"100.1.1.1","port":8787,"token":"   "}"#,
        #"{"v":1,"name":"mbp","addr":"100.1.1.1","port":70000,"token":"t"}"#,
        #"{"v":1,"name":"mbp","addr":"300.1.1.1","port":8787,"token":"t"}"#,
    ])
    func v1RejectsBadPayloads(text: String) {
        #expect(failure(text) != nil)
    }
}

struct PairingClientTests {
    let host = uniqueHost("pair")

    func invite(addrs: [String]) -> PairingInvite {
        PairingInvite(name: "studio", addrs: addrs, port: 47292, fingerprint: PairingLinkTests.fp, code: PairingLinkTests.code)
    }

    @Test func redeemsTheCodeOverHTTPSWithoutABearer() async throws {
        StubURLProtocol.register(host: host) { _ in .respond(.init(body: Fixtures.data("pair-response.json"))) }
        let config = try await PairingClient(session: StubURLProtocol.session()).redeem(invite(addrs: [host]), id: "dev-1")
        #expect(config.token == "fixture-not-a-real-token")
        #expect(config.record == DeviceRecord(id: "dev-1", name: "studio", addrs: [host], port: 47292, fingerprint: PairingLinkTests.fp))

        let request = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(request.url?.absoluteString == "https://\(host):47292/v1/pair")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(try JSONDecoder().decode(PairRequestDTO.self, from: request.httpBody ?? Data()).code == PairingLinkTests.code)
    }

    @Test func fallsThroughToTheNextCandidate() async throws {
        let dead = uniqueHost("dead")
        StubURLProtocol.register(host: dead) { _ in .fail(.timedOut) }
        StubURLProtocol.register(host: host) { _ in .respond(.init(body: Fixtures.data("pair-response.json"))) }
        let config = try await PairingClient(session: StubURLProtocol.session()).redeem(invite(addrs: [dead, host]))
        #expect(config.token == "fixture-not-a-real-token")
    }

    @Test(arguments: [
        ("invalid_code", "run `claude-usage pair` again"),
        ("rate_limited", "too many pairing attempts"),
        ("plain_http", "pair over https"),
    ])
    func surfacesTheDaemonsRefusal(name: String, message: String) async {
        let status = Fixtures.errorStatus(name, file: "pair-errors.json")
        let body = Fixtures.errorBody(name, file: "pair-errors.json")
        StubURLProtocol.register(host: host) { _ in .respond(.init(status: status, body: body)) }
        await #expect {
            try await PairingClient(session: StubURLProtocol.session()).redeem(invite(addrs: [host]))
        } throws: { error in
            (error as? DaemonError)?.userMessage == message
        }
    }

    @Test func aReplyNamingAnotherKeyIsRefused() async {
        let reply = #"{"token":"t","name":"studio","fp":"\#(String(repeating: "0", count: 64))"}"#
        StubURLProtocol.register(host: host) { _ in .respond(.init(body: Data(reply.utf8))) }
        await #expect(throws: DaemonError(code: "pinning")) {
            try await PairingClient(session: StubURLProtocol.session()).redeem(invite(addrs: [host]))
        }
    }
}

/// The first request to a LAN address is what makes iOS ask for Local Network access, and it
/// fails while the question is on screen. The code was never spent, so redeem tries again.
struct PairingPatienceTests {
    let host = uniqueHost("patient")

    func invite() -> PairingInvite {
        PairingInvite(name: "studio", addrs: [host], port: 47292, fingerprint: PairingLinkTests.fp, code: PairingLinkTests.code)
    }

    /// Unreachable for the first `failures` requests, then the daemon answers.
    func answerAfter(_ failures: Int) {
        let host = host
        StubURLProtocol.register(host: host) { _ in
            StubURLProtocol.recorded(host: host).count <= failures
                ? .fail(.notConnectedToInternet)
                : .respond(.init(body: Fixtures.data("pair-response.json")))
        }
    }

    func redeem(_ patience: PairingPatience) async throws -> DeviceConfig {
        try await PairingClient(session: StubURLProtocol.session()).redeem(invite(), patience: patience)
    }

    @Test func triesAgainWhileNoAddressAnswers() async throws {
        answerAfter(2)
        let config = try await redeem(PairingPatience(window: 30, pause: .zero))
        #expect(config.token == "fixture-not-a-real-token")
        #expect(StubURLProtocol.recorded(host: host).count == 3)
    }

    @Test func withoutPatienceTheFirstFailureIsFinal() async {
        answerAfter(1)
        await #expect(throws: DaemonError.network) { try await redeem(.none) }
        #expect(StubURLProtocol.recorded(host: host).count == 1)
    }

    @Test func neverRepeatsACodeTheDaemonRefused() async {
        let status = Fixtures.errorStatus("invalid_code", file: "pair-errors.json")
        let body = Fixtures.errorBody("invalid_code", file: "pair-errors.json")
        StubURLProtocol.register(host: host) { _ in .respond(.init(status: status, body: body)) }
        await #expect { try await redeem(PairingPatience(window: 30, pause: .zero)) } throws: { error in
            (error as? DaemonError)?.userMessage == "run `claude-usage pair` again"
        }
        #expect(StubURLProtocol.recorded(host: host).count == 1)
    }

    @Test func givesUpOnceTheWindowIsSpent() async {
        answerAfter(.max)
        // Every reading of the clock is a second later, so each failed attempt costs one second.
        let ticks = Mutex(0.0)
        let clock: @Sendable () -> Date = {
            ticks.withLock { tick in
                tick += 1
                return Date(timeIntervalSince1970: tick)
            }
        }
        await #expect(throws: DaemonError.network) {
            try await redeem(PairingPatience(window: 3, pause: .zero, now: clock))
        }
        #expect(StubURLProtocol.recorded(host: host).count == 3)
    }

    /// However long the permission question stays up, the answer gets a fresh window.
    @Test func aWaitForTheAppToComeBackRestartsTheWindow() async throws {
        answerAfter(2)
        let waits = Mutex(2)
        let patience = PairingPatience(window: 0, pause: .zero) {
            waits.withLock { left in
                left -= 1
                return left >= 0
            }
        }
        let config = try await redeem(patience)
        #expect(config.token == "fixture-not-a-real-token")
        #expect(StubURLProtocol.recorded(host: host).count == 3)
    }
}

struct PinnedTrustTests {
    @Test func theFingerprintMatchesOpenSSLsSPKIHash() {
        let expected = Fixtures.text("tls-fingerprint.txt").trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(expected.count == 64)
        #expect(PinnedTrust.fingerprint(ofCertificateDER: Fixtures.data("tls-cert.der")) == expected)
    }

    @Test func theHeaderIsTheContractsP256Prefix() {
        #expect(PinnedTrust.hex(PinnedTrust.p256SPKIHeader) == "3059301306072a8648ce3d020106082a8648ce3d030107034200")
    }

    @Test func garbageIsNotACertificate() {
        #expect(PinnedTrust.fingerprint(ofCertificateDER: Data("nope".utf8)) == nil)
    }

    @Test func comparisonIsExactAndCaseNormalisedAtInit() {
        #expect(PinnedTrust.constantTimeEqual("abc", "abc"))
        #expect(!PinnedTrust.constantTimeEqual("abc", "abd"))
        #expect(!PinnedTrust.constantTimeEqual("abc", "abcd"))
        #expect(PinnedTrust(fingerprint: "ABC").fingerprint == "abc")
    }

    @Test func refusesEveryChallengeThatIsNotServerTrust() async throws {
        let space = URLProtectionSpace(
            host: "x.test",
            port: 443,
            protocol: "https",
            realm: nil,
            authenticationMethod: NSURLAuthenticationMethodHTTPBasic
        )
        let challenge = URLAuthenticationChallenge(
            protectionSpace: space,
            proposedCredential: nil,
            previousFailureCount: 0,
            failureResponse: nil,
            error: nil,
            sender: NoopSender()
        )
        let (disposition, credential) = await PinnedTrust(fingerprint: "a").urlSession(URLSession.shared, didReceive: challenge)
        #expect(disposition == .cancelAuthenticationChallenge)
        #expect(credential == nil)
        // The task-level challenge gets the same answer.
        let task = try URLSession.shared.dataTask(with: #require(URL(string: "https://x.test/")))
        let (taskDisposition, taskCredential) = await PinnedTrust(fingerprint: "a")
            .urlSession(URLSession.shared, task: task, didReceive: challenge)
        #expect(taskDisposition == .cancelAuthenticationChallenge)
        #expect(taskCredential == nil)
    }

    /// iOS 26 sends a `bytes(for:)` task's server-trust challenge to the task-level method only.
    /// Without it the system's trust evaluation refused the self-signed daemon and every first
    /// pairing failed as "certificate changed".
    @Test func answersTaskLevelChallenges() {
        let selector = #selector(URLSessionTaskDelegate.urlSession(_:task:didReceive:completionHandler:))
        #expect(PinnedTrust(fingerprint: "a").responds(to: selector))
    }
}

private final class NoopSender: NSObject, URLAuthenticationChallengeSender {
    func use(_: URLCredential, for _: URLAuthenticationChallenge) {}
    func continueWithoutCredential(for _: URLAuthenticationChallenge) {}
    func cancel(_: URLAuthenticationChallenge) {}
}
