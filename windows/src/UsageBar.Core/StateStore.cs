// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace UsageBar.Core;

public static class AtomicFile
{
    /// <summary>Write to a temp file beside the target, then rename over it (atomic on NTFS).</summary>
    public static void WriteAllText(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var tmp = $"{path}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        for (var attempt = 0; ; attempt++)
        {
            try { File.Move(tmp, path, overwrite: true); return; }
            catch (Exception e) when ((e is IOException or UnauthorizedAccessException) && attempt < 20)
            {
                Thread.Sleep(15); // a reader has it open without FILE_SHARE_DELETE; retry briefly
            }
            catch
            {
                try { File.Delete(tmp); } catch { }
                throw;
            }
        }
    }

    public static string? TryReadAllText(string path)
    {
        for (var attempt = 0; attempt < 20; attempt++)
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var sr = new StreamReader(fs, Encoding.UTF8);
                return sr.ReadToEnd();
            }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
            catch (IOException) { Thread.Sleep(15); }
            catch (UnauthorizedAccessException) { Thread.Sleep(15); }
        }
        return null;
    }
}

/// <summary>
/// The shared state file, guarded by a per-user named mutex so the tray, every MCP server and
/// every status-line render can read-modify-write it without clobbering each other.
/// </summary>
public sealed class StateStore
{
    public string Path { get; }
    readonly string _mutexName;

    public StateStore(string? path = null)
    {
        Path = System.IO.Path.GetFullPath(path ?? Paths.StatePath);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.ToLowerInvariant())))[..16];
        _mutexName = $@"Local\usagebar-state-{hash}";
        FetchLockPath = Path + ".fetch.lock";
    }

    /// <summary>Held open exclusively by whichever process is calling upstream, so two never call at once.</summary>
    public string FetchLockPath { get; }

    /// <summary>Lock-free read. A torn or missing file yields an empty state, never an exception.</summary>
    public State Load()
    {
        var text = AtomicFile.TryReadAllText(Path);
        if (text is null) return new State();
        try { return JsonSerializer.Deserialize<State>(text, Json.Options) ?? new State(); }
        catch (JsonException) { return new State(); }
    }

    /// <summary>Locked read-modify-write. <paramref name="mutate"/> returns false to skip the write.</summary>
    public State Update(Func<State, bool> mutate, TimeSpan? timeout = null)
    {
        using var mutex = new Mutex(false, _mutexName);
        var owned = false;
        try
        {
            try { owned = mutex.WaitOne(timeout ?? TimeSpan.FromSeconds(3)); }
            catch (AbandonedMutexException) { owned = true; } // previous holder died; we own it now
            if (!owned) throw new TimeoutException("state file is busy");
            var state = Load();
            if (mutate(state))
                AtomicFile.WriteAllText(Path, JsonSerializer.Serialize(state, Json.Options));
            return state;
        }
        finally
        {
            if (owned) mutex.ReleaseMutex();
        }
    }
}
