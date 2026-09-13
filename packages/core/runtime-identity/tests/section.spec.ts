/**
 * Tests for the `runtime/world-state` prompt section: text rendering for
 * full identities, partial identities (no canonicalUrl, no sourceRoot),
 * the null identity (no provider registered), and the empty-capabilities
 * case.
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

import { describe, expect, it } from 'vitest'
import { renderWorldState, RUNTIME_WORLD_STATE_SECTION } from '../src/section.ts'
import type { RuntimeIdentity } from '../src/types.ts'

const FULL_IDENTITY: RuntimeIdentity = {
  profile: 'web',
  canonicalUrl: 'http://127.0.0.1:3080',
  processId: 1234,
  buildFingerprint: 'sha256:abc',
  sourceRoot: '/Users/me/deepseek-harness',
  capabilities: {
    hasNetworkSurface: true,
    hasFilesystem: true,
    hasShell: true,
    hasSandbox: true,
  },
}

describe('RUNTIME_WORLD_STATE_SECTION', () => {
  it('is the canonical section name', () => {
    expect(RUNTIME_WORLD_STATE_SECTION).toBe('runtime/world-state')
  })
})

describe('renderWorldState', () => {
  it('returns empty text when identity is null', () => {
    expect(renderWorldState(null)).toBe('')
  })

  it('renders every key for a full identity', () => {
    const text = renderWorldState(FULL_IDENTITY)
    expect(text).toContain('You are running inside the DeepSeek Harness.')
    expect(text).toContain('Profile: web')
    expect(text).toContain('Canonical URL: http://127.0.0.1:3080')
    expect(text).toContain('Build fingerprint: sha256:abc')
    expect(text).toContain('Source checkout: /Users/me/deepseek-harness')
    expect(text).toContain('Capabilities: network, filesystem, shell, sandbox')
    expect(text).toContain('Process id: 1234')
  })

  it('omits Canonical URL when the profile has no network surface', () => {
    const { canonicalUrl: _unused, ...rest } = FULL_IDENTITY
    const identity: RuntimeIdentity = rest
    const text = renderWorldState(identity)
    expect(text).not.toContain('Canonical URL:')
    expect(text).toContain('Profile: web')
  })

  it('omits Source checkout when the runtime is from a published install', () => {
    const { sourceRoot: _unused, ...rest } = FULL_IDENTITY
    const identity: RuntimeIdentity = rest
    const text = renderWorldState(identity)
    expect(text).not.toContain('Source checkout:')
  })

  it('renders an empty capabilities list when none are present', () => {
    const identity: RuntimeIdentity = {
      ...FULL_IDENTITY,
      capabilities: {
        hasNetworkSurface: false,
        hasFilesystem: false,
        hasShell: false,
        hasSandbox: false,
      },
    }
    const text = renderWorldState(identity)
    expect(text).toContain('Capabilities: (none)')
  })

  it('lists capabilities in a deterministic order', () => {
    const identity: RuntimeIdentity = {
      ...FULL_IDENTITY,
      capabilities: {
        hasNetworkSurface: false,
        hasFilesystem: true,
        hasShell: false,
        hasSandbox: true,
      },
    }
    const text = renderWorldState(identity)
    expect(text).toContain('Capabilities: filesystem, sandbox')
  })
})
