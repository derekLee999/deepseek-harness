# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

Desktop shell for the DeepSeek Harness Web GUI: an Electron window over the real `dsh web` server, with a tray icon that owns app lifetime. The shell never serves the GUI itself — it supervises the same CLI Web boot a browser tab would connect to, so the GUI it shows is byte-identical to the browser product.

## Run

From the repository root, after a build:

```sh
pnpm run desktop
```

The command builds first (like `pnpm run test:web`), then launches the Electron window. With built artifacts already present, `pnpm --filter @deepseek-ai/dsh-desktop run start` launches directly.

## Behavior

- The host and port come from the composed web profile, exactly as `dsh web` resolves them; on a busy port the Web boot fails loud with its bind diagnostic.
- Closing the window hides it to the tray; the server and its sessions keep running. Tray click or the tray's Open item restores the window; the tray's Quit item stops the server and exits.
- One instance only: launching the app again focuses (and re-shows) the existing window.
- Same-origin popups open in the app; external `http(s)` links go to the system browser.

## Environment seams

| Variable | Default | Purpose |
|---|---|---|
| `DSH_DESKTOP_NODE` | `node` | Node binary that runs the supervised `dsh web` host. |
| `DSH_DESKTOP_CLI_JS` | resolved beside `@deepseek-ai/dsh` | The built CLI entry (`lib/bin.js`) to spawn. |
| `DSH_DESKTOP_WEB_ARGS` | (none) | Extra `dsh web` arguments, split on whitespace — `--port 0` pins a free port. |
| `DSH_DESKTOP_DEVTOOLS` | (none) | `1` opens the window's DevTools on load. |

## Development

The unit lane (`apps/desktop/tests/web-host.spec.ts`) covers readiness-line parsing and override resolution; `pnpm run test:desktop` builds the repository and runs the real Electron shell over the real server and dist, asserting boot-manifest delivery, the full UI mount, close→hidden-not-quit, restore, and quit→server-stopped.

## Known Limitations and Deferred Work

- **Distribution is deferred**: the app is a workspace assembly with no bin or installer, and Electron is a devDependency, so the published npm package is not a launchable product yet; single-exe packaging moves Electron to a runtime dependency.
- **Native conventions are minimal**: macOS keeps the Dock icon and tray together; Windows/Linux remove the application menu (DevTools via `DSH_DESKTOP_DEVTOOLS=1`).
- The test lane needs a desktop session and a full build, so it is not part of the default CI jobs.