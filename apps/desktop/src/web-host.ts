/**
 * Supervision of the hosted `dsh web` server the desktop window displays.
 * The shell never serves the GUI itself — only `dsh web` injects
 * `window.__DSH_BOOT__` — so the child process owns the server, and the shell
 * only starts it, reads its readiness URL line, and stops it on quit.
 * @module @deepseek-ai/dsh-desktop/web-host
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

/** How long the supervisor waits for the readiness line before failing the boot. */
const READY_TIMEOUT_MS = 60_000

/** How long a stopped child may take to exit before the supervisor kills it. */
const STOP_GRACE_MS = 2_000

/**
 * Parse the canonical loopback Web URL from the readiness line the web app
 * prints after the server binds (`dsh web: http://127.0.0.1:<port>`, with an
 * optional `(LAN: …)` tail the supervisor ignores).
 * @param line - one child stdout line.
 * @returns the URL, or `undefined` when the line is not the readiness line.
 */
export function parseWebReadyUrl(line: string): string | undefined {
  const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(line)
  return match?.[1]
}

/** A running web host plus its readiness settlement. */
export interface WebHost {
  /** Settles with the bound Web URL, or rejects when the child exits or the timeout elapses first. */
  ready: Promise<string>
  /** Settles with the exit code once the child exits (`null` when a signal ended it). */
  exited: Promise<number | null>
  /** Request child termination and wait for its exit (hard kill after the grace window). */
  stop(): Promise<void>
}

/**
 * Start the supervised `dsh web` host: the CLI entry `web` subcommand with the
 * shell's extra arguments, its output forwarded to this process's console with
 * a `[web]` prefix.
 * @param nodeCommand - the Node binary to spawn.
 * @param cliArgs - the CLI entry and `web` subcommand.
 * @param webArgs - extra `dsh web` arguments, in argument order.
 * @param environment - spawn environment (the shell's own, usually).
 * @returns the host handle with its readiness settlement.
 */
export function startWebHost(
  nodeCommand: string,
  cliArgs: readonly string[],
  webArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
): WebHost {
  // stdin is deliberately closed: the Web host never reads interactive input.
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    nodeCommand,
    [...cliArgs, ...webArgs],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let boundUrl: string | undefined
  let settled: (value: string) => void = () => {}
  let failed: (reason: Error) => void = () => {}
  let recordExit: (code: number | null) => void = () => {}
  const tail: string[] = []
  const remember = (line: string): void => {
    tail.push(line)
    if (tail.length > 20) tail.shift()
  }
  const ready = new Promise<string>((resolveReady, reject) => {
    settled = resolveReady
    failed = reject
  })
  const exited = new Promise<number | null>((resolveExit) => {
    recordExit = resolveExit
  })
  const fail = (reason: string, code: number | null): void => {
    failed(new Error(`desktop: the web host exited before its readiness line (code ${code === null ? 'signal' : String(code)}): ${reason}\n${tail.join('\n')}`))
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.length === 0) continue
      console.log(`[web] ${line}`)
      remember(line)
      if (boundUrl === undefined) {
        const url = parseWebReadyUrl(line)
        if (url !== undefined) {
          boundUrl = url
          settled(url)
        }
      }
    }
  })
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.length === 0) continue
      console.error(`[web] ${line}`)
      remember(line)
    }
  })
  // A spawn failure is the only `error` event: the process never started (a
  // missing Node binary or entry path), so no exit event follows it.
  child.on('error', (error: Error) => {
    failed(error)
  })
  child.on('exit', (code) => {
    recordExit(code)
    if (boundUrl === undefined) fail('the server never bound', code)
  })
  const readyTimer = setTimeout(() => {
    failed(new Error(`desktop: the web host did not print its readiness line within ${READY_TIMEOUT_MS / 1000}s\n${tail.join('\n')}`))
  }, READY_TIMEOUT_MS)
  void ready.then(() => { clearTimeout(readyTimer) }, () => { clearTimeout(readyTimer) })

  return {
    ready,
    exited,
    stop(): Promise<void> {
      return new Promise((resolveStop) => {
        void ready.catch(() => {}) // a failed boot still needs a killed child on stop
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveStop()
          return
        }
        let stopped = false
        const settle = (): void => {
          if (stopped) return
          stopped = true
          clearTimeout(forceTimer)
          resolveStop()
        }
        const forceTimer = setTimeout(() => {
          // On Windows SIGTERM already terminates; elsewhere the host's own
          // handlers get the grace window before this hard kill.
          child.kill('SIGKILL')
          settle()
        }, STOP_GRACE_MS)
        child.once('exit', settle)
        child.kill()
      })
    },
  }
}
