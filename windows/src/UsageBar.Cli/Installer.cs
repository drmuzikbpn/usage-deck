// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Diagnostics;
using System.Text;
using Microsoft.Win32;
using UsageBar.Core;

namespace UsageBar.Cli;

/// <summary>
/// <c>usagebar install</c> / <c>uninstall</c>. Per-user only, no admin: files under
/// <c>%LOCALAPPDATA%\Programs\usagebar</c>, an HKCU Run value, a user-scope MCP entry, and a
/// merge-only <c>statusLine</c>. Every change is explained and confirmed first unless <c>--yes</c>.
/// </summary>
public static class Installer
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunValue = "usagebar";
    const string McpName = "usagebar";

    public static async Task<int> InstallAsync(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var yes = args.Contains("--yes") || args.Contains("-y");
        var source = Path.GetFullPath(AppContext.BaseDirectory);
        var cliSrc = Path.Combine(source, "usagebar.exe");
        var traySrc = Path.Combine(source, "usagebar-tray.exe");
        if (!File.Exists(cliSrc) || !File.Exists(traySrc))
            throw new InvalidOperationException($"{source} must contain usagebar.exe and usagebar-tray.exe — run install from the published folder (build.ps1 output)");

        var claude = FindClaude();
        var runningFromInstall = IsUnder(source, Paths.InstallRoot);
        var cmdLine = SettingsMerge.CommandFor(Paths.CurrentCliExe);

        Console.WriteLine($"usagebar {UsageClient.Version} install — per-user, no admin rights needed.\n");
        Console.WriteLine("Each step says what it changes and asks first.\n");

        // 1. files
        if (!runningFromInstall)
        {
            var target = Path.Combine(Paths.VersionsDir, $"{UsageClient.Version}-{DateTime.Now:yyyyMMddHHmmss}");
            if (Confirm(yes, $"Copy the program to {target}\n  and point {Paths.CurrentDir} at it (a directory junction)?"))
            {
                var trayWasRunning = TrayControl.IsRunning();
                if (trayWasRunning && !TrayControl.RequestQuit(TimeSpan.FromSeconds(5)))
                    Console.WriteLine("  ! the running tray did not quit; it keeps the old version until you sign out");
                CopyDir(source, target);
                SwapJunction(Paths.CurrentDir, target);
                Console.WriteLine($"  ok: {Paths.CurrentDir} -> {target}");
                CleanupOldVersions(target);
            }
            else if (!Directory.Exists(Paths.CurrentDir))
            {
                Console.WriteLine("  skipped — later steps point at the install folder, so they are skipped too.");
                return 1;
            }
        }

        // 2. start at login + start now
        if (Confirm(yes, $"Start the tray icon when you sign in?\n  (HKCU\\{RunKey} value \"{RunValue}\")"))
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
            key.SetValue(RunValue, $"\"{Paths.CurrentTrayExe}\"");
            Console.WriteLine("  ok");
        }
        if (!TrayControl.IsRunning())
        {
            Process.Start(new ProcessStartInfo(Paths.CurrentTrayExe) { UseShellExecute = true, WorkingDirectory = Paths.CurrentDir });
            Console.WriteLine("  started the tray icon. Windows 11 hides new icons under the ^ arrow — drag it onto the taskbar,");
            Console.WriteLine("  or turn it on in Settings > Personalization > Taskbar > Other system tray icons.");
        }

        // 3. MCP
        if (claude is null)
        {
            Console.WriteLine($"\n  ! `claude` was not found on PATH; register the MCP server yourself:\n    claude mcp add --scope user {McpName} -- \"{Paths.CurrentCliExe}\" mcp");
        }
        else if (Confirm(yes, $"Register the MCP server with Claude Code (user scope, all projects)?\n  claude mcp add --scope user {McpName} -- \"{Paths.CurrentCliExe}\" mcp"))
        {
            await RunAsync(claude, ["mcp", "remove", "--scope", "user", McpName]); // ok if it was not there
            var (code, output) = await RunAsync(claude, ["mcp", "add", "--scope", "user", McpName, "--", Paths.CurrentCliExe, "mcp"]);
            Console.WriteLine(code == 0 ? "  ok" : $"  ! claude mcp add exited {code}: {output.Trim()}");
        }

        // 4. status line
        var settingsText = AtomicFile.TryReadAllText(Paths.SettingsPath);
        var settings = SettingsMerge.ParseOrEmpty(settingsText);
        var existing = settings["statusLine"];
        if (existing is not null && !SettingsMerge.IsOurs(existing))
        {
            Console.WriteLine($"\n  You already have your own statusLine in {Paths.SettingsPath}; it is left alone.");
            Console.WriteLine($"  To feed live limits to usagebar, pipe the same stdin JSON your script receives into:\n    {cmdLine}");
        }
        else if (Confirm(yes, $"Set Claude Code's status line in {Paths.SettingsPath}?\n  It shows `5h 42% · 7d 61%` and feeds live numbers to the tray. Only the \"statusLine\" key is touched.\n  command: {cmdLine}"))
        {
            var outcome = SettingsMerge.Add(settings, cmdLine);
            if (outcome is StatusLineOutcome.Added or StatusLineOutcome.Updated)
            {
                if (settingsText is not null && !File.Exists(Paths.SettingsPath + ".usagebar.bak"))
                    File.Copy(Paths.SettingsPath, Paths.SettingsPath + ".usagebar.bak");
                AtomicFile.WriteAllText(Paths.SettingsPath, SettingsMerge.Serialize(settings));
            }
            Console.WriteLine($"  ok ({outcome}) — open Claude Code sessions pick it up on restart");
        }

        Console.WriteLine($"\nDone. Check with: \"{Paths.CurrentCliExe}\" status");
        return 0;
    }

    public static async Task<int> UninstallAsync(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var yes = args.Contains("--yes") || args.Contains("-y");
        var purge = args.Contains("--purge");

        if (Confirm(yes, "Quit the tray icon and stop starting it at sign-in?"))
        {
            TrayControl.RequestQuit(TimeSpan.FromSeconds(5));
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            key?.DeleteValue(RunValue, throwOnMissingValue: false);
            Console.WriteLine("  ok");
        }

        var claude = FindClaude();
        if (claude is not null && Confirm(yes, $"Remove the \"{McpName}\" MCP server from Claude Code?"))
        {
            var (code, output) = await RunAsync(claude, ["mcp", "remove", "--scope", "user", McpName]);
            Console.WriteLine(code == 0 ? "  ok" : $"  (claude mcp remove exited {code}: {output.Trim()})");
        }

        var text = AtomicFile.TryReadAllText(Paths.SettingsPath);
        if (text is not null)
        {
            var settings = SettingsMerge.ParseOrEmpty(text);
            if (SettingsMerge.IsOurs(settings["statusLine"]) && Confirm(yes, $"Remove usagebar's statusLine from {Paths.SettingsPath}?"))
            {
                SettingsMerge.Remove(settings);
                AtomicFile.WriteAllText(Paths.SettingsPath, SettingsMerge.Serialize(settings));
                Console.WriteLine("  ok");
            }
        }

        if (Directory.Exists(Paths.InstallRoot) && Confirm(yes, $"Delete the program files in {Paths.InstallRoot}?"))
        {
            if (IsUnder(AppContext.BaseDirectory, Paths.InstallRoot))
                Console.WriteLine("  ! this usagebar.exe is running from there; files in use are left — delete the folder afterwards");
            try { if (Directory.Exists(Paths.CurrentDir)) Directory.Delete(Paths.CurrentDir, recursive: false); } catch (IOException) { }
            var left = DeleteBestEffort(Paths.InstallRoot);
            Console.WriteLine(left == 0 ? "  ok" : $"  {left} file(s) still in use (open Claude sessions run the MCP server); they go when those close");
        }

        if (purge && Confirm(yes, $"Delete usagebar's data (cache, config, logs) in {Paths.DataDir}?"))
        {
            DeleteBestEffort(Paths.DataDir);
            Console.WriteLine("  ok");
        }
        return 0;
    }

    // --- helpers -------------------------------------------------------------

    static bool Confirm(bool yes, string question)
    {
        Console.WriteLine();
        Console.WriteLine(question);
        if (yes) { Console.WriteLine("  [--yes]"); return true; }
        if (Console.IsInputRedirected) { Console.WriteLine("  (no terminal to ask; skipped — pass --yes)"); return false; }
        Console.Write("  Proceed? [y/N] ");
        var a = Console.ReadLine()?.Trim().ToLowerInvariant();
        return a is "y" or "yes";
    }

    static bool IsUnder(string path, string root)
    {
        var p = Path.GetFullPath(path).TrimEnd('\\') + "\\";
        var r = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        return p.StartsWith(r, StringComparison.OrdinalIgnoreCase);
    }

    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.EnumerateFiles(from))
            File.Copy(f, Path.Combine(to, Path.GetFileName(f)), overwrite: true);
        foreach (var d in Directory.EnumerateDirectories(from))
            CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
    }

    /// <summary>Re-point the <c>current</c> junction. Files locked in the old target don't block this.</summary>
    static void SwapJunction(string junction, string target)
    {
        if (Directory.Exists(junction))
        {
            var info = new DirectoryInfo(junction);
            if (!info.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidOperationException($"{junction} exists and is not a junction; refusing to replace it");
            info.Delete(); // removes the link only, never the target's files
        }
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe"); // absolute: never a PATH lookup
        var psi = new ProcessStartInfo(cmd) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in new[] { "/d", "/c", "mklink", "/J", junction, target }) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        p.WaitForExit();
        if (p.ExitCode != 0) throw new InvalidOperationException($"mklink /J failed: {p.StandardError.ReadToEnd().Trim()}");
    }

    static void CleanupOldVersions(string keep)
    {
        if (!Directory.Exists(Paths.VersionsDir)) return;
        foreach (var d in Directory.EnumerateDirectories(Paths.VersionsDir))
        {
            if (string.Equals(Path.GetFullPath(d), Path.GetFullPath(keep), StringComparison.OrdinalIgnoreCase)) continue;
            try { Directory.Delete(d, recursive: true); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* still in use */ }
        }
    }

    static int DeleteBestEffort(string dir)
    {
        var left = 0;
        if (!Directory.Exists(dir)) return 0;
        foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
        {
            try { File.Delete(f); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { left++; }
        }
        try { Directory.Delete(dir, recursive: true); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        return left;
    }

    static string? FindClaude()
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!Path.IsPathFullyQualified(dir)) continue; // never resolve relative PATH entries
            foreach (var name in new[] { "claude.exe", "claude.cmd" })
            {
                var p = Path.Combine(dir, name);
                if (File.Exists(p)) return p;
            }
        }
        return null;
    }

    static async Task<(int Code, string Output)> RunAsync(string exe, string[] args)
    {
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        if (exe.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
        {
            psi.FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            psi.ArgumentList.Add("/d");
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add(exe);
        }
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync();
        return (p.ExitCode, await stdout + await stderr);
    }
}
