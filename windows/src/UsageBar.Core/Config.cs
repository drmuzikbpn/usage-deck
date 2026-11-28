// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text.Json;

namespace UsageBar.Core;

/// <summary><c>%LOCALAPPDATA%\usagebar\config.json</c>. Missing or bad values fall back to defaults.</summary>
public sealed class Config
{
    public int Warn { get; set; } = 80;
    public int Critical { get; set; } = 95;
    public bool Notifications { get; set; } = true;
    public int PollIntervalSeconds { get; set; } = Schedule.DefaultIntervalSeconds;

    public static Config Load(string? path = null)
    {
        path ??= Paths.ConfigPath;
        Config cfg;
        try
        {
            cfg = File.Exists(path) ? JsonSerializer.Deserialize<Config>(File.ReadAllText(path), Json.Options) ?? new() : new();
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException)
        {
            Log.Write($"config: {path} unreadable ({e.GetType().Name}); using defaults");
            cfg = new();
        }
        return cfg.Sanitized();
    }

    public Config Sanitized()
    {
        var c = (Config)MemberwiseClone();
        c.Warn = Math.Clamp(c.Warn, 0, 100);
        c.Critical = Math.Clamp(c.Critical, 0, 100);
        if (c.Warn > c.Critical) (c.Warn, c.Critical) = (80, 95);
        c.PollIntervalSeconds = Math.Clamp(c.PollIntervalSeconds, Schedule.MinIntervalSeconds, 86_400);
        return c;
    }

    public void Save(string? path = null)
    {
        path ??= Paths.ConfigPath;
        AtomicFile.WriteAllText(path, JsonSerializer.Serialize(this, Json.Options));
    }
}
