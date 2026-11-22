// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { versionDir } from '../paths.js';
import { buildUnit, defaultExec } from '../service/index.js';
import { addMcpServer } from './claude-json.js';
import {
  asLaunchd,
  asSystemd,
  loadConfigWithToken,
  persistConfig,
  resolveContext,
  verifyHealth,
  type InstallIO,
} from './context.js';
import {
  buildPlan,
  confirmPlan,
  InstallError,
  parseInstallArgs,
  planToIntegrations,
  renderPlan,
  type PlanContext,
} from './plan.js';
import { preflight, renderPreflight } from './preflight.js';
import { readlinePrompter } from './plan.js';
import { isLoopbackAddress } from '../server/middleware.js';
import { applySettings, type StatusLineOutcome } from './settings-merge.js';
import { readInstallFiles } from '../server/install-state.js';
import { installVersion } from './versions.js';
import { ensureRuntimeDeps } from './deps.js';
import { describePathLink, linkOnPath } from './path-link.js';
import { pairingHint } from './pair-hint.js';
import { findBrew, offerMenuBar } from './menu-bar.js';
import { findMenuBarApp } from '../menubar.js';

/** `claude-usage install` (§8). Returns the process exit code; never calls `process.exit`. */
export async function runInstall(argv: readonly string[], io: InstallIO): Promise<number> {
  const flags = parseInstallArgs(argv);
  if (flags.unknown.length > 0) {
    io.stderr(`claude-usage install: unknown option "${flags.unknown[0] ?? ''}"\n`);
    return 1;
  }

  const ctx = await resolveContext(io);

  // 1. Preflight — the Keychain notice is printed before the first credential read.
  const pre = await preflight({
    platform: ctx.platform,
    notify: (line) => io.stdout(`\n${line}\n\n`),
    ...(io.readCredentials === undefined ? {} : { readCredentials: io.readCredentials }),
  });
  io.stdout('preflight\n');
  io.stdout(renderPreflight(pre));
  if (!pre.ok) {
    io.stderr('claude-usage install: preflight failed — nothing was changed\n');
    return 1;
  }

  // 2. Plan + confirm.
  const planCtx: PlanContext = {
    serviceKind: ctx.service.kind,
    unitPath: ctx.service.unitPath,
    settingsFile: ctx.settingsFile,
    claudeJsonFile: ctx.claudeJsonFile,
    binPath: ctx.binPath,
    versionDir: versionDir(ctx.version, ctx.env),
    // §23.54: look at what statusLine holds before planning, so the plan says what will happen.
    statusline: readInstallFiles({ settingsFile: ctx.settingsFile, claudeJsonFile: ctx.claudeJsonFile, binPath: ctx.binPath }).statusline,
  };
  const items = buildPlan(flags, planCtx);
  io.stdout(`\n${renderPlan(items, planCtx)}\n`);

  let confirmed;
  try {
    confirmed = await confirmPlan(items, {
      yes: flags.yes,
      isTTY: io.isTTY ?? process.stdout.isTTY === true,
      ...(io.prompt === undefined ? {} : { prompt: io.prompt }),
    });
  } catch (err) {
    if (err instanceof InstallError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const chosen = planToIntegrations(confirmed);
  const interactive = !flags.yes;
  const ask = io.prompt ?? (interactive ? readlinePrompter() : undefined);

  // §23.44: LAN reachability for the iPhone app. Interactive default yes; `--yes` alone
  // never widens reachability — a scripted install gets it only with `--lan`.
  let lan = flags.lan;
  if (!lan && interactive && ask !== undefined) lan = await ask('Let phones on this network reach the daemon? (HTTPS only, pinned certificate; pairing still needs a one-time code)', true);

  // 3. Config: mint the bearer token if there is none, record the choices, 0600.
  const { config, minted } = loadConfigWithToken(ctx.configDir, io.randomToken);
  config.integrations = { ...config.integrations, ...chosen };
  if (flags.tailscale && !config.bind.includes('tailscale')) config.bind = [...config.bind, 'tailscale'];
  if (lan && !config.bind.includes('lan')) config.bind = [...config.bind, 'lan'];
  persistConfig(config, ctx.configDir);
  io.stdout(`\nconfig: ${ctx.configDir}/config.json (0600)${minted ? ' — bearer token generated' : ''}\n`);

  // 4. Versions layout: copy the package, repoint `current` (§20).
  const version = installVersion({
    version: ctx.version,
    env: ctx.env,
    ...(io.sourceDir === undefined ? {} : { sourceDir: io.sourceDir }),
  });
  const depsInstalled = await ensureRuntimeDeps(version.versionDir, ctx.exec ?? undefined);
  io.stdout(
    `package: ${version.versionDir}${version.copied ? '' : ' (already installed)'}${depsInstalled ? ' — production deps installed' : ''}\n` +
      `current: ${version.currentLink} -> ${version.versionDir}\n`,
  );

  // §23.51: `claude-usage` on the PATH, so `claude-usage pair` works in the next terminal.
  const notes: string[] = [];
  const path = describePathLink(linkOnPath(ctx.env), ctx.env);
  io.stdout(path.line);
  if (path.note !== null) notes.push(path.note);

  // 5. Apply.
  if (chosen.service) {
    await ctx.service.install(buildUnit({ nodePath: ctx.nodePath, binPath: ctx.binPath, env: ctx.env }));
    io.stdout(`service: ${ctx.service.kind} ${ctx.service.unitPath}\n`);
    // An install over ssh produces a job launchd will not restart on its own; say so rather
    // than hand back a service that only looks healthy (§23.20).
    for (const warning of (await asLaunchd(ctx.service)?.diagnose()) ?? []) notes.push(warning);
    if (flags.linger) {
      const systemd = asSystemd(ctx.service);
      if (systemd === null) notes.push('--linger only applies to systemd; ignored');
      else {
        const report = await systemd.enableLinger();
        notes.push(report.message);
      }
    }
  }

  let feed: StatusLineOutcome | null = null;
  if (chosen.hook || chosen.statusline) {
    const result = applySettings({
      file: ctx.settingsFile,
      binPath: ctx.binPath,
      hook: chosen.hook,
      statusline: chosen.statusline,
      statuslineMode: flags.statusline ? 'line' : 'feed',
    });
    feed = result.statusLine?.outcome ?? null;
    if (chosen.hook) {
      io.stdout(
        `hooks:   ${result.hooksAdded.length > 0 ? `registered ${result.hooksAdded.join(', ')}` : 'already registered'}\n`,
      );
    }
    if (result.backupPath !== null) notes.push(`backup written once: ${result.backupPath}`);
    if (feed === 'set') {
      io.stdout(flags.statusline ? 'status:  statusLine set\n' : 'limits:  statusLine forwards rate limits to the daemon (prints nothing)\n');
    }
    if (result.statusLine?.outcome === 'other-exists') {
      notes.push(
        'live limits need one line in your own status line, which install never edits — ' +
          `add this line to your own status line script, after it reads stdin into $input:\n    ${result.statusLine.snippet}`,
      );
    }
  }

  if (chosen.mcp) {
    // The MCP registration is the least important thing install does and the only one with a
    // hard dependency on another tool's CLI. It must not abort an install that has already
    // put the service in place — that loses the status table and every note, including the
    // one saying launchd will not supervise what we just installed (§23.29).
    try {
      const mcp = await addMcpServer({
        file: ctx.claudeJsonFile,
        binPath: ctx.binPath,
        ...(ctx.exec === undefined ? {} : { exec: ctx.exec }),
      });
      io.stdout(`mcp:     registered via ${mcp.method === 'claude-cli' ? '`claude mcp add`' : 'direct merge'}\n`);
      if (mcp.warning !== null) notes.push(mcp.warning);
    } catch (err) {
      io.stdout('mcp:     not registered\n');
      notes.push(
        `the MCP server could not be registered: ${err instanceof Error ? err.message : String(err)} — ` +
          'everything else installed; re-run `claude-usage install --no-service --no-hook` once that is resolved',
      );
    }
  }

  // 6. Verify + status table.
  let healthy = false;
  if (chosen.service) {
    healthy = await verifyHealth(io, ctx.configDir);
    if (!healthy) {
      notes.push(
        `the daemon did not answer GET /health within 5s — check \`claude-usage status\`${
          ctx.service.kind === 'launchd' ? ' or the log under ~/Library/Logs/claude-usage' : ' or `journalctl --user -u claude-usage`'
        }`,
      );
    }
  } else {
    notes.push('no service installed — run `claude-usage serve` yourself, or re-run install without --no-service');
  }

  io.stdout(`\n${await renderStatusTable(ctx, chosen, healthy, config.port, feed)}`);
  for (const note of notes) io.stdout(`\nnote: ${note}\n`);

  // §23.73: the menu-bar item needs SwiftBar (or xbar).
  await offerMenuBar({
    platform: ctx.platform,
    configDir: ctx.configDir,
    env: ctx.env,
    nodePath: ctx.nodePath,
    binPath: ctx.binPath,
    exec: ctx.exec ?? defaultExec,
    stdout: io.stdout,
    stderr: io.stderr,
    findApp: io.findMenuBarApp ?? (() => findMenuBarApp(ctx.env)),
    findBrew: io.findBrew ?? findBrew,
    ...(interactive && ask !== undefined ? { ask } : {}),
  });

  // §23.48: offer the pairing page — only when there is something a phone could reach.
  const reachable = config.bind.some((entry) => !isLoopbackAddress(entry));
  if (healthy && reachable && interactive && ask !== undefined) {
    if (await ask('Open the pairing page now?', true)) {
      const pair = io.pair ?? (async () => (await import('./pair.js')).runPair({ stdout: io.stdout, stderr: io.stderr, configDir: ctx.configDir }));
      await pair();
    }
  }
  io.stdout(`\n${pairingHint(config.bind)}\n`);
  return 0;
}

async function renderStatusTable(
  ctx: Awaited<ReturnType<typeof resolveContext>>,
  chosen: Record<string, boolean>,
  healthy: boolean,
  port: number,
  feed: StatusLineOutcome | null,
): Promise<string> {
  const state = await ctx.service.status();
  const rows: Array<[string, string]> = [
    ['service', chosen['service'] === true ? `${ctx.service.kind} — ${state}` : 'off'],
    ['daemon', healthy ? `healthy on port ${String(port)}` : chosen['service'] === true ? 'not answering' : 'not started'],
    ['hooks', chosen['hook'] === true ? 'on' : 'off'],
    ['mcp', chosen['mcp'] === true ? 'on' : 'off'],
    ['limits', feed === null ? 'off' : feed === 'other-exists' ? 'needs one line in your own status line (see note)' : 'live, from Claude Code'],
    ['config', ctx.configDir],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  return `installed\n${rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n')}\n`;
}

