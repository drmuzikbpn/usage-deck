// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import SwiftUI
import UsageCore

/// One account: uppercase name, the 5 h window as a big ring and the 7 d window as a small one,
/// each with its countdown and reset time. Stale data fades and wears a corner dot; Always-On
/// keeps the rings and percents only.
struct AccountPage: View {
    @Environment(PhoneLink.self) private var link
    @Environment(\.isLuminanceReduced) private var systemLuminanceReduced
    private var isLuminanceReduced: Bool {
        AlwaysOn.dimmed(systemLuminanceReduced)
    }

    let account: WatchSnapshot.Account
    let snapshot: WatchSnapshot

    var body: some View {
        TimelineView(.periodic(from: .now, by: isLuminanceReduced ? 60 : 1)) { context in
            let now = context.date
            let health = snapshot.health(of: account, now: now)
            let faded = health != .fresh || !link.reachable
            VStack(spacing: 6) {
                if !link.reachable, !isLuminanceReduced {
                    UnreachableBanner()
                }
                header(health: health, now: now)
                // The rings take whatever the screen has left: the 5 h ring as large as fits beside
                // the 7 d ring with room under both for their countdowns.
                GeometryReader { proxy in
                    let sizes = RingSize.fitting(proxy.size, showsText: !isLuminanceReduced)
                    // Bottom-aligned like the phone's rail: both windows end on the same line.
                    // §23.68: with no 5-hour window the week takes the big ring; places stay put.
                    let swap = account.noFiveHourLimit
                    HStack(alignment: .bottom, spacing: RingSize.gap) {
                        window(account.fiveHour, label: "5 h", size: swap ? sizes.small : sizes.big, now: now, noLimit: swap)
                        window(account.sevenDay, label: "7 d", size: swap ? sizes.big : sizes.small, now: now)
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                }
                .opacity(faded ? Theme.staleFade : 1)
            }
            .padding(.horizontal, 4)
        }
        .containerBackground(Theme.ground.gradient, for: .tabView)
    }

    private func header(health: Health, now: Date) -> some View {
        HStack(spacing: 4) {
            Text(account.name.uppercased())
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .kerning(0.6)
                .foregroundStyle(Theme.muted)
                .lineLimit(1)
            Spacer(minLength: 0)
            if health != .fresh {
                if !isLuminanceReduced {
                    Text(Format.age(snapshot.generatedAt, now: now))
                        .font(Theme.data(11))
                        .foregroundStyle(Theme.color(health))
                }
                Circle()
                    .fill(Theme.color(health))
                    .frame(width: 6, height: 6)
                    .accessibilityLabel(health == .dead ? "no recent data" : "stale data")
            }
        }
        // Clear of the vertical page dots on the trailing edge.
        .padding(.trailing, 14)
    }

    private struct RingSize {
        let diameter: CGFloat
        let line: CGFloat
        let numeral: CGFloat

        static let gap: CGFloat = 6
        /// The small ring is this fraction of the big one, as on the deck's rail.
        static let ratio: CGFloat = 0.6
        /// Two lines of countdown text under each ring.
        static let textHeight: CGFloat = 32

        init(diameter: CGFloat) {
            self.diameter = diameter
            line = max(4, diameter * 0.085)
            numeral = diameter * 0.44
        }

        /// The largest pair that fits `space`: limited by width (both rings side by side) and by
        /// height (the big ring plus its text).
        static func fitting(_ space: CGSize, showsText: Bool) -> (big: RingSize, small: RingSize) {
            let byWidth = (space.width - gap) / (1 + ratio)
            let byHeight = space.height - (showsText ? textHeight : 0)
            let big = max(40, min(byWidth, byHeight))
            return (RingSize(diameter: big), RingSize(diameter: big * ratio))
        }
    }

    private func window(
        _ headline: WatchSnapshot.Headline?,
        label: String,
        size: RingSize,
        now: Date,
        noLimit: Bool = false
    ) -> some View {
        let none = noLimit && headline == nil
        return VStack(spacing: 2) {
            // "none" is four letters, so it runs smaller than a percent in the same ring.
            RingGauge(
                ring: none ? .noLimit : RingFace(headline),
                lineWidth: size.line,
                numeralSize: none ? size.numeral * 0.55 : size.numeral,
                lively: !isLuminanceReduced
            )
            .frame(width: size.diameter, height: size.diameter)
            if !isLuminanceReduced {
                Text(verbatim: none ? NoLimit.ringCaption : "\(label) · \(Format.resetCountdown(headline?.resetsAt, now: now))")
                    .font(Theme.data(12))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .fixedSize()
                Text(verbatim: none ? NoLimit.caption : Format.resetAt(headline?.resetsAt, now: now, use24h: snapshot.use24h))
                    .font(Theme.data(11))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        // Exactly the ring's width, so a wider caption never pushes the other ring.
        .frame(width: size.diameter)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: none ? "\(label) window, no limit on this plan" : "\(label) window"))
    }
}
