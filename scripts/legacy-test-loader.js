/**
 * legacy-test-loader.js — Node ESM custom loader / --import hook for the
 * legacy-tests.js runner.
 *
 * PURPOSE: The pure-JS legacy tests run under `node --experimental-strip-types`
 * with no bundler. Some test files transitively import `@local/*` Expo native
 * modules that have no JS stub — they are only resolvable by Metro at build
 * time. When Node tries to resolve them, it throws "Cannot find package".
 *
 * This hook intercepts imports of `@local/*` (and other pure-native packages
 * such as `expo-audio`, `expo-file-system`, `expo-sqlite`,
 * `@react-native-async-storage/async-storage`) and returns an empty module so
 * Node can load the importing file without crashing.
 *
 * Usage (from legacy-tests.js):
 *   spawnSync(node, ['--import', loaderPath, '--experimental-strip-types', file])
 *
 * This is a standard Node.js ESM module customization hook:
 *   https://nodejs.org/api/module.html#customization-hooks
 */

const STUB_PACKAGES = new Set([
  '@local/raw-audio-output',
  '@local/raw-audio-input',
  '@local/auto-mic-claim',
  'expo-audio',
  'expo-file-system',
  'expo-sqlite',
  '@react-native-async-storage/async-storage',
  'react-native',
  'react',
]);

/**
 * resolve hook — intercepts imports whose specifier starts with a known
 * native-only package name and redirects them to `data:` URIs so Node
 * never touches the file system for those packages.
 */
export async function resolve(specifier, context, nextResolve) {
  // Check exact match or scoped-package prefix.
  const isStub = [...STUB_PACKAGES].some(
    (pkg) => specifier === pkg || specifier.startsWith(pkg + '/'),
  );

  if (isStub) {
    // Return a data URI that exports an empty default object.  This satisfies
    // both `import foo from '...'` (default) and `import { x } from '...'`
    // (named — Proxy forwards any key access to undefined gracefully).
    return {
      shortCircuit: true,
      url: `data:text/javascript,export default new Proxy({},{get:()=>()=>{}});`,
    };
  }

  return nextResolve(specifier, context);
}
