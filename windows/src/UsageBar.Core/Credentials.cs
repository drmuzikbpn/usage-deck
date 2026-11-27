// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Text.Json;

namespace UsageBar.Core;

/// <summary>
/// The Claude Code OAuth token. <see cref="AccessToken"/> is a credential: never log it, never
/// put it in an exception message, never serialize it. <see cref="ToString"/> is redacted.
/// </summary>
public sealed class OAuthToken(string accessToken, DateTimeOffset? expiresAt, string? subscriptionType)
{
    public string AccessToken { get; } = accessToken;
    public DateTimeOffset? ExpiresAt { get; } = expiresAt;
    public string? SubscriptionType { get; } = subscriptionType;
    public override string ToString() => $"OAuthToken(redacted, expires {ExpiresAt:O})";
}

public sealed class CredentialsException(string message, string hint = "open Claude Code and sign in")
    : Exception(message)
{
    public string Hint { get; } = hint;
}

public static class Credentials
{
    /// <summary>
    /// Read <c>claudeAiOauth</c> from Claude Code's credentials file. On Windows this is the same
    /// file and shape the upstream Linux path reads. We never refresh tokens — Claude Code owns that.
    /// </summary>
    public static OAuthToken Read(string? path = null)
    {
        path ??= Paths.CredentialsPath;
        string text;
        try
        {
            // FileShare.ReadWrite|Delete: Claude Code may be rewriting it while we read.
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var sr = new StreamReader(fs);
            text = sr.ReadToEnd();
        }
        catch (FileNotFoundException) { throw new CredentialsException($"{path} does not exist"); }
        catch (DirectoryNotFoundException) { throw new CredentialsException($"{path} does not exist"); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new CredentialsException($"cannot read {path}: {e.GetType().Name}");
        }
        return Parse(text, path);
    }

    public static OAuthToken Parse(string text, string source)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(text); }
        catch (JsonException e) { throw new CredentialsException($"{source} is not valid JSON (line {e.LineNumber}, byte {e.BytePositionInLine})"); }
        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object ||
                !doc.RootElement.TryGetProperty("claudeAiOauth", out var oauth) ||
                oauth.ValueKind != JsonValueKind.Object)
                throw new CredentialsException($"{source} has no \"claudeAiOauth\" object");

            if (!oauth.TryGetProperty("accessToken", out var tok) || tok.ValueKind != JsonValueKind.String ||
                string.IsNullOrEmpty(tok.GetString()))
                throw new CredentialsException($"{source} has no \"claudeAiOauth.accessToken\"");

            DateTimeOffset? expires = null;
            if (oauth.TryGetProperty("expiresAt", out var exp) && exp.ValueKind == JsonValueKind.Number && exp.TryGetInt64(out var ms))
                expires = ms > 100_000_000_000 ? DateTimeOffset.FromUnixTimeMilliseconds(ms) : DateTimeOffset.FromUnixTimeSeconds(ms);

            string? sub = oauth.TryGetProperty("subscriptionType", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
            return new OAuthToken(tok.GetString()!, expires, sub);
        }
    }
}

/// <summary>
/// Cached token reader. Re-reads after <see cref="Ttl"/> (an account switch keeps the old token
/// valid, so caching forever would silently report the wrong account), or when asked for a
/// fresh read (the once-after-401 retry).
/// </summary>
public sealed class TokenReader(string? path = null, Func<DateTimeOffset>? now = null)
{
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    readonly Func<DateTimeOffset> _now = now ?? (() => DateTimeOffset.UtcNow);
    OAuthToken? _cached;
    DateTimeOffset _readAt;

    public OAuthToken Get(bool fresh = false)
    {
        var t = _now();
        if (!fresh && _cached is not null && t - _readAt < Ttl) return _cached;
        _cached = Credentials.Read(path);
        _readAt = t;
        return _cached;
    }
}
