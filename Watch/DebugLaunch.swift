// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

#if DEBUG
    import Foundation
    import UsageCore

    /// Launch arguments that load made-up data, for screenshots and simulator runs without an
    /// iPhone: `-sampleSnapshot`, plus `-unreachable`, `-noDevices`, `-aod` and
    /// `-screen account|actions|projects|project`.
    enum DebugLaunch {
        private static var arguments: [String] {
            ProcessInfo.processInfo.arguments
        }

        static func sampleSnapshot() -> WatchSnapshot? {
            guard arguments.contains("-sampleSnapshot") else { return nil }
            var sample = WatchSnapshot.sample(now: unreachable ? .now.addingTimeInterval(-250) : .now)
            if arguments.contains("-noDevices") {
                sample.devices = []
            }
            // A plan with no 5-hour window (daemon §23.68), for the "none" faces.
            if arguments.contains("-noFiveHour") {
                for index in sample.accounts.indices {
                    sample.accounts[index].fiveHour = nil
                }
            }
            return sample
        }

        static var unreachable: Bool {
            arguments.contains("-unreachable")
        }

        static var alwaysOn: Bool {
            arguments.contains("-aod")
        }

        static var screen: String? {
            guard let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1) else { return nil }
            return arguments[index + 1]
        }
    }
#endif

/// Always-On as the views see it: the system's flag, or `-aod` in a debug build (the simulator
/// cannot be put into Always-On for a screenshot).
enum AlwaysOn {
    static func dimmed(_ isLuminanceReduced: Bool) -> Bool {
        #if DEBUG
            isLuminanceReduced || DebugLaunch.alwaysOn
        #else
            isLuminanceReduced
        #endif
    }
}
