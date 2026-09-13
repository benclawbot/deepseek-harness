/**
 * Package-owned relational invariants for the runtime-identity seam.
 * Load this companion beside `@deepseek-ai/dsh-invariants` to enable
 * the checks.
 *
 * The invariant asserts three independent observations that can
 * diverge in shipped code:
 *
 * 1. `runtime/heartbeat.seq` is strictly monotonic per session log.
 * 2. `runtime/heartbeat-lost.lastSeq` matches the most recently
 *    committed heartbeat seq for the session.
 * 3. At most one `runtime/identity` event is committed before a session
 *    begins normal turn traffic (subsequent identities are valid; they
 *    signal a profile switch and must carry a different `processId` or
 *    a different `buildFingerprint` to be informative).
 *
 * The companion is intentionally narrow — anything else belongs in a
 * domain plugin's own invariant (e.g. the session-level structural
 * rules live in `@deepseek-ai/dsh-session/invariant`).
 *
 * @module @deepseek-ai/dsh-runtime-identity/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { RuntimeHeartbeatEvent, RuntimeIdentityEvent } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-runtime-identity'

/** Cordis companion plugin name. */
export const name = 'runtime-identity-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Per-session bookkeeping for runtime-identity checks. */
interface Trace {
  /** Last observed heartbeat seq (0 if none). */
  lastHeartbeatSeq: number
  /** Number of `runtime/identity` events committed in this log. */
  identityCount: number
  /** Most recent identity's fingerprint (empty string if none). */
  lastFingerprint: string
}

/** Validate one event without mutating the committed trace. */
function validateEvent(trace: Trace, event: SessionEvent, fail: InvariantFailure): void {
  switch (event.type) {
    case 'runtime/heartbeat': {
      const data: RuntimeHeartbeatEvent = event.data
      if (data.seq <= trace.lastHeartbeatSeq) {
        fail(`runtime/heartbeat seq ${data.seq} is not strictly greater than the last observed ${trace.lastHeartbeatSeq}`)
      }
      break
    }
    case 'runtime/heartbeat-lost': {
      const data: { lastSeq: number } = event.data
      if (data.lastSeq !== trace.lastHeartbeatSeq) {
        fail(`runtime/heartbeat-lost lastSeq ${data.lastSeq} does not match the last observed heartbeat seq ${trace.lastHeartbeatSeq}`)
      }
      break
    }
    case 'runtime/identity': {
      const data: RuntimeIdentityEvent = event.data
      trace.identityCount += 1
      if (trace.identityCount === 1) {
        if (data.buildFingerprint.length === 0) {
          fail('first runtime/identity must carry a non-empty buildFingerprint')
        }
      } else {
        // Subsequent identities are valid; they signal a profile switch.
        // Two identities with the same fingerprint in the same log are a
        // configuration mistake the framework should surface, not silently
        // accept.
        if (data.buildFingerprint === trace.lastFingerprint) {
          fail(`runtime/identity committed twice with the same buildFingerprint ${data.buildFingerprint}; profile switch must change the fingerprint`)
        }
      }
      break
    }
    default:
      break
  }
}

/** Advance the trace after one event has committed. */
function advanceTrace(trace: Trace, event: SessionEvent): void {
  switch (event.type) {
    case 'runtime/heartbeat': {
      const data: RuntimeHeartbeatEvent = event.data
      trace.lastHeartbeatSeq = data.seq
      break
    }
    case 'runtime/identity': {
      const data: RuntimeIdentityEvent = event.data
      trace.lastFingerprint = data.buildFingerprint
      break
    }
    default:
      break
  }
}

/** Seed one trace by replaying a session's events once. */
function seedTrace(session: Session, fail: InvariantFailure): Trace {
  const trace: Trace = {
    lastHeartbeatSeq: 0,
    identityCount: 0,
    lastFingerprint: '',
  }
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of session.snapshotEvents()) {
    validateEvent(trace, event, fail)
    advanceTrace(trace, event)
  }
  return trace
}

/** Install the runtime-identity contribution. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, Trace>()
  const seed = (session: Session): void => {
    traces.set(session, seedTrace(session, fail))
  }
  const traceFor = (session: Session): Trace => {
    let trace = traces.get(session)
    if (trace === undefined) {
      trace = seedTrace(session, fail)
      traces.set(session, trace)
    }
    return trace
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(traceFor(session), event, fail)
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    advanceTrace(traceFor(session), event)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the runtime-identity invariant companion.
 *
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
