// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import SwiftUI
import UsageCore

/// A glass pill: a 7 pt status dot (glowing in its colour), mono 11 pt text. A tinted chip tints
/// its glass.
struct Chip: View {
    var text: String
    var dot: Color?
    var tint: Color = DeckColor.fg
    var action: (() -> Void)?

    var body: some View {
        let label = HStack(spacing: 6) {
            if let dot {
                Circle().fill(dot).frame(width: 7, height: 7)
                    .shadow(color: dot.opacity(0.8), radius: 3)
            }
            if !text.isEmpty {
                Text(text)
                    .font(DeckFont.mono(11))
                    .foregroundStyle(tint)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .deckGlass(in: Capsule(), tint: tint == DeckColor.fg ? nil : tint, interactive: action != nil)

        if let action {
            Button(action: action) { label }.buttonStyle(.plain)
        } else {
            label
        }
    }
}

/// The small rounded label: mono 10 pt. Neutral on `surface2`, or tinted at 15 % with full-colour text.
struct Tag: View {
    var text: String
    var color: Color?

    var body: some View {
        Text(text)
            .font(DeckFont.mono(10))
            .foregroundStyle(color ?? DeckColor.muted)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background((color?.opacity(0.15) ?? DeckColor.surface2), in: RoundedRectangle(cornerRadius: 5))
            .fixedSize()
    }
}

/// One utilisation window as a row: `5h | ████░░░░ | 42% | 2h33 left`. Nil renders `—`.
struct LimitBar: View {
    var label: String
    var limit: Limit?
    var now: Date
    var use24h: Bool
    /// Daemon §23.68: the plan has no such window — `none · on this plan`, not `—`.
    var noLimit = false

    var body: some View {
        let none = noLimit && limit == nil
        let percent = limit.map { min(max($0.percent, 0), 100) }
        let color = limit.map { DeckColor.of($0.status) } ?? DeckColor.dim
        HStack(spacing: 8) {
            Text(label)
                .font(DeckFont.mono(11))
                .foregroundStyle(DeckColor.muted)
                .frame(width: 24, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(DeckColor.surface2)
                    if let percent, percent > 0 {
                        Capsule()
                            .fill(LinearGradient(colors: [color.opacity(0.55), color], startPoint: .leading, endPoint: .trailing))
                            .frame(width: geo.size.width * CGFloat(percent) / 100)
                            .shadow(color: color.opacity(0.5), radius: 4)
                    }
                }
                .animation(.smooth(duration: 0.6), value: percent)
            }
            .frame(height: 8)
            Text(verbatim: percent.map { "\($0)%" } ?? (none ? NoLimit.short : "—"))
                .font(DeckFont.numeral(none ? 13 : 18, .medium))
                .foregroundStyle(color)
                .frame(width: 44, alignment: .trailing)
                .rolling(percent)
            Text(verbatim: limit != nil
                ? Format.resetsShort(limit?.resetsAt, now: now, use24h: use24h)
                : none ? NoLimit.caption : "—")
                .font(DeckFont.mono(10))
                .foregroundStyle(DeckColor.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: 76, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A burn trace: gradient-filled area, glowing line, endpoint dot. Axis-free — the number beside it
/// carries the magnitude, this only carries the shape. It draws itself in from the left the first
/// time it appears.
struct Sparkline: View {
    var series: [Double]
    var color: Color = DeckColor.accent

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let points = Self.points(series, in: geo.size)
            if points.count >= 2, let end = points.last {
                ZStack(alignment: .topLeading) {
                    Self.area(points, height: geo.size.height)
                        .fill(LinearGradient(colors: [color.opacity(0.38), color.opacity(0)], startPoint: .top, endPoint: .bottom))
                        .mask(alignment: .leading) { Rectangle().frame(width: geo.size.width * drawn) }
                    Path { $0.addLines(points) }
                        .trim(from: 0, to: drawn)
                        .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                        .shadow(color: color.opacity(0.7), radius: 2)
                    Circle()
                        .fill(color)
                        .frame(width: 4, height: 4)
                        .shadow(color: color, radius: 3)
                        .position(end)
                        .opacity(drawn)
                }
            }
        }
        .onAppear {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.8)) { drawn = 1 }
        }
        .accessibilityHidden(true)
    }

    private static func points(_ series: [Double], in size: CGSize) -> [CGPoint] {
        guard series.count >= 2, size.width > 0, size.height > 0,
              let high = series.max(), let low = series.min()
        else { return [] }
        let span = high - low > 0 ? high - low : 1
        let step = size.width / CGFloat(series.count - 1)
        let stroke: CGFloat = 1.5
        let usable = max(size.height - stroke * 2, 0)
        return series.enumerated().map { index, value in
            CGPoint(x: CGFloat(index) * step, y: stroke + (1 - CGFloat((value - low) / span)) * usable)
        }
    }

    private static func area(_ points: [CGPoint], height: CGFloat) -> Path {
        Path { path in
            path.move(to: CGPoint(x: points[0].x, y: height))
            path.addLines(points)
            path.addLine(to: CGPoint(x: points[points.count - 1].x, y: height))
            path.closeSubpath()
        }
    }
}

/// A secondary button: a glass capsule with neutral text.
struct DeckButton: View {
    var label: String
    var systemImage: String?
    var padding: CGFloat = 10
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 15, weight: .medium))
                } else {
                    Text(label).font(DeckFont.text(14, .medium))
                }
            }
            .foregroundStyle(DeckColor.fg)
            .padding(.horizontal, 16)
            .padding(.vertical, padding)
            .frame(maxHeight: .infinity)
            .contentShape(DeckMetrics.buttonShape)
            .deckGlass(in: DeckMetrics.buttonShape, interactive: true)
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityLabel(label)
    }
}

/// Section caption for the list headers.
struct ListCaption: View {
    var title: String
    var trailing: String

    var body: some View {
        HStack {
            Text(title)
                .textCase(.uppercase)
                .font(DeckFont.text(11, .semibold))
                .tracking(1.1)
                .foregroundStyle(DeckColor.muted)
                .rolling(title)
            Spacer()
            Text(trailing)
                .font(DeckFont.mono(10))
                .foregroundStyle(DeckColor.dim)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }
}

/// The bottom-of-screen failure line (a refused pause, an unreachable device).
struct ToastView: View {
    var text: String

    var body: some View {
        Text(text)
            .font(DeckFont.text(13, .medium))
            .foregroundStyle(DeckColor.fg)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .deckGlass(in: Capsule(), tint: DeckColor.crit)
            .padding(.horizontal, 16)
            .padding(.bottom, 72)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
