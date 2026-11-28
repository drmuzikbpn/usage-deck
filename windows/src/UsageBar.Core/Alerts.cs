// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text.Json;

namespace UsageBar.Core;

public sealed record Alert(string LimitId, string Title, string Body, LimitStatus Level, bool IsReset);

public sealed class AlertEntry
{
    public DateTimeOffset? WindowResetsAt { get; set; }
    /// <summary>Highest level already notified in this window.</summary>
    public LimitStatus Notified { get; set; }
    /// <summary>Highest level seen in this window (drives the "reset" notice).</summary>
    public LimitStatus Highest { get; set; }
    public bool ResetNotified { get; set; }
}

public sealed class AlertState
{
    public Dictionary<string, AlertEntry> ById { get; set; } = [];

    public static AlertState Load(string? path = null)
    {
        var text = AtomicFile.TryReadAllText(path ?? Paths.AlertsPath);
        if (text is null) return new();
        try { return JsonSerializer.Deserialize<AlertState>(text, Json.Options) ?? new(); }
        catch (JsonException) { return new(); }
    }

    public void Save(string? path = null) =>
        AtomicFile.WriteAllText(path ?? Paths.AlertsPath, JsonSerializer.Serialize(this, Json.Options));
}

/// <summary>
/// Decides which notifications to show: one per threshold crossing per window, plus one
/// "you're clear" when a window you'd pushed past warn rolls over.
/// </summary>
public static class Alerts
{
    public static List<Alert> Evaluate(AlertState st, LimitsView view, Config cfg, DateTimeOffset now)
    {
        var alerts = new List<Alert>();

        // Time-based: a window we warned about has rolled over, even if no new data has arrived yet.
        foreach (var (id, e) in st.ById)
        {
            if (e.WindowResetsAt is { } at && at <= now && e.Highest >= LimitStatus.Warn && !e.ResetNotified)
            {
                alerts.Add(ResetAlert(id, view.Limits.FirstOrDefault(r => r.Id == id)));
                e.ResetNotified = true;
            }
        }

        foreach (var row in view.Limits)
        {
            if (row.Percent is null) continue;
            if (!st.ById.TryGetValue(row.Id, out var e))
                st.ById[row.Id] = e = new AlertEntry { WindowResetsAt = row.ResetsAt };

            var newWindow = e.WindowResetsAt is { } prev && row.ResetsAt is { } cur
                && (cur - prev) >= StatusLine.SameWindowTolerance;
            if (newWindow)
            {
                if (e.Highest >= LimitStatus.Warn && !e.ResetNotified) alerts.Add(ResetAlert(row.Id, row));
                e.WindowResetsAt = row.ResetsAt;
                e.Notified = LimitStatus.Ok;
                e.Highest = LimitStatus.Ok;
                e.ResetNotified = false;
            }
            e.WindowResetsAt ??= row.ResetsAt;

            var level = Status.Of(row, cfg);
            if (level > e.Highest) e.Highest = level;
            if (level > e.Notified)
            {
                e.Notified = level;
                var label = Status.Label(row);
                var title = level == LimitStatus.Critical ? $"Claude {label} limit almost used up" : $"Claude {label} limit at {row.Percent}%";
                alerts.Add(new Alert(row.Id, title, $"{label} window {row.Percent}% used · resets {Text.Resets(row.ResetsAt, now)}", level, false));
            }
        }
        return alerts;
    }

    static Alert ResetAlert(string id, LimitRow? row)
    {
        var label = row is null ? (id == "session" ? "5h" : id == "weekly_all" ? "7d" : id) : Status.Label(row);
        return new Alert(id, $"Claude {label} limit reset", $"The {label} window has rolled over — you're clear.", LimitStatus.Ok, true);
    }
}
