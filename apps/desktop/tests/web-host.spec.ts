// Unit coverage for the desktop shell's Electron-free logic: the readiness-line
// parser from web-host.ts and the override resolution from paths.ts. The real
// process and window lifecycle is the desktop e2e lane's job (apps/desktop/tests/desktop.e2e.ts).
import { describe, expect, it } from 'vitest'
import { parseWebReadyUrl } from '../src/web-host.ts'
import { readDesktopEnv, resolveCliEntry, splitExtraWebArgs } from '../src/paths.ts'

describe('parseWebReadyUrl', () => {
  it('reads the canonical loopback URL from the readiness line', () => {
    expect(parseWebReadyUrl('dsh web: http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
  })

  it('reads the OS-assigned port and ignores the LAN tail', () => {
    expect(parseWebReadyUrl('dsh web: http://127.0.0.1:52338 (LAN: http://192.168.1.7:52338)'))
      .toBe('http://127.0.0.1:52338')
  })

  it('rejects lines that are not the readiness line', () => {
    expect(parseWebReadyUrl('dsh web: http://localhost:3080')).toBeUndefined()
    expect(parseWebReadyUrl('some log line http://127.0.0.1:3080')).toBeUndefined()
    expect(parseWebReadyUrl('dsh web: http://127.0.0.1:notaport')).toBeUndefined()
    expect(parseWebReadyUrl('')).toBeUndefined()
  })
})

describe('splitExtraWebArgs', () => {
  it('splits on whitespace and drops emptiness', () => {
    expect(splitExtraWebArgs('--port 0 --trusted-host a b')).toEqual(['--port', '0', '--trusted-host', 'a', 'b'])
    expect(splitExtraWebArgs('  --port\t0  ')).toEqual(['--port', '0'])
  })

  it('treats unset as no arguments', () => {
    expect(splitExtraWebArgs(undefined)).toEqual([])
    expect(splitExtraWebArgs('')).toEqual([])
  })
})

describe('resolveCliEntry', () => {
  it('resolves the built CLI bin beside the dsh package manifest', () => {
    const resolve = (specifier: string): string => {
      expect(specifier).toBe('@deepseek-ai/dsh/package.json')
      return '/install/node_modules/@deepseek-ai/dsh/package.json'
    }
    // Path separators are platform-owned; the segment layout is the contract.
    expect(resolveCliEntry({}, resolve)).toMatch(/node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/)
  })

  it('prefers the layout override when set', () => {
    const resolve = (): string => {
      throw new Error('the override must short-circuit resolution')
    }
    expect(resolveCliEntry({ DSH_DESKTOP_CLI_JS: '/checkout/apps/cli/lib/bin.js' }, resolve))
      .toBe('/checkout/apps/cli/lib/bin.js')
  })

  it('ignores an empty override', () => {
    const resolve = (specifier: string): string => specifier
    expect(resolveCliEntry({ DSH_DESKTOP_CLI_JS: '' }, resolve)).toMatch(/lib(?:\/|\\)bin\.js$/)
  })
})

describe('readDesktopEnv', () => {
  it('assembles the spawn command from the environment', () => {
    const env = readDesktopEnv(
      { DSH_DESKTOP_WEB_ARGS: '--port 0', DSH_DESKTOP_DEVTOOLS: '1' },
      () => '/pkg/package.json',
    )
    expect(env.nodeCommand).toBe('node')
    expect(env.cliArgs[0]).toMatch(/pkg[\\/]lib[\\/]bin\.js$/)
    expect(env.cliArgs[1]).toBe('web')
    expect(env.webArgs).toEqual(['--port', '0'])
    expect(env.devtools).toBe(true)
  })

  it('defaults to no extra args and no DevTools; the node override wins', () => {
    const env = readDesktopEnv({ DSH_DESKTOP_NODE: '/opt/node/bin/node' }, () => '/pkg/package.json')
    expect(env.nodeCommand).toBe('/opt/node/bin/node')
    expect(env.webArgs).toEqual([])
    expect(env.devtools).toBe(false)
  })
})
