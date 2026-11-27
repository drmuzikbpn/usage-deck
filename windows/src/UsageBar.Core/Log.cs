// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
namespace UsageBar.Core;

/// <summary>
/// Append-only daily log in <c>%LOCALAPPDATA%\usagebar\logs</c>. Never pass a token here.
/// Logging must never throw into the caller.
/// </summary>
public static class Log
{
    static readonly object Gate = new();
    public static string Component { get; set; } = "usagebar";

    public static void Write(string message)
    {
        try
        {
            var now = DateTimeOffset.Now;
            Directory.CreateDirectory(Paths.LogDir);
            var file = Path.Combine(Paths.LogDir, $"usagebar-{now:yyyyMMdd}.log");
            var line = $"{now:yyyy-MM-ddTHH:mm:ss.fffzzz} [{Component} {Environment.ProcessId}] {message}{Environment.NewLine}";
            lock (Gate)
            {
                using var fs = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                using var sw = new StreamWriter(fs);
                sw.Write(line);
            }
        }
        catch
        {
            // never let logging break anything
        }
    }

    /// <summary>Delete logs older than 14 days.</summary>
    public static void Prune()
    {
        try
        {
            foreach (var f in Directory.EnumerateFiles(Paths.LogDir, "usagebar-*.log"))
                if (File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-14)) File.Delete(f);
        }
        catch { }
    }
}
