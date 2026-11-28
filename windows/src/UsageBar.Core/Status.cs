// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
namespace UsageBar.Core;

public enum LimitStatus { Ok = 0, Warn = 1, Critical = 2 }

/// <summary>ok / warn / critical, following upstream usage-deck <c>src/limits/status.ts</c>.</summary>
public static class Status
{
    static readonly HashSet<string> CriticalSeverities = new(StringComparer.OrdinalIgnoreCase)
    {
        "critical", "severe", "exceeded", "exhausted", "blocked", "locked", "limit_reached", "over_limit",
    };

    /// <summary>
    /// critical if percent ≥ critical or severity is critical-like; warn if percent ≥ warn or
    /// severity is anything other than "normal"; else ok.
    /// </summary>
    public static LimitStatus Of(LimitRow row, Config cfg)
    {
        var sev = row.Severity;
        if ((row.Percent is int p && p >= cfg.Critical) || (sev is not null && CriticalSeverities.Contains(sev)))
            return LimitStatus.Critical;
        if ((row.Percent is int q && q >= cfg.Warn) || (sev is not null && !sev.Equals("normal", StringComparison.OrdinalIgnoreCase)))
            return LimitStatus.Warn;
        return LimitStatus.Ok;
    }

    public static LimitStatus Overall(IEnumerable<LimitRow> rows, Config cfg) =>
        rows.Select(r => Of(r, cfg)).DefaultIfEmpty(LimitStatus.Ok).Max();

    /// <summary>Short label: <c>5h</c>, <c>7d</c>, <c>7d Fable</c>.</summary>
    public static string Label(LimitRow row) => row.Id switch
    {
        "session" => "5h",
        "weekly_all" => "7d",
        _ when row.Kind == "weekly_scoped" && row.Model is not null => $"7d {row.Model}",
        _ => row.Model is null ? row.Id : $"{row.Kind} {row.Model}",
    };
}
