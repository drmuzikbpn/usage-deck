// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
namespace UsageBar.Core;

public enum FetchResult { Fetched, Failed, SkippedTooSoon, SkippedBackoff, SkippedBusy }

public sealed record FetchOutcome(FetchResult Result, ErrorInfo? Error = null, DateTimeOffset? NotBefore = null)
{
    public string Describe() => Result switch
    {
        FetchResult.Fetched => "fetched from Anthropic",
        FetchResult.SkippedTooSoon => $"refresh skipped (Anthropic was asked under {Schedule.ManualMinIntervalSeconds} s ago) — current limits",
        FetchResult.SkippedBackoff => $"refresh skipped (backing off until {NotBefore:HH:mm} UTC{(Error?.Code == "rate_limited" ? ", Anthropic rate-limited us" : "")}) — current limits",
        FetchResult.SkippedBusy => "refresh already in progress in another process — current limits",
        _ => $"refresh failed: {Error?.Code} — {Error?.Message}",
    };
}

/// <summary>
/// One guarded call to Anthropic. Any process may run it (the tray on its schedule, the MCP
/// server's refresh tool); a named mutex keeps it to one at a time machine-wide, and the backoff
/// state lives in the shared state file so every process honours it.
/// </summary>
public sealed class Fetcher(StateStore store, TokenReader tokens, HttpClient http, Func<DateTimeOffset>? now = null)
{
    readonly Func<DateTimeOffset> _now = now ?? (() => DateTimeOffset.UtcNow);

    public async Task<FetchOutcome> FetchAsync(bool manual, CancellationToken ct = default)
    {
        // A file lock, not a Mutex: a Mutex must be released by the thread that took it, and the
        // await below may resume elsewhere. The OS drops the lock if this process dies.
        FileStream? lockFile;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(store.FetchLockPath)!);
            lockFile = new FileStream(store.FetchLockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException) { return new FetchOutcome(FetchResult.SkippedBusy); }

        using (lockFile)
        {
            var t = _now();
            var s = store.Load();
            if (s.Poll.NextAllowedAt is { } na && na > t)
                return new FetchOutcome(FetchResult.SkippedBackoff, s.Poll.LastError, na);
            if (manual && s.Poll.LastAttemptAt is { } la && t - la < TimeSpan.FromSeconds(Schedule.ManualMinIntervalSeconds))
                return new FetchOutcome(FetchResult.SkippedTooSoon, s.Poll.LastError, la.AddSeconds(Schedule.ManualMinIntervalSeconds));

            try
            {
                var payload = await CallAsync(t, ct).ConfigureAwait(false);
                var snap = Normalize.FromPayload(payload, t);
                store.Update(st =>
                {
                    st.Upstream = snap;
                    var p = st.Poll;
                    p.LastAttemptAt = t;
                    p.LastSuccessAt = t;
                    p.LastError = null;
                    p.ConsecutiveFailures = 0;
                    p.NextAllowedAt = null;
                    p.SuccessesSinceSlowdown++;
                    if (p.AdaptiveIntervalSeconds > Schedule.DefaultIntervalSeconds && p.SuccessesSinceSlowdown >= Schedule.RelaxAfterSuccesses)
                    {
                        p.AdaptiveIntervalSeconds = Math.Max(Schedule.DefaultIntervalSeconds, p.AdaptiveIntervalSeconds / 2);
                        p.SuccessesSinceSlowdown = 0;
                    }
                    return true;
                });
                Log.Write($"fetch: ok ({snap.Limits.Count} limits){(manual ? " [manual]" : "")}");
                return new FetchOutcome(FetchResult.Fetched);
            }
            catch (Exception e) when (e is UsageApiException or CredentialsException)
            {
                var err = Record(e, t);
                Log.Write($"fetch: {err.Code} — {err.Message}");
                return new FetchOutcome(FetchResult.Failed, err, store.Load().Poll.NextAllowedAt);
            }
        }
    }

    async Task<System.Text.Json.Nodes.JsonObject> CallAsync(DateTimeOffset t, CancellationToken ct)
    {
        var token = tokens.Get();
        if (token.ExpiresAt is { } exp && exp <= t)
        {
            // Claude Code refreshes the token when it next runs; re-read in case it already did.
            token = tokens.Get(fresh: true);
            if (token.ExpiresAt is { } exp2 && exp2 <= t)
                throw new UsageApiException("token_expired", "the Claude Code sign-in has expired", hint: "open Claude Code — it refreshes the sign-in on its own");
        }
        try
        {
            return await UsageClient.FetchAsync(http, token.AccessToken, t, ct).ConfigureAwait(false);
        }
        catch (UsageApiException e) when (e.Code == "unauthorized")
        {
            // Once: Claude Code may have rotated the token since we cached it.
            var again = tokens.Get(fresh: true);
            if (again.AccessToken == token.AccessToken) throw;
            return await UsageClient.FetchAsync(http, again.AccessToken, t, ct).ConfigureAwait(false);
        }
    }

    ErrorInfo Record(Exception e, DateTimeOffset t)
    {
        ErrorInfo err = e switch
        {
            UsageApiException u => new ErrorInfo { Code = u.Code, Message = u.Message, Hint = u.Hint },
            CredentialsException c => new ErrorInfo { Code = "no_credentials", Message = c.Message, Hint = c.Hint },
            _ => new ErrorInfo { Code = "network", Message = e.GetType().Name },
        };
        store.Update(st =>
        {
            var p = st.Poll;
            p.LastAttemptAt = t;
            p.ConsecutiveFailures++;
            switch (err.Code)
            {
                case "rate_limited":
                    p.AdaptiveIntervalSeconds = Math.Min(Schedule.MaxAdaptiveIntervalSeconds, Math.Max(p.AdaptiveIntervalSeconds, Schedule.DefaultIntervalSeconds) * 2);
                    p.SuccessesSinceSlowdown = 0;
                    var wait = (e as UsageApiException)?.RetryAfter ?? TimeSpan.FromSeconds(p.AdaptiveIntervalSeconds);
                    if (wait > Schedule.MaxRetryAfter) wait = Schedule.MaxRetryAfter;
                    p.NextAllowedAt = t + wait;
                    err.RetryAt = p.NextAllowedAt;
                    break;
                case "unauthorized" or "token_expired" or "no_credentials":
                    p.NextAllowedAt = t + TimeSpan.FromSeconds(Schedule.MaxBackoffSeconds);
                    break;
                default:
                    p.NextAllowedAt = t + Schedule.ErrorBackoff(p.ConsecutiveFailures);
                    break;
            }
            p.LastError = err;
            return true;
        });
        return err;
    }
}
