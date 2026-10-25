// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * `claude-usage observe` (§23.36): forward Claude Code's statusline `rate_limits` to the daemon.
 *
 * Claude Code passes its statusline command a JSON render payload on stdin, including the
 * 5-hour and 7-day utilisation it read from its own model responses' headers. Piping that
 * payload here lets the daemon serve live headline numbers without spending the usage
 * endpoint's tiny budget. Like a hook, this never prints and always exits 0.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from './clients/http.js';
import { loadConfig, resolveConfigDir, writeJsonFile } from './config.js';
import { OBSERVE_PATH } from './limits/types.js';
import { isSessionId } from './sessions/validate.js';

export { OBSERVE_PATH };

/** The statusline renders often; an unchanged payload is not re-sent inside this window. */
export const OBSERVE_DEDUPE_MS = 60_000;
/** Same budget as the statusline itself: a render must never wait on us. */
export const OBSERVE_TIMEOUT_MS = 400;
const OBSERVE_STATE_FILE = 'observe-last.json';

export type ObservePost = (path: string, body: unknown, token: string) => Promise<void>;

export interface ObserveIO {
  stdin?: string;
  configDir?: string;
  now?: () => number;
  /** Injectable transport (tests); defaults to a `DaemonClient` POST. */
  post?: ObservePost;
}

function lastSent(configDir: string): { sentAt: number; payload: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, OBSERVE_STATE_FILE), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    return typeof rec['sentAt'] === 'number' && typeof rec['payload'] === 'string'
      ? { sentAt: rec['sentAt'], payload: rec['payload'] }
      : null;
  } catch {
    return null;
  }
}

export async function runObserve(io: ObserveIO = {}): Promise<number> {
  const configDir = io.configDir ?? resolveConfigDir();
  const now = io.now ?? Date.now;
  try {
    const parsed = JSON.parse(io.stdin ?? '') as unknown;
    if (typeof parsed !== 'object' || parsed === null) return 0;
    const limits = (parsed as Record<string, unknown>)['rate_limits'];
    // API-key sessions have no rate_limits at all; nothing to forward.
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return 0;

    // §23.64: the session id lets the daemon tell a live session's genuine drop (a plan
    // change) from an idle one's old numbers. UUIDs only; anything else goes untagged.
    const sessionId = (parsed as Record<string, unknown>)['session_id'];
    const body = isSessionId(sessionId) ? { ...limits, session_id: sessionId } : limits;
    const payload = JSON.stringify(body);
    const previous = lastSent(configDir);
    if (previous !== null && previous.payload === payload && now() - previous.sentAt < OBSERVE_DEDUPE_MS) return 0;

    const token = loadConfig(configDir).auth.token;
    const post: ObservePost =
      io.post ??
      (async (path, body, bearer) => {
        await new DaemonClient({ configDir, token: bearer, timeoutMs: OBSERVE_TIMEOUT_MS }).post(path, body);
      });
    await post(OBSERVE_PATH, body, token);
    // Recorded only after the daemon took it, so a down daemon is retried on the next render.
    writeJsonFile(join(configDir, OBSERVE_STATE_FILE), { sentAt: now(), payload });
  } catch {
    // Never break a statusline render.
  }
  return 0;
}
