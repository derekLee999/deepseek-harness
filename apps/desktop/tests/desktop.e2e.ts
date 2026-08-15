// Keyless desktop-shell acceptance: the real built Electron main entry
// supervising the real `dsh web` child over the built GUI dist. Requires a
// prior `pnpm run build` (the lane's root scripts run one) and a desktop
// session for Electron.
//
// Playwright's `_electron` launcher drives Electron through a protocol
// sequence that exits Electron 36+ during attach (electron#47419), and the
// renderer DevTools HTTP endpoint is unreachable in Electron 43 either way.
// This lane therefore speaks the main-process inspector protocol itself: a
// minimal CDP client over `--inspect=0` evaluates in the main process, where
// `require("electron")` and `webContents.executeJavaScript` reach everything
// the assertions need — window state, close/show, the rendered page, and quit.
import { type ChildProcess, type ChildProcessByStdio, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, expect, test } from 'vitest'

/** The desktop app directory: `electron` reads package.json `main` from it. */
const DESKTOP_DIR = fileURLToPath(new URL('../', import.meta.url))
/** The built main-process bundle under test. */
const MAIN_BUNDLE = join(DESKTOP_DIR, 'lib', 'main.js')
/** The built Web frontend the supervised host serves. */
const DIST_INDEX = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url))

/** How long the lane waits for the shell's readiness before failing the boot. */
const BOOT_TIMEOUT_MS = 150_000

/** Setup-phase polling (beforeAll runs outside a test, where expect.poll rejects). */
async function waitFor(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolveSleep) => { setTimeout(resolveSleep, 250) })
  }
  throw new Error(message)
}

/** Minimal request/reply client over the main-process inspector websocket. */
class MainProcessCdp {
  private readonly socket: WebSocket
  private nextId = 0
  private readonly pending = new Map<number, (value: unknown) => void>()

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event) => {
      const reply = JSON.parse(String(event.data)) as { id?: number }
      if (reply.id === undefined) return
      const resolveReply = this.pending.get(reply.id)
      if (resolveReply === undefined) return
      this.pending.delete(reply.id)
      resolveReply(reply)
    })
  }

  /** Open the socket and enable evaluation. */
  ready(): Promise<void> {
    return new Promise((resolveReady, reject) => {
      this.socket.addEventListener('open', () => {
        void this.call('Runtime.enable', {}).then(() => { resolveReady() }, reject)
      })
      this.socket.addEventListener('error', () => { reject(new Error('main-process inspector socket failed')) })
    })
  }

  private call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, (value) => { resolve(value as Record<string, unknown> | undefined) })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`main-process inspector call timed out: ${method}`))
      }, 30_000)
    })
  }

  /** Evaluate an expression in the main process (command-line `require` is available there). */
  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.call('Runtime.evaluate', {
      expression,
      includeCommandLineAPI: true,
      awaitPromise: true,
      returnByValue: true,
    })
    const outcome = reply?.result as { exceptionDetails?: { text?: string }; result?: { value?: T } } | undefined
    if (outcome?.exceptionDetails !== undefined) {
      throw new Error(`main-process evaluate failed: ${outcome.exceptionDetails.text ?? 'unknown exception'}`)
    }
    return outcome?.result?.value as T
  }

  close(): void { this.socket.close() }
}

/** The launched shell under test. */
interface ShellUnderTest {
  electron: ChildProcess
  main: MainProcessCdp
}

let shell: ShellUnderTest | undefined
let tempWorld = ''

/** Collect a process stream, trimmed to the latest lines. */
function collectTail(stream: Readable): string[] {
  const tail: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    tail.push(...chunk.split('\n').filter(line => line.length > 0))
    if (tail.length > 20) tail.shift()
  })
  return tail
}

/** Evaluate the given expression inside the shell window's renderer. */
function evalPage<T>(main: MainProcessCdp, expression: string): Promise<T> {
  const quoted = JSON.stringify(expression)
  return main.evaluate<T>(`require("electron").BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${quoted}, true)`)
}

async function launchShell(): Promise<ShellUnderTest> {
  tempWorld = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-'))
  // In plain Node the electron package resolves to the binary path string; the
  // test never imports its API surface.
  const electronBinary = createRequire(import.meta.url)('electron') as unknown as string
  const electronProcess: ChildProcessByStdio<null, Readable, Readable> = spawn(
    electronBinary,
    ['--inspect=0', DESKTOP_DIR],
    {
      cwd: tempWorld,
      env: {
        ...process.env,
        // The supervised host must never touch the developer's real harness home.
        DSH_HOME: join(tempWorld, '.dsh-home'),
        // A free port keeps this lane independent of any running `dsh web`.
        DSH_DESKTOP_WEB_ARGS: '--port 0',
        // A concrete Node binary: the shell defaults to PATH lookup, which test
        // runners may not provide.
        DSH_DESKTOP_NODE: process.execPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const errTail = collectTail(electronProcess.stderr)

  const inspectorUrl = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(
      () => { reject(new Error(`no main-process inspector within ${BOOT_TIMEOUT_MS / 1000}s: ${errTail.join(' ')}`)) },
      BOOT_TIMEOUT_MS,
    )
    electronProcess.stderr.on('data', function onDebugLine(chunk: Buffer) {
      const match = /Debugger listening on (ws:\/\/[^\s]+)/.exec(String(chunk))
      if (match === null) return
      clearTimeout(timer)
      electronProcess.stderr.off('data', onDebugLine)
      resolveUrl(match[1]!)
    })
    electronProcess.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`electron exited during launch with code ${String(code)}`))
    })
  })
  const main = new MainProcessCdp(inspectorUrl)
  await main.ready()

  // The window loads the bound Web URL the supervised host prints; wait for a
  // real page URL to appear (the host boot settles within the same budget).
  try {
    await waitFor(async () => {
      const url = await main.evaluate<string>('require("electron").BrowserWindow.getAllWindows()[0]?.webContents.getURL() ?? ""')
      return /^http:\/\/127\.0\.0\.1:\d+\//.test(url)
    }, 'the shell window never loaded a Web URL')
  } catch (error) {
    const diagnostics = await main.evaluate<unknown>(`
      ({
        ready: require("electron").app.isReady(),
        windows: require("electron").BrowserWindow.getAllWindows().length,
        url: require("electron").BrowserWindow.getAllWindows()[0]?.webContents.getURL() ?? "",
        cwd: process.cwd(),
        node: process.env.DSH_DESKTOP_NODE ?? "(default node)",
      })
    `).catch((diagnosticError: unknown) => String(diagnosticError))
    throw new Error(`${(error as Error).message} — main diagnostics: ${JSON.stringify(diagnostics)}; stderr tail: ${errTail.slice(-10).join(' | ')}`)
  }
  return { electron: electronProcess, main }
}

beforeAll(async () => {
  if (!existsSync(MAIN_BUNDLE) || !existsSync(DIST_INDEX)) {
    throw new Error('desktop e2e needs built artifacts — run `pnpm run build` first (`pnpm run test:desktop` does this)')
  }
  shell = await launchShell()
})

afterAll(async () => {
  if (shell !== undefined) {
    if (shell.electron.exitCode === null) {
      await shell.main.evaluate('require("electron").app.quit()').catch(() => {})
      shell.main.close()
      await new Promise<void>((resolveDone) => {
        const timer = setTimeout(() => { shell?.electron.kill(); resolveDone() }, 10_000)
        shell?.electron.once('exit', () => { clearTimeout(timer); resolveDone() })
      })
    }
    shell.main.close()
    await rm(tempWorld, { recursive: true, force: true }).catch(() => {})
  }
})

test('boots the real Web GUI, boot manifest included', async () => {
  const active = shell!
  await expect(active.main.evaluate<string>('require("electron").BrowserWindow.getAllWindows()[0].webContents.getURL()'))
    .resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
  await expect(evalPage<string>(active.main, 'document.title')).resolves.toBe('DeepSeek Harness')
  await expect.poll(
    () => evalPage<boolean>(active.main, '(globalThis.__DSH_BOOT__ !== undefined)'),
    { timeout: BOOT_TIMEOUT_MS, message: 'window.__DSH_BOOT__ never appeared' },
  ).toBe(true)
  await expect.poll(
    () => evalPage<boolean>(active.main, 'document.querySelector("#root") !== null && document.querySelector("#root").childElementCount > 0'),
    { timeout: BOOT_TIMEOUT_MS, message: 'the GUI never mounted into #root' },
  ).toBe(true)
  const entryCount = await evalPage<number>(active.main, 'globalThis.__DSH_BOOT__.entries.length')
  expect(entryCount).toBeGreaterThan(0)
})

test('closing the window hides it to the tray instead of quitting', async () => {
  const active = shell!
  // The user close gesture: BrowserWindow.close fires the shell's close handler.
  await active.main.evaluate('require("electron").BrowserWindow.getAllWindows()[0].close()')
  await expect.poll(async () => {
    const state = await active.main.evaluate<boolean[]>(`
      (() => {
        const win = require("electron").BrowserWindow.getAllWindows()[0]
        return [!!win, !win.isDestroyed(), !win.isVisible()]
      })()
    `)
    return state[0] === true && state[1] === true && state[2] === true
      && active.electron.exitCode === null
      && await evalPage<string>(active.main, 'document.visibilityState') === 'hidden'
  }, { timeout: 15_000, message: 'close did not settle into the hidden tray state' }).toBe(true)

  // The restore path (the same BrowserWindow the tray re-shows), proving the
  // hide is reversible while the app and its web host keep running.
  await active.main.evaluate('require("electron").BrowserWindow.getAllWindows()[0].show()')
  await expect.poll(() => active.main.evaluate<boolean>('require("electron").BrowserWindow.getAllWindows()[0].isVisible()'))
    .toBe(true)
})

test('quitting stops the supervised web host', async () => {
  const active = shell!
  const serverUrl = await active.main.evaluate<string>('require("electron").BrowserWindow.getAllWindows()[0].webContents.getURL()')
  await active.main.evaluate('require("electron").app.quit()')
  // The lane's own inspector attachment is the last external anchor on the
  // main process; the app delivers quit, but the process terminates only after
  // the attached debugger lets go.
  active.main.close()
  await expect.poll(() => active.electron.exitCode, { timeout: 30_000 }).not.toBeNull()
  // before-quit stops the supervised child; once Electron is gone the server
  // must stop accepting (a lingering child holding the port would fail here).
  await expect.poll(async () => {
    try {
      await fetch(serverUrl)
      return false
    } catch {
      return true
    }
  }, { timeout: 15_000, message: `the supervised web host kept serving ${serverUrl}` }).toBe(true)
}, 60_000)
