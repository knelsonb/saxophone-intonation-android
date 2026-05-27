/**
 * legacy-tests.js — runs the pre-Jest unit tests via node --experimental-strip-types.
 *
 * These tests were written before the Jest harness existed and rely on
 * process.exit(1) / console.log for pass/fail reporting.  They cannot be
 * picked up by Jest directly (they use `.ts` extensions with raw TS imports
 * and no module transform), so we shell them out here and let Jest run the
 * .tsx / .test.tsx files separately.
 *
 * Some test files transitively import `@local/*` Expo native modules that
 * have no bare-JS stub (they are Metro-only).  The `--import` flag loads
 * legacy-test-loader.js first, which registers an ESM resolve hook that
 * returns empty stubs for those packages before any test file is parsed.
 * This mirrors the same native-module mocking Jest does via jest.setup.js.
 *
 * Invoked by:  node ./scripts/legacy-tests.js
 * Called from: the "test" script in package.json before `jest`.
 */

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, '..', 'src', '__tests__');
const loaderPath = join(__dirname, 'legacy-test-loader.js');

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join(testsDir, f));

if (files.length === 0) {
  console.log('[legacy-tests] No .test.ts files found — skipping.');
  process.exit(0);
}

let allPassed = true;

for (const file of files) {
  console.log(`\n[legacy-tests] Running: ${file}`);
  const result = spawnSync(
    process.execPath,
    [
      '--import', loaderPath,
      '--experimental-strip-types',
      file,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`[legacy-tests] FAILED: ${file}`);
    allPassed = false;
    // Mirror the original for-loop semantics: exit immediately on first failure.
    process.exit(1);
  }
}

if (allPassed) {
  console.log('\n[legacy-tests] All legacy tests passed.');
}
