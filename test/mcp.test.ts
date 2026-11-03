// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LATEST_PROTOCOL_VERSION, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from '../src/clients/http.js';
import { saveConfig } from '../src/config.js';
import {
  createMcpServer,
  runMcp,
  DAEMON_DOWN_TEXT,
  MCP_TOOLS,
  type UsageHttpClient,
  type UsageMcpServer,
} from '../src/mcp.js';
import { startFakeDaemon, tempConfigDir, type FakeDaemon } from './helpers/fake-daemon.js';
import { testConfig } from './helpers/fakes.js';

const TOKEN = 'test-bearer-token';

const daemons: FakeDaemon[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const d of daemons.splice(0)) await d.stop();
});

async function daemon(opts: { withSessions?: boolean } = {}): Promise<FakeDaemon> {
  const d = await startFakeDaemon(opts.withSessions === true ? { withSessions: true } : {});
  daemons.push(d);
  return d;
}

/** An MCP server over a real fake daemon; `token: ''` ⇒ an unauthenticated client. */
function mcpFor(d: FakeDaemon, opts: { token?: string } = {}): UsageMcpServer {
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${String(d.port)}`, timeoutMs: 2_000, token: opts.token ?? TOKEN });
  return createMcpServer({ client, log: () => {} });
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  expect(first?.type).toBe('text');
  return String((first as { text: string }).text);
}

function headline(result: CallToolResult): string {
  return text(result).split('\n')[0] ?? '';
}

function body(result: CallToolResult): Record<string, unknown> {
  const lines = text(result).split('\n');
  return JSON.parse(lines.slice(1).join('\n')) as Record<string, unknown>;
}

describe('tool listing', () => {
  it('advertises exactly the five read-mostly tools, in order', async () => {
    const d = await daemon();
    const mcp = mcpFor(d);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    closers.push(async () => {
      await client.close();
      await mcp.close();
    });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((t: Tool) => t.name)).toEqual([
      'get_limits',
      'get_summary',
      'get_tokens',
      'get_sessions',
      'refresh_limits',
    ]);
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(listed.tools.map((t: Tool) => t.name));
    // No pause/resume/freeze surface: remote control stays out of model reach (§18).
    expect(listed.tools.some((t: Tool) => /pause|resume|freeze|stop/.test(t.name))).toBe(false);
  });

  it('describes get_tokens with an optional since and an enumerated groupBy', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'get_tokens');
    const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.required ?? []).toEqual([]);
    expect(Object.keys(schema.properties ?? {})).toEqual(['since', 'groupBy']);
    expect((schema.properties?.['groupBy'] as { enum: string[] }).enum).toEqual(['project', 'session', 'model', 'day']);
  });

  it('tells the model that resetsAt may be null', () => {
    for (const name of ['get_limits', 'get_summary', 'refresh_limits']) {
      expect(MCP_TOOLS.find((t) => t.name === name)?.description).toContain('`resetsAt` may be null');
    }
  });

  it('says out loud that get_sessions is read-only', () => {
    const description = MCP_TOOLS.find((t) => t.name === 'get_sessions')?.description ?? '';
    expect(description).toContain('no tool here to pause, resume or freeze');
  });
});

describe('get_limits', () => {
  it('passes the daemon body through, minus raw, behind a headline', async () => {
    const d = await daemon();
    d.setPercents({ session: 34, weekly_all: 29 });
    const result = await mcpFor(d).callTool('get_limits');

    expect(result.isError).toBeUndefined();
    expect(headline(result)).toBe('session 34% · weekly 29% · weekly_scoped:fable 10%');
    const payload = body(result);
    expect(payload['raw']).toBeUndefined();
    expect(payload['limits']).toEqual((await new DaemonClient({ baseUrl: `http://127.0.0.1:${String(d.port)}`, token: TOKEN }).get('/v1/limits') as Record<string, unknown>)['limits']);
    expect(payload).toHaveProperty('legacyWindows');
    expect(payload).toHaveProperty('fetchedAt');
  });

  it('flags a stale snapshot and a limits error in the headline', async () => {
    const d = await daemon();
    d.limits.set({
      fetchedAt: null,
      stale: true,
      error: { code: 'unauthorized', message: 'nope' },
      limits: [],
      legacyWindows: {},
      extraUsage: null,
      raw: null,
    });
    const result = await mcpFor(d).callTool('get_limits');
    expect(headline(result)).toBe('no limits data yet · stale · error unauthorized');
  });

  it('spells out an upstream 429: until when, and how old the numbers are (§23.32)', async () => {
    const d = await daemon();
    d.limits.set({
      fetchedAt: '2026-09-25T10:51:17.351Z',
      stale: true,
      error: {
        code: 'rate_limited',
        message: 'Anthropic is rate-limiting the usage endpoint (HTTP 429)',
        retryAt: '2026-09-25T23:18:40.000Z',
      },
      limits: [
        { id: 'weekly_all', kind: 'weekly_all', group: 'weekly', percent: 20, severity: 'normal', resetsAt: null, scope: null, isActive: true },
      ],
      legacyWindows: {},
      extraUsage: null,
      raw: null,
    });
    const result = await mcpFor(d).callTool('get_limits');
    expect(headline(result)).toBe(
      'weekly 20% · stale · rate-limited by Anthropic (HTTP 429) until 2026-09-25 23:18 UTC · numbers from 2026-09-25 10:51 UTC',
    );
  });

  it('says the plan has no 5-hour window instead of leaving it out (§23.68)', async () => {
    const d = await daemon();
    d.limits.set({
      fetchedAt: null,
      stale: false,
      error: null,
      limits: [
        { id: 'weekly_all', kind: 'weekly_all', group: 'weekly', percent: 6, severity: null, resetsAt: null, scope: null, isActive: false, source: 'statusline', asOf: '2026-09-26T08:24:10.000Z' },
      ],
      legacyWindows: {},
      extraUsage: null,
      noSessionLimit: true,
      raw: null,
    });
    const result = await mcpFor(d).callTool('get_limits');
    expect(headline(result)).toBe('session none on this plan · weekly 6% · live from Claude Code as of 2026-09-26 08:24 UTC');
    expect(body(result)['noSessionLimit']).toBe(true);
  });

  it('statusline-only data: says where the numbers came from and when, and not stale (§23.36)', async () => {
    const d = await daemon();
    d.limits.set({
      fetchedAt: null,
      stale: false,
      error: null,
      limits: [
        { id: 'session', kind: 'session', group: 'session', percent: 10, severity: null, resetsAt: null, scope: null, isActive: false, source: 'statusline', asOf: '2026-09-26T08:24:10.000Z' },
        { id: 'weekly_all', kind: 'weekly_all', group: 'weekly', percent: 52, severity: null, resetsAt: null, scope: null, isActive: false, source: 'statusline', asOf: '2026-09-26T08:24:10.000Z' },
      ],
      legacyWindows: {},
      extraUsage: null,
      raw: null,
    });
    const result = await mcpFor(d).callTool('get_limits');
    expect(headline(result)).toBe('session 10% · weekly 52% · live from Claude Code as of 2026-09-26 08:24 UTC');
    expect(body(result)['stale']).toBe(false);
    expect((body(result)['limits'] as Array<Record<string, unknown>>)[0]).toMatchObject({ source: 'statusline', asOf: '2026-09-26T08:24:10.000Z' });
  });

  it('mixed sources while upstream is 429ing: live headline, Anthropic numbers dated (§23.36)', async () => {
    const d = await daemon();
    d.limits.set({
      fetchedAt: '2026-09-26T08:24:55.043Z',
      stale: false,
      error: { code: 'rate_limited', message: 'Anthropic is rate-limiting the usage endpoint (HTTP 429)', retryAt: '2026-09-26T09:54:55.136Z' },
      limits: [
        { id: 'session', kind: 'session', group: 'session', percent: 12, severity: null, resetsAt: null, scope: null, isActive: false, source: 'statusline', asOf: '2026-09-26T09:10:00.000Z' },
        { id: 'weekly_scoped:fable', kind: 'weekly_scoped', group: 'weekly', percent: 43, severity: 'normal', resetsAt: null, scope: null, isActive: false, source: 'upstream', asOf: '2026-09-26T08:24:55.043Z' },
      ],
      legacyWindows: {},
      extraUsage: null,
      raw: null,
    });
    const result = await mcpFor(d).callTool('get_limits');
    expect(headline(result)).toBe(
      'session 12% · weekly_scoped:fable 43% · live from Claude Code as of 2026-09-26 09:10 UTC · ' +
        'rate-limited by Anthropic (HTTP 429) until 2026-09-26 09:54 UTC · Anthropic numbers from 2026-09-26 08:24 UTC',
    );
  });

  it('says rate-limited without a time when upstream gave no Retry-After', async () => {
    const d = await daemon();
    d.limits.set({
      fetchedAt: null,
      stale: false,
      error: { code: 'rate_limited', message: 'Anthropic is rate-limiting the usage endpoint (HTTP 429)' },
      limits: [],
      legacyWindows: {},
      extraUsage: null,
      raw: null,
    });
    const result = await mcpFor(d).callTool('get_limits');
    expect(headline(result)).toBe('no limits data yet · rate-limited by Anthropic (HTTP 429)');
  });
});

describe('get_summary', () => {
  it('leads with percents, overall status and today’s tokens', async () => {
    const d = await daemon();
    d.setPercents({ session: 34, weekly_all: 29 });
    const result = await mcpFor(d).callTool('get_summary');

    expect(headline(result)).toContain('session 34% · weekly 29%');
    expect(headline(result)).toContain('status ok');
    expect(headline(result)).toContain('today 8 msgs, in 1,234 / out 567');
    const payload = body(result);
    expect(Object.keys(payload).sort()).toEqual(['limits', 'status', 'thresholds', 'today']);
    expect((payload['limits'] as Record<string, unknown>)['raw']).toBeUndefined();
  });

  it('reports a warn overall when a limit crosses the threshold', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    const result = await mcpFor(d).callTool('get_summary');
    expect(headline(result)).toContain('status warn');
  });
});

describe('get_tokens', () => {
  it('defaults to today grouped by project', async () => {
    const d = await daemon();
    const result = await mcpFor(d).callTool('get_tokens');
    const payload = body(result);
    expect(payload['groupBy']).toBe('project');
    expect(String(payload['since'])).toMatch(/T00:00:00\.000Z$/);
    expect(headline(result)).toContain('in 1,234 / out 567 · 8 msgs');
  });

  it('forwards since and groupBy to the daemon', async () => {
    const d = await daemon();
    const result = await mcpFor(d).callTool('get_tokens', { since: '2026-09-01T00:00:00.000Z', groupBy: 'model' });
    const payload = body(result);
    expect(payload['since']).toBe('2026-09-01T00:00:00.000Z');
    expect(payload['groupBy']).toBe('model');
    expect(headline(result)).toContain('since 2026-09-01T00:00:00.000Z by model');
  });

  it('surfaces a 400 from the daemon as a tool error, not as "daemon not running"', async () => {
    const d = await daemon();
    const result = await mcpFor(d).callTool('get_tokens', { groupBy: 'bogus' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('bad_request');
    expect(text(result)).toContain('groupBy');
    expect(text(result)).not.toContain(DAEMON_DOWN_TEXT);
  });

  it('surfaces a 400 for an unparseable since', async () => {
    const d = await daemon();
    const result = await mcpFor(d).callTool('get_tokens', { since: 'last tuesday' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('bad_request');
  });
});

describe('get_sessions', () => {
  it('returns the registry body with a counting headline', async () => {
    const d = await daemon({ withSessions: true });
    d.sessions?.registry.register({ sessionId: 's-1', pid: process.pid, cwd: '/tmp/x/foo', gitCommonDir: null });

    const result = await mcpFor(d).callTool('get_sessions');
    expect(result.isError).toBeUndefined();
    const payload = body(result);
    const sessions = payload['sessions'] as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.['sessionId']).toBe('s-1');
    expect(headline(result)).toMatch(/^1 session\(s\) · 1 alive · 0 paused · rev \d+$/);
  });

  it('handles an empty registry', async () => {
    const d = await daemon({ withSessions: true });
    const result = await mcpFor(d).callTool('get_sessions');
    expect(headline(result)).toContain('0 session(s)');
    expect(body(result)['sessions']).toEqual([]);
  });
});

describe('refresh_limits', () => {
  it('needs the bearer token — an unauthenticated client is refused', async () => {
    const d = await daemon();
    const result = await mcpFor(d, { token: '' }).callTool('refresh_limits');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('unauthorized');
    expect(d.limits.refreshCalls).toBe(0);
  });

  it('refreshes and returns the new limits when the token is present', async () => {
    const d = await daemon();
    d.setPercents({ session: 41, weekly_all: 29 });
    const result = await mcpFor(d, { token: TOKEN }).callTool('refresh_limits');

    expect(result.isError).toBeUndefined();
    expect(d.limits.refreshCalls).toBe(1);
    expect(headline(result)).toBe('session 41% · weekly 29% · weekly_scoped:fable 10%');
    expect(body(result)['raw']).toBeUndefined();
  });

  it('on 429 returns the current limits with a note instead of an error', async () => {
    const d = await daemon();
    d.setPercents({ session: 41, weekly_all: 29 });
    d.limits.rateLimited = true;

    const result = await mcpFor(d, { token: TOKEN }).callTool('refresh_limits');
    expect(result.isError).toBeUndefined();
    expect(headline(result)).toContain('refresh skipped (fetched under a minute ago) — current limits');
    expect(headline(result)).toContain('session 41%');
    expect(body(result)['limits']).toBeInstanceOf(Array);
  });
});

describe('daemon unreachable', () => {
  const down: UsageHttpClient = {
    get: () => Promise.reject(new Error('should not be reached')),
    post: () => Promise.reject(new Error('should not be reached')),
  };

  it.each(['get_limits', 'get_summary', 'get_tokens', 'get_sessions', 'refresh_limits'])(
    '%s reports §7.2’s exact wording when there is no daemon.json',
    async (name) => {
      // No daemon.json in this temp dir, so `baseUrl()` throws DaemonUnreachable.
      const client = new DaemonClient({ configDir: tempConfigDir(), timeoutMs: 2_000 });
      const logs: string[] = [];
      const mcp = createMcpServer({ client, log: (t) => logs.push(t) });

      const result = await mcp.callTool(name);
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(DAEMON_DOWN_TEXT);
      expect(logs.join('')).toContain(name);
    },
  );

  it('reports the same wording when the connection itself fails', async () => {
    const d = await daemon();
    const port = d.port;
    await d.stop();
    daemons.length = 0;
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${String(port)}`, timeoutMs: 2_000 });
    const result = await createMcpServer({ client, log: () => {} }).callTool('get_limits');
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(DAEMON_DOWN_TEXT);
  });

  it('rejects an unknown tool without touching the daemon', async () => {
    const result = await createMcpServer({ client: down, log: () => {} }).callTool('pause_session');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('unknown tool "pause_session"');
  });
});

describe('runMcp over stdio', () => {
  it('writes nothing but JSON-RPC to stdout, and diagnostics to stderr', async () => {
    // A config dir with no daemon.json: every tool call fails, so if anything ever
    // logged to stdout instead of stderr this is where it would show up.
    const configDir = tempConfigDir();
    const stdin = new PassThrough();
    const written: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _enc, cb: (err?: Error | null) => void) {
        written.push(chunk.toString());
        cb();
      },
    });
    const errs: string[] = [];
    // Belt and braces: the injected writable proves the transport is clean, and this spy
    // proves nothing in the MCP path reaches the process' own stdout either.
    const leaked: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      leaked.push(String(chunk));
      return true;
    });
    const transport = new StdioServerTransport(stdin, stdout);
    const exit = runMcp({ configDir, transport, stderr: (t) => errs.push(t) });

    const send = (msg: unknown): void => {
      stdin.write(`${JSON.stringify(msg)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_summary', arguments: {} } });

    const lines = await waitForLines(written, 3);
    const messages = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const m of messages) expect(m['jsonrpc']).toBe('2.0');
    expect(messages.map((m) => m['id'])).toEqual([1, 2, 3]);

    const listed = (messages[1]?.['result'] as { tools: Tool[] }).tools;
    expect(listed).toHaveLength(5);

    const called = messages[2]?.['result'] as CallToolResult;
    expect(called.isError).toBe(true);
    expect(text(called)).toBe(DAEMON_DOWN_TEXT);
    expect(errs.join('')).toContain('get_summary');

    await transport.close();
    expect(await exit).toBe(0);
    spy.mockRestore();
    expect(leaked).toEqual([]);
  });

  it('builds an authenticated client from config.json so refresh works', async () => {
    const configDir = tempConfigDir();
    const d = await startFakeDaemon({ configDir });
    daemons.push(d);
    saveConfig(testConfig(), configDir);
    d.setPercents({ session: 55, weekly_all: 29 });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    const exit = runMcp({ configDir, transport: serverTransport, stderr: () => {} });
    await client.connect(clientTransport);

    const result = (await client.callTool({ name: 'refresh_limits', arguments: {} })) as CallToolResult;
    expect(result.isError).toBeUndefined();
    expect(d.limits.refreshCalls).toBe(1);
    expect(headline(result)).toContain('session 55%');

    await client.close();
    expect(await exit).toBe(0);
  });
});

/** Poll `written` until it holds at least `n` complete newline-delimited frames. */
async function waitForLines(written: string[], n: number, timeoutMs = 5_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = written.join('').split('\n').filter((l) => l.length > 0);
    if (lines.length >= n) return lines;
    if (Date.now() > deadline) throw new Error(`only ${String(lines.length)} of ${String(n)} JSON-RPC frames arrived`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
