// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import CoreText
import Foundation
import SwiftUI
import Testing
import UsageCore
import WidgetKit

/// Renders every widget or complication family for a few sample scenarios to PNG, so the faces
/// can be looked at without a home screen or a watch face. Test-only: nothing here ships.
///
/// Output goes to `$WIDGET_SHOTS_DIR` (pass it to `xcodebuild test` as
/// `TEST_RUNNER_WIDGET_SHOTS_DIR`), else a temporary directory. Accessory families are drawn
/// in full colour; the system tints them on a real lock screen or watch face.
@MainActor
struct WidgetRenderTests {
    struct Scenario: Sendable, CustomStringConvertible {
        let name: String
        let choice: AccountChoice
        let make: @Sendable (Date) -> WatchSnapshot?

        var description: String {
            name
        }
    }

    nonisolated static let scenarios: [Scenario] = [
        Scenario(name: "one-account", choice: .highest) { now in
            var sample = WatchSnapshot.sample(now: now)
            sample.accounts = Array(sample.accounts.prefix(1))
            return sample
        },
        Scenario(name: "two-accounts-highest", choice: .highest) { WatchSnapshot.sample(now: $0) },
        Scenario(name: "two-accounts-fixed-home", choice: .account(key: "sample-home/org")) { WatchSnapshot.sample(now: $0) },
        Scenario(name: "stale", choice: .highest) { WatchSnapshot.sample(now: $0.addingTimeInterval(-75)) },
        // Daemon §23.68: a plan with no 5-hour window leads with the week.
        Scenario(name: "no-five-hour", choice: .highest) { now in
            var sample = WatchSnapshot.sample(now: now)
            sample.accounts = Array(sample.accounts.prefix(1))
            sample.accounts[0].fiveHour = nil
            return sample
        },
        Scenario(name: "no-devices", choice: .highest) { now in
            var sample = WatchSnapshot.sample(now: now)
            sample.devices = []
            return sample
        },
    ]

    // Points per family: iPhone 14 Pro Max / iPhone 16 Pro Max class, Apple Watch 46 mm class.
    #if os(iOS)
        static let families: [(WidgetFamily, CGSize)] = [
            (.systemSmall, CGSize(width: 170, height: 170)),
            (.systemMedium, CGSize(width: 364, height: 170)),
            (.accessoryCircular, CGSize(width: 76, height: 76)),
            (.accessoryRectangular, CGSize(width: 172, height: 76)),
            (.accessoryInline, CGSize(width: 257, height: 26)),
        ]
        static let platform = "ios"
    #else
        static let families: [(WidgetFamily, CGSize)] = [
            (.accessoryCircular, CGSize(width: 50, height: 50)),
            (.accessoryRectangular, CGSize(width: 186, height: 76)),
            (.accessoryCorner, CGSize(width: 44, height: 44)),
            (.accessoryInline, CGSize(width: 186, height: 22)),
        ]
        static let platform = "watch"
    #endif

    static let outputDirectory: URL = {
        let path = ProcessInfo.processInfo.environment["WIDGET_SHOTS_DIR"] ?? NSTemporaryDirectory() + "widget-shots"
        return URL(fileURLWithPath: path, isDirectory: true)
    }()

    init() throws {
        try FileManager.default.createDirectory(at: Self.outputDirectory, withIntermediateDirectories: true)
        _ = Self.registerFont
    }

    /// The extensions register Barlow through UIAppFonts; a test bundle has to do it by hand.
    static let registerFont: Void = {
        let bundle = Bundle(for: BundleToken.self)
        if let url = bundle.url(forResource: "BarlowCondensed-SemiBold", withExtension: "ttf") {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()

    @Test(arguments: scenarios)
    func rendersEveryFamily(_ scenario: Scenario) throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let face = GlanceFace.make(snapshot: scenario.make(now), choice: scenario.choice, now: now)
        for (family, size) in Self.families {
            let view = GlanceContent(face: face, family: family)
                .frame(width: size.width, height: size.height)
                .padding(family == .accessoryInline ? 4 : 10)
                .background(Theme.ground)
                .environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            let image = try #require(renderer.uiImage, "\(family) did not render")
            let png = try #require(image.pngData())
            let url = Self.outputDirectory.appendingPathComponent("\(Self.platform)-\(family.fileName)-\(scenario.name).png")
            try png.write(to: url)
            #expect(png.count > 1000)
        }
    }
}

private final class BundleToken {}

private extension WidgetFamily {
    var fileName: String {
        String(describing: self)
    }
}
