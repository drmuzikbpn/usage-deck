// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using UsageBar.Core;

namespace UsageBar.Tests;

public class NormalizeTests
{
    [Fact]
    public void Maps_limits_array_one_to_one()
    {
        var at = DateTimeOffset.Parse("2026-09-13T15:00:00Z");
        var snap = Normalize.FromPayload(Fixtures.Usage(), at);
        Assert.Equal(["session", "weekly_all", "weekly_scoped:fable"], snap.Limits.Select(l => l.Id));
        var session = snap.Limits[0];
        Assert.Equal(5, session.Percent);
        Assert.Equal("normal", session.Severity);
        Assert.Equal(DateTimeOffset.Parse("2026-09-13T18:00:00.114379+00:00"), session.ResetsAt);
        Assert.Equal("Fable", snap.Limits[2].Model);
        Assert.True(snap.Limits[1].IsActive);
        Assert.False(snap.ExtraUsageEnabled);
        Assert.True(snap.SpendLimitReached);
    }

    [Fact]
    public void Ignores_malformed_entries()
    {
        var payload = (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse(
            """{"limits":[{"percent":3},"junk",{"kind":"session","percent":"x","resets_at":"not a date"}]}""")!;
        var snap = Normalize.FromPayload(payload, DateTimeOffset.UtcNow);
        var only = Assert.Single(snap.Limits);
        Assert.Null(only.Percent);
        Assert.Null(only.ResetsAt);
    }
}

public class StatusTests
{
    static readonly Config Cfg = new();

    [Theory]
    [InlineData(79, "normal", LimitStatus.Ok)]
    [InlineData(80, "normal", LimitStatus.Warn)]
    [InlineData(95, "normal", LimitStatus.Critical)]
    [InlineData(10, "elevated", LimitStatus.Warn)]
    [InlineData(10, "Exhausted", LimitStatus.Critical)]
    public void Thresholds_and_severity(int pct, string sev, LimitStatus expected) =>
        Assert.Equal(expected, Status.Of(new LimitRow { Id = "session", Percent = pct, Severity = sev }, Cfg));

    [Fact]
    public void Labels() =>
        Assert.Equal("7d Fable", Status.Label(new LimitRow { Id = "weekly_scoped:fable", Kind = "weekly_scoped", Model = "Fable" }));
}

public class CredentialsTests
{
    [Fact]
    public void Reads_token_and_ms_expiry_without_leaking_it()
    {
        var token = Fixtures.FakeToken();
        var exp = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds());
        var t = Credentials.Parse(Fixtures.CredentialsJson(token, exp), "test");
        Assert.Equal(token, t.AccessToken);
        Assert.Equal(exp, t.ExpiresAt);
        Assert.DoesNotContain(token, t.ToString());
    }

    [Fact]
    public void Errors_never_include_file_contents()
    {
        var secret = Fixtures.FakeToken();
        var e = Assert.Throws<CredentialsException>(() => Credentials.Parse("{\"claudeAiOauth\":{\"refreshToken\":\"" + secret + "\"}}", "test"));
        Assert.DoesNotContain(secret, e.Message);
        var bad = Assert.Throws<CredentialsException>(() => Credentials.Parse($"{{ {secret}", "test"));
        Assert.DoesNotContain(secret, bad.Message);
    }

    [Fact]
    public void Missing_file_is_a_credentials_error()
    {
        using var d = new TempDir();
        Assert.Throws<CredentialsException>(() => Credentials.Read(d.File("nope.json")));
    }
}

public class ViewTests
{
    static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-09-13T15:00:00Z");

    static State WithUpstream() => new() { Upstream = Normalize.FromPayload(Fixtures.Usage(), T0) };

    [Fact]
    public void Fresh_observation_overrides_upstream_headline()
    {
        var s = WithUpstream();
        s.Observed["session"] = new Observation { UsedPercentage = 41.6, ResetsAt = T0.AddHours(3), ObservedAt = T0.AddMinutes(1) };
        var v = LimitsView.Build(s, T0.AddMinutes(2));
        var row = v.Limits.Single(r => r.Id == "session");
        Assert.Equal(42, row.Percent);
        Assert.Equal("statusline", row.Source);
        Assert.Equal("upstream", v.Limits.Single(r => r.Id == "weekly_all").Source);
    }

    [Fact]
    public void Newer_higher_upstream_reading_beats_an_older_observation()
    {
        // Seen live: the status line said 7 %, Anthropic a minute later said 8 %, the view showed 7.
        var s = WithUpstream();
        var session = s.Upstream!.Limits.Single(r => r.Id == "session");
        session.Percent = 8;
        s.Upstream.FetchedAt = T0.AddMinutes(2);
        session.AsOf = s.Upstream.FetchedAt;
        s.Observed["session"] = new Observation { UsedPercentage = 7, ResetsAt = session.ResetsAt, ObservedAt = T0.AddMinutes(1) };
        var row = LimitsView.Build(s, T0.AddMinutes(3)).Limits.Single(r => r.Id == "session");
        Assert.Equal(8, row.Percent);
        Assert.Equal("upstream", row.Source);
    }

    [Fact]
    public void Usage_never_reads_lower_than_either_source_in_the_same_window()
    {
        // Older observation, but higher: usage only grows inside a window, so 9 % still stands.
        var s = WithUpstream();
        var session = s.Upstream!.Limits.Single(r => r.Id == "session");
        s.Upstream.FetchedAt = T0.AddMinutes(2);
        s.Observed["session"] = new Observation { UsedPercentage = 9, ResetsAt = session.ResetsAt, ObservedAt = T0.AddMinutes(1) };
        Assert.Equal(9, LimitsView.Build(s, T0.AddMinutes(3)).Limits.Single(r => r.Id == "session").Percent);
    }

    [Fact]
    public void Old_observation_is_ignored()
    {
        var s = WithUpstream();
        s.Observed["session"] = new Observation { UsedPercentage = 90, ResetsAt = T0.AddHours(3), ObservedAt = T0 };
        var v = LimitsView.Build(s, T0.AddMinutes(16));
        Assert.Equal(5, v.Limits.Single(r => r.Id == "session").Percent);
    }

    [Fact]
    public void Window_reset_since_read_shows_unknown()
    {
        var v = LimitsView.Build(WithUpstream(), DateTimeOffset.Parse("2026-09-13T18:30:00Z"));
        var row = v.Limits.Single(r => r.Id == "session");
        Assert.Null(row.Percent);
        Assert.True(row.Stale);
    }

    [Fact]
    public void Headline_is_the_tighter_window()
    {
        var s = WithUpstream();
        s.Upstream!.Limits.Single(r => r.Id == "weekly_all").Percent = 85;
        var head = LimitsView.Build(s, T0).Headline(new Config());
        Assert.Equal("weekly_all", head!.Id);
    }

    [Fact]
    public void Weekly_only_plan_reports_no_session_limit()
    {
        var s = WithUpstream();
        s.Upstream!.Limits.RemoveAll(r => r.Id == "session");
        Assert.True(LimitsView.Build(s, T0).NoSessionLimit);
    }
}

public class StatusLineTests
{
    static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-09-13T15:00:00Z");

    [Fact]
    public void Parses_epoch_and_iso_resets()
    {
        var obs = StatusLine.ParseObservations(
            """{"session_id":"x","rate_limits":{"five_hour":{"used_percentage":42.4,"resets_at":1789412400},"seven_day":{"used_percentage":61,"resets_at":"2026-09-16T13:00:00Z"}}}""", T0)!;
        Assert.Equal(42.4, obs["session"].UsedPercentage);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1789412400), obs["session"].ResetsAt);
        Assert.Equal(DateTimeOffset.Parse("2026-09-16T13:00:00Z"), obs["weekly_all"].ResetsAt);
    }

    [Theory]
    [InlineData("""{"model":{}}""")]
    [InlineData("""{"rate_limits":{"five_hour":{"used_percentage":140}}}""")]
    [InlineData("""{"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":true}}}""")]
    [InlineData("not json")]
    [InlineData("")]
    public void Rejects_unusable_payloads(string stdin) => Assert.Null(StatusLine.ParseObservations(stdin, T0));

    [Fact]
    public void Lower_reading_in_same_window_does_not_pull_gauge_down()
    {
        var s = new State();
        var reset = T0.AddHours(3);
        StatusLine.Merge(s, new() { ["session"] = new Observation { UsedPercentage = 50, ResetsAt = reset, ObservedAt = T0 } }, T0);
        var changed = StatusLine.Merge(s, new() { ["session"] = new Observation { UsedPercentage = 30, ResetsAt = reset, ObservedAt = T0.AddMinutes(1) } }, T0.AddMinutes(1));
        Assert.False(changed);
        Assert.Equal(50, s.Observed["session"].UsedPercentage);
    }

    [Fact]
    public void New_window_replaces_reading()
    {
        var s = new State();
        StatusLine.Merge(s, new() { ["session"] = new Observation { UsedPercentage = 90, ResetsAt = T0.AddHours(1), ObservedAt = T0 } }, T0);
        StatusLine.Merge(s, new() { ["session"] = new Observation { UsedPercentage = 2, ResetsAt = T0.AddHours(6), ObservedAt = T0.AddMinutes(1) } }, T0.AddMinutes(1));
        Assert.Equal(2, s.Observed["session"].UsedPercentage);
    }

    [Fact]
    public void Formats_with_and_without_colour()
    {
        var v = new LimitsView { Limits = [new() { Id = "session", Percent = 42 }, new() { Id = "weekly_all", Percent = 96 }] };
        Assert.Equal("5h 42% · 7d 96%", StatusLine.Format(v, new Config(), color: false));
        Assert.Equal("5h 42% · \u001b[31m7d 96%\u001b[0m", StatusLine.Format(v, new Config(), color: true));
        Assert.Null(StatusLine.Format(new LimitsView(), new Config(), false));
    }

    [Fact]
    public void Render_round_trips_through_the_state_file()
    {
        using var d = new TempDir();
        var store = new StateStore(d.File("state.json"));
        var line = UsageBar.Cli.StatusLineCommand.Render(
            """{"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1789412400}}}""", store, new Config(), T0, color: false);
        Assert.Equal("5h 12%", line);
        Assert.Equal(12, store.Load().Observed["session"].UsedPercentage);
    }
}

public class ScheduleTests
{
    static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-09-13T15:00:00Z");

    [Fact]
    public void Default_is_five_minutes_and_never_under_two()
    {
        var s = new State { Poll = { LastAttemptAt = T0 } };
        Assert.Equal(T0.AddMinutes(5), Schedule.NextDue(s, new Config(), T0));
        Assert.Equal(T0.AddMinutes(2), Schedule.NextDue(s, new Config { PollIntervalSeconds = 10 }.Sanitized(), T0));
    }

    [Fact]
    public void Fresh_feed_slows_polling_to_hourly()
    {
        var s = new State { Upstream = new UpstreamSnapshot { FetchedAt = T0 }, Poll = { LastAttemptAt = T0 } };
        foreach (var id in new[] { "session", "weekly_all" })
            s.Observed[id] = new Observation { UsedPercentage = 1, ResetsAt = T0.AddHours(4), ObservedAt = T0 };
        Assert.Equal(T0.AddHours(1), Schedule.NextDue(s, new Config(), T0.AddMinutes(1)));
    }

    [Fact]
    public void Backoff_wins()
    {
        var s = new State { Poll = { LastAttemptAt = T0, NextAllowedAt = T0.AddMinutes(50) } };
        Assert.Equal(T0.AddMinutes(50), Schedule.NextDue(s, new Config(), T0));
    }
}

public class AlertTests
{
    static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-09-13T15:00:00Z");

    static LimitsView View(int pct, DateTimeOffset resets) =>
        new() { Limits = [new LimitRow { Id = "session", Kind = "session", Percent = pct, Severity = "normal", ResetsAt = resets }] };

    [Fact]
    public void Each_crossing_fires_once_per_window_then_reset_fires()
    {
        var st = new AlertState();
        var cfg = new Config();
        var w1 = T0.AddHours(2);
        Assert.Empty(Alerts.Evaluate(st, View(50, w1), cfg, T0));
        Assert.Equal(LimitStatus.Warn, Assert.Single(Alerts.Evaluate(st, View(81, w1), cfg, T0)).Level);
        Assert.Empty(Alerts.Evaluate(st, View(85, w1), cfg, T0));
        Assert.Equal(LimitStatus.Critical, Assert.Single(Alerts.Evaluate(st, View(96, w1), cfg, T0)).Level);
        Assert.Empty(Alerts.Evaluate(st, View(97, w1), cfg, T0));

        var reset = Assert.Single(Alerts.Evaluate(st, View(97, w1), cfg, w1.AddMinutes(1)));
        Assert.True(reset.IsReset);
        // new window arrives: no duplicate reset notice, and counting starts over
        Assert.Empty(Alerts.Evaluate(st, View(3, w1.AddHours(5)), cfg, w1.AddMinutes(2)));
        Assert.Single(Alerts.Evaluate(st, View(82, w1.AddHours(5)), cfg, w1.AddHours(1)));
    }

    [Fact]
    public void No_reset_notice_for_a_quiet_window()
    {
        var st = new AlertState();
        var w1 = T0.AddHours(2);
        Alerts.Evaluate(st, View(20, w1), new Config(), T0);
        Assert.Empty(Alerts.Evaluate(st, View(20, w1), new Config(), w1.AddMinutes(1)));
    }
}
