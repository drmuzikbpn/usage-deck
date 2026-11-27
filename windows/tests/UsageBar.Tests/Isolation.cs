// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Runtime.CompilerServices;

namespace UsageBar.Tests;

/// <summary>
/// Before any test runs, point every default path (state, config, logs, Claude dir, install root)
/// at a throwaway directory, so nothing a test does can reach the real user files.
/// </summary>
static class Isolation
{
    [ModuleInitializer]
    internal static void Init()
    {
        var root = Path.Combine(Path.GetTempPath(), "usagebar-tests-" + Environment.ProcessId);
        Environment.SetEnvironmentVariable("USAGEBAR_DATA_DIR", Path.Combine(root, "data"));
        Environment.SetEnvironmentVariable("CLAUDE_CONFIG_DIR", Path.Combine(root, "claude"));
        Environment.SetEnvironmentVariable("USAGEBAR_INSTALL_ROOT", Path.Combine(root, "install"));
    }
}
