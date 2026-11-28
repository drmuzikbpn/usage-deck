// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text.Json.Nodes;

namespace UsageBar.Core;

/// <summary>
/// Map the <c>GET /api/oauth/usage</c> payload to <see cref="LimitRow"/>s. <c>limits[]</c> is the
/// authoritative model and is mapped 1:1; unknown keys and unknown severities pass through or are
/// ignored, never thrown on. Logic follows upstream usage-deck <c>src/limits/normalize.ts</c>.
/// </summary>
public static class Normalize
{
    public static UpstreamSnapshot FromPayload(JsonObject payload, DateTimeOffset fetchedAt)
    {
        var snap = new UpstreamSnapshot { FetchedAt = fetchedAt };
        if (payload["limits"] is JsonArray arr)
        {
            foreach (var entry in arr)
            {
                if (entry is not JsonObject o) continue;
                var kind = Str(o["kind"]);
                if (kind is null) continue;
                var model = ScopeName(o["scope"], "model");
                snap.Limits.Add(new LimitRow
                {
                    Id = model is null ? kind : $"{kind}:{model.ToLowerInvariant()}",
                    Kind = kind,
                    Group = Str(o["group"]),
                    Percent = Num(o["percent"]) is double p ? (int)Math.Round(p, MidpointRounding.AwayFromZero) : null,
                    Severity = Str(o["severity"]),
                    ResetsAt = Time(o["resets_at"]),
                    Model = model,
                    IsActive = o["is_active"] is JsonValue v && v.TryGetValue<bool>(out var b) && b,
                    Source = "upstream",
                    AsOf = fetchedAt,
                });
            }
        }
        if (payload["extra_usage"] is JsonObject extra)
        {
            snap.ExtraUsageEnabled = Bool(extra["is_enabled"]);
            snap.SpendLimitReached = Bool(extra["spend_limit_reached"]);
        }
        return snap;
    }

    static string? ScopeName(JsonNode? scope, string key) => scope is JsonObject s
        ? s[key] switch
        {
            JsonObject m => Str(m["display_name"]),
            var other => Str(other),
        }
        : null;

    static string? Str(JsonNode? n) =>
        n is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;

    static double? Num(JsonNode? n) =>
        n is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : null;

    static bool? Bool(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

    static DateTimeOffset? Time(JsonNode? n) =>
        Str(n) is string s && DateTimeOffset.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal, out var t) ? t.ToUniversalTime() : null;
}
