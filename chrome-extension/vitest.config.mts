import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit-test runner for the background service-worker logic. Scope is the
// pure, money-path modules first (fee floors, RPC failover, chain config) —
// the code that decides what gets signed and broadcast. `node` environment:
// these units have no DOM dependency. Tests that exercise modules importing
// chrome.* (via @extension/*) mock those imports with `vi.mock` per-file.
const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // The workspace packages declare `main: ./dist/index.js`, which isn't
    // built during tests. Point at their TS source so vitest can resolve
    // the imports. Modules whose real source touches browser globals are
    // additionally `vi.mock`-ed at the top of the test that imports them.
    alias: {
      '@extension/storage': fromHere('../packages/storage/index.ts'),
      '@extension/shared': fromHere('../packages/shared/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
