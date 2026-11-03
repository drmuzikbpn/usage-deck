// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * `claude-usage mcp` — the stdio MCP server (§7.2).
 *
 * Every tool is a thin proxy over the local daemon's HTTP API with a 2 s timeout.
 *
 * Two rules this file exists to keep:
 * 1. **stdout is JSON-RPC only.** Nothing here writes to stdout; diagnostics go to
 *    stderr through `deps.log`. A stray `console.log` corrupts the protocol stream.
 * 2. **Read-only.** `pause` / `resume` are deliberately *not* exposed as tools —
 *    remote control of sessions stays out of model reach by design (§18).
 *
 * Tools are registered against the low-level `Server` with literal JSON Schema rather
 * than `McpServer.registerTool`, which in SDK 1.30 only accepts Zod schemas. Zod is not
 * a declared dependency of this package and the dependency surface is deliberately
 * frozen at `@modelcontextprotocol/sdk` (see CLAUDE.md), so JSON Schema it is.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DaemonClient, DaemonUnreachable } from './clients/http.js';
import { resolveConfigDir } from './config.js';
import type { LimitStatus } from './limits/status.js';
import type { NormalizedLimit } from './limits/types.js';
import { TOKENS_GROUP_BY } from './server/types.js';
import { getVersion } from './version.js';

/** §7.2's exact wording — hooks, CLI and MCP all say the same thing. */
export const DAEMON_DOWN_TEXT = 'claude-usage daemon not running — run `claude-usage status`';

/** §7.2: every proxied call gets 2 s, so a wedged daemon never stalls a session. */
export const MCP_TIMEOUT_MS = 2_000;

export const MCP_SERVER_NAME = 'claude-usage';

/** The subset of `DaemonClient` the tools use; tests substitute their own. */
export interface UsageHttpClient {
  get(path: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  post(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export interface McpDeps {
  client: UsageHttpClient;
  now?: () => number;
  /** Diagnostics sink. Defaults to stderr — *never* stdout. */
  log?: (text: string) => void;
}

// --- result helpers ----------------------------------------------------------

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/**
 * One text block: a human-readable headline on the first line, the raw JSON body on
 * the second. A model can read the headline without parsing, or `JSON.parse` line 2.
 */
function payloadResult(headline: string, body: unknown): CallToolResult {
  return textResult(`${headline}\n${JSON.stringify(body)}`);
}

/** `/v1/limits` and `POST /v1/refresh` include the upstream `raw` blob; tools never ship it. */
function withoutRaw(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete out['raw'];
  return out;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function count(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

// --- headlines ---------------------------------------------------------------

/** `weekly_all` is the whole-account weekly bucket; "weekly" reads better in one line. */
const LIMIT_LABELS: Readonly<Record<string, string>> = { weekly_all: 'weekly' };

function limitPart(limit: NormalizedLimit): string {
  const label = LIMIT_LABELS[limit.id] ?? limit.id;
  return `${label} ${limit.percent === null ? '?' : String(limit.percent)}%`;
}

/** e.g. `session 34% · weekly 29% · status ok`. */
function limitsHeadline(body: unknown, overall?: LimitStatus | null, prefix?: string): string {
  const rec = record(body);
  const limits = array(rec['limits']).filter((l): l is NormalizedLimit => typeof l === 'object' && l !== null);
  const parts: string[] = prefix === undefined ? [] : [prefix];
  // §23.68: a plan with no 5-hour window says so, so its absence does not read as missing data.
  if (rec['noSessionLimit'] === true && !limits.some((l) => l.id === 'session')) parts.push('session none on this plan');
  if (limits.length === 0) parts.push('no limits data yet');
  else parts.push(...limits.map(limitPart));
  if (overall !== undefined && overall !== null) parts.push(`status ${overall}`);
  // §23.36: say when the headline numbers came from Claude Code rather than Anthropic.
  const observedAt = limits
    .filter((l) => l.source === 'statusline')
    .map((l) => l.asOf)
    .filter((at): at is string => typeof at === 'string')
    .sort()
    .at(-1);
  const live = observedAt === undefined ? null : utcMinute(observedAt);
  if (live !== null) parts.push(`live from Claude Code as of ${live}`);
  if (rec['stale'] === true) parts.push('stale');
  const error = record(rec['error']);
  if (error['code'] === 'rate_limited') parts.push(...rateLimitedParts(error, rec['fetchedAt'], live !== null));
  else if (typeof error['code'] === 'string') parts.push(`error ${error['code']}`);
  return parts.join(' · ');
}

/** `2026-09-25T23:18:40.000Z` → `2026-09-25 23:18 UTC`; anything else → null. */
function utcMinute(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** §23.32: an upstream 429 says until when, and how old the numbers being served are. */
function rateLimitedParts(error: Record<string, unknown>, fetchedAt: unknown, mixed: boolean): string[] {
  const until = utcMinute(error['retryAt']);
  const from = utcMinute(fetchedAt);
  const parts = [`rate-limited by Anthropic (HTTP 429)${until === null ? '' : ` until ${until}`}`];
  if (from !== null) parts.push(`${mixed ? 'Anthropic numbers' : 'numbers'} from ${from}`);
  return parts;
}

function summaryHeadline(body: unknown): string {
  const rec = record(body);
  const status = record(rec['status'])['overall'];
  const headline = limitsHeadline(rec['limits'], typeof status === 'string' ? (status as LimitStatus) : null);
  const today = record(rec['today']);
  const todayPart =
    today['ready'] === true
      ? `today ${count(today['messages'])} msgs, in ${count(today['input'])} / out ${count(today['output'])}`
      : 'today scanning transcripts…';
  return `${headline} · ${todayPart}`;
}

function tokensHeadline(body: unknown): string {
  const rec = record(body);
  if (rec['ready'] !== true) return 'token scan still running — totals are not final yet';
  const totals = record(rec['totals']);
  const groups = array(rec['groups']).length;
  return (
    `since ${String(rec['since'])} by ${String(rec['groupBy'])} · ` +
    `in ${count(totals['input'])} / out ${count(totals['output'])} · ` +
    `${count(totals['messages'])} msgs · ${String(groups)} group(s)`
  );
}

function sessionsHeadline(body: unknown): string {
  const rec = record(body);
  const sessions = array(rec['sessions']).map(record);
  const alive = sessions.filter((s) => s['alive'] === true).length;
  const paused = sessions.filter((s) => s['pause'] !== null && s['pause'] !== undefined).length;
  return `${String(sessions.length)} session(s) · ${String(alive)} alive · ${String(paused)} paused · rev ${String(rec['rev'] ?? 0)}`;
}

// --- error mapping -----------------------------------------------------------

/**
 * `DaemonClient` reports both transport failures and HTTP error responses as
 * `DaemonUnreachable`, so the two are told apart by `cause`: a transport failure (or
 * a missing `daemon.json`, which has no cause at all) carries the underlying `Error`,
 * while an HTTP error carries the parsed JSON envelope — or `null` for a body that
 * was not JSON.
 */
function isDaemonDown(err: unknown): boolean {
  if (!(err instanceof DaemonUnreachable)) return false;
  const cause: unknown = (err as Error).cause;
  return cause === undefined || cause instanceof Error;
}

interface ErrorEnvelope {
  code?: string;
  message?: string;
  hint?: string;
}

/** The `{ error: { code, message } }` envelope of an HTTP failure, when there was one. */
function errorEnvelopeOf(err: unknown): ErrorEnvelope | null {
  if (!(err instanceof DaemonUnreachable)) return null;
  const cause: unknown = (err as Error).cause;
  if (cause === undefined || cause instanceof Error) return null;
  const envelope = record(cause)['error'];
  return typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope) ? (envelope as ErrorEnvelope) : null;
}

function failure(err: unknown): CallToolResult {
  if (isDaemonDown(err)) return textResult(DAEMON_DOWN_TEXT, true);
  const envelope = errorEnvelopeOf(err);
  if (envelope === null) {
    return textResult(`claude-usage: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  const hint = typeof envelope.hint === 'string' ? ` (${envelope.hint})` : '';
  return textResult(`claude-usage: ${envelope.code ?? 'error'} — ${envelope.message ?? 'request failed'}${hint}`, true);
}

// --- tools -------------------------------------------------------------------

const NO_ARGS: Tool['inputSchema'] = { type: 'object', properties: {}, additionalProperties: false };

const RESETS_NOTE = '`resetsAt` may be null — render "resets: unknown" rather than guessing.';

interface ToolDef {
  readonly tool: Tool;
  run(args: Record<string, unknown>, deps: Required<Pick<McpDeps, 'client'>>): Promise<CallToolResult>;
}

const TOOL_DEFS: readonly ToolDef[] = [
  {
    tool: {
      name: 'get_limits',
      title: 'Account rate limits',
      description:
        "The Claude account's current rate-limit utilization, read from the local daemon's cached copy " +
        'of the Anthropic usage endpoint (no network call is made by this tool). Each entry of `limits[]` ' +
        'has `percent` — an integer 0–100 of that window consumed, where 100 means the window is used up ' +
        'and requests in it will be refused — plus `severity` reported upstream and `resetsAt`, the ' +
        'instant the window rolls over. ' +
        RESETS_NOTE +
        ' `id` is `session` for the rolling session window, `weekly_all` for the whole account week, and ' +
        '`weekly_scoped:<model>` for a per-model week. `noSessionLimit: true` means the plan has no ' +
        'rolling session window at all (only weeks), not that its reading is missing. `stale: true` means the last refresh failed and ' +
        'these numbers are from an earlier successful one. Cheap; safe to call often.',
      inputSchema: NO_ARGS,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async run(_args, { client }) {
      const body = withoutRaw(await client.get('/v1/limits', { timeoutMs: MCP_TIMEOUT_MS }));
      return payloadResult(limitsHeadline(body), body);
    },
  },
  {
    tool: {
      name: 'get_summary',
      title: 'Limits, status and today’s tokens',
      description:
        'One call for "how close is this account to its limits, and what has this machine spent today". ' +
        'Returns `limits` (as `get_limits`), `status` — `ok` / `warn` / `critical` per limit id plus an ' +
        '`overall`, evaluated against the user\'s configured `thresholds` — and `today`, machine-wide ' +
        'token counts since UTC midnight. `today.ready: false` means the transcript scan is still ' +
        'running and the counts are not final. ' +
        RESETS_NOTE +
        ' Prefer this over calling `get_limits` and `get_tokens` separately.',
      inputSchema: NO_ARGS,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async run(_args, { client }) {
      const body = await client.get('/v1/summary', { timeoutMs: MCP_TIMEOUT_MS });
      return payloadResult(summaryHeadline(body), body);
    },
  },
  {
    tool: {
      name: 'get_tokens',
      title: 'Local token spend',
      description:
        'Token counts aggregated from the local Claude Code transcripts on this machine. These are ' +
        '*tokens*, not dollars and not rate-limit percentages — use `get_limits` for how close the ' +
        'account is to being throttled. Totals and each group carry `input`, `output`, `cacheCreate`, ' +
        '`cacheRead` and `messages`. `ready: false` means the initial scan is still running, so the ' +
        'numbers will grow; `stale: true` means the index is behind the transcripts on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description:
              'Lower bound. `today` (UTC midnight, the default), `all`, a relative window like `24h`, ' +
              '`7d` or `30m`, or an ISO-8601 instant.',
          },
          groupBy: {
            type: 'string',
            enum: [...TOKENS_GROUP_BY],
            description: 'How to bucket the groups. Defaults to `project`.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async run(args, { client }) {
      const params = new URLSearchParams();
      if (typeof args['since'] === 'string') params.set('since', args['since']);
      if (typeof args['groupBy'] === 'string') params.set('groupBy', args['groupBy']);
      const qs = params.toString();
      const body = await client.get(`/v1/tokens${qs.length === 0 ? '' : `?${qs}`}`, { timeoutMs: MCP_TIMEOUT_MS });
      return payloadResult(tokensHeadline(body), body);
    },
  },
  {
    tool: {
      name: 'get_sessions',
      title: 'Live Claude Code sessions',
      description:
        'The Claude Code sessions this machine knows about: project and worktree, pid, whether the ' +
        'process is still `alive`, the model, per-session token counts, and `pause` (null unless the ' +
        'session is paused from the dashboard or CLI). `discovered: "transcript"` means the session was ' +
        'recovered from a transcript file rather than a hook, so `pid` is null. Read-only on purpose: ' +
        'there is no tool here to pause, resume or freeze a session — that control belongs to the user, ' +
        'through `claude-usage pause` / `resume` or the dashboard, and is not exposed to models.',
      inputSchema: NO_ARGS,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async run(_args, { client }) {
      const body = await client.get('/v1/sessions', { timeoutMs: MCP_TIMEOUT_MS });
      return payloadResult(sessionsHeadline(body), body);
    },
  },
  {
    tool: {
      name: 'refresh_limits',
      title: 'Force a limits refetch',
      description:
        'Forces the daemon to refetch the rate limits from Anthropic right now and returns the fresh ' +
        'body, same shape as `get_limits`. The daemon already polls on its own, so only use this when ' +
        'the cached numbers are known to be stale — for example straight after a long burst of work. ' +
        'Anthropic rate-limits the usage endpoint, so a refresh within a minute of the last fetch returns the *current* ' +
        'limits with a note on the first line instead of an error. ' +
        RESETS_NOTE,
      inputSchema: NO_ARGS,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async run(_args, { client }) {
      try {
        const body = withoutRaw(await client.post('/v1/refresh', undefined, { timeoutMs: MCP_TIMEOUT_MS }));
        return payloadResult(limitsHeadline(body), body);
      } catch (err) {
        if (errorEnvelopeOf(err)?.code !== 'rate_limited') throw err;
        const body = withoutRaw(await client.get('/v1/limits', { timeoutMs: MCP_TIMEOUT_MS }));
        return payloadResult(limitsHeadline(body, null, 'refresh skipped (fetched under a minute ago) — current limits'), body);
      }
    },
  },
];

/** The five tools, in listing order. */
export const MCP_TOOLS: readonly Tool[] = TOOL_DEFS.map((d) => d.tool);

export const MCP_INSTRUCTIONS =
  'Usage telemetry for this machine: how close the Claude account is to its rate limits (`get_limits`, ' +
  '`get_summary`, `refresh_limits`) and how many tokens local Claude Code sessions have spent ' +
  '(`get_tokens`, `get_sessions`). Every tool returns a one-line human-readable summary followed by the ' +
  'raw JSON body. All read-only; nothing here changes the user\'s sessions.';

export interface UsageMcpServer {
  readonly server: Server;
  readonly tools: readonly Tool[];
  /** Direct handler access, so tests need no transport. */
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** Build the MCP server over `deps.client`. Nothing is connected until `connect`. */
export function createMcpServer(deps: McpDeps): UsageMcpServer {
  const log = deps.log ?? ((text: string) => process.stderr.write(text));
  const toolDeps = { client: deps.client };
  const byName = new Map(TOOL_DEFS.map((d) => [d.tool.name, d]));

  const server = new Server(
    { name: MCP_SERVER_NAME, version: getVersion() },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const def = byName.get(name);
    if (def === undefined) return textResult(`claude-usage: unknown tool "${name}"`, true);
    try {
      return await def.run(args, toolDeps);
    } catch (err) {
      // Diagnostics on stderr only; the model gets the mapped text result.
      log(`claude-usage mcp: ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return failure(err);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...MCP_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}),
  );

  return {
    server,
    tools: MCP_TOOLS,
    callTool,
    connect: (transport) => server.connect(transport),
    close: () => server.close(),
  };
}

export interface McpIo {
  configDir?: string;
  /** Defaults to stderr. Never stdout — that stream belongs to JSON-RPC. */
  stderr?: (text: string) => void;
  client?: UsageHttpClient;
  /** Defaults to stdio; tests pass an in-memory pair. */
  transport?: Transport;
}

/**
 * `claude-usage mcp`. Resolves once the transport closes (the client went away, or the
 * parent process closed stdin), which is the CLI's cue to exit 0.
 */
export async function runMcp(io: McpIo = {}): Promise<number> {
  const log = io.stderr ?? ((text: string) => process.stderr.write(text));
  const configDir = io.configDir ?? resolveConfigDir();

  let client = io.client;
  if (client === undefined) {
    // Every request needs the bearer (§23.55); `DaemonClient` reads it from config.json.
    client = new DaemonClient({ configDir, timeoutMs: MCP_TIMEOUT_MS });
  }

  const mcp = createMcpServer({ client, log });
  const transport = io.transport ?? new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    mcp.server.onclose = resolve;
  });
  await mcp.connect(transport);
  await closed;
  return 0;
}
