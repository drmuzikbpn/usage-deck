// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DaemonClient, isPidAlive, readDaemonInfo } from './clients/http.js';
import { resolveConfigDir } from './config.js';
import { HEADLINE_IDS, type SummaryBody } from './hook.js';
import type { LimitStatus } from './limits/status.js';
import type { NormalizedLimit } from './limits/types.js';
import { defaultExec, type ExecRunner } from './service/index.js';

/**
 * §23.66: the macOS menu-bar item, as a SwiftBar (or xbar) plugin. `claude-usage menubar`
 * prints the plugin's output; `--install` writes a small shell script into SwiftBar's plugin
 * folder that runs it every minute. The script calls node and the `current` bin by absolute
 * path, because SwiftBar does not run plugins with the user's shell PATH.
 */

export const MENUBAR_TIMEOUT_MS = 2000;
/** A reading older than this is called stale in the menu-bar title. */
export const MENUBAR_STALE_MS = 15 * 60 * 1000;
/** `<n>m` is SwiftBar's refresh interval, taken from the file name. */
export const PLUGIN_FILE = 'claude-usage.1m.sh';
/** Marks a plugin file as ours, so uninstall never removes someone else's. */
export const PLUGIN_MARKER = '# claude-usage menubar plugin';
/** `<configDir>/menubar-plugin` holds the absolute path `--install` wrote to. */
export const PLUGIN_RECORD = 'menubar-plugin';
const DEFAULTS_BIN = '/usr/bin/defaults';
export const REPO_URL = 'https://github.com/drmuzikbpn/usage-deck';
export const APP_STORE_URL = 'https://apps.apple.com/us/app/usage-deck/id6818383053';
export const ABOUT_DESC =
  'Your Claude account limits and the claude-usage service, in the menu bar. Works with Claude Code. Not affiliated with, endorsed by, or sponsored by Anthropic.';

const SHORT_LABELS: Record<string, string> = { session: '5h', weekly_all: '7d' };
/**
 * No text colours anywhere: the menu bar and the dropdown are both translucent, and coloured
 * text was unreadable on them (red on a blue menu bar, red on a red wallpaper). Status goes
 * in a leading dot instead, which reads on any background.
 */
const DOTS: Record<LimitStatus, string> = { ok: '🟢 ', warn: '🟠 ', critical: '🔴 ' };

export type MenubarState =
  | { running: false }
  | { running: true; version: string; summary: SummaryBody | null };

/** SwiftBar treats `|` as the start of its parameters; keep it out of menu text. */
const clean = (text: string): string => text.replace(/\|/g, '/');

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ${min % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

function resets(iso: string | null, now: number): string {
  if (iso === null) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return ' · resetting';
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return ` · resets in ${h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${min % 60}m`}`;
}

/** A dropdown row for one limit. Unknown is not fine: a green dot beside `?%` is a contradiction. */
function limitRow(limit: NormalizedLimit, label: string, status: LimitStatus | undefined, now: number): string {
  if (limit.percent === null) return info(`⚪ ${label}: waiting for a reading`);
  return info(`${DOTS[status ?? 'ok']}${label}: ${limit.percent}%${resets(limit.resetsAt, now)}${limit.stale === true ? ' ⚠︎' : ''}`);
}

/** Single-quote for the plugin's `sh` script. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A dropdown row with no action is drawn disabled, in faint grey that disappears on the
 * translucent menu. `refresh=true` gives it one, so it gets the normal menu text colour.
 */
const info = (text: string): string => `${clean(text)} | refresh=true`;

function action(label: string, plugin: string | null, args: readonly string[]): string {
  if (plugin === null) return `${label} | color=gray`;
  const params = args.map((a, i) => `param${i + 1}=${a}`).join(' ');
  return `${label} | bash="${plugin.replace(/"/g, '')}" ${params} terminal=false refresh=true`;
}

/** The plugin output: a title line, `---`, then the dropdown menu. Pure, for tests. */
export function renderMenubar(state: MenubarState, now: number, plugin: string | null): string {
  const lines: string[] = [];
  if (!state.running) {
    lines.push('🔴 Claude ⏹');
    lines.push('---');
    lines.push(info('claude-usage: stopped'));
    lines.push(action('Start daemon', plugin, ['service', 'start']));
  } else {
    const parts: string[] = [];
    const menu: string[] = [];
    let newest = Number.NEGATIVE_INFINITY;
    let stale = false;
    const summary = state.summary;
    for (const id of HEADLINE_IDS) {
      const limit = summary?.limits.limits.find((l) => l.id === id);
      if (limit === undefined) continue;
      const pct = limit.percent === null ? '?%' : `${limit.percent}%`;
      parts.push(`${SHORT_LABELS[id] ?? id} ${pct}`);
      menu.push(limitRow(limit, SHORT_LABELS[id] ?? id, summary?.status.byId[id], now));
      if (limit.stale === true) stale = true;
      const at = typeof limit.asOf === 'string' ? Date.parse(limit.asOf) : Number.NaN;
      if (Number.isFinite(at)) newest = Math.max(newest, at);
    }
    if (Number.isFinite(newest) && now - newest > MENUBAR_STALE_MS) stale = true;

    const dot = DOTS[summary?.status.overall ?? 'ok'];
    const title = parts.length === 0 ? 'Claude …' : `${dot}${parts.join(' · ')}${stale ? ' ⚠︎' : ''}`;
    lines.push(clean(title));
    lines.push('---');
    lines.push(info(`claude-usage: running (${state.version === '' ? 'version unknown' : state.version})`));
    if (summary === null) lines.push(info('🔴 Not answering'));
    lines.push(...menu);
    // Every other limit too: they count toward the title's dot, so it must be explainable here.
    for (const limit of summary?.limits.limits ?? []) {
      if ((HEADLINE_IDS as readonly string[]).includes(limit.id)) continue;
      const label = limit.scope?.model ?? limit.id.replace(/^weekly_scoped:/, '');
      lines.push(limitRow(limit, label, summary?.status.byId[limit.id], now));
    }
    if (Number.isFinite(newest)) {
      lines.push(info(`${stale ? '⚠︎ Stale: updated' : 'Updated'} ${ago(now - newest)}`));
    } else if (parts.length > 0 && stale) {
      lines.push(info('⚠︎ Stale reading'));
    }
    lines.push('---');
    lines.push(action('Stop daemon', plugin, ['service', 'stop']));
  }
  lines.push('Refresh | refresh=true');
  lines.push('---');
  lines.push('About Usage Deck');
  lines.push(`--${clean(state.running ? `claude-usage ${state.version}` : 'claude-usage')} | refresh=true`);
  lines.push('--Not affiliated with Anthropic | refresh=true');
  lines.push(`--GitHub | href=${REPO_URL}`);
  lines.push(`--iPhone and Apple Watch app | href=${APP_STORE_URL}`);
  return `${lines.join('\n')}\n`;
}

function isSummary(v: unknown): v is SummaryBody {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  const limits = rec['limits'] as { limits?: unknown } | null | undefined;
  return typeof limits === 'object' && limits !== null && Array.isArray(limits.limits) && typeof rec['status'] === 'object' && rec['status'] !== null;
}

export interface MenubarIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  configDir?: string;
  client?: { get(path: string, opts?: { timeoutMs?: number }): Promise<unknown> };
  env?: NodeJS.ProcessEnv;
  exec?: ExecRunner;
  now?: number;
  nodePath?: string;
  binPath?: string;
}

/** What the plugin shows right now. Never throws: SwiftBar would show the stack instead. */
export async function readMenubarState(io: Pick<MenubarIO, 'configDir' | 'client'>): Promise<MenubarState> {
  const configDir = io.configDir ?? resolveConfigDir();
  const info = readDaemonInfo(configDir);
  if (info === null || !isPidAlive(info.pid)) return { running: false };
  try {
    const client = io.client ?? new DaemonClient({ configDir, timeoutMs: MENUBAR_TIMEOUT_MS });
    const body = await client.get('/v1/summary', { timeoutMs: MENUBAR_TIMEOUT_MS });
    return { running: true, version: info.version, summary: isSummary(body) ? body : null };
  } catch {
    return { running: true, version: info.version, summary: null };
  }
}

export function pluginScript(nodePath: string, binPath: string): string {
  return [
    '#!/bin/sh',
    PLUGIN_MARKER,
    '# Written by `claude-usage menubar --install`; removed by `claude-usage uninstall`.',
    '# <xbar.title>Usage Deck</xbar.title>',
    '# <xbar.author>Even Seal Productions</xbar.author>',
    '# <xbar.author.github>drmuzikbpn</xbar.author.github>',
    `# <xbar.desc>${ABOUT_DESC}</xbar.desc>`,
    `# <xbar.abouturl>${REPO_URL}</xbar.abouturl>`,
    '# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>',
    `if [ "$#" -gt 0 ]; then exec ${shQuote(nodePath)} ${shQuote(binPath)} "$@"; fi`,
    `exec ${shQuote(nodePath)} ${shQuote(binPath)} menubar --plugin "$0"`,
    '',
  ].join('\n');
}

async function swiftBarPluginDir(exec: ExecRunner): Promise<string | null> {
  const r = await exec(DEFAULTS_BIN, ['read', 'com.ameba.SwiftBar', 'PluginDirectory']);
  const dir = r.stdout.trim();
  return r.code === 0 && isAbsolute(dir) ? dir : null;
}

/** Remove the plugin `--install` recorded, if it is still ours. Returns the removed path. */
export function removeMenubarPlugin(configDir: string): string | null {
  const record = join(configDir, PLUGIN_RECORD);
  let path: string;
  try {
    path = readFileSync(record, 'utf8').trim();
  } catch {
    return null;
  }
  rmSync(record, { force: true });
  try {
    if (!isAbsolute(path) || !readFileSync(path, 'utf8').includes(PLUGIN_MARKER)) return null;
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  return path;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `claude-usage menubar [--install [--dir <d>] | --uninstall | --plugin <path>]`. */
export async function runMenubar(argv: readonly string[], io: MenubarIO): Promise<number> {
  const configDir = io.configDir ?? resolveConfigDir();
  if (argv.includes('--uninstall')) {
    const removed = removeMenubarPlugin(configDir);
    io.stdout(removed === null ? 'menubar: no plugin installed\n' : `menubar: removed ${removed}\n`);
    return 0;
  }
  if (argv.includes('--install')) {
    const dir = flagValue(argv, '--dir') ?? (await swiftBarPluginDir(io.exec ?? defaultExec));
    if (dir === undefined || dir === null) {
      io.stderr(
        'claude-usage menubar: SwiftBar has no plugin folder yet. Install it (brew install swiftbar),\n' +
          'open it once and pick a folder, or pass --dir <folder>.\n',
      );
      return 1;
    }
    if (!isAbsolute(dir)) {
      io.stderr('claude-usage menubar: --dir must be an absolute path\n');
      return 1;
    }
    const { currentBin } = await import('./paths.js');
    const nodePath = io.nodePath ?? process.execPath;
    const binPath = io.binPath ?? currentBin(io.env ?? process.env);
    removeMenubarPlugin(configDir);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, PLUGIN_FILE);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, pluginScript(nodePath, binPath), { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
    mkdirSync(dirname(join(configDir, PLUGIN_RECORD)), { recursive: true });
    writeFileSync(join(configDir, PLUGIN_RECORD), `${target}\n`, { mode: 0o600 });
    io.stdout(`menubar: installed ${target}\n`);
    if (!existsSync('/Applications/SwiftBar.app')) io.stdout('menubar: open SwiftBar to see it (brew install swiftbar)\n');
    return 0;
  }
  const plugin = flagValue(argv, '--plugin') ?? null;
  const state = await readMenubarState({ configDir, ...(io.client === undefined ? {} : { client: io.client }) });
  io.stdout(renderMenubar(state, io.now ?? Date.now(), plugin !== null && isAbsolute(plugin) ? plugin : null));
  return 0;
}
