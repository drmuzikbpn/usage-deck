// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
namespace UsageBar.Core;

/// <summary>
/// Every filesystem location usagebar reads or writes. Environment overrides exist so tests
/// (and a curious user) can point everything at a temp directory and never touch real files.
/// </summary>
public static class Paths
{
    public const string App = "usagebar";

    static string? Env(string name)
    {
        var v = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(v) ? null : v;
    }

    static string LocalAppData => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    static string UserProfile => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    /// <summary><c>%LOCALAPPDATA%\usagebar</c> — state, config, logs.</summary>
    public static string DataDir => Env("USAGEBAR_DATA_DIR") ?? Path.Combine(LocalAppData, App);
    public static string StatePath => Path.Combine(DataDir, "state.json");
    public static string ConfigPath => Path.Combine(DataDir, "config.json");
    public static string AlertsPath => Path.Combine(DataDir, "alerts.json");
    public static string LogDir => Path.Combine(DataDir, "logs");

    /// <summary>Claude Code's own directory; honours <c>CLAUDE_CONFIG_DIR</c> like Claude Code does.</summary>
    public static string ClaudeDir => Env("CLAUDE_CONFIG_DIR") ?? Path.Combine(UserProfile, ".claude");
    public static string CredentialsPath => Path.Combine(ClaudeDir, ".credentials.json");
    public static string SettingsPath => Path.Combine(ClaudeDir, "settings.json");

    /// <summary><c>%LOCALAPPDATA%\Programs\usagebar</c> — the install root (no admin needed).</summary>
    public static string InstallRoot => Env("USAGEBAR_INSTALL_ROOT") ?? Path.Combine(LocalAppData, "Programs", App);
    public static string VersionsDir => Path.Combine(InstallRoot, "versions");
    /// <summary>A directory junction to the active version, so registered paths never change.</summary>
    public static string CurrentDir => Path.Combine(InstallRoot, "current");
    public static string CurrentCliExe => Path.Combine(CurrentDir, "usagebar.exe");
    public static string CurrentTrayExe => Path.Combine(CurrentDir, "usagebar-tray.exe");
}
