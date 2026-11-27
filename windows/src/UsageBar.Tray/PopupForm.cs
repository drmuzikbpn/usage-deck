// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using Microsoft.Win32;
using UsageBar.Core;
using Fmt = UsageBar.Core.Text; // inside a Form/Control, a bare `Text` means the Text property

namespace UsageBar.Tray;

/// <summary>The panel a left-click opens: one bar per window, countdowns, freshness, buttons.</summary>
public sealed class PopupForm : Form
{
    readonly FlowLayoutPanel _rows;
    readonly Label _footer;
    readonly Label _note;
    readonly Button _refresh, _quit;
    readonly CheckBox _notify;
    readonly Action _toggleNotifications;
    bool _syncing;
    Color _bg, _fg, _muted, _track;

    /// <summary>
    /// Clicking the tray icon while the panel is open deactivates (hides) it first, then delivers
    /// the click; the tray uses this to tell "close it" from "open it".
    /// </summary>
    public DateTime HiddenAt { get; private set; }

    public PopupForm(Func<Task> refresh, Action toggleNotifications, Action quit)
    {
        _toggleNotifications = toggleNotifications;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9f);
        Padding = new Padding(14);
        Width = 320;
        KeyPreview = true;
        KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) Hide(); };
        Deactivate += (_, _) => { Hide(); HiddenAt = DateTime.UtcNow; };

        var title = new Label { Text = "Claude usage", Font = new Font("Segoe UI Semibold", 11f), AutoSize = true, Margin = new Padding(0, 0, 0, 8) };
        _rows = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Margin = Padding.Empty };
        _footer = new Label { AutoSize = true, MaximumSize = new Size(290, 0), Margin = new Padding(0, 6, 0, 0) };
        _note = new Label { AutoSize = true, MaximumSize = new Size(290, 0), Margin = new Padding(0, 4, 0, 0), Visible = false };

        _refresh = new Button { Text = "Refresh", AutoSize = true, FlatStyle = FlatStyle.Flat };
        _refresh.Click += async (_, _) =>
        {
            _refresh.Enabled = false;
            try { await refresh(); } finally { _refresh.Enabled = true; }
        };
        _quit = new Button { Text = "Quit", AutoSize = true, FlatStyle = FlatStyle.Flat };
        _quit.Click += (_, _) => quit();
        _notify = new CheckBox { Text = "Notifications", AutoSize = true, Margin = new Padding(0, 6, 12, 0) };
        _notify.CheckedChanged += (_, _) => { if (!_syncing) _toggleNotifications(); };

        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, Margin = new Padding(0, 10, 0, 0) };
        buttons.Controls.AddRange([_notify, _refresh, _quit]);

        var stack = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true };
        stack.Controls.AddRange([title, _rows, _footer, _note, buttons]);
        Controls.Add(stack);
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        ApplyTheme();
    }

    public void ApplyTheme()
    {
        var light = true;
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            light = k?.GetValue("AppsUseLightTheme") is not int v || v != 0;
        }
        catch { }
        _bg = light ? Color.FromArgb(0xF9, 0xF9, 0xF9) : Color.FromArgb(0x2B, 0x2B, 0x2B);
        _fg = light ? Color.FromArgb(0x1A, 0x1A, 0x1A) : Color.FromArgb(0xF2, 0xF2, 0xF2);
        _muted = light ? Color.FromArgb(0x5F, 0x5F, 0x5F) : Color.FromArgb(0xA8, 0xA8, 0xA8);
        _track = light ? Color.FromArgb(0xE0, 0xE0, 0xE0) : Color.FromArgb(0x45, 0x45, 0x45);
        BackColor = _bg;
        ForeColor = _fg;
        foreach (var b in new[] { _refresh, _quit })
        {
            b.BackColor = _bg;
            b.ForeColor = _fg;
            b.FlatAppearance.BorderColor = _muted;
        }
        _footer.ForeColor = _muted;
        _note.ForeColor = _muted;
        Invalidate(true);
    }

    public void ShowNote(string text)
    {
        _note.Text = text;
        _note.Visible = true;
    }

    public void Update(LimitsView view, Config cfg, DateTimeOffset now)
    {
        SuspendLayout();
        // Clear() does not dispose; without this each 15 s redraw leaked window handles.
        var old = _rows.Controls.Cast<Control>().ToArray();
        _rows.Controls.Clear();
        foreach (var c in old) c.Dispose();
        if (view.NoSessionLimit)
            _rows.Controls.Add(new Label { Text = "5h — no 5-hour window on this plan", AutoSize = true, ForeColor = _muted, Margin = new Padding(0, 0, 0, 6) });
        foreach (var r in view.Limits)
            _rows.Controls.Add(new LimitBar(r, Status.Of(r, cfg), now, _fg, _muted, _track));
        if (view.Limits.Count == 0)
            _rows.Controls.Add(new Label { Text = "No data yet.", AutoSize = true, ForeColor = _muted });

        var lines = new List<string>();
        if (view.Limits.Any(r => r.Source == "statusline")) lines.Add("5h/7d live from Claude Code's status line.");
        lines.Add(view.FetchedAt is { } f ? $"Anthropic checked {Fmt.Ago(f, now)}." : "Anthropic not checked yet.");
        if (view.Error is { } e)
        {
            lines.Add(e.Code == "rate_limited" && e.RetryAt is { } ra
                ? $"Anthropic is rate-limiting usage checks until {ra.ToLocalTime():t}."
                : $"Last check failed: {e.Message}{(e.Hint is null ? "" : $" — {e.Hint}")}");
        }
        _footer.Text = string.Join("\n", lines);

        _syncing = true;
        _notify.Checked = cfg.Notifications;
        _syncing = false;
        ResumeLayout(true);
    }

    public void ShowNearTray()
    {
        _note.Visible = false;
        var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
        PerformLayout();
        var x = Math.Min(Cursor.Position.X - Width / 2, wa.Right - Width - 8);
        var y = Cursor.Position.Y > wa.Bottom - 40 || Cursor.Position.Y > wa.Top + wa.Height / 2
            ? wa.Bottom - Height - 8   // taskbar at the bottom (usual)
            : wa.Top + 8;              // taskbar at the top
        Location = new Point(Math.Max(wa.Left + 8, x), y);
        Show();
        Activate();
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
            return cp;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(_track);
        e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
    }

    /// <summary>One window: label + percent, a bar, and "resets in …".</summary>
    sealed class LimitBar : Control
    {
        readonly LimitRow _row;
        readonly LimitStatus _status;
        readonly DateTimeOffset _now;
        readonly Color _fg, _muted, _track;

        public LimitBar(LimitRow row, LimitStatus status, DateTimeOffset now, Color fg, Color muted, Color track)
        {
            (_row, _status, _now, _fg, _muted, _track) = (row, status, now, fg, muted, track);
            DoubleBuffered = true;
            Size = new Size(290, 50);
            Margin = new Padding(0, 0, 0, 6);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var label = Status.Label(_row) switch { "5h" => "5-hour window", "7d" => "7-day window", var l => l };
            var pct = _row.Percent is int p ? $"{p}%" : "?";
            using var bold = new Font("Segoe UI Semibold", 9.5f);
            using var small = new Font("Segoe UI", 8.5f);
            using var fgBrush = new SolidBrush(_fg);
            using var mutedBrush = new SolidBrush(_muted);
            g.DrawString(label, bold, fgBrush, 0, 0);
            var pctSize = g.MeasureString(pct, bold);
            g.DrawString(pct, bold, fgBrush, Width - pctSize.Width, 0);

            var barY = 21;
            var barH = 8;
            using (var trackBrush = new SolidBrush(_track)) g.FillRectangle(trackBrush, 0, barY, Width, barH);
            if (_row.Percent is int v && v > 0)
            {
                using var fill = new SolidBrush(_row.Stale ? Color.FromArgb(140, IconRenderer.ColorFor(_status)) : IconRenderer.ColorFor(_status));
                g.FillRectangle(fill, 0, barY, Width * Math.Min(100, v) / 100f, barH);
            }
            var sub = $"resets {Fmt.Resets(_row.ResetsAt, _now)}{(_row.Stale ? " · not current" : "")}";
            g.DrawString(sub, small, mutedBrush, 0, barY + barH + 3);
        }
    }
}
