import { defineConfig } from 'vitest/config'

/**
 * The desktop shell's e2e lane: its own config because the default test lane
 * and the keyed e2e lane must not launch Electron. Ran by `pnpm run
 * test:desktop` after a full build (it boots the built main bundle over the
 * built GUI dist). No cordis setup files — this lane exercises the assembled
 * product through process boundaries; Electron needs a desktop session.
 */
export default defineConfig({
  test: {
    include: ['apps/desktop/tests/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})