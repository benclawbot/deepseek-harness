/**
 * Tests for the runtime-identity registry: registration, snapshot caching,
 * duplicate detection, dispose semantics, and `invalidate()` flow.
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeIdentityRegistry } from '../src/registry.ts'
import type { RuntimeIdentity, RuntimeIdentityProvider } from '../src/types.ts'

const BASE_IDENTITY: RuntimeIdentity = {
  profile: 'test',
  processId: 42,
  buildFingerprint: 'sha256:test',
  capabilities: {
    hasNetworkSurface: false,
    hasFilesystem: false,
    hasShell: false,
    hasSandbox: false,
  },
}

function makeRegistry(): RuntimeIdentityRegistry {
  return new RuntimeIdentityRegistry(new Context())
}

interface MockProvider {
  snapshots: number
  disposers: number
  snapshot: ReturnType<typeof vi.fn>
  startHeartbeat: ReturnType<typeof vi.fn>
}

function makeProvider(overrides: Partial<RuntimeIdentity> = {}): RuntimeIdentityProvider & MockProvider {
  const provider: RuntimeIdentityProvider & MockProvider = {
    snapshots: 0,
    disposers: 0,
    snapshot: vi.fn(() => {
      provider.snapshots += 1
      return { ...BASE_IDENTITY, ...overrides }
    }),
    startHeartbeat: vi.fn(() => {
      provider.disposers += 1
      return () => { provider.disposers -= 1 }
    }),
  }
  return provider
}

describe('RuntimeIdentityRegistry', () => {
  it('returns null when no provider is registered', () => {
    const registry = makeRegistry()
    expect(registry.current()).toBeNull()
  })

  it('seeds the current identity from snapshot() at registration', () => {
    const registry = makeRegistry()
    const provider = makeProvider({ profile: 'web' })
    registry.register('web', provider)
    expect(registry.current()).toEqual({
      profile: 'web',
      processId: 42,
      buildFingerprint: 'sha256:test',
      capabilities: BASE_IDENTITY.capabilities,
    })
    expect(provider.snapshot.mock.calls.length).toBe(1)
    expect(provider.startHeartbeat.mock.calls.length).toBe(1)
  })

  it('throws on duplicate registration with the conflicting key in the message', () => {
    const registry = makeRegistry()
    registry.register('web', makeProvider())
    expect(() => { registry.register('web', makeProvider()) }).toThrow(/already registered/)
  })

  it('throws when the provider is missing snapshot()', () => {
    const registry = makeRegistry()
    const bad = {
      startHeartbeat: () => () => {},
    } as unknown as RuntimeIdentityProvider
    expect(() => registry.register('web', bad)).toThrow(/missing snapshot/)
  })

  it('throws when the provider is missing startHeartbeat()', () => {
    const registry = makeRegistry()
    const bad = {
      snapshot: () => BASE_IDENTITY,
    } as unknown as RuntimeIdentityProvider
    expect(() => registry.register('web', bad)).toThrow(/missing startHeartbeat/)
  })

  it('throws when startHeartbeat() does not return a disposer', () => {
    const registry = makeRegistry()
    const bad = {
      snapshot: () => BASE_IDENTITY,
      startHeartbeat: () => undefined,
    } as unknown as RuntimeIdentityProvider
    expect(() => registry.register('web', bad)).toThrow(/must return a disposer/)
  })

  it('disposing the registration stops the heartbeat and clears current', () => {
    const registry = makeRegistry()
    const provider = makeProvider()
    const dispose = registry.register('web', provider)
    expect(provider.disposers).toBe(1)
    dispose()
    expect(provider.disposers).toBe(0)
    expect(registry.current()).toBeNull()
  })

  it('disposing twice is a no-op', () => {
    const registry = makeRegistry()
    const provider = makeProvider()
    const dispose = registry.register('web', provider)
    dispose()
    expect(() => { dispose() }).not.toThrow()
  })

  it('a failing stopHeartbeat does not block unload', () => {
    const registry = makeRegistry()
    const provider = {
      snapshot: () => BASE_IDENTITY,
      startHeartbeat: () => () => { throw new Error('boom') },
    } as unknown as RuntimeIdentityProvider
    const dispose = registry.register('web', provider)
    expect(() => { dispose() }).not.toThrow()
  })

  it('invalidate() returns null when no provider is registered', async () => {
    const registry = makeRegistry()
    await expect(registry.invalidate('restart')).resolves.toBeNull()
  })

  it('invalidate() calls onInvalidate and re-snapshots', async () => {
    const registry = makeRegistry()
    const onInvalidate = vi.fn()
    const snapshot = vi.fn(() => ({ ...BASE_IDENTITY }))
    const provider: RuntimeIdentityProvider = {
      snapshot,
      startHeartbeat: () => () => {},
      onInvalidate,
    }
    registry.register('web', provider)
    await registry.invalidate('profile-switch')
    expect(onInvalidate).toHaveBeenCalledWith('profile-switch')
    expect(vi.mocked(snapshot).mock.calls.length).toBe(2)
  })

  it('invalidate() commits the new snapshot to current()', async () => {
    const registry = makeRegistry()
    let profile = 'web'
    const provider: RuntimeIdentityProvider = {
      snapshot: () => ({ ...BASE_IDENTITY, profile }),
      startHeartbeat: () => () => {},
    }
    registry.register('web', provider)
    profile = 'desktop'
    const fresh = await registry.invalidate('profile-switch')
    expect(fresh).not.toBeNull()
    expect(fresh?.profile).toBe('desktop')
    expect(registry.current()?.profile).toBe('desktop')
  })
})
