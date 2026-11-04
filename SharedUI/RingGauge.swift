// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import SwiftUI
import UsageCore
import WidgetKit

/// The deck's `RingNumber`: an arc from twelve o'clock on a faint full-circle track, the percent
/// (no sign) in the middle, both coloured by status. A `lively` ring — the ones read at length on
/// the iPhone and the watch — sweeps in, glows, rolls its digits and pulses when its status
/// changes; widget and complication glances stay flat.
struct RingGauge: View {
    let ring: RingFace
    var lineWidth: CGFloat = 6
    var numeralSize: CGFloat = 28
    var showsLabel = true
    var lively = false

    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var swept: Double?

    var body: some View {
        let color = Theme.color(ring.status)
        let fullColor = renderingMode == .fullColor
        let fraction = swept ?? (lively ? 0 : ring.fraction)
        ZStack {
            Circle()
                .stroke(Theme.line, lineWidth: lineWidth)
            if ring.fraction > 0 {
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(
                        fullColor ? AnyShapeStyle(Self.sweep(color, fraction: fraction)) : AnyShapeStyle(color),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                    .shadow(color: color.opacity(lively && fullColor ? 0.55 : 0), radius: lineWidth * 1.1)
                    .widgetAccentable()
            }
            if showsLabel {
                Text(ring.label)
                    .font(Theme.numeral(numeralSize))
                    .foregroundStyle(color)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .padding(lineWidth)
                    .contentTransition(.numericText(value: Double(ring.percent ?? 0)))
                    .animation(lively ? .snappy : nil, value: ring.label)
            }
        }
        .padding(lineWidth / 2)
        // Keyed on the status alone: toggling `lively` (Always-On on the watch) must not pulse.
        .keyframeAnimator(initialValue: 1.0, trigger: ring.status) { content, scale in
            content.scaleEffect(lively ? scale : 1)
        } keyframes: { _ in
            SpringKeyframe(1.08, duration: 0.16)
            SpringKeyframe(1, duration: 0.5, spring: .bouncy)
        }
        .onAppear {
            // Always settle `swept`, so a ring that first appears flat (dimmed) and turns lively
            // later keeps its arc instead of dropping to empty.
            guard swept == nil else { return }
            withAnimation(lively && !reduceMotion ? .smooth(duration: 0.9) : nil) { swept = ring.fraction }
        }
        .onChange(of: ring.fraction) { _, new in
            withAnimation(.smooth(duration: 0.6)) { swept = new }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: ring.percent.map { "\($0) percent" } ?? (ring == .noLimit ? "no limit" : "no reading")))
    }

    /// Darker at the start of the arc, full colour at its head, so the ring reads as moving.
    private static func sweep(_ color: Color, fraction: Double) -> AngularGradient {
        AngularGradient(
            colors: [color.opacity(0.45), color],
            center: .center,
            startAngle: .degrees(0),
            endAngle: .degrees(max(360 * fraction, 1))
        )
    }
}
