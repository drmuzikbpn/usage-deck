// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using Microsoft.Win32;
using UsageBar.Core;

namespace UsageBar.Tray;

/// <summary>
/// The tray process is usagebar's background service: it owns the polling schedule, writes the
/// shared cache, and redraws whenever the cache changes (its own polls, a status-line render, or
/// an MCP refresh in another process).
/// </summary>
public sealed class TrayContext : ApplicationContext
{
    readonly NotifyIcon _icon;
    readonly System.Windows.Forms.Timer _tick;
    readonly FileSystemWatcher? _watcher;
    readonly StateStore _store = new();
    readonly TokenReader _tokens = new();
    readonly HttpClient _http = UsageClient.CreateHttpClient();
    readonly Fetcher _fetcher;
    readonly EventWaitHandle _quit;
    readonly SynchronizationContext _ui;
    readonly ToolStripMenuItem _notifyItem;
    readonly AlertState _alerts = AlertState.Load();
    PopupForm? _popup;
    IconRenderer.Owned? _current;
    Config _cfg = Config.Load();
    bool _fetching;
    string _lastIconKey = "";

    public TrayContext()
    {
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        _fetcher = new Fetcher(_store, _tokens, _http);

        _notifyItem = new ToolStripMenuItem("Notifications", null, (_, _) => ToggleNotifications()) { Checked = _cfg.Notifications };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Refresh now", null, async (_, _) => await FetchAsync(manual: true));
        menu.Items.Add(_notifyItem);
        menu.Items.Add("Open data folder", null, (_, _) => OpenFolder(Paths.DataDir));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit usagebar", null, (_, _) => ExitThread());

        _icon = new NotifyIcon { ContextMenuStrip = menu, Visible = true, Text = "usagebar — starting" };
        _icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) TogglePopup(); };

        _tick = new System.Windows.Forms.Timer { Interval = 15_000 };
        _tick.Tick += async (_, _) => await OnTickAsync();
        _tick.Start();

        try
        {
            Directory.CreateDirectory(Paths.DataDir);
            _watcher = new FileSystemWatcher(Paths.DataDir)
            {
                Filter = "*.json",
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
                EnableRaisingEvents = true,
            };
            _watcher.Changed += OnDataFileChanged;
            _watcher.Created += OnDataFileChanged;
            _watcher.Renamed += OnDataFileChanged;
        }
        catch (Exception e) { Log.Write($"watcher unavailable: {e.GetType().Name}"); }

        _quit = new EventWaitHandle(false, EventResetMode.AutoReset, TrayControl.QuitEvent);
        ThreadPool.RegisterWaitForSingleObject(_quit, (_, _) => _ui.Post(_ => ExitThread(), null), null, Timeout.Infinite, executeOnlyOnce: true);

        SystemEvents.PowerModeChanged += OnPowerModeChanged;
        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;

        Redraw();
        _ = OnTickAsync();
    }

    // --- polling ---------------------------------------------------------------

    async Task OnTickAsync()
    {
        var now = DateTimeOffset.UtcNow;
        if (Schedule.NextDue(_store.Load(), _cfg, now) <= now) await FetchAsync(manual: false);
        Redraw(); // countdowns and "reset since" states move with the clock
    }

    async Task FetchAsync(bool manual)
    {
        if (_fetching) return;
        _fetching = true;
        try
        {
            var outcome = await Task.Run(() => _fetcher.FetchAsync(manual));
            if (manual && outcome.Result != FetchResult.Fetched && _popup is { Visible: true })
                _popup.ShowNote(outcome.Describe());
        }
        catch (Exception e) { Log.Write($"fetch crashed: {e.GetType().Name}: {e.Message}"); }
        finally { _fetching = false; }
        Redraw();
    }

    void OnDataFileChanged(object sender, FileSystemEventArgs e)
    {
        var name = Path.GetFileName(e.FullPath);
        if (name.Equals("config.json", StringComparison.OrdinalIgnoreCase))
            _ui.Post(_ => { _cfg = Config.Load(); _notifyItem.Checked = _cfg.Notifications; Redraw(); }, null);
        else if (name.Equals("state.json", StringComparison.OrdinalIgnoreCase))
            _ui.Post(_ => Redraw(), null);
    }

    void OnPowerModeChanged(object? sender, PowerModeChangedEventArgs e)
    {
        // After sleep the clock jumped; re-evaluate straight away instead of waiting for the next tick.
        if (e.Mode == PowerModes.Resume) _ui.Post(async _ => { await Task.Delay(5_000); await OnTickAsync(); }, null);
    }

    void OnUserPreferenceChanged(object? sender, UserPreferenceChangedEventArgs e)
    {
        _lastIconKey = ""; // DPI/theme change: force a fresh icon
        _ui.Post(_ => { _popup?.ApplyTheme(); Redraw(); }, null);
    }

    // --- drawing ---------------------------------------------------------------

    void Redraw()
    {
        try
        {
            var now = DateTimeOffset.UtcNow;
            var state = _store.Load();
            var view = LimitsView.Build(state, now);
            var head = view.Headline(_cfg);
            LimitStatus? status = head is null || head.Percent is null ? null : Status.Of(head, _cfg);
            var text = IconRenderer.TextFor(head);
            var weekly = head?.Id == "weekly_all";
            var dimmed = head is not null && head.Stale;
            var size = SystemInformation.SmallIconSize.Width;
            var key = $"{text}|{status}|{weekly}|{dimmed}|{size}";
            if (key != _lastIconKey)
            {
                var next = IconRenderer.Render(text, IconRenderer.ColorFor(status), weekly, dimmed, size);
                _icon.Icon = next.Icon;
                _current?.Dispose(); // only after the shell has the new one
                _current = next;
                _lastIconKey = key;
            }
            _icon.Text = Tooltip(view, now);
            _popup?.Update(view, _cfg, now);
            Notify(view, now);
        }
        catch (Exception e) { Log.Write($"redraw failed: {e.GetType().Name}: {e.Message}"); }
    }

    /// <summary>NotifyIcon.Text is capped at 127 characters.</summary>
    static string Tooltip(LimitsView view, DateTimeOffset now)
    {
        string Part(string id)
        {
            var r = view.Limits.FirstOrDefault(x => x.Id == id);
            return r is null ? "" : $"{Status.Label(r)} {(r.Percent is int p ? $"{p}%" : "?")} (resets {Text.ResetsShort(r.ResetsAt, now)})";
        }
        var parts = new[] { Part("session"), Part("weekly_all") }.Where(s => s.Length > 0).ToList();
        var line = parts.Count > 0 ? string.Join(" · ", parts) : view.Error is { } e ? $"usagebar: {e.Code}" : "usagebar: no data yet";
        if (view.Limits.Any(r => r.Source == "statusline")) line += "\nlive from Claude Code";
        else if (view.FetchedAt is { } f) line += $"\nupdated {Text.Ago(f, now)}";
        if (view.Error is { Code: "rate_limited" }) line += " · Anthropic rate limit";
        return line.Length <= 127 ? line : line[..127];
    }

    void Notify(LimitsView view, DateTimeOffset now)
    {
        var alerts = Alerts.Evaluate(_alerts, view, _cfg, now);
        if (alerts.Count == 0) return;
        try { _alerts.Save(); } catch (Exception e) { Log.Write($"alerts save failed: {e.GetType().Name}"); }
        if (!_cfg.Notifications) return;
        // One balloon at a time; the most important one wins.
        var a = alerts.OrderByDescending(x => x.Level).ThenBy(x => x.IsReset).First();
        _icon.ShowBalloonTip(10_000, a.Title, a.Body, a.Level switch
        {
            LimitStatus.Critical => ToolTipIcon.Error,
            LimitStatus.Warn => ToolTipIcon.Warning,
            _ => ToolTipIcon.Info,
        });
        Log.Write($"notified: {a.Title}");
    }

    // --- popup / menu ----------------------------------------------------------

    void TogglePopup()
    {
        if (_popup is { Visible: true }) { _popup.Hide(); return; }
        if (_popup is not null && DateTime.UtcNow - _popup.HiddenAt < TimeSpan.FromMilliseconds(300)) return;
        _popup ??= new PopupForm(
            refresh: async () => await FetchAsync(manual: true),
            toggleNotifications: ToggleNotifications,
            quit: ExitThread);
        var now = DateTimeOffset.UtcNow;
        _popup.Update(LimitsView.Build(_store.Load(), now), _cfg, now);
        _popup.ShowNearTray();
    }

    void ToggleNotifications()
    {
        _cfg = Config.Load();
        _cfg.Notifications = !_cfg.Notifications;
        try { _cfg.Save(); } catch (Exception e) { Log.Write($"config save failed: {e.GetType().Name}"); }
        _notifyItem.Checked = _cfg.Notifications;
        Redraw();
    }

    static void OpenFolder(string dir)
    {
        Directory.CreateDirectory(dir);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(dir) { UseShellExecute = true });
    }

    protected override void ExitThreadCore()
    {
        _icon.Visible = false; // otherwise a ghost icon lingers until the mouse passes over it
        base.ExitThreadCore();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.PowerModeChanged -= OnPowerModeChanged;
            SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
            _tick.Dispose();
            _watcher?.Dispose();
            _icon.Dispose();
            _current?.Dispose();
            _popup?.Dispose();
            _http.Dispose();
            _quit.Dispose();
        }
        base.Dispose(disposing);
    }
}
