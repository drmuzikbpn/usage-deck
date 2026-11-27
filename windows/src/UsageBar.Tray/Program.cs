// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using UsageBar.Core;

namespace UsageBar.Tray;

static class Program
{
    [STAThread]
    static int Main()
    {
        Log.Component = "tray";
        using var instance = new Mutex(true, TrayControl.InstanceMutex, out var createdNew);
        if (!createdNew) return 0; // one tray per user session

        ApplicationConfiguration.Initialize();
        Application.ThreadException += (_, e) => Log.Write($"ui exception: {e.Exception}");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Write($"unhandled: {e.ExceptionObject}");
        Log.Prune();
        Log.Write($"start v{UsageClient.Version}");
        using var ctx = new TrayContext();
        Application.Run(ctx);
        Log.Write("exit");
        return 0;
    }
}
