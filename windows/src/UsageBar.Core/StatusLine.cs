// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Globalization;
using System.Text.Json;

namespace UsageBar.Core;

/// <summary>
/// Claude Code runs the configured status-line command on each render and passes a JSON payload
/// on stdin. Its <c>rate_limits</c> object carries the 5-hour and 7-day utilisation Claude Code
/// read from its own model responses — live numbers that cost no call to the usage endpoint.
/// (Shape per upstream usage-deck <c>src/limits/poller.ts</c> parseObservedWindow.)
/// </summary>
public static class StatusLine
{
    public const string Separator = " · ";
    /// <summary>An unchanged reading is not rewritten to disk inside this window.</summary>
    public static readonly TimeSpan DedupeWindow = TimeSpan.FromSeconds(60);
    /// <summary>Two readings whose resets_at differ by less than this describe the same window.</summary>
    public static readonly TimeSpan SameWindowTolerance = TimeSpan.FromMinutes(30);

    /// <summary>Parse <c>rate_limits</c>. All-or-nothing: one bad window rejects the lot.</summary>
    public static Dictionary<string, Observation>? ParseObservations(string stdin, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(stdin)) return null;
        try
        {
            using var doc = JsonDocument.Parse(stdin);
            if (doc.RootElement.ValueKind != JsonValueKind.Object ||
                !doc.RootElement.TryGetProperty("rate_limits", out var rl) || rl.ValueKind != JsonValueKind.Object)
                return null; // API-key sessions have no rate_limits at all

            var result = new Dictionary<string, Observation>();
            foreach (var (key, id, _, _) in LimitsView.ObservedWindows)
            {
                if (!rl.TryGetProperty(key, out var w) || w.ValueKind == JsonValueKind.Null) continue;
                if (w.ValueKind != JsonValueKind.Object) return null;
                if (!w.TryGetProperty("used_percentage", out var pct) || pct.ValueKind != JsonValueKind.Number) return null;
                var used = pct.GetDouble();
                if (!double.IsFinite(used) || used < 0 || used > 100) return null;

                DateTimeOffset? resets = null;
                if (w.TryGetProperty("resets_at", out var ra))
                {
                    switch (ra.ValueKind)
                    {
                        case JsonValueKind.Number:
                            var secs = ra.GetDouble();
                            if (!double.IsFinite(secs) || secs <= 0) return null;
                            resets = DateTimeOffset.FromUnixTimeMilliseconds((long)(secs * 1000));
                            break;
                        case JsonValueKind.String:
                            if (!DateTimeOffset.TryParse(ra.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)) return null;
                            resets = t.ToUniversalTime();
                            break;
                        case JsonValueKind.Null: break;
                        default: return null;
                    }
                }
                result[id] = new Observation { UsedPercentage = used, ResetsAt = resets, ObservedAt = now };
            }
            return result.Count == 0 ? null : result;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>
    /// Merge readings into state. Returns false when nothing changed enough to write.
    /// Usage only grows inside a window, so a lower reading for the same window — an idle session
    /// re-rendering its old numbers — is ignored rather than allowed to pull the gauge down.
    /// </summary>
    public static bool Merge(State s, Dictionary<string, Observation> incoming, DateTimeOffset now)
    {
        var changed = false;
        foreach (var (id, obs) in incoming)
        {
            if (!s.Observed.TryGetValue(id, out var prev))
            {
                s.Observed[id] = obs;
                changed = true;
                continue;
            }
            var sameWindow = prev.ResetsAt is { } a && obs.ResetsAt is { } b && (a - b).Duration() < SameWindowTolerance;
            var prevLive = LimitsView.IsFresh(prev, now);
            if (sameWindow && prevLive && obs.UsedPercentage < prev.UsedPercentage) continue;
            if (sameWindow && obs.UsedPercentage == prev.UsedPercentage && now - prev.ObservedAt < DedupeWindow) continue;
            s.Observed[id] = obs;
            changed = true;
        }
        return changed;
    }

    static readonly Dictionary<LimitStatus, string> Ansi = new()
    {
        [LimitStatus.Ok] = "",
        [LimitStatus.Warn] = "\u001b[33m",
        [LimitStatus.Critical] = "\u001b[31m",
    };

    /// <summary><c>5h 42% · 7d 61%</c>, or null when there is nothing to show.</summary>
    public static string? Format(LimitsView view, Config cfg, bool color)
    {
        var parts = new List<string>();
        foreach (var id in new[] { "session", "weekly_all" })
        {
            var row = view.Limits.FirstOrDefault(r => r.Id == id);
            if (row is null) continue;
            var text = $"{Status.Label(row)} {(row.Percent is int p ? $"{p}%" : "?%")}";
            var st = Status.Of(row, cfg);
            parts.Add(color && Ansi[st].Length > 0 ? $"{Ansi[st]}{text}\u001b[0m" : text);
        }
        return parts.Count == 0 ? null : string.Join(Separator, parts);
    }
}
