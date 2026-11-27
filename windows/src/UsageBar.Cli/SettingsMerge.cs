// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text.Json;
using System.Text.Json.Nodes;

namespace UsageBar.Cli;

public enum StatusLineOutcome { Added, AlreadyOurs, Updated, OtherExists, Removed, NotOurs, Absent }

/// <summary>
/// Merge-only edits to <c>~/.claude/settings.json</c>: we touch the <c>statusLine</c> key and
/// nothing else, and never replace a status line the user set up themselves.
/// </summary>
public static class SettingsMerge
{
    public static bool IsOurs(JsonNode? statusLine) =>
        statusLine is JsonObject o && o["command"] is JsonValue v && v.TryGetValue<string>(out var cmd)
        && cmd.Contains("usagebar", StringComparison.OrdinalIgnoreCase)
        && cmd.Contains("statusline", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The command Claude Code runs. Forward slashes and no quotes when the path has no spaces, so
    /// it reads the same whether Claude Code hands it to Git Bash, cmd or PowerShell.
    /// </summary>
    public static string CommandFor(string exePath)
    {
        var p = exePath.Replace('\\', '/');
        return p.Contains(' ') ? $"\"{p}\" statusline" : $"{p} statusline";
    }

    public static JsonObject ParseOrEmpty(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return new JsonObject();
        var node = JsonNode.Parse(text, documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
        return node as JsonObject ?? throw new InvalidDataException("settings.json is not a JSON object");
    }

    public static StatusLineOutcome Add(JsonObject settings, string command)
    {
        var existing = settings["statusLine"];
        if (existing is not null && !IsOurs(existing)) return StatusLineOutcome.OtherExists;
        if (existing is JsonObject o && o["command"]?.GetValue<string>() == command) return StatusLineOutcome.AlreadyOurs;
        settings["statusLine"] = new JsonObject { ["type"] = "command", ["command"] = command };
        return existing is null ? StatusLineOutcome.Added : StatusLineOutcome.Updated;
    }

    public static StatusLineOutcome Remove(JsonObject settings)
    {
        var existing = settings["statusLine"];
        if (existing is null) return StatusLineOutcome.Absent;
        if (!IsOurs(existing)) return StatusLineOutcome.NotOurs;
        settings.Remove("statusLine");
        return StatusLineOutcome.Removed;
    }

    public static string Serialize(JsonObject settings) =>
        settings.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
}
