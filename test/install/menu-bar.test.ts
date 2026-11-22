// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { offerMenuBar, SWIFTBAR_URL, type MenuBarOffer } from '../../src/install/menu-bar.js';
import { findMenuBarApp, PLUGIN_FILE, PLUGIN_RECORD } from '../../src/menubar.js';
import { cleanupAllTempHomes, fakeExec, scriptedPrompter, tempHome, type ExecResponder } from './helpers.js';

afterAll(cleanupAllTempHomes);

const APP = '/Applications/SwiftBar.app';
const BREW = '/opt/homebrew/bin/brew';
const INSTALL = "SwiftBar isn't installed. Install it with Homebrew to see your limits in the menu bar?";
const PAGE = "SwiftBar isn't installed. Open its download page to see your limits in the menu bar?";
const ADD = 'SwiftBar is opening. If it asks for a plugin folder, pick one, then answer yes to add the menu bar item. Add it?';

async function offer(
  opts: {
    platform?: string;
    apps?: Array<string | null>;
    brew?: string | null;
    answers?: boolean[] | null;
    respond?: ExecResponder;
    plugin?: 'there' | 'gone';
  } = {},
): Promise<{ out: string; questions: string[]; lines: string[]; folder: string; configDir: string }> {
  const h = tempHome();
  const folder = join(h.home, 'plugins');
  mkdirSync(h.configDir, { recursive: true });
  if (opts.plugin !== undefined) {
    const file = join(h.home, 'plugin.sh');
    if (opts.plugin === 'there') writeFileSync(file, '');
    writeFileSync(join(h.configDir, PLUGIN_RECORD), `${file}\n`);
  }
  const exec = fakeExec(opts.respond ?? ((file) => (file === '/usr/bin/defaults' ? { stdout: `${folder}\n` } : undefined)));
  const scripted = scriptedPrompter(opts.answers ?? []);
  const apps = [...(opts.apps ?? [null])];
  let out = '';
  const o: MenuBarOffer = {
    platform: opts.platform ?? 'darwin',
    configDir: h.configDir,
    env: h.env,
    nodePath: '/n',
    binPath: '/b',
    exec: exec.runner,
    stdout: (t) => (out += t),
    stderr: (t) => (out += t),
    findApp: () => (apps.length > 1 ? (apps.shift() ?? null) : (apps[0] ?? null)),
    findBrew: () => (opts.brew === undefined ? BREW : opts.brew),
    ...(opts.answers === null ? {} : { ask: scripted.prompt }),
  };
  await offerMenuBar(o);
  return { out, questions: scripted.questions, lines: exec.lines(), folder, configDir: h.configDir };
}

describe('install: the menu bar app', () => {
  it('does nothing off macOS', async () => {
    const r = await offer({ platform: 'linux' });
    expect([r.out, r.questions, r.lines]).toEqual(['', [], []]);
  });

  it('asks nothing when SwiftBar and our plugin are both there', async () => {
    const r = await offer({ apps: [APP], plugin: 'there' });
    expect([r.out, r.questions, r.lines]).toEqual(['', [], []]);
  });

  it('asks nothing when SwiftBar is there without our plugin, and says how to add it', async () => {
    const r = await offer({ apps: [APP] });
    expect([r.questions, r.lines]).toEqual([[], []]);
    expect(r.out).toContain('claude-usage menubar --install');
    expect(r.out).not.toContain('--dir');
  });

  it('says how to add our plugin back when its file is gone', async () => {
    expect((await offer({ apps: [APP], plugin: 'gone' })).out).toContain('claude-usage menubar --install');
  });

  it('tells an xbar user to name the folder', async () => {
    const r = await offer({ apps: ['/Applications/xbar.app'] });
    expect(r.questions).toEqual([]);
    expect(r.out).toContain('claude-usage menubar --install --dir');
  });

  it('offers SwiftBar with "no" as the default, and a "no" runs nothing', async () => {
    const r = await offer();
    expect(r.questions).toEqual([INSTALL]);
    expect(r.lines).toEqual([]);
    expect(r.out).toContain('brew install --cask swiftbar');
  });

  it('installs it, opens it, and adds the menu bar item', async () => {
    const r = await offer({ apps: [null, '/opt/apps/SwiftBar.app'], answers: [true, true, true] });
    expect(r.questions.slice(0, 2)).toEqual([INSTALL, ADD]);
    expect(r.lines.slice(0, 2)).toEqual([`${BREW} install --cask swiftbar`, '/usr/bin/open -a SwiftBar']);
    expect(existsSync(join(r.folder, PLUGIN_FILE))).toBe(true);
    expect(existsSync(join(r.configDir, PLUGIN_RECORD))).toBe(true);
    expect(r.questions[2]).toContain('Start SwiftBar at login');
    expect(r.lines.at(-1)).toContain('/opt/apps/SwiftBar.app');
  });

  it('leaves the menu bar item for later when asked to', async () => {
    const r = await offer({ apps: [null, APP], answers: [true, false] });
    expect(existsSync(join(r.folder, PLUGIN_FILE))).toBe(false);
    expect(r.out).toContain('claude-usage menubar --install');
  });

  it('says what to do when no plugin folder was picked', async () => {
    const r = await offer({
      apps: [null, APP],
      answers: [true, true],
      respond: (file) => (file === '/usr/bin/defaults' ? { code: 1 } : undefined),
    });
    expect(r.out).toContain('no plugin folder yet');
  });

  it('offers SwiftBar once, even when it cannot be found afterwards', async () => {
    const r = await offer({ answers: [true, true, true, true] });
    expect(r.questions).toEqual([INSTALL, ADD]);
  });

  it('a failed Homebrew install opens nothing and says how to retry', async () => {
    const r = await offer({ answers: [true], respond: (file) => (file === BREW ? { code: 1, stderr: 'no network' } : undefined) });
    expect(r.lines).toEqual([`${BREW} install --cask swiftbar`]);
    expect(r.questions).toEqual([INSTALL]);
    expect(r.out).toContain('could not install SwiftBar');
    expect(r.out).toContain('brew install --cask swiftbar');
  });

  it('without Homebrew, offers the download page instead', async () => {
    const r = await offer({ brew: null, answers: [true] });
    expect(r.questions).toEqual([PAGE]);
    expect(r.lines).toEqual([`/usr/bin/open ${SWIFTBAR_URL}`]);
    expect(r.out).toContain('claude-usage menubar --install');
  });

  it('without Homebrew, a "no" names the download page', async () => {
    const r = await offer({ brew: null });
    expect(r.lines).toEqual([]);
    expect(r.out).toContain(SWIFTBAR_URL);
  });

  it('with nobody to ask, installs nothing and prints one line', async () => {
    const r = await offer({ answers: null });
    expect(r.lines).toEqual([]);
    expect(r.out.trim().split('\n')).toHaveLength(1);
    expect(r.out).toContain('brew install --cask swiftbar');
  });

  it('never fails the install', async () => {
    const r = await offer({
      answers: [true],
      respond: () => {
        throw new Error('spawn blew up');
      },
    });
    expect(r.out).toContain('could not install SwiftBar');
  });
});

describe('findMenuBarApp', () => {
  it("finds an app in the user's own Applications folder", () => {
    const h = tempHome();
    const app = join(h.home, 'Applications', 'SwiftBar.app');
    mkdirSync(app, { recursive: true });
    expect(findMenuBarApp(h.env, join(h.home, 'none'))).toBe(app);
    expect(findMenuBarApp(tempHome().env, join(h.home, 'none'))).toBeNull();
  });

  it('looks in the system folder first, and takes xbar when SwiftBar is absent', () => {
    const h = tempHome();
    const system = join(h.home, 'System');
    mkdirSync(join(system, 'xbar.app'), { recursive: true });
    expect(findMenuBarApp(h.env, system)).toBe(join(system, 'xbar.app'));
    mkdirSync(join(system, 'SwiftBar.app'));
    expect(findMenuBarApp(h.env, system)).toBe(join(system, 'SwiftBar.app'));
  });
});
