// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
namespace UsageBar.Core;

/// <summary>
/// When the tray may call Anthropic. Numbers follow upstream usage-deck <c>src/limits/poller.ts</c>:
/// a 60 s poll earned a 429 with a 50-minute Retry-After, so the default is 5 min, never under
/// 2 min, doubling on each 429 up to 30 min, and hourly while the status-line feed is fresh.
/// </summary>
public static class Schedule
{
    public const int DefaultIntervalSeconds = 300;
    public const int MinIntervalSeconds = 120;
    public const int MaxAdaptiveIntervalSeconds = 1_800;
    public const int RelaxAfterSuccesses = 12;
    public const int MaxBackoffSeconds = 600;
    public const int ObservedIntervalSeconds = 3_600;
    /// <summary>A manual refresh within this long of the last call is served from cache.</summary>
    public const int ManualMinIntervalSeconds = 60;
    public static readonly TimeSpan MaxRetryAfter = TimeSpan.FromHours(6);

    public static int EffectiveIntervalSeconds(State s, Config cfg, DateTimeOffset now)
    {
        var baseInterval = Math.Max(cfg.PollIntervalSeconds, MinIntervalSeconds);
        // The adaptive interval only matters once 429s have pushed it above the default.
        if (s.Poll.AdaptiveIntervalSeconds > DefaultIntervalSeconds) baseInterval = Math.Max(baseInterval, s.Poll.AdaptiveIntervalSeconds);
        // While Claude Code is feeding us both headline windows, upstream is only needed for what
        // the feed lacks (per-model weeks, severity), so ask it rarely.
        var feedCovers = LimitsView.ObservedWindows.All(w => s.Observed.TryGetValue(w.Id, out var o) && LimitsView.IsFresh(o, now));
        return feedCovers && s.Upstream is not null ? Math.Max(baseInterval, ObservedIntervalSeconds) : baseInterval;
    }

    /// <summary>When the next scheduled poll is due.</summary>
    public static DateTimeOffset NextDue(State s, Config cfg, DateTimeOffset now)
    {
        if (s.Poll.LastAttemptAt is not { } last) return Max(now, s.Poll.NextAllowedAt);
        var due = last + TimeSpan.FromSeconds(EffectiveIntervalSeconds(s, cfg, now));

        // A window we only know from upstream just reset: fetch soon, rather than show "?" for an hour.
        var resetSeen = s.Upstream?.Limits.Any(r => r.ResetsAt is { } at && at <= now && at > s.Upstream.FetchedAt
            && !(s.Observed.TryGetValue(r.Id, out var o) && LimitsView.IsFresh(o, now))) ?? false;
        if (resetSeen) due = Min(due, last + TimeSpan.FromSeconds(MinIntervalSeconds));

        return Max(due, s.Poll.NextAllowedAt);
    }

    public static TimeSpan ErrorBackoff(int consecutiveFailures) =>
        TimeSpan.FromSeconds(Math.Min(MaxBackoffSeconds, 30 * Math.Pow(2, Math.Max(0, consecutiveFailures - 1))));

    static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset? b) => b is { } bb && bb > a ? bb : a;
    static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => a < b ? a : b;
}
