// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace UsageBar.Core;

public sealed class UsageApiException(string code, string message, int? status = null, TimeSpan? retryAfter = null, string? hint = null)
    : Exception(message)
{
    public string Code { get; } = code;
    public int? Status { get; } = status;
    public TimeSpan? RetryAfter { get; } = retryAfter;
    public string? Hint { get; } = hint;
}

/// <summary>
/// <c>GET https://api.anthropic.com/api/oauth/usage</c> — the only Anthropic endpoint usagebar
/// calls, read-only. We never refresh tokens.
/// </summary>
public static class UsageClient
{
    public const string Endpoint = "https://api.anthropic.com/api/oauth/usage";
    /// <summary>The literal beta header Claude Code sends to this endpoint.</summary>
    public const string BetaHeader = "oauth-2025-04-20";
    /// <summary>The real body is a few hundred bytes; anything far larger is not it.</summary>
    public const int MaxResponseBytes = 256 * 1024;

    public static string Version { get; } =
        typeof(UsageClient).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0]
        ?? "0.0.0";

    /// <summary>Our own identity — not .NET's default, not Claude Code's.</summary>
    public static string UserAgent => $"usagebar/{Version}";

    public static HttpClient CreateHttpClient(HttpMessageHandler? handler = null)
    {
        var http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        http.Timeout = TimeSpan.FromSeconds(15);
        return http;
    }

    public static async Task<JsonObject> FetchAsync(HttpClient http, string token, DateTimeOffset now, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, Endpoint);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.TryAddWithoutValidation("anthropic-beta", BetaHeader);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        req.Headers.TryAddWithoutValidation("User-Agent", UserAgent);

        HttpResponseMessage res;
        try { res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw new UsageApiException("network", $"usage request failed: {e.GetType().Name}");
        }

        using (res)
        {
            var status = (int)res.StatusCode;
            if (res.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new UsageApiException("unauthorized", $"usage request rejected with {status}", status, hint: "open Claude Code to sign in again");
            if (status == 429)
                throw new UsageApiException("rate_limited", "usage request returned HTTP 429", 429, ParseRetryAfter(res.Headers.RetryAfter, now));
            if (!res.IsSuccessStatusCode)
                throw new UsageApiException("network", $"usage request returned HTTP {status}", status);

            if (res.Content.Headers.ContentLength is long len && len > MaxResponseBytes)
                throw new UsageApiException("schema_drift", $"usage response declares {len} bytes, over the cap");

            byte[] body;
            try
            {
                await using var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                using var ms = new MemoryStream();
                var buf = new byte[16 * 1024];
                int n;
                while ((n = await stream.ReadAsync(buf, ct).ConfigureAwait(false)) > 0)
                {
                    ms.Write(buf, 0, n);
                    if (ms.Length > MaxResponseBytes) throw new UsageApiException("schema_drift", "usage response is over the cap");
                }
                body = ms.ToArray();
            }
            catch (Exception e) when (e is IOException or HttpRequestException or TaskCanceledException)
            {
                throw new UsageApiException("network", $"could not read usage response: {e.GetType().Name}");
            }

            JsonNode? parsed;
            try { parsed = JsonNode.Parse(body); }
            catch (JsonException e) { throw new UsageApiException("schema_drift", $"usage response was not valid JSON (byte {e.BytePositionInLine})"); }
            if (parsed is not JsonObject obj) throw new UsageApiException("schema_drift", "usage response was not a JSON object");
            if (obj["limits"] is not JsonArray) throw new UsageApiException("schema_drift", "usage response has no \"limits\" array");
            return obj;
        }
    }

    public static TimeSpan? ParseRetryAfter(RetryConditionHeaderValue? h, DateTimeOffset now)
    {
        if (h is null) return null;
        if (h.Delta is { } d) return d < TimeSpan.Zero ? TimeSpan.Zero : d;
        if (h.Date is { } at) return at > now ? at - now : TimeSpan.Zero;
        return null;
    }
}
