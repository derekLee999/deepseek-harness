/**
 * Electron main entry for the desktop shell: a single-instance window over the
 * supervised `dsh web` server, with a tray icon that owns app lifetime.
 * Closing the window hides it to the tray; only the tray's Quit item (or a
 * platform quit gesture) ends the app, first stopping the supervised host.
 *
 * Electron-specific facts stay here; resolution and supervision live in
 * `paths.ts` / `web-host.ts` so the unit lane can test them without Electron.
 * @module @deepseek-ai/dsh-desktop/main
 */

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  shell,
  Tray,
  type NativeImage,
} from 'electron'
import { readShellEnvironment, APP_ICON_PATH, TRAY_ICON_PATH } from './paths.ts'
import { startWebHost } from './web-host.ts'

/** Window title, matching the Web shell's own `<title>`. */
const WINDOW_TITLE = 'DeepSeek Harness'

/**
 * Whether this window's close request must follow the default
 * (destroy-and-Quit) instead of hiding to the tray: only a quit that
 * `before-quit` already announced reaches that state.
 */
let appIsQuitting = false

/** The one BrowserWindow; recreated on second-instance activation after a destroy. */
let windowHandle: BrowserWindow | undefined

/** The supervised web host, if it started. */
let webHost: { stop(): Promise<void> } | undefined

/** The bound Web URL the window loads; set before the window exists. */
let webUrl = ''

/** The application icon, loaded before the first window; every window creation reuses it. */
let windowIcon: NativeImage | undefined

/** This shell's deployment overrides, resolved once at module load. */
const desktopEnv = readShellEnvironment()

/** Stop the supervised host without blocking Electron's exit path, if it started. */
function stopWebHost(): void {
  const host = webHost
  webHost = undefined
  if (host !== undefined) void host.stop().catch((error: unknown) => { console.error(error) })
}

/** Fail-loud dialog for a host boot failure, then leave: the shell has no surface without it. */
function failBoot(detail: string): void {
  console.error(detail)
  dialog.showErrorBox('DeepSeek Harness could not start', detail)
  app.quit()
}

/** Load a shipped icon or fail the boot: an unreadable asset is a broken package, not a cosmetic gap. */
function loadRequiredImage(path: string, label: string): NativeImage {
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) throw new Error(`desktop: ${label} missing or unreadable at ${path}`)
  return image
}

/** Create the tray that owns app lifetime, showing the shell's tray icon at the tray's working size. */
function buildTray(show: () => void, image: NativeImage): Tray {
  const tray = new Tray(image.resize({ width: 32, height: 32 }))
  tray.setToolTip(WINDOW_TITLE)
  tray.on('click', show)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DeepSeek Harness', click: show },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit() } },
  ]))
  return tray
}

/** Show the window and focus it, recreating it when an earlier quit path destroyed it. */
function showWindow(): void {
  // Second-instance activation can race the host boot; a window without its
  // Web URL would be a blank frame, so the tray simply retries on the next click.
  if (webUrl === '') return
  if (windowHandle === undefined || windowHandle.isDestroyed()) {
    windowHandle = createWindow()
  }
  windowHandle.show()
  windowHandle.focus()
}

/** Create the BrowserWindow over the bound Web URL with hide-on-close behavior. */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: WINDOW_TITLE,
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#101418',
    show: false,
    // Taskbar/window identity comes from the shipped application icon; it is
    // always loaded before the first window (the boot fails loud otherwise).
    ...(windowIcon === undefined ? {} : { icon: windowIcon }),
  })
  win.on('ready-to-show', () => { win.show() })
  win.on('close', (event) => {
    if (appIsQuitting) return
    event.preventDefault()
    win.hide()
    console.log('dsh desktop: window hidden to tray')
  })
  // The GUI opens its own same-origin views and leaves external links to the
  // system browser, mirroring the browser tab the shell replaces.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(webUrl)) return { action: 'allow' }
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  void win.loadURL(webUrl)
  if (desktopEnv.devtools) win.webContents.openDevTools()
  return win
}

// Single instance: the first window wins; a second launch focuses it (and
// re-shows it when it sits hidden in the tray). The lock must be requested
// before `ready`, and losing it ends this process unchanged.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { showWindow() })
  app.on('activate', () => { showWindow() }) // macOS dock: bring the hidden window back
  app.on('before-quit', () => {
    appIsQuitting = true
    stopWebHost()
  })
  // The tray owns lifetime: closing every window is the normal hidden state,
  // not an exit request. Quit only ever arrives through before-quit above.
  app.on('window-all-closed', () => { /* keep the tray and the supervised host alive */ })

  // Event-based boot, not a top-level await: an Electron ESM entry with a
  // top-level `await app.whenReady()` never resolves in Electron 43, so the
  // whole boot runs off the ready promise instead.
  void app.whenReady().then(() => {
    try {
      if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
      // Icons gate the boot before any window exists: the tray hides the
      // window with no way back without its icon, and the window identity
      // comes from the shipped application icon.
      windowIcon = loadRequiredImage(APP_ICON_PATH, 'window icon')
      const trayImage = loadRequiredImage(TRAY_ICON_PATH, 'tray icon')
      const host = startWebHost(
        desktopEnv.nodeCommand,
        desktopEnv.cliArgs,
        desktopEnv.webArgs,
        process.env,
      )
      webHost = host
      // True once the ready rejection reported the boot failure: the exit
      // watcher below must not double-report the same death.
      let bootReported = false
      // The shell without its server is not a product state: a child that exits
      // on its own takes the app down with a diagnostic — before the ready line
      // through the ready rejection's dialog, after it through this watcher.
      void host.exited.then((code) => {
        if (appIsQuitting || bootReported) return
        failBoot(`the supervised web host exited on its own (code ${code === null ? 'signal' : String(code)})`)
      })
      void host.ready.then(
        (url) => {
          try {
            webUrl = url
            console.log(`dsh desktop: web ready ${url}`)
            windowHandle = createWindow()
            buildTray(showWindow, trayImage)
            console.log('dsh desktop: window ready')
          } catch (error) {
            // A shell without a working tray could hide the window with no way
            // back, so a tray creation failure ends the boot instead of degrading silently.
            failBoot(error instanceof Error ? error.message : String(error))
          }
        },
        (error: unknown) => {
          bootReported = true
          failBoot(error instanceof Error ? error.message : String(error))
        },
      )
    } catch (error) {
      // Icon loading or spawn setup failed before any async reporting could;
      // the same fail-loud boot dialog owns every pre-ready failure.
      failBoot(error instanceof Error ? error.message : String(error))
    }
  })
}
