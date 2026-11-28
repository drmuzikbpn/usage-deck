// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Net;
using System.Text.Json.Nodes;
using UsageBar.Core;

namespace UsageBar.Tests;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "usagebar-test-" + Guid.NewGuid().ToString("N"));
    public TempDir() => Directory.CreateDirectory(Path);
    public string File(string name) => System.IO.Path.Combine(Path, name);
    public void Dispose() { try { Directory.Delete(Path, true); } catch { } }
}

public static class Fixtures
{
    public static string Read(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));
    public static JsonObject Usage() => (JsonObject)JsonNode.Parse(Read("usage-live.json"))!;

    /// <summary>A fake, generated-at-runtime token. Never a real one.</summary>
    public static string FakeToken() => "test-" + Guid.NewGuid().ToString("N");

    public static string CredentialsJson(string token, DateTimeOffset expires) =>
        "{\"claudeAiOauth\":{\"accessToken\":\"" + token + "\",\"refreshToken\":\"r-" + Guid.NewGuid().ToString("N") +
        "\",\"expiresAt\":" + expires.ToUnixTimeMilliseconds() + ",\"subscriptionType\":\"pro\"}}";
}

/// <summary>Scripted HTTP responses; records what was asked.</summary>
public sealed class FakeHandler(params Func<HttpRequestMessage, HttpResponseMessage>[] responses) : HttpMessageHandler
{
    int _i;
    public List<HttpRequestMessage> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Requests.Add(request);
        var f = responses[Math.Min(_i++, responses.Length - 1)];
        return Task.FromResult(f(request));
    }

    public static HttpResponseMessage Ok(string json) =>
        new(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Status(int code, TimeSpan? retryAfter = null)
    {
        var r = new HttpResponseMessage((HttpStatusCode)code) { Content = new StringContent("{}") };
        if (retryAfter is { } ra) r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(ra);
        return r;
    }
}

public sealed class Clock(DateTimeOffset start)
{
    public DateTimeOffset Now { get; set; } = start;
    public DateTimeOffset Get() => Now;
}
