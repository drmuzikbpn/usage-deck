// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using UsageBar.Core;

namespace UsageBar.Tests;

public class IsolationTests
{
    [Fact]
    public void Default_paths_never_point_at_real_user_files()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Assert.DoesNotContain(Path.Combine(local, "usagebar"), Paths.LogDir, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(Path.Combine(home, ".claude"), Paths.SettingsPath, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(Path.Combine(local, "Programs"), Paths.InstallRoot, StringComparison.OrdinalIgnoreCase);
    }
}
