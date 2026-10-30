// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { DaemonClient, DaemonUnreachable, isPidAlive, readDaemonInfo } from './clients/http.js';
import { loadConfig, redactConfig, resolveConfigDir } from './config.js';
import { pairingHint } from './install/pair-hint.js';
import { serve } from './daemon.js';
import { runHook, readStdin } from './hook.js';
import { runStatusline } from './statusline.js';
import { getVersion } from './version.js';
import type { LimitStatus } from './limits/status.js';
import type { ServiceManager } from './service/index.js';
import type { NormalizedLimit } from './limits/types.js';
import { isTokensGroupBy } from './server/types.js';
import { resumeAll } from './pause/freeze.js';
import { parseScope, type PauseRule } from './pause/rules.js';
import type { SessionView } from './sessions/types.js';

export interface CliIO {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  configDir?: string;
  client?: Pick<DaemonClient, 'get'> & Partial<Pick<DaemonClient, 'post'>>;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests so no launchctl/systemctl ever runs. */
  service?: Pick<ServiceManager, 'start' | 'stop' | 'status'>;
}

/** Subcommands other waves own; they exist so `help` is honest about the surface. */
const PLANNED: string[] = [];

const HELP = `claude-usage — local usage service for Claude Code sessions

Usage: claude-usage <command> [options]

  serve [--verbose]                 run the daemon in the foreground
  status                            daemon state, limits and today's tokens
  tokens [--since <v>] [--by <g>]   token spend table (since: today|7d|24h|ISO)
  sessions                          live Claude Code sessions
  pause <scope> [--hard] [--reason] pause all | project:<path> | session:<id>
  resume <scope> | --all            clear pause rules (--all works with no daemon)
  install [--yes] [--no-service]    install the service, hooks and MCP server
          [--no-hook] [--no-mcp] [--statusline | --no-statusline] [--tailscale] [--lan] [--linger]
  configure [<setting> <on|off>]    interactive menu, or a scriptable setting
  pair                              QR page to pair the iPhone app (one-time code)
  uninstall [--purge]               remove everything install added
  mcp                               MCP server over stdio (stdout is JSON-RPC only)
  update [--check]                  install the newest release (--check: just look)
  rollback                          point "current" back at the previous version
  hook                              UserPromptSubmit hook (always exits 0)
  statusline                        one-line status for statusLine.command
  service <start|stop|status>       start or stop the installed launchd/systemd service
  menubar [--install [--dir <d>]]   macOS menu-bar item (SwiftBar plugin); --uninstall removes it
  observe                           forward statusline JSON's rate_limits to the daemon
  --version                         print the version
  help                              print this help


Docs: https://github.com/drmuzikbpn/usage-deck
Works with Claude Code. Not affiliated with, endorsed by, or sponsored by Anthropic.
`;

function flagValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    for (const name of names) {
      if (arg === name) return argv[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function formatCount(v: unknown): string {
  return num(v).toLocaleString('en-US');
}

function limitsTable(limits: readonly NormalizedLimit[], byId: Record<string, LimitStatus>): string {
  if (limits.length === 0) return '  (no limits data yet)\n';
  const idWidth = Math.max(8, ...limits.map((l) => l.id.length));
  let out = '';
  for (const l of limits) {
    const percent = l.percent === null ? '  ?' : `${String(l.percent).padStart(3)}`;
    const status = byId[l.id] ?? 'ok';
    const resets = l.resetsAt === null ? 'resets: unknown' : `resets ${l.resetsAt}`;
    out += `  ${pad(l.id, idWidth)}  ${percent}%  ${pad(status, 8)}  ${resets}\n`;
  }
  return out;
}

async function cmdStatus(io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  const configDir = io.configDir ?? resolveConfigDir();
  const info = readDaemonInfo(configDir);

  if (info === null) {
    io.stdout('daemon: not running (no daemon.json)\n');
    io.stdout(`config: ${configDir}\n`);
    return 1;
  }
  if (!isPidAlive(info.pid)) {
    io.stdout(`daemon: not running (stale daemon.json — pid ${info.pid} is gone)\n`);
    io.stdout(`config: ${configDir}\n`);
    return 1;
  }

  const client = io.client ?? new DaemonClient({ configDir });
  let summary: Record<string, unknown>;
  try {
    summary = (await client.get('/v1/summary')) as Record<string, unknown>;
  } catch (err) {
    io.stdout(`daemon: pid ${info.pid} on port ${info.port}, but not answering\n`);
    io.stderr(`  ${(err as Error).message}\n`);
    return 1;
  }

  io.stdout(`daemon: running (pid ${info.pid}, port ${info.port}, version ${info.version || 'unknown'})\n`);

  const limitsBody = summary['limits'] as { limits?: NormalizedLimit[]; stale?: boolean; error?: unknown } | undefined;
  const status = summary['status'] as { byId?: Record<string, LimitStatus>; overall?: LimitStatus } | undefined;
  io.stdout(`overall: ${status?.overall ?? 'unknown'}${limitsBody?.stale === true ? ' (stale)' : ''}\n`);
  const err = limitsBody?.error as { code?: string; message?: string } | null | undefined;
  if (err !== null && err !== undefined && err.code !== undefined) {
    io.stdout(`limits error: ${err.code} — ${err.message ?? ''}\n`);
  }
  io.stdout('limits:\n');
  io.stdout(limitsTable(limitsBody?.limits ?? [], status?.byId ?? {}));

  const today = summary['today'] as Record<string, unknown> | undefined;
  if (today?.['ready'] === true) {
    io.stdout(
      `today: ${formatCount(today['messages'])} messages, ` +
        `in ${formatCount(today['input'])} / out ${formatCount(today['output'])}, ` +
        `cache ${formatCount(today['cacheCreate'])} created / ${formatCount(today['cacheRead'])} read\n`,
    );
  } else {
    io.stdout('today: scanning transcripts…\n');
  }
  try {
    io.stdout(`${pairingHint(loadConfig(configDir).bind)}\n`);
  } catch {
    // An unreadable config already showed up above; the hint is a courtesy.
  }
  return 0;
}

async function cmdTokens(argv: readonly string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  const since = flagValue(argv, ['--since', '-s']) ?? 'today';
  const by = flagValue(argv, ['--by', '-b', '--groupBy']) ?? 'project';
  if (!isTokensGroupBy(by)) {
    io.stderr(`claude-usage: --by must be one of project, session, model, day (got "${by}")\n`);
    return 1;
  }

  const configDir = io.configDir ?? resolveConfigDir();
  const client = io.client ?? new DaemonClient({ configDir });
  let body: Record<string, unknown>;
  try {
    const qs = new URLSearchParams({ since, groupBy: by });
    body = (await client.get(`/v1/tokens?${qs.toString()}`)) as Record<string, unknown>;
  } catch (err) {
    io.stderr(
      err instanceof DaemonUnreachable
        ? 'claude-usage: daemon not running — run `claude-usage status`\n'
        : `claude-usage: ${(err as Error).message}\n`,
    );
    return 1;
  }

  if (body['ready'] !== true) {
    io.stdout('tokens: initial scan still running — try again shortly\n');
    return 0;
  }

  const groups = Array.isArray(body['groups']) ? (body['groups'] as Array<Record<string, unknown>>) : [];
  const totals = (body['totals'] ?? {}) as Record<string, unknown>;
  io.stdout(`since ${String(body['since'])}, grouped by ${by}\n`);
  const labelWidth = Math.max(12, ...groups.map((g) => String(g['label'] ?? g['key'] ?? '').length));
  io.stdout(`  ${pad('group', labelWidth)}  ${'input'.padStart(12)}  ${'output'.padStart(12)}  ${'msgs'.padStart(8)}\n`);
  for (const g of groups) {
    const label = String(g['label'] ?? g['key'] ?? '');
    io.stdout(
      `  ${pad(label, labelWidth)}  ${formatCount(g['input']).padStart(12)}  ` +
        `${formatCount(g['output']).padStart(12)}  ${formatCount(g['messages']).padStart(8)}\n`,
    );
  }
  io.stdout(
    `  ${pad('TOTAL', labelWidth)}  ${formatCount(totals['input']).padStart(12)}  ` +
      `${formatCount(totals['output']).padStart(12)}  ${formatCount(totals['messages']).padStart(8)}\n`,
  );
  return 0;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * `soft`, or `hard(<n>)` where `n` is the tool subprocesses currently SIGSTOPped. `hard(0)`
 * is normal and not a failure: the session had nothing running, so there was nothing to
 * stop, and it is held at the `PreToolUse` gate instead (§23.16).
 */
function pauseLabel(session: SessionView): string {
  if (session.pause === null) return '-';
  const frozen = session.pause.frozenPids.length;
  return session.pause.mode === 'hard' ? `hard(${frozen})` : 'soft';
}

/** Every client is authenticated: `DaemonClient` reads the token from `config.json` (§23.55). */
function authedClient(_io: CliIO, configDir: string): DaemonClient {
  return new DaemonClient({ configDir });
}

function unreachable(io: Required<Pick<CliIO, 'stderr'>>, err: unknown): number {
  io.stderr(
    err instanceof DaemonUnreachable
      ? `claude-usage: ${err.message}\n`
      : `claude-usage: ${(err as Error).message}\n`,
  );
  return 1;
}

async function cmdSessions(io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  const configDir = io.configDir ?? resolveConfigDir();
  const client = io.client ?? new DaemonClient({ configDir });
  let body: Record<string, unknown>;
  try {
    body = (await client.get('/v1/sessions')) as Record<string, unknown>;
  } catch (err) {
    return unreachable(io, err);
  }
  const sessions = Array.isArray(body['sessions']) ? (body['sessions'] as SessionView[]) : [];
  if (sessions.length === 0) {
    io.stdout('no sessions\n');
    return 0;
  }
  const projectWidth = Math.max(7, ...sessions.map((s) => (s.project?.name ?? '').length + (s.worktree === null ? 0 : s.worktree.length + 3)));
  io.stdout(
    `  ${pad('session', 9)}  ${pad('project', projectWidth)}  ${pad('pid', 7)}  ${pad('state', 7)}  ${pad('pause', 9)}  ${'msgs'.padStart(7)}  last activity\n`,
  );
  for (const s of sessions) {
    const project = s.worktree === null ? (s.project?.name ?? '?') : `${s.project?.name ?? '?'} @ ${s.worktree}`;
    io.stdout(
      `  ${pad(shortId(s.sessionId), 9)}  ${pad(project, projectWidth)}  ` +
        `${pad(s.pid === null ? '-' : String(s.pid), 7)}  ${pad(s.alive ? 'alive' : s.discovered === 'transcript' ? 'file' : 'dead', 7)}  ` +
        `${pad(pauseLabel(s), 9)}  ${formatCount(s.tokens?.messages).padStart(7)}  ${s.lastActivityAt}\n`,
    );
  }
  io.stdout(`rev ${String(body['rev'] ?? 0)}\n`);
  return 0;
}

async function cmdPause(argv: readonly string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  const scope = argv.find((a) => !a.startsWith('-'));
  if (scope === undefined || parseScope(scope) === null) {
    io.stderr('claude-usage: pause needs a scope — all | project:<path> | session:<id>\n');
    return 1;
  }
  const configDir = io.configDir ?? resolveConfigDir();
  const client = io.client ?? authedClient(io, configDir);
  if (typeof client.post !== 'function') {
    io.stderr('claude-usage: this client cannot POST\n');
    return 1;
  }
  const mode = argv.includes('--hard') ? 'hard' : 'soft';
  const reason = flagValue(argv, ['--reason', '-r']) ?? '';
  let body: Record<string, unknown>;
  try {
    body = (await client.post('/v1/pause', { scope, mode, reason, createdBy: 'cli' })) as Record<string, unknown>;
  } catch (err) {
    return unreachable(io, err);
  }
  const rule = body['rule'] as PauseRule | undefined;
  const affected = Array.isArray(body['affected']) ? (body['affected'] as string[]) : [];
  io.stdout(`paused ${scope} (${mode}) — rule ${rule?.id ?? '?'}\n`);
  io.stdout(`affected: ${affected.length === 0 ? 'none' : affected.map(shortId).join(', ')}\n`);
  return 0;
}

async function cmdResume(argv: readonly string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  const configDir = io.configDir ?? resolveConfigDir();
  const all = argv.includes('--all');
  const scope = argv.find((a) => !a.startsWith('-'));
  if (!all && (scope === undefined || parseScope(scope) === null)) {
    io.stderr('claude-usage: resume needs a scope — all | project:<path> | session:<id> — or --all\n');
    return 1;
  }

  const client = io.client ?? authedClient(io, configDir);
  if (all) {
    // §18.3's escape hatch: every rule goes, and everything recorded is SIGCONTed —
    // with the daemon if it is up, straight off disk if it is not.
    try {
      if (typeof client.post !== 'function') throw new DaemonUnreachable('no POST client');
      const body = (await client.get('/v1/pause/rules')) as { rules?: PauseRule[] };
      const rules = body.rules ?? [];
      for (const scopeValue of new Set(rules.map((r) => r.scope))) {
        await client.post('/v1/resume', { scope: scopeValue });
      }
      io.stdout(`resumed everything — removed ${String(rules.length)} rule(s)\n`);
      return 0;
    } catch {
      const offline = resumeAll(configDir);
      io.stdout(
        `daemon not answering — resumed offline: ${String(offline.resumed.length)} process(es), ` +
          `${String(offline.removed.length)} rule(s) cleared\n`,
      );
      return 0;
    }
  }

  if (typeof client.post !== 'function') {
    io.stderr('claude-usage: this client cannot POST\n');
    return 1;
  }
  let body: Record<string, unknown>;
  try {
    body = (await client.post('/v1/resume', { scope })) as Record<string, unknown>;
  } catch (err) {
    return unreachable(io, err);
  }
  const removed = Array.isArray(body['removed']) ? (body['removed'] as string[]) : [];
  const resumed = Array.isArray(body['resumed']) ? (body['resumed'] as string[]) : [];
  io.stdout(`removed ${String(removed.length)} rule(s); resumed ${resumed.length === 0 ? 'none' : resumed.map(shortId).join(', ')}\n`);
  return 0;
}
// ─────────────────────────── W6 (feat/install) block ───────────────────────────
// `install` / `uninstall` / `configure`, plus the service diagnostics `status`
// prints when the daemon is down (§23.9). Everything here is self-contained: the
// install and service modules are imported lazily so `serve`, `hook` and
// `statusline` never pay for them, and nothing outside this block changes except
// the three dispatch cases and the one `status` call marked "W6".

/** §23.9: `status` prints the last 20 stderr lines when the daemon is down. */
export const W6_LOG_TAIL = 20;

type W6Io = Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO;

function w6InstallIo(io: W6Io): {
  stdout: (t: string) => void;
  stderr: (t: string) => void;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
} {
  return {
    stdout: io.stdout,
    stderr: io.stderr,
    ...(io.configDir === undefined ? {} : { configDir: io.configDir }),
    ...(io.env === undefined ? {} : { env: io.env }),
  };
}

async function w6Dispatch(cmd: 'install' | 'uninstall' | 'configure', argv: readonly string[], io: W6Io): Promise<number> {
  const install = await import('./install/index.js');
  const installIo = w6InstallIo(io);
  if (cmd === 'install') return install.runInstall(argv, installIo);
  if (cmd === 'uninstall') return install.runUninstall(argv, installIo);
  return install.runConfigure(argv, installIo);
}

/** Service state + log tail, appended to `status` when the daemon is not answering. */
async function w6ServiceDiagnostics(io: W6Io): Promise<void> {
  try {
    const { createServiceManager } = await import('./service/index.js');
    const service = await createServiceManager(io.env === undefined ? {} : { env: io.env });
    io.stdout(`service: ${service.kind} — ${await service.status()}\n`);
    const lines = await service.logTail(W6_LOG_TAIL);
    if (lines.length === 0) {
      io.stdout('log: no stderr output captured\n');
      return;
    }
    io.stdout(`log: last ${String(lines.length)} stderr lines\n`);
    for (const line of lines) io.stdout(`  ${line}\n`);
  } catch (err) {
    io.stderr(`service: could not read the service state (${(err as Error).message})\n`);
  }
}
// ───────────────────────── end W6 (feat/install) block ─────────────────────────

/** `claude-usage service <start|stop|status>` (§23.66): the menu-bar item's Start/Stop. */
async function cmdService(argv: readonly string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  const action = argv[0];
  if (action !== 'start' && action !== 'stop' && action !== 'status') {
    io.stderr('claude-usage: service needs start, stop or status\n');
    return 1;
  }
  const { createServiceManager } = await import('./service/index.js');
  const service = io.service ?? (await createServiceManager(io.env === undefined ? {} : { env: io.env }));
  try {
    const state = await service.status();
    if (action === 'status') {
      io.stdout(`service: ${state}\n`);
      return state === 'running' ? 0 : 1;
    }
    if (state === 'not-installed') {
      io.stderr('claude-usage: the service is not installed; run `claude-usage install`\n');
      return 1;
    }
    if (action === 'start') await service.start();
    else await service.stop();
    io.stdout(`service: ${await service.status()}\n`);
    return 0;
  } catch (err) {
    io.stderr(`claude-usage: service ${action} failed: ${(err as Error).message}\n`);
    return 1;
  }
}

/** Subcommand dispatch. Returns the process exit code; never calls `process.exit`. */
export async function run(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = io.stderr ?? ((t: string) => process.stderr.write(t));
  const base = { ...io, stdout, stderr };
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);

  switch (cmd) {
    case 'serve': {
      const opts = { verbose: rest.includes('--verbose') || rest.includes('-v') };
      return serve(io.configDir === undefined ? opts : { ...opts, configDir: io.configDir });
    }
    case 'status': {
      const code = await cmdStatus(base);
      if (code !== 0) await w6ServiceDiagnostics(base); // W6
      return code;
    }
    // W6
    case 'install':
    case 'uninstall':
    case 'configure':
      return w6Dispatch(cmd, rest, base);
    // W8
    case 'update':
    case 'rollback': {
      const { runUpdateCli } = await import('./update/index.js');
      return runUpdateCli(cmd, rest, base);
    }
    case 'pair': {
      // §23.48: CLI-only and lazy — the QR code and page server never load in the daemon.
      const { runPair } = await import('./install/pair.js');
      return runPair({ stdout, stderr, ...(io.configDir === undefined ? {} : { configDir: io.configDir }) });
    }
    case 'tokens':
      return cmdTokens(rest, base);
    case 'sessions':
      return cmdSessions(base);
    case 'pause':
      return cmdPause(rest, base);
    case 'resume':
      return cmdResume(rest, base);
    case 'mcp': {
      // Lazily imported: the SDK must never be loaded by `serve`, `hook` or `statusline`.
      const { runMcp } = await import('./mcp.js');
      return runMcp({
        stderr,
        ...(io.configDir === undefined ? {} : { configDir: io.configDir }),
      });
    }
    case 'hook': {
      const hookIo = {
        stdin: io.stdin ?? (await readStdin()),
        stdout,
        ...(io.configDir === undefined ? {} : { configDir: io.configDir }),
      };
      return runHook(hookIo);
    }
    case 'observe': {
      const { runObserve } = await import('./observe.js');
      return runObserve({
        stdin: io.stdin ?? (await readStdin()),
        ...(io.configDir === undefined ? {} : { configDir: io.configDir }),
      });
    }
    case 'statusline': {
      const slIo = {
        stdin: io.stdin ?? (await readStdin()),
        stdout,
        ...(io.configDir === undefined ? {} : { configDir: io.configDir }),
        ...(io.env === undefined ? {} : { env: io.env }),
      };
      return runStatusline(slIo);
    }
    case 'service':
      return cmdService(rest, base);
    case 'menubar': {
      const { runMenubar } = await import('./menubar.js');
      return runMenubar(rest, {
        stdout,
        stderr,
        ...(io.configDir === undefined ? {} : { configDir: io.configDir }),
        ...(io.client === undefined ? {} : { client: io.client }),
        ...(io.env === undefined ? {} : { env: io.env }),
      });
    }
    case 'config': {
      // Never the bearer itself: this output ends up in terminals, bug reports and
      // screenshots. `config.json` is where it lives, readable by its owner only.
      const configDir = io.configDir ?? resolveConfigDir();
      stdout(`${JSON.stringify(redactConfig(loadConfig(configDir)), null, 2)}\n`);
      return 0;
    }
    case '--version':
    case '-V':
    case 'version':
      stdout(`${getVersion()}\n`);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      stdout(HELP);
      return 0;
    default:
      if (PLANNED.includes(cmd)) {
        stderr(`claude-usage: subcommand "${cmd}" not implemented yet\n`);
        return 1;
      }
      stderr(`claude-usage: unknown subcommand "${cmd}"\n`);
      stderr('run `claude-usage help` for usage\n');
      return 1;
  }
}

/**
 * §23.43: `claude-usage status | head -1` closes the pipe early, and Node raises that as an
 * unhandled EPIPE with a stack trace. A reader that has gone away is not an error: exit 0.
 */
export function exitQuietlyOnEpipe(
  stream: { on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): unknown },
  exit: (code: number) => void,
): void {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') {
      exit(0);
      return;
    }
    throw err;
  });
}

export async function main(argv: string[]): Promise<void> {
  exitQuietlyOnEpipe(process.stdout, (code) => process.exit(code));
  const code = await run(argv);
  if (code !== 0) process.exitCode = code;
}
