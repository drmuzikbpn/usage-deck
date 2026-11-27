// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
namespace UsageBar.Core;

/// <summary>Named kernel objects the tray and the installer share (per Windows session).</summary>
public static class TrayControl
{
    /// <summary>Held by the running tray; its presence means "a tray is up".</summary>
    public const string InstanceMutex = @"Local\usagebar-tray-instance";
    /// <summary>Set it and the tray exits cleanly (used by install/uninstall).</summary>
    public const string QuitEvent = @"Local\usagebar-tray-quit";

    public static bool IsRunning()
    {
        if (!Mutex.TryOpenExisting(InstanceMutex, out var m)) return false;
        m.Dispose();
        return true;
    }

    /// <summary>Ask a running tray to quit and wait for it. True if none is left running.</summary>
    public static bool RequestQuit(TimeSpan timeout)
    {
        if (!IsRunning()) return true;
        if (EventWaitHandle.TryOpenExisting(QuitEvent, out var ev))
            using (ev) ev.Set();
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (!IsRunning()) return true;
            Thread.Sleep(100);
        }
        return !IsRunning();
    }
}
