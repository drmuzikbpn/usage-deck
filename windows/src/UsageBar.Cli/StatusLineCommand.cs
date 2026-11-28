// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text;
using UsageBar.Core;

namespace UsageBar.Cli;

/// <summary>
/// <c>usagebar statusline</c>. Reads Claude Code's render payload, folds its <c>rate_limits</c>
/// into the shared cache, prints <c>5h 42% · 7d 61%</c>. Any failure prints nothing; always exit 0.
/// </summary>
public static class StatusLineCommand
{
    public static int Run()
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            var stdin = "";
            if (Console.IsInputRedirected)
            {
                using var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                stdin = reader.ReadToEnd();
            }
            var line = Render(stdin, new StateStore(), Config.Load(), DateTimeOffset.UtcNow,
                color: string.IsNullOrEmpty(Environment.GetEnvironmentVariable("NO_COLOR")));
            if (line is not null) Console.Out.Write(line + "\n");
        }
        catch
        {
            // never break a status-line render
        }
        return 0;
    }

    public static string? Render(string stdin, StateStore store, Config cfg, DateTimeOffset now, bool color)
    {
        State state;
        var observed = StatusLine.ParseObservations(stdin, now);
        if (observed is not null)
        {
            try { state = store.Update(s => StatusLine.Merge(s, observed, now), TimeSpan.FromMilliseconds(300)); }
            catch (TimeoutException) { state = store.Load(); }
        }
        else
        {
            state = store.Load();
        }
        return StatusLine.Format(LimitsView.Build(state, now), cfg, color);
    }
}
