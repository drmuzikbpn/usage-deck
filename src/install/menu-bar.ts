// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { recordedPlugin, runMenubar } from '../menubar.js';
import type { ExecRunner } from '../service/index.js';
import type { Prompter } from './plan.js';

/**
 * §23.73: install looks for the app the menu bar item needs (§23.66) and offers SwiftBar when
 * neither it nor xbar is there. It is another project's app, so the default answer is no and
 * nothing is installed unasked. The install has already succeeded: nothing here fails it.
 */

export const SWIFTBAR_URL = 'https://github.com/swiftbar/SwiftBar/releases/latest';
const BREW_BINS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const BREW_ARGS = ['install', '--cask', 'swiftbar'] as const;
const BREW_COMMAND = `brew ${BREW_ARGS.join(' ')}`;
const OPEN_BIN = '/usr/bin/open';
const ADD_LATER = 'claude-usage menubar --install';

export interface MenuBarOffer {
  platform: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  binPath: string;
  exec: ExecRunner;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  findApp: () => string | null;
  findBrew: () => string | null;
  /** Absent when nobody is at the terminal, or with `--yes`. */
  ask?: Prompter;
}

/** By absolute path, never from the PATH. */
export function findBrew(): string | null {
  return BREW_BINS.find((path) => existsSync(path)) ?? null;
}

export async function offerMenuBar(o: MenuBarOffer): Promise<void> {
  if (o.platform !== 'darwin') return;
  const say = (line: string): void => o.stdout(`menu bar: ${line}\n`);

  const app = o.findApp();
  if (app !== null) {
    const plugin = recordedPlugin(o.configDir);
    if (plugin !== null && existsSync(plugin)) return;
    say(
      basename(app) === 'xbar.app'
        ? `xbar is installed; add the item with ${ADD_LATER} --dir <xbar's plugin folder>`
        : `SwiftBar is installed; add the item with ${ADD_LATER}`,
    );
    return;
  }

  const brew = o.findBrew();
  const how = brew === null ? `get it from ${SWIFTBAR_URL}` : BREW_COMMAND;
  if (o.ask === undefined) {
    say(`SwiftBar isn't installed (optional); ${how}, then ${ADD_LATER}`);
    return;
  }

  if (brew === null) {
    if (await o.ask("SwiftBar isn't installed. Open its download page to see your limits in the menu bar?", false)) {
      await run(o, OPEN_BIN, [SWIFTBAR_URL]);
      say(`once SwiftBar is installed and open, run ${ADD_LATER}`);
    } else {
      say(`skipped; to add it later, ${how}, then ${ADD_LATER}`);
    }
    return;
  }

  if (!(await o.ask("SwiftBar isn't installed. Install it with Homebrew to see your limits in the menu bar?", false))) {
    say(`skipped; to add it later, ${how}, then ${ADD_LATER}`);
    return;
  }
  say('installing SwiftBar with Homebrew, which can take a minute');
  if (!(await run(o, brew, BREW_ARGS))) {
    say(`could not install SwiftBar; try ${BREW_COMMAND} yourself, then ${ADD_LATER}`);
    return;
  }
  say('SwiftBar installed');
  await run(o, OPEN_BIN, ['-a', 'SwiftBar']);
  const ask = o.ask;
  const add = await ask(
    'SwiftBar is opening. If it asks for a plugin folder, pick one, then answer yes to add the menu bar item. Add it?',
    true,
  );
  if (!add) {
    say(`to add the item later, run ${ADD_LATER}`);
    return;
  }
  try {
    await runMenubar(['--install'], {
      stdout: o.stdout,
      stderr: o.stderr,
      configDir: o.configDir,
      env: o.env,
      nodePath: o.nodePath,
      binPath: o.binPath,
      exec: o.exec,
      menuBarApp: o.findApp(),
      confirm: (question) => ask(question, false),
    });
  } catch {
    say(`could not add the item; run ${ADD_LATER}`);
  }
}

async function run(o: MenuBarOffer, file: string, args: readonly string[]): Promise<boolean> {
  try {
    return (await o.exec(file, args)).code === 0;
  } catch {
    return false;
  }
}
