# Agent Note: Desktop Electron shell supervises the real `dsh web` server with close-to-tray

Status: implemented

English | [中文](2026-08-15-desktop-electron-shell.zh.md)

## Problem

No desktop delivery existed: users ran `dsh web` in a browser tab, and the [layering note](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md) only anticipated an Electron client that reuses the web client packages over an IPC fetch carrier. An IPC carrier is a second transport — fetch, SSE, WebSocket downlink, and `window.__DSH_BOOT__` injection over `file://` pages — duplicating the carrier layer for a first shell that has no second consumer. A desktop shell also needs lifetime semantics of its own: closing the window chrome must not end the sessions the server is running.

## Decision

`apps/desktop` (`@deepseek-ai/dsh-desktop`) is the desktop shell: an Electron main process that spawns the real CLI Web boot as a child (`node <dsh>/lib/bin.js web`), treats the existing readiness line `dsh web: http://127.0.0.1:<port>` as its supervisor contract (the line the CLI already documents for supervisors), and opens one BrowserWindow at that URL. The GUI is therefore the byte-identical same-origin HTTP carrier plus WebSocket downlink plus boot-manifest injection that browsers get; the web stack needed no changes, and the shell never serves the GUI itself.

Lifetime: a single-instance lock makes a second launch focus (and re-show) the existing window; the window's `close` event is prevented and hides the window to the tray; the tray's click and Open item re-show it, and its Quit item calls `app.quit()`, which sets the quit flag in `before-quit` so the close proceeds, then stops the child (SIGTERM, SIGKILL after a 2 s grace). A child exit before its readiness line ends the app with an error dialog; a child exit after readiness also quits — the shell without its server is not a product state. `window-all-closed` never quits: the tray owns app lifetime.

The spawn layout resolves from the `@deepseek-ai/dsh` package manifest beside `lib/bin.js`, with explicit deployment seams: `DSH_DESKTOP_NODE` (Node binary, default `node`), `DSH_DESKTOP_CLI_JS` (CLI entry override), `DSH_DESKTOP_WEB_ARGS` (extra `dsh web` arguments, whitespace-split — `--port 0` is how a user or a test pins a free port), and `DSH_DESKTOP_DEVTOOLS=1` (open the window's DevTools). The composed web profile owns host and port; the shell passes no port unless the override names one. The window-open policy allows same-origin popups, sends external `http(s)` links to the system browser, and denies everything else.

Build follows the apps/cli pattern: the tsconfig sits in the host aggregate (types to `lib/types`), the root tsdown workspace bundles `lib/types/main.js` into `lib/main.js` with `electron` external, and `pnpm run desktop` rebuilds before launching. Assembly facts (tray icon path, CLI entry resolution) live in the app; nothing in `packages/` changed.

## Alternatives considered

- **An IPC fetch carrier over a `file://` dist** (the earlier anticipated design): rejected for the first shell — reimplementing fetch, SSE, WebSocket, and boot-manifest injection for a second transport with no second consumer is the costliest hand-roll in the GUI stack; `AbstractApiClient`'s [subclass seat](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md) keeps the option open without carrying the cost.
- **Booting the profile in-process** (`runProfile` inside Electron main): rejected — the CLI's signal handlers, fail-loud process hooks, and exit semantics would run inside Electron's main process; a child process keeps the boot byte-identical to `dsh web` and confined to plain Node.
- **A shell-owned file server**: rejected — only `dsh web` injects `window.__DSH_BOOT__`; a replacement server white-screens the GUI.
- **Electron as a runtime dependency**: rejected for now — the published package has no launch entry yet (bin and installer packaging is deferred), and a hard dependency would download the Electron binary on every CI install; it moves to `dependencies` together with that packaging work.
- **Driving the smoke through Playwright's `_electron` launcher**: rejected — its main-process inspector sequence exits Electron 36+ during attach ([electron#47419](https://github.com/electron/electron/issues/47419)), and Electron 43 exposes no usable renderer DevTools HTTP endpoint either way. The lane speaks the main-process inspector protocol itself: a small in-test CDP client over `--inspect=0` evaluates in the main process, where `require("electron")` reaches window state, close/show, quit, and `webContents.executeJavaScript` reaches the rendered page.

## Consequences

- The desktop GUI is the same composition and dist the browser loads, so the existing web e2e lane stays the authoritative GUI contract; the desktop adds only supervision and window/tray semantics.
- Closing the window always keeps the server and sessions alive in the tray; quitting through the tray cleans up both processes, verified by the e2e lane asserting the server stops serving after quit.
- Verification: the unit lane covers readiness-line parsing and override resolution; `pnpm run test:desktop` builds and then runs the real Electron shell over the real built server and dist, asserting the boot manifest, the full UI mount, close→hidden-not-quit, restore, and quit→server-dead. The shell's main entry registers `whenReady` through an event-style `void app.whenReady().then(...)` chain rather than a top-level await, because an Electron ESM entry whose top-level `await app.whenReady()` gates the boot never resolves in Electron 43. The lane's own inspector attachment is the process's last external anchor, so the quit assertion drops it after delivering `app.quit()`. The lane needs a desktop session and is not part of the default CI jobs.
- Costs: a new app workspace joins the apps/cli wiring (constraints files policy, knip section, host aggregate reference, tsdown workspace list, third-party notices), and installs an Electron devDependency (~120 MB binary, allowed explicitly in `pnpm-workspace.yaml`).
- The webserver's "servers browsers only" claim and the layering note's Electron rows now state the supervised same-origin reuse; the IPC carrier remains a hypothetical subclass in the protocol table.
- Deferred: standalone packaging (single exe/app, installer, auto-update), macOS dock conventions (⌘Q quits, tray click re-shows), and the IPC carrier should a consumer ever need a non-HTTP transport.