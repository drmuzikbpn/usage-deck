// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import XCTest

/// Daemon §23.68: a plan with no 5-hour window. Demo data with `-UsageDeckDemoNoFiveHour`
/// (Debug only): Adam's account reports a week and no 5-hour window, so the Ledger says "none"
/// rather than `—`, and the landscape rail gives the week the big ring.
final class NoFiveHourTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-UsageDeckDemo", "-UsageDeckDemoNoFiveHour"]
        app.launch()
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    @MainActor
    func testAPlanWithNoFiveHourWindowSaysNone() {
        XCTAssertTrue(element(containing: "none").waitForExistence(timeout: 10))
        sleep(2)
        snap("no-five-hour-1-ledger")

        element(containing: "Adam").tap()
        XCTAssertTrue(element(containing: "on this plan").waitForExistence(timeout: 5))
        sleep(1)
        snap("no-five-hour-2-ledger-open")

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(element(containing: "no 5h limit").waitForExistence(timeout: 10))
        sleep(2)
        snap("no-five-hour-3-dock")
    }

    private func element(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    @MainActor
    private func snap(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
