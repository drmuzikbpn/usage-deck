// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text.Json;
using System.Text.Json.Serialization;

namespace UsageBar.Core;

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static readonly JsonSerializerOptions Compact = new(Options) { WriteIndented = false };
}

/// <summary>One rate-limit window, e.g. the 5-hour session or the 7-day week.</summary>
public sealed class LimitRow
{
    /// <summary><c>session</c>, <c>weekly_all</c>, or <c>weekly_scoped:&lt;model&gt;</c>.</summary>
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string? Group { get; set; }
    /// <summary>0–100 of the window used; null when unknown (e.g. the window reset since it was read).</summary>
    public int? Percent { get; set; }
    public string? Severity { get; set; }
    /// <summary>When the window rolls over. May legitimately be null — say "unknown", never guess.</summary>
    public DateTimeOffset? ResetsAt { get; set; }
    /// <summary>Model display name for per-model weekly windows.</summary>
    public string? Model { get; set; }
    public bool IsActive { get; set; }
    /// <summary><c>upstream</c> (Anthropic's usage endpoint) or <c>statusline</c> (Claude Code's own headers).</summary>
    public string Source { get; set; } = "upstream";
    public DateTimeOffset? AsOf { get; set; }
    public bool Stale { get; set; }

    public LimitRow Clone() => (LimitRow)MemberwiseClone();
}

public sealed class UpstreamSnapshot
{
    public DateTimeOffset FetchedAt { get; set; }
    public List<LimitRow> Limits { get; set; } = [];
    public bool? ExtraUsageEnabled { get; set; }
    public bool? SpendLimitReached { get; set; }
}

/// <summary>A reading from Claude Code's status-line payload (<c>rate_limits</c>).</summary>
public sealed class Observation
{
    public double UsedPercentage { get; set; }
    public DateTimeOffset? ResetsAt { get; set; }
    public DateTimeOffset ObservedAt { get; set; }
}

public sealed class ErrorInfo
{
    /// <summary><c>no_credentials</c>, <c>token_expired</c>, <c>unauthorized</c>, <c>rate_limited</c>, <c>network</c>, <c>schema_drift</c>.</summary>
    public string Code { get; set; } = "";
    public string Message { get; set; } = "";
    public string? Hint { get; set; }
    public DateTimeOffset? RetryAt { get; set; }
}

public sealed class PollState
{
    public DateTimeOffset? LastAttemptAt { get; set; }
    public DateTimeOffset? LastSuccessAt { get; set; }
    public int ConsecutiveFailures { get; set; }
    /// <summary>Base interval, doubled on each 429 and relaxed after a run of successes.</summary>
    public int AdaptiveIntervalSeconds { get; set; } = Schedule.DefaultIntervalSeconds;
    public int SuccessesSinceSlowdown { get; set; }
    /// <summary>Nobody calls upstream before this (429 Retry-After, error backoff).</summary>
    public DateTimeOffset? NextAllowedAt { get; set; }
    public ErrorInfo? LastError { get; set; }
}

/// <summary>The shared cache file every usagebar process reads (the "note on the fridge").</summary>
public sealed class State
{
    public int Version { get; set; } = 1;
    public UpstreamSnapshot? Upstream { get; set; }
    /// <summary>Keyed by limit id: <c>session</c>, <c>weekly_all</c>.</summary>
    public Dictionary<string, Observation> Observed { get; set; } = [];
    public PollState Poll { get; set; } = new();
}
