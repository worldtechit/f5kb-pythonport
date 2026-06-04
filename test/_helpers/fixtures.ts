// ===========================================================================
// TEST HELPER: synchronous fixture loaders rooted at test/fixtures/.
// CATEGORY: unit (support)
// COVERS: n/a (test infrastructure)   FIXTURES: test/fixtures/<relPath>
// NETWORK: none
// ASSERTS: n/a — provides loadFixture / loadJsonFixture for the suite.
// ===========================================================================

// Directory that holds all committed fixtures, resolved relative to THIS file
// so tests work regardless of the process cwd. We decode the file:// URL by
// hand (no @std/path) to keep the helper import-map / network free.
const FIXTURES_DIR = decodeURIComponent(
  new URL("../fixtures/", import.meta.url).pathname,
);

/** Read a fixture file as UTF-8 text. `relPath` is relative to test/fixtures/. */
export function loadFixture(relPath: string): string {
  return Deno.readTextFileSync(FIXTURES_DIR + relPath);
}

/** Read + JSON.parse a fixture file. */
export function loadJsonFixture<T = unknown>(relPath: string): T {
  return JSON.parse(loadFixture(relPath)) as T;
}

/** Absolute path to a fixture (handy for tests that need the path itself). */
export function fixturePath(relPath: string): string {
  return FIXTURES_DIR + relPath;
}
