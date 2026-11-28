// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.ComponentModel;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using UsageBar.Core;

namespace UsageBar.Cli;

/// <summary>
/// <c>usagebar mcp</c> — stdio MCP server. stdout is JSON-RPC only: every diagnostic goes to
/// stderr. Read-only by design; the only network-touching tool is <c>refresh_limits</c>, and it
/// goes through the same guarded <see cref="Fetcher"/> as the tray.
/// </summary>
public static class McpCommand
{
    public const string Instructions =
        "Claude account rate-limit telemetry for this Windows machine. `get_limits` (cheap, cached) and " +
        "`get_summary` (adds ok/warn/critical) tell you how close the account is to its 5-hour and 7-day " +
        "limits; `refresh_limits` re-asks Anthropic, at most once a minute. Before starting a long or " +
        "expensive task, check `get_summary`; if status is `critical`, tell the user before proceeding. " +
        "Every tool returns a one-line summary followed by the JSON body. Nothing here changes anything.";

    public static async Task<int> RunAsync(string[] args)
    {
        Log.Component = "mcp";
        var builder = Host.CreateApplicationBuilder(args);
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Services
            .AddMcpServer(o =>
            {
                o.ServerInfo = new() { Name = "usagebar", Version = UsageClient.Version };
                o.ServerInstructions = Instructions;
            })
            .WithStdioServerTransport()
            .WithTools<UsageTools>();
        await builder.Build().RunAsync();
        return 0;
    }
}

[McpServerToolType]
public sealed class UsageTools
{
    const string ResetsNote = "`resetsAt` may be null — say \"resets: unknown\" rather than guessing.";

    [McpServerTool(Name = "get_limits", Title = "Account rate limits", ReadOnly = true, OpenWorld = false, Idempotent = true)]
    [Description(
        "The Claude account's current rate-limit usage, from usagebar's local cache (no network call). " +
        "Each `limits[]` entry has `percent` (0–100 of that window used; 100 = requests will be refused), " +
        "`resetsAt` (when the window rolls over), `id` (`session` = rolling 5-hour window, `weekly_all` = " +
        "the 7-day week, `weekly_scoped:<model>` = a per-model week), and `source`: `statusline` = live from " +
        "Claude Code's own response headers, `upstream` = Anthropic's usage endpoint as of `asOf`. " +
        "`stale: true` = the last refresh failed and numbers are older. `noSessionLimit: true` = the plan " +
        "has no 5-hour window at all. " + ResetsNote + " Cheap; safe to call often.")]
    public static string GetLimits()
    {
        var now = DateTimeOffset.UtcNow;
        var view = LimitsView.Build(new StateStore().Load(), now);
        return Headlines.Payload(Headlines.Limits(view, Config.Load(), now), view);
    }

    [McpServerTool(Name = "get_summary", Title = "Limits with ok/warn/critical", ReadOnly = true, OpenWorld = false, Idempotent = true)]
    [Description(
        "Limits as in `get_limits`, plus `status`: `ok` / `warn` / `critical` per limit id and `overall`, " +
        "evaluated against the user's configured `thresholds` (default warn 80%, critical 95%; a non-normal " +
        "upstream severity also escalates). Use this before long or expensive work. " + ResetsNote)]
    public static string GetSummary()
    {
        var now = DateTimeOffset.UtcNow;
        var cfg = Config.Load();
        var view = LimitsView.Build(new StateStore().Load(), now);
        var body = new
        {
            limits = view,
            status = new
            {
                byId = view.Limits.ToDictionary(r => r.Id, r => Status.Of(r, cfg)),
                overall = Status.Overall(view.Limits, cfg),
            },
            thresholds = new { warn = cfg.Warn, critical = cfg.Critical },
        };
        return Headlines.Payload($"{Headlines.Limits(view, cfg, now)} · status {Status.Overall(view.Limits, cfg).ToString().ToLowerInvariant()}", body);
    }

    [McpServerTool(Name = "refresh_limits", Title = "Re-ask Anthropic now", ReadOnly = false, Destructive = false, Idempotent = true, OpenWorld = true)]
    [Description(
        "Asks Anthropic's usage endpoint for fresh numbers now and returns them (same shape as `get_limits`). " +
        "usagebar already polls on its own, so only use this when the cached numbers are known to be old. " +
        "Anthropic rate-limits this endpoint hard: a refresh within a minute of the last call, or during a " +
        "backoff, returns the current cached limits with a note on the first line instead of an error. " + ResetsNote)]
    public static async Task<string> RefreshLimits(CancellationToken ct)
    {
        var store = new StateStore();
        using var http = UsageClient.CreateHttpClient();
        var outcome = await new Fetcher(store, new TokenReader(), http).FetchAsync(manual: true, ct);
        var now = DateTimeOffset.UtcNow;
        var view = LimitsView.Build(store.Load(), now);
        return Headlines.Payload($"{outcome.Describe()} · {Headlines.Limits(view, Config.Load(), now)}", view);
    }
}

public static class Headlines
{
    public static string Payload(string headline, object body) => $"{headline}\n{JsonSerializer.Serialize(body, Json.Compact)}";

    /// <summary>e.g. <c>5h 34% (resets in 2h 10m) · 7d 29% · live from Claude Code</c>.</summary>
    public static string Limits(LimitsView v, Config cfg, DateTimeOffset now)
    {
        var parts = new List<string>();
        if (v.NoSessionLimit) parts.Add("5h: none on this plan");
        if (v.Limits.Count == 0) parts.Add("no limits data yet");
        parts.AddRange(v.Limits.Select(r =>
            $"{Status.Label(r)} {(r.Percent is int p ? $"{p}%" : "?%")} (resets {Text.Resets(r.ResetsAt, now)})"));
        if (v.Limits.Any(r => r.Source == "statusline")) parts.Add("live from Claude Code");
        if (v.FetchedAt is { } f) parts.Add($"Anthropic fetched {Text.Ago(f, now)}");
        if (v.Stale) parts.Add("stale");
        if (v.Error is { } e)
            parts.Add(e.Code == "rate_limited" && e.RetryAt is { } ra
                ? $"rate-limited by Anthropic until {ra.ToLocalTime():HH:mm}"
                : $"error {e.Code}");
        return string.Join(" · ", parts);
    }
}
