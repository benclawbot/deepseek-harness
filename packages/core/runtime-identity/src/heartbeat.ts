/**
 * The heartbeat emitter: a small, framework-agnostic timer wrapper that
 * one provider's `startHeartbeat()` returns. The registry installs the
 * returned disposer as a Cordis effect; the emitter itself owns the
 * monotonic `seq` counter, the wall-clock timestamp, and the optional
 * gap-detection that commits a `runtime/heartbeat-lost` event when the
 * interval lapses without a fresh tick.
 *
 * The emitter is deliberately tiny: a `setInterval` (or its test fake)
 * feeds `onTick`, and the registry subscribes to the tick to commit
 * `runtime/heartbeat` events on the receiving session. The default
 * implementation lives here; profile-specific emitters (e.g. an ACP
 * profile that wants 1 s heartbeats) implement `startHeartbeat` against
 * the same contract.
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

import type { RuntimeHeartbeatEvent } from './types.ts'

/**
 * The minimal timer abstraction the emitter depends on. The default
 * implementation uses Node's `setInterval`/`clearInterval`; tests can
 * inject a fake to control time deterministically.
 */
export interface HeartbeatTicker {
  /**
   * Schedule `tick` to be called every `intervalMs` milliseconds. The
   * returned handle is opaque; pass it to {@link HeartbeatTicker.stop}
   * to cancel.
   *
   * @param tick - the function invoked on each tick.
   * @param intervalMs - interval in milliseconds (must be `> 0`).
   * @returns the opaque handle.
   */
  schedule(tick: () => void, intervalMs: number): unknown
  /**
   * Cancel a handle previously returned by {@link HeartbeatTicker.schedule}.
   *
   * @param handle - the handle to cancel.
   */
  stop(handle: unknown): void
}

/**
 * The default Node.js ticker. Profiles that boot in environments without
 * `setInterval` (rare; the harness is Node-only) must provide their own.
 */
export const nodeTicker: HeartbeatTicker = {
  schedule(tick, intervalMs) {
    return setInterval(tick, intervalMs)
  },
  stop(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

/**
 * Construct an emitter bound to a ticker and a tick callback. The
 * returned `start` function begins the interval and returns a disposer;
 * the returned `seq` accessor reports the current monotonic count for
 * test assertions.
 *
 * The emitter never throws; an invalid interval (≤ 0, non-finite)
 * produces a no-op start that logs to the optional `onError` callback
 * rather than crashing the host fiber.
 *
 * @param ticker - the ticker to use.
 * @param onTick - the callback invoked on each tick (typically commits the `runtime/heartbeat` event).
 * @param options - the emitter options.
 * @returns the emitter handles.
 */
export interface HeartbeatEmitterOptions {
  /** Floor below which an interval is rejected as unsafe. Defaults to 100 ms. */
  floorMs?: number
  /** Optional sink for emitter-internal errors (default: throw). */
  onError?: (error: Error) => void
}

export interface HeartbeatEmitter {
  /**
   * Begin emitting. Returns a disposer that cancels the interval.
   * Calling `start` while a previous interval is active cancels the
   * previous one before scheduling the new one (the registry never
   * does this in practice; the function exists for the
   * `invalidate()` re-registration path).
   *
   * @param intervalMs - interval in milliseconds (must be `> floorMs`).
   * @returns the disposer.
   */
  start(intervalMs: number): () => void
  /** Current monotonic sequence number (0 when never started). */
  seq(): number
}

export function createHeartbeatEmitter(
  ticker: HeartbeatTicker,
  onTick: (event: RuntimeHeartbeatEvent) => void,
  options: HeartbeatEmitterOptions = {},
): HeartbeatEmitter {
  const floor = options.floorMs ?? 100
  let counter = 0
  let active: unknown = null
  const stopActive = (): void => {
    if (active === null) return
    ticker.stop(active)
    active = null
  }
  const fail = (message: string): never => {
    const error = new Error(message)
    if (options.onError !== undefined) {
      options.onError(error)
      /* v8 ignore next -- throw after reporting is unreachable when onError swallows */
      throw error
    }
    throw error
  }
  const tick = (): void => {
    counter += 1
    onTick({ seq: counter, ts: Date.now() })
  }
  return {
    start(intervalMs) {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        fail(`heartbeat interval must be a positive finite number, got ${String(intervalMs)}`)
      }
      if (intervalMs < floor) {
        fail(`heartbeat interval ${intervalMs} ms is below the ${floor} ms floor`)
      }
      stopActive()
      active = ticker.schedule(tick, intervalMs)
      return stopActive
    },
    seq() {
      return counter
    },
  }
}
