/**
 * Deployment overrides for the desktop shell. Every override is an explicit
 * environment seam a supervisor or test can set; production runs take the
 * defaults resolved from this package's own layout.
 * @module @deepseek-ai/dsh-desktop/paths
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Environment variable naming the Node binary that runs the supervised `dsh web` host. */
const DSH_DESKTOP_NODE = 'DSH_DESKTOP_NODE'
/** Environment variable naming the built `dsh` CLI entry (`lib/bin.js`) the supervisor spawns. */
const DSH_DESKTOP_CLI_JS = 'DSH_DESKTOP_CLI_JS'
/** Environment variable carrying extra `dsh web` arguments, split on whitespace. */
const DSH_DESKTOP_WEB_ARGS = 'DSH_DESKTOP_WEB_ARGS'
/** Environment variable set to `1` to open the window's DevTools once the page finishes loading. */
const DSH_DESKTOP_DEVTOOLS = 'DSH_DESKTOP_DEVTOOLS'

/** Snapshot of the deployment overrides {@link readDesktopEnv} resolves. */
export interface DesktopEnv {
  /** Command the supervisor spawns on the web host (the first arg is the CLI entry). */
  nodeCommand: string
  /** Leading spawn arguments: the CLI entry and the `web` subcommand. */
  cliArgs: string[]
  /** Extra `dsh web` arguments from {@link DSH_DESKTOP_WEB_ARGS}. */
  webArgs: string[]
  /** Whether the window opens its DevTools on load. */
  devtools: boolean
}

/** Resolve flag extras the user can set in {@link DSH_DESKTOP_WEB_ARGS}. */
export function splitExtraWebArgs(raw: string | undefined): string[] {
  const value = raw ?? ''
  return value.split(/\s+/).filter(argument => argument.length > 0)
}

/**
 * Resolve the built CLI entry from the `dsh` package this shell declares as a
 * dependency (`lib/bin.js` beside the package manifest). The override is for
 * layouts that do not install the package normally.
 * @param env - the raw process environment.
 * @param resolve - package-specifier resolver (injectable for tests).
 * @returns the CLI entry path to spawn.
 */
export function resolveCliEntry(
  env: Record<string, string | undefined>,
  resolve: (specifier: string) => string,
): string {
  const override = env[DSH_DESKTOP_CLI_JS]
  if (override !== undefined && override !== '') return override
  // The layout fact for the default: NODE runs the bin beside the CLI package
  // manifest, so the desktop shell need not know the CLI's entry file name.
  return join(resolve('@deepseek-ai/dsh/package.json'), '..', 'lib', 'bin.js')
}

/**
 * Resolve the shell's deployment overrides.
 * @param env - the raw process environment.
 * @param resolve - package-specifier resolver (injectable for tests).
 * @returns the resolved environment snapshot.
 */
export function readDesktopEnv(
  env: Record<string, string | undefined>,
  resolve: (specifier: string) => string,
): DesktopEnv {
  const nodeOverride = env[DSH_DESKTOP_NODE]
  return {
    nodeCommand: nodeOverride !== undefined && nodeOverride !== '' ? nodeOverride : 'node',
    cliArgs: [resolveCliEntry(env, resolve), 'web'],
    webArgs: splitExtraWebArgs(env[DSH_DESKTOP_WEB_ARGS]),
    devtools: env[DSH_DESKTOP_DEVTOOLS] === '1',
  }
}

/** Absolute path of the tray icon the shell ships (`assets/tray.png`). */
export const TRAY_ICON_PATH = fileURLToPath(new URL('../assets/tray.png', import.meta.url))

/** Absolute path of the application icon the shell ships (`assets/icon.png`). */
export const APP_ICON_PATH = fileURLToPath(new URL('../assets/icon.png', import.meta.url))

/** Read the process environment of the running shell. */
export function readShellEnvironment(): DesktopEnv {
  return readDesktopEnv(process.env, createRequire(import.meta.url).resolve)
}
