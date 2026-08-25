/**
 * Which commit this build came from.
 *
 * Rewritten by `scripts/build-info.mjs` during a CI build, and left alone
 * locally so a developer's tree never goes dirty from running the build.
 * Reported by /api/health, which is how the smoke test knows whether the
 * deployment it is about to test is actually running the code under test.
 */
export const BUILD_COMMIT = 'dev'
