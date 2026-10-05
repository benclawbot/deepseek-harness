import { describe, expect, it, vi } from 'vitest'
import { claimDesktopSingleInstance, type DesktopSingleInstanceApplication } from '../src/single-instance.ts'

describe('desktop single-instance ownership', () => {
  it('quits a second process without registering lifecycle work', () => {
    const quit = vi.fn()
    const on = vi.fn()
    const application = {
      requestSingleInstanceLock: () => false,
      quit,
      on,
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, vi.fn())).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(on).not.toHaveBeenCalled()
  })

  it('routes a later launch to the primary process', () => {
    let secondInstance: ((_event: unknown, commandLine: string[]) => void) | undefined
    const focus = vi.fn()
    const application = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: vi.fn((_event: 'second-instance', listener: (_event: unknown, commandLine: string[]) => void) => { secondInstance = listener }),
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, focus)).toBe(true)
    const commandLine = ['/app', 'dsh://open']
    secondInstance?.({}, commandLine)
    expect(focus).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith(commandLine)
  })

  it('routes an ordinary later launch with no protocol argument to the primary process', () => {
    let secondInstance: ((_event: unknown, commandLine: string[]) => void) | undefined
    const focus = vi.fn()
    const application = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: vi.fn((_event: 'second-instance', listener: (_event: unknown, commandLine: string[]) => void) => { secondInstance = listener }),
    } satisfies DesktopSingleInstanceApplication

    claimDesktopSingleInstance(application, focus)
    secondInstance?.({}, ['/app'])
    expect(focus).toHaveBeenCalledWith(['/app'])
  })
})
