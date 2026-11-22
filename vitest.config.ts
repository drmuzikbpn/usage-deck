// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], globalSetup: 'test/helpers/temp-root.ts', testTimeout: 15000, pool: 'forks' } });
