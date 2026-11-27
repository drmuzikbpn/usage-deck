// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using UsageBar.Cli;
using UsageBar.Core;

namespace UsageBar.Tests;

public class FetcherTests
{
    static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-09-13T15:00:00Z");

    sealed class Rig : IDisposable
    {
        public readonly TempDir Dir = new();
        public readonly Clock Clock = new(T0);
        public readonly StateStore Store;
        public readonly string CredPath;
        public string Token = Fixtures.FakeToken();

        public Rig(DateTimeOffset? expires = null)
        {
            Store = new StateStore(Dir.File("state.json"));
            CredPath = Dir.File(".credentials.json");
            WriteCreds(expires ?? T0.AddHours(8));
        }

        public void WriteCreds(DateTimeOffset expires) => File.WriteAllText(CredPath, Fixtures.CredentialsJson(Token, expires));

        public (Fetcher, FakeHandler) Make(params Func<HttpRequestMessage, HttpResponseMessage>[] responses)
        {
            var h = new FakeHandler(responses);
            return (new Fetcher(Store, new TokenReader(CredPath, Clock.Get), UsageClient.CreateHttpClient(h), Clock.Get), h);
        }

        public void Dispose() => Dir.Dispose();
    }

    [Fact]
    public async Task Success_writes_snapshot_and_sends_expected_headers()
    {
        using var rig = new Rig();
        var (f, h) = rig.Make(_ => FakeHandler.Ok(Fixtures.Read("usage-live.json")));
        var r = await f.FetchAsync(manual: false);
        Assert.Equal(FetchResult.Fetched, r.Result);
        var req = Assert.Single(h.Requests);
        Assert.Equal(UsageClient.Endpoint, req.RequestUri!.ToString());
        Assert.Equal("Bearer", req.Headers.Authorization!.Scheme);
        Assert.Equal("oauth-2025-04-20", req.Headers.GetValues("anthropic-beta").Single());
        Assert.StartsWith("usagebar/", req.Headers.UserAgent.ToString());
        Assert.Equal(3, rig.Store.Load().Upstream!.Limits.Count);
    }

    [Fact]
    public async Task Http_429_honours_retry_after_and_doubles_interval()
    {
        using var rig = new Rig();
        var (f, h) = rig.Make(_ => FakeHandler.Status(429, TimeSpan.FromMinutes(50)));
        var r = await f.FetchAsync(manual: false);
        Assert.Equal("rate_limited", r.Error!.Code);
        var s = rig.Store.Load();
        Assert.Equal(T0.AddMinutes(50), s.Poll.NextAllowedAt);
        Assert.Equal(600, s.Poll.AdaptiveIntervalSeconds);

        rig.Clock.Now = T0.AddMinutes(10);
        Assert.Equal(FetchResult.SkippedBackoff, (await f.FetchAsync(manual: true)).Result);
        Assert.Single(h.Requests); // nobody called upstream during the backoff
    }

    [Fact]
    public async Task Manual_refresh_within_a_minute_is_served_from_cache()
    {
        using var rig = new Rig();
        var (f, h) = rig.Make(_ => FakeHandler.Ok(Fixtures.Read("usage-live.json")));
        await f.FetchAsync(manual: false);
        rig.Clock.Now = T0.AddSeconds(30);
        Assert.Equal(FetchResult.SkippedTooSoon, (await f.FetchAsync(manual: true)).Result);
        Assert.Single(h.Requests);
    }

    [Fact]
    public async Task Expired_token_is_not_sent()
    {
        using var rig = new Rig(expires: T0.AddMinutes(-1));
        var (f, h) = rig.Make(_ => FakeHandler.Ok("{}"));
        var r = await f.FetchAsync(manual: false);
        Assert.Equal("token_expired", r.Error!.Code);
        Assert.Empty(h.Requests);
    }

    [Fact]
    public async Task Unauthorized_rereads_rotated_token_once()
    {
        using var rig = new Rig();
        var first = rig.Token;
        var (f, h) = rig.Make(
            _ => { rig.Token = Fixtures.FakeToken(); rig.WriteCreds(T0.AddHours(8)); return FakeHandler.Status(401); },
            _ => FakeHandler.Ok(Fixtures.Read("usage-live.json")));
        var r = await f.FetchAsync(manual: false);
        Assert.Equal(FetchResult.Fetched, r.Result);
        Assert.Equal(2, h.Requests.Count);
        Assert.Equal(first, h.Requests[0].Headers.Authorization!.Parameter);
        Assert.Equal(rig.Token, h.Requests[1].Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task Errors_never_contain_the_token()
    {
        using var rig = new Rig();
        var (f, _) = rig.Make(_ => FakeHandler.Status(403));
        var r = await f.FetchAsync(manual: false);
        Assert.Equal("unauthorized", r.Error!.Code);
        Assert.DoesNotContain(rig.Token, File.ReadAllText(rig.Store.Path));
    }

    [Fact]
    public async Task Rejects_non_usage_bodies()
    {
        using var rig = new Rig();
        var (f, _) = rig.Make(_ => FakeHandler.Ok("""{"hello":1}"""));
        Assert.Equal("schema_drift", (await f.FetchAsync(manual: false)).Error!.Code);
    }
}

public class SettingsMergeTests
{
    const string Cmd = "C:/Users/alice/AppData/Local/Programs/usagebar/current/usagebar.exe statusline";

    [Fact]
    public void Adds_only_the_statusLine_key()
    {
        var s = SettingsMerge.ParseOrEmpty("""{"theme":"auto","autoUpdatesChannel":"latest"}""");
        Assert.Equal(StatusLineOutcome.Added, SettingsMerge.Add(s, Cmd));
        Assert.Equal("auto", s["theme"]!.GetValue<string>());
        Assert.Equal(Cmd, s["statusLine"]!["command"]!.GetValue<string>());
        Assert.Equal(StatusLineOutcome.AlreadyOurs, SettingsMerge.Add(s, Cmd));
    }

    [Fact]
    public void Never_replaces_someone_elses_status_line()
    {
        var s = SettingsMerge.ParseOrEmpty("""{"statusLine":{"type":"command","command":"my-script.ps1"}}""");
        Assert.Equal(StatusLineOutcome.OtherExists, SettingsMerge.Add(s, Cmd));
        Assert.Equal(StatusLineOutcome.NotOurs, SettingsMerge.Remove(s));
        Assert.Equal("my-script.ps1", s["statusLine"]!["command"]!.GetValue<string>());
    }

    [Fact]
    public void Removes_ours()
    {
        var s = SettingsMerge.ParseOrEmpty("{\"theme\":\"auto\",\"statusLine\":{\"type\":\"command\",\"command\":\"" + Cmd + "\"}}");
        Assert.Equal(StatusLineOutcome.Removed, SettingsMerge.Remove(s));
        Assert.Null(s["statusLine"]);
        Assert.NotNull(s["theme"]);
    }

    [Theory]
    [InlineData(@"C:\Users\alice\usagebar.exe", "C:/Users/alice/usagebar.exe statusline")]
    [InlineData(@"D:\Program Files\usagebar\usagebar.exe", "\"D:/Program Files/usagebar/usagebar.exe\" statusline")]
    public void Command_is_shell_neutral(string exe, string expected) => Assert.Equal(expected, SettingsMerge.CommandFor(exe));
}
