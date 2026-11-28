// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text;
using UsageBar.Cli;
using UsageBar.Core;

// usagebar.exe — the console half: mcp, statusline, status, refresh, install, uninstall.
// The tray lives in usagebar-tray.exe (a GUI-subsystem exe, so login start shows no console).

var cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "help";
var rest = args.Skip(1).ToArray();

try
{
    return cmd switch
    {
        "mcp" => await McpCommand.RunAsync(rest),
        "statusline" => StatusLineCommand.Run(),
        "status" => StatusCommand.Run(rest),
        "refresh" => await StatusCommand.RefreshAsync(),
        "install" => await Installer.InstallAsync(rest),
        "uninstall" => await Installer.UninstallAsync(rest),
        "version" or "--version" or "-v" => Print(UsageClient.Version),
        _ => Help(),
    };
}
catch (Exception e) when (cmd is not ("statusline" or "mcp"))
{
    Console.Error.WriteLine($"usagebar {cmd}: {e.Message}");
    return 1;
}

static int Print(string s) { Console.WriteLine(s); return 0; }

static int Help()
{
    Console.OutputEncoding = Encoding.UTF8;
    Console.WriteLine($"""
        usagebar {UsageClient.Version} — Claude usage limits on Windows (not affiliated with Anthropic)

          usagebar status [--json]   current limits from the shared cache
          usagebar refresh           ask Anthropic now (at most once a minute)
          usagebar install [--yes]   install to {Paths.InstallRoot}, start at login,
                                     register the MCP server and the status line
          usagebar uninstall [--yes] [--purge]
          usagebar mcp               stdio MCP server (Claude Code starts this)
          usagebar statusline        Claude Code status-line command
        """);
    return 0;
}
