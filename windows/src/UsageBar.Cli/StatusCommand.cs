// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text;
using System.Text.Json;
using UsageBar.Core;

namespace UsageBar.Cli;

public static class StatusCommand
{
    public static int Run(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var now = DateTimeOffset.UtcNow;
        var cfg = Config.Load();
        var view = LimitsView.Build(new StateStore().Load(), now);
        if (args.Contains("--json"))
        {
            Console.WriteLine(JsonSerializer.Serialize(view, Json.Options));
            return 0;
        }
        Console.WriteLine(Describe(view, cfg, now));
        return 0;
    }

    public static async Task<int> RefreshAsync()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var store = new StateStore();
        using var http = UsageClient.CreateHttpClient();
        var outcome = await new Fetcher(store, new TokenReader(), http).FetchAsync(manual: true);
        Console.WriteLine(outcome.Describe());
        Console.WriteLine(Describe(LimitsView.Build(store.Load(), DateTimeOffset.UtcNow), Config.Load(), DateTimeOffset.UtcNow));
        return outcome.Result == FetchResult.Failed ? 1 : 0;
    }

    public static string Describe(LimitsView view, Config cfg, DateTimeOffset now)
    {
        var sb = new StringBuilder();
        if (view.Limits.Count == 0) sb.AppendLine("no limits data yet");
        foreach (var r in view.Limits)
        {
            var pct = r.Percent is int p ? $"{p,3}%" : "  ?%";
            var st = Status.Of(r, cfg).ToString().ToLowerInvariant();
            sb.AppendLine($"{Status.Label(r),-12} {pct}  {st,-8}  resets {Text.Resets(r.ResetsAt, now)}  [{r.Source}{(r.Stale ? ", stale" : "")}]");
        }
        if (view.NoSessionLimit) sb.AppendLine("this plan has no 5-hour window");
        sb.AppendLine($"Anthropic last fetched: {(view.FetchedAt is { } f ? Text.Ago(f, now) : "never")}");
        if (view.Error is { } e)
            sb.AppendLine($"last error: {e.Code} — {e.Message}{(e.Hint is null ? "" : $" ({e.Hint})")}");
        if (view.NextPollNotBefore is { } nb && nb > now)
            sb.AppendLine($"next call to Anthropic not before {nb.ToLocalTime():HH:mm}");
        return sb.ToString().TrimEnd();
    }
}
