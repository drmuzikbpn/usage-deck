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

/** What getting SwiftBar needs; `ask` is absent when nobody is at the terminal, or with `--yes`. */
export interface SwiftBarOffer {
  exec: ExecRunner;
  stdout: (text: string) => void;
  findBrew: () => string | null;
  ask?: Prompter;
}

export interface MenuBarOffer extends SwiftBarOffer {
  platform: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  binPath: string;
  stderr: (text: string) => void;
  findApp: () => string | null;
}

/** By absolute path, never from the PATH. */
export function findBrew(): string | null {
  return BREW_BINS.find((path) => existsSync(path)) ?? null;
}

/** Offer SwiftBar. True when it was installed and the user wants the item added now. */
export async function getSwiftBar(o: SwiftBarOffer): Promise<boolean> {
  const say = (line: string): void => o.stdout(`menu bar: ${line}\n`);
  const brew = o.findBrew();
  const how = brew === null ? `get it from ${SWIFTBAR_URL}` : BREW_COMMAND;
  if (o.ask === undefined) {
    say(`SwiftBar isn't installed (optional); ${how}, then ${ADD_LATER}`);
    return false;
  }
  const what = brew === null ? 'Open its download page' : 'Install it with Homebrew';
  if (!(await o.ask(`SwiftBar isn't installed. ${what} to see your limits in the menu bar?`, false))) {
    say(`skipped; to add it later, ${how}, then ${ADD_LATER}`);
    return false;
  }
  if (brew === null) {
    await run(o.exec, OPEN_BIN, [SWIFTBAR_URL]);
    say(`once SwiftBar is installed and open, run ${ADD_LATER}`);
    return false;
  }
  say('installing SwiftBar with Homebrew, which can take a minute');
  if (!(await run(o.exec, brew, BREW_ARGS))) {
    say(`could not install SwiftBar; try ${BREW_COMMAND} yourself, then ${ADD_LATER}`);
    return false;
  }
  say('SwiftBar installed');
  await run(o.exec, OPEN_BIN, ['-a', 'SwiftBar']);
  if (
    await o.ask(
      'SwiftBar is opening. If it asks for a plugin folder, pick one, then answer yes to add the menu bar item. Add it?',
      true,
    )
  ) {
    return true;
  }
  say(`to add the item later, run ${ADD_LATER}`);
  return false;
}

/** The last step of `install` on macOS. */
export async function offerMenuBar(o: MenuBarOffer): Promise<void> {
  if (o.platform !== 'darwin') return;
  const app = o.findApp();
  if (app !== null) {
    const plugin = recordedPlugin(o.configDir);
    if (plugin !== null && existsSync(plugin)) return;
    o.stdout(
      basename(app) === 'xbar.app'
        ? `menu bar: xbar is installed; add the item with ${ADD_LATER} --dir <xbar's plugin folder>\n`
        : `menu bar: SwiftBar is installed; add the item with ${ADD_LATER}\n`,
    );
    return;
  }
  if (!(await getSwiftBar(o))) return;
  const ask = o.ask;
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
      swiftBarOffered: true,
      ...(ask === undefined ? {} : { confirm: (question: string, defaultYes = false) => ask(question, defaultYes) }),
    });
  } catch {
    o.stdout(`menu bar: could not add the item; run ${ADD_LATER}\n`);
  }
}

async function run(exec: ExecRunner, file: string, args: readonly string[]): Promise<boolean> {
  try {
    return (await exec(file, args)).code === 0;
  } catch {
    return false;
  }
}
