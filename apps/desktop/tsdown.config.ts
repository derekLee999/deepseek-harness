import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships one Electron main-process entry, bundled from the
 * tsc-emitted tree (the same apps/cli pattern). `electron` is the runtime the
 * bundle loads inside and must never be folded into the bundle; tsdown's node
 * externalization keeps it an import. Declarations come from `tsc -b`
 * (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/^electron$/],
})