// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
namespace UsageBar.Core;

/// <summary>What every client shows: upstream rows, overlaid with fresh status-line readings.</summary>
public sealed class LimitsView
{
    public List<LimitRow> Limits { get; set; } = [];
    public DateTimeOffset? FetchedAt { get; set; }
    /// <summary>The last upstream call failed; numbers are from an earlier success.</summary>
    public bool Stale { get; set; }
    public ErrorInfo? Error { get; set; }
    /// <summary>Anthropic reports a week but no 5-hour window: the plan has none.</summary>
    public bool NoSessionLimit { get; set; }
    public DateTimeOffset? NextPollNotBefore { get; set; }

    /// <summary>A status-line reading is believed this long (or until its window resets).</summary>
    public static readonly TimeSpan ObservationTtl = TimeSpan.FromMinutes(15);

    /// <summary>The two windows Claude Code's status-line payload carries, and the ids they feed.</summary>
    public static readonly (string Key, string Id, string Kind, string Group)[] ObservedWindows =
    [
        ("five_hour", "session", "session", "session"),
        ("seven_day", "weekly_all", "weekly_all", "weekly"),
    ];

    public static bool IsFresh(Observation o, DateTimeOffset now) =>
        now - o.ObservedAt < ObservationTtl && (o.ResetsAt is null || o.ResetsAt > now);

    public static LimitsView Build(State s, DateTimeOffset now)
    {
        var view = new LimitsView
        {
            FetchedAt = s.Upstream?.FetchedAt,
            Error = s.Poll.LastError,
            Stale = s.Poll.LastError is not null && s.Upstream is not null,
            NextPollNotBefore = s.Poll.NextAllowedAt,
        };

        var rows = (s.Upstream?.Limits ?? []).Select(r => r.Clone()).ToList();
        foreach (var r in rows)
        {
            r.Stale = view.Stale;
            if (r.ResetsAt is { } at && at <= now)
            {
                // The window rolled over since we read it: the old number is meaningless.
                r.Percent = null;
                r.Stale = true;
            }
        }

        foreach (var (_, id, kind, group) in ObservedWindows)
        {
            if (!s.Observed.TryGetValue(id, out var obs) || !IsFresh(obs, now)) continue;
            var row = rows.FirstOrDefault(r => r.Id == id);
            if (row is null)
            {
                row = new LimitRow { Id = id, Kind = kind, Group = group, Severity = null };
                rows.Insert(id == "session" ? 0 : Math.Min(1, rows.Count), row);
            }
            var observed = (int)Math.Round(obs.UsedPercentage, MidpointRounding.AwayFromZero);
            // Same window, and upstream is both newer and at least as high: upstream is the better
            // reading (usage only grows inside a window, so the higher number is the current one).
            var sameWindow = row.ResetsAt is { } ur && obs.ResetsAt is { } or
                && (ur - or).Duration() < StatusLine.SameWindowTolerance;
            if (sameWindow && row.Source == "upstream" && !row.Stale && row.Percent is int up
                && row.AsOf > obs.ObservedAt && up >= observed)
                continue;
            row.Percent = sameWindow && row.Percent is int prior && !row.Stale ? Math.Max(prior, observed) : observed;
            row.ResetsAt = obs.ResetsAt ?? row.ResetsAt;
            row.Source = "statusline";
            row.AsOf = obs.ObservedAt;
            row.Stale = false;
        }

        view.Limits = rows;
        view.NoSessionLimit = s.Upstream is not null
            && s.Upstream.Limits.Any(r => r.Id == "weekly_all")
            && !s.Upstream.Limits.Any(r => r.Id == "session")
            && !rows.Any(r => r.Id == "session");
        return view;
    }

    /// <summary>The row the tray icon shows: whichever headline window is tighter.</summary>
    public LimitRow? Headline(Config cfg)
    {
        var candidates = Limits.Where(r => r.Id is "session" or "weekly_all").ToList();
        if (candidates.Count == 0) candidates = Limits;
        return candidates
            .OrderByDescending(r => Status.Of(r, cfg))
            .ThenByDescending(r => r.Percent ?? -1)
            .ThenBy(r => r.Id == "session" ? 0 : 1)
            .FirstOrDefault();
    }
}
