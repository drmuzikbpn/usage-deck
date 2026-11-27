// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using UsageBar.Core;

namespace UsageBar.Tray;

/// <summary>Draws the tray icon: the headline percent on a rounded tile coloured by status.</summary>
public static class IconRenderer
{
    public static readonly Color OkColor = Color.FromArgb(0x2E, 0x7D, 0x32);
    public static readonly Color WarnColor = Color.FromArgb(0xF5, 0xA6, 0x23);
    public static readonly Color CriticalColor = Color.FromArgb(0xC6, 0x28, 0x28);
    public static readonly Color UnknownColor = Color.FromArgb(0x75, 0x75, 0x75);

    public static Color ColorFor(LimitStatus? s) => s switch
    {
        LimitStatus.Ok => OkColor,
        LimitStatus.Warn => WarnColor,
        LimitStatus.Critical => CriticalColor,
        _ => UnknownColor,
    };

    /// <summary>What goes on the tile: <c>42</c>, <c>!</c> at 100, <c>?</c> unknown, <c>–</c> no data.</summary>
    public static string TextFor(LimitRow? row) => row switch
    {
        null => "–",
        { Percent: null } => "?",
        { Percent: >= 100 } => "!",
        { Percent: var p } => p!.Value.ToString(),
    };

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool DestroyIcon(IntPtr hIcon);

    /// <summary>An icon plus the GDI handle behind it; Icon.FromHandle never frees that handle itself.</summary>
    public sealed class Owned(Icon icon, IntPtr handle) : IDisposable
    {
        public Icon Icon { get; } = icon;
        IntPtr _handle = handle;
        public void Dispose()
        {
            Icon.Dispose();
            if (_handle != IntPtr.Zero) { DestroyIcon(_handle); _handle = IntPtr.Zero; }
        }
    }

    /// <summary>
    /// Render at the shell's small-icon size (16 px at 100 %, larger on high-DPI). Dispose the
    /// result only after the NotifyIcon has been given its replacement.
    /// </summary>
    public static Owned Render(string text, Color tile, bool weeklyMarker, bool dimmed, int size)
    {
        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);

            var fill = dimmed ? Color.FromArgb(150, tile) : tile;
            var r = Math.Max(2, size / 5);
            using (var path = RoundedRect(new RectangleF(0, 0, size, size), r))
            using (var brush = new SolidBrush(fill))
                g.FillPath(brush, path);

            var fg = tile == WarnColor ? Color.Black : Color.White;
            var fontPx = text.Length >= 2 ? size * 0.68f : size * 0.80f;
            using var font = new Font("Segoe UI", fontPx, FontStyle.Bold, GraphicsUnit.Pixel);
            using var sf = new StringFormat(StringFormat.GenericTypographic)
            {
                Alignment = StringAlignment.Center,
                LineAlignment = StringAlignment.Center,
                FormatFlags = StringFormatFlags.NoWrap,
            };
            using var textBrush = new SolidBrush(fg);
            var textRect = new RectangleF(-1, weeklyMarker ? -size * 0.08f : 0, size + 2, size);
            g.DrawString(text, font, textBrush, textRect, sf);

            if (weeklyMarker)
            {
                // a short bar along the bottom edge = "this number is the 7-day window"
                using var pen = new Pen(fg, Math.Max(1f, size / 12f));
                var y = size - Math.Max(2f, size / 7f);
                g.DrawLine(pen, size * 0.28f, y, size * 0.72f, y);
            }
        }
        var hIcon = bmp.GetHicon();
        return new Owned(Icon.FromHandle(hIcon), hIcon);
    }

    static GraphicsPath RoundedRect(RectangleF b, float r)
    {
        var d = r * 2;
        var p = new GraphicsPath();
        p.AddArc(b.X, b.Y, d, d, 180, 90);
        p.AddArc(b.Right - d, b.Y, d, d, 270, 90);
        p.AddArc(b.Right - d, b.Bottom - d, d, d, 0, 90);
        p.AddArc(b.X, b.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}
