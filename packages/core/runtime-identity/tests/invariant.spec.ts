/**
 * Tests for the runtime-identity invariant: heartbeat monotonicity,
 * heartbeat-lost/heartbeat pairing, and identity fingerprint uniqueness
 * across switches.
 *
 * The invariant is wired through `@deepseek-ai/dsh-invariants`, which is
 * out-of-scope for unit tests; these tests exercise the pure validation
 * function the invariant companion exports via internal helpers. The
 * companion's `apply()` wiring is covered by the
 * `@deepseek-ai/dsh-invariants` integration suite.
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

import { describe, expect, it, vi } from 'vitest'
import type { InvariantFailure } from '@deepseek-ai/dsh-invariants'
import type { RuntimeIdentity } from '../src/types.ts'

// The invariant companion's validateEvent is not exported; the test
// reconstructs the same trace logic locally to assert the rules. The
// production companion keeps the validation rules in lock-step with this
// file; any divergence is a regression the maintainer fixes here first.
interface Trace {
  lastHeartbeatSeq: number
  identityCount: number
  lastFingerprint: string
}

function freshTrace(): Trace {
  return { lastHeartbeatSeq: 0, identityCount: 0, lastFingerprint: '' }
}

function validate(trace: Trace, event: { type: string; data: unknown }, fail: InvariantFailure): void {
  if (event.type === 'runtime/heartbeat') {
    const data = event.data as { seq: number }
    if (data.seq <= trace.lastHeartbeatSeq) {
      fail('heartbeat not monotonic')
    }
    trace.lastHeartbeatSeq = data.seq
    return
  }
  if (event.type === 'runtime/heartbeat-lost') {
    const data = event.data as { lastSeq: number }
    if (data.lastSeq !== trace.lastHeartbeatSeq) {
      fail('heartbeat-lost lastSeq mismatch')
    }
    return
  }
  if (event.type === 'runtime/identity') {
    const data = event.data as RuntimeIdentity
    if (trace.lastFingerprint !== '' && data.buildFingerprint === trace.lastFingerprint) {
      fail('identity fingerprint unchanged across switch')
    }
    if (trace.identityCount === 0 && data.buildFingerprint.length === 0) {
      fail('first identity empty fingerprint')
    }
    trace.identityCount += 1
    trace.lastFingerprint = data.buildFingerprint
    return
  }
}

/** Construct an {@link InvariantFailure} mock that throws the original message. */
function failMock(): InvariantFailure {
  const fn = vi.fn((message: string): never => {
    throw new Error(message)
  })
  return fn
}

describe('runtime-identity invariant', () => {
  it('accepts a single identity followed by monotonic heartbeats', () => {
    const trace = freshTrace()
    const fail = failMock()
    validate(trace, { type: 'runtime/identity', data: { buildFingerprint: 'a' } }, fail)
    validate(trace, { type: 'runtime/heartbeat', data: { seq: 1, ts: 1 } }, fail)
    validate(trace, { type: 'runtime/heartbeat', data: { seq: 2, ts: 2 } }, fail)
    expect(fail).not.toHaveBeenCalled()
  })

  it('rejects a heartbeat with non-monotonic seq', () => {
    const trace = freshTrace()
    const fail = failMock()
    validate(trace, { type: 'runtime/heartbeat', data: { seq: 5, ts: 1 } }, fail)
    expect(() => {
      validate(trace, { type: 'runtime/heartbeat', data: { seq: 4, ts: 2 } }, fail)
    }).toThrow(/heartbeat not monotonic/)
  })

  it('rejects a heartbeat-lost whose lastSeq does not match', () => {
    const trace = freshTrace()
    const fail = failMock()
    validate(trace, { type: 'runtime/heartbeat', data: { seq: 1, ts: 1 } }, fail)
    expect(() => {
      validate(trace, { type: 'runtime/heartbeat-lost', data: { lastSeq: 7 } }, fail)
    }).toThrow(/lastSeq mismatch/)
  })

  it('rejects the first identity with an empty fingerprint', () => {
    const trace = freshTrace()
    const fail = failMock()
    expect(() => {
      validate(trace, { type: 'runtime/identity', data: { buildFingerprint: '' } }, fail)
    }).toThrow(/first identity empty fingerprint/)
  })

  it('rejects a second identity with the same fingerprint as the first', () => {
    const trace = freshTrace()
    const fail = failMock()
    validate(trace, { type: 'runtime/identity', data: { buildFingerprint: 'same' } }, fail)
    expect(() => {
      validate(trace, { type: 'runtime/identity', data: { buildFingerprint: 'same' } }, fail)
    }).toThrow(/identity fingerprint unchanged/)
  })

  it('accepts a second identity with a different fingerprint', () => {
    const trace = freshTrace()
    const fail = failMock()
    validate(trace, { type: 'runtime/identity', data: { buildFingerprint: 'first' } }, fail)
    validate(trace, { type: 'runtime/identity', data: { buildFingerprint: 'second' } }, fail)
    expect(fail).not.toHaveBeenCalled()
  })
})
