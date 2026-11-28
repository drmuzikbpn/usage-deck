// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
namespace UsageBar.Core;

/// <summary>Human-readable times shared by the CLI, MCP headlines and the tray.</summary>
public static class Text
{
    public static string Ago(DateTimeOffset t, DateTimeOffset now)
    {
        var d = now - t;
        if (d < TimeSpan.FromSeconds(60)) return "just now";
        if (d < TimeSpan.FromHours(1)) return $"{(int)d.TotalMinutes} min ago";
        if (d < TimeSpan.FromDays(1)) return $"{(int)d.TotalHours} h {d.Minutes} min ago";
        return $"{(int)d.TotalDays} d ago";
    }

    public static string Countdown(DateTimeOffset at, DateTimeOffset now)
    {
        var d = at - now;
        if (d <= TimeSpan.Zero) return "now";
        if (d < TimeSpan.FromHours(1)) return $"{Math.Max(1, (int)Math.Ceiling(d.TotalMinutes))}m";
        if (d < TimeSpan.FromDays(1)) return $"{(int)d.TotalHours}h {d.Minutes}m";
        return $"{(int)d.TotalDays}d {d.Hours}h";
    }

    /// <summary><c>in 2h 14m (3:10 PM)</c> / <c>in 3d 4h (Tue 1:00 PM)</c> / <c>unknown</c>.</summary>
    public static string Resets(DateTimeOffset? at, DateTimeOffset now)
    {
        if (at is not { } a) return "unknown";
        var local = a.ToLocalTime();
        // "t" alone is the short-time pattern; inside a custom format it would mean the AM/PM letter.
        var when = (a - now) < TimeSpan.FromHours(20) ? local.ToString("t") : $"{local:ddd} {local:t}";
        return a <= now ? $"already ({when})" : $"in {Countdown(a, now)} ({when})";
    }

    /// <summary>Short reset for the tooltip: <c>3:10 PM</c> or <c>Tue</c>.</summary>
    public static string ResetsShort(DateTimeOffset? at, DateTimeOffset now)
    {
        if (at is not { } a) return "?";
        var local = a.ToLocalTime();
        return (a - now) < TimeSpan.FromHours(20) ? local.ToString("t") : local.ToString("ddd");
    }
}
