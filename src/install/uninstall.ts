// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { daemonFilePath } from '../clients/http.js';
import { removeMenubarPlugin } from '../menubar.js';
import { dataDir, macLogDir } from '../paths.js';
import { removeMcpServer } from './claude-json.js';
import { resolveContext, type InstallIO } from './context.js';
import { unlinkFromPath, pathLinkFile } from './path-link.js';
import { removeSettings } from './settings-merge.js';

/** `claude-usage uninstall [--purge]` (§8). Reverses install; never touches linger or the `.bak`. */

export const PAUSE_STATE_FILE = 'pause.json';

export interface UninstallFlags {
  purge: boolean;
  unknown: string[];
}

export function parseUninstallArgs(argv: readonly string[]): UninstallFlags {
  const flags: UninstallFlags = { purge: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--purge') flags.purge = true;
    else flags.unknown.push(arg);
  }
  return flags;
}

/**
 * SIGCONT anything we hard-froze before the daemon goes away (§18.3 invariant).
 * `src/pause/freeze.js` lands in W3, which is concurrent with this wave, so the
 * import is dynamic and its absence is not an error.
 */
export async function resumeFrozen(configDir: string): Promise<string | null> {
  if (!existsSync(join(configDir, PAUSE_STATE_FILE))) return null;
  const specifier = ['..', 'pause', 'freeze.js'].join('/');
  try {
    const mod = (await import(specifier)) as { resumeAll?: (dir: string) => Promise<unknown> | unknown };
    if (typeof mod.resumeAll !== 'function') return null;
    await mod.resumeAll(configDir);
    return 'resumed hard-frozen sessions (SIGCONT)';
  } catch {
    return null;
  }
}

export async function runUninstall(argv: readonly string[], io: InstallIO): Promise<number> {
  const flags = parseUninstallArgs(argv);
  if (flags.unknown.length > 0) {
    io.stderr(`claude-usage uninstall: unknown option "${flags.unknown[0] ?? ''}"\n`);
    return 1;
  }
  const ctx = await resolveContext(io);

  const resumed = await resumeFrozen(ctx.configDir);
  if (resumed !== null) io.stdout(`${resumed}\n`);

  await ctx.service.stop();
  await ctx.service.uninstall();
  io.stdout(`service: removed${ctx.service.unitPath === '' ? '' : ` (${ctx.service.unitPath})`}\n`);

  const settings = removeSettings({ file: ctx.settingsFile, binPath: ctx.binPath, hook: true, statusline: true });
  io.stdout(
    `hooks:   ${settings.hooksRemoved.length > 0 ? `removed ${settings.hooksRemoved.join(', ')}` : 'nothing registered'}\n`,
  );
  if (settings.statusLineRemoved) io.stdout('status:  statusLine removed\n');

  const mcp = await removeMcpServer({
    file: ctx.claudeJsonFile,
    binPath: ctx.binPath,
    ...(ctx.exec === undefined ? {} : { exec: ctx.exec }),
  });
  io.stdout(`mcp:     ${mcp.changed ? 'removed' : 'nothing registered'}\n`);

  if (unlinkFromPath(ctx.env)) io.stdout(`path:    removed ${pathLinkFile(ctx.env)}\n`);

  const menubar = removeMenubarPlugin(ctx.configDir);
  if (menubar !== null) io.stdout(`menubar: removed ${menubar}\n`);

  rmSync(daemonFilePath(ctx.configDir), { force: true });

  if (flags.purge) {
    rmSync(ctx.configDir, { recursive: true, force: true });
    rmSync(dataDir(ctx.env), { recursive: true, force: true });
    if (ctx.platform === 'darwin') rmSync(macLogDir(ctx.env), { recursive: true, force: true });
    io.stdout(`purged:  ${ctx.configDir}, ${dataDir(ctx.env)}\n`);
  } else {
    io.stdout(`kept:    ${ctx.configDir} (config, state and logs) — re-run with --purge to delete them\n`);
  }
  return 0;
}
