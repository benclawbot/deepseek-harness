/**
 * Tests for the heartbeat emitter: monotonic seq, ticker delegation,
 * dispose semantics, floor enforcement, and error surfacing.
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

import { describe, expect, it, vi } from 'vitest'
import { createHeartbeatEmitter, type HeartbeatTicker } from '../src/heartbeat.ts'

function fakeTicker(): HeartbeatTicker & { tick: () => void; scheduled: number; cancelled: number } {
  let tickFn: () => void = () => {}
  const ticker = {
    scheduled: 0,
    cancelled: 0,
    get tick(): () => void { return tickFn },
    schedule(fn: () => void, _ms: number) {
      tickFn = () => {
        ticker.scheduled += 1
        fn()
      }
      ticker.scheduled += 1
      return { id: ticker.scheduled }
    },
    stop(_handle: unknown) {
      ticker.cancelled += 1
    },
  }
  return ticker
}

describe('createHeartbeatEmitter', () => {
  it('invokes onTick with a strictly monotonic seq', () => {
    const ticker = fakeTicker()
    const events: number[] = []
    const emitter = createHeartbeatEmitter(ticker, (event) => { events.push(event.seq) })
    emitter.start(1_000)
    ticker.tick()
    ticker.tick()
    ticker.tick()
    expect(events).toEqual([1, 2, 3])
  })

  it('records ts from Date.now()', () => {
    const ticker = fakeTicker()
    const observed: number[] = []
    const emitter = createHeartbeatEmitter(ticker, (event) => { observed.push(event.ts) })
    emitter.start(1_000)
    ticker.tick()
    ticker.tick()
    expect(observed.length).toBe(2)
    expect(observed[1]).toBeGreaterThanOrEqual(observed[0]!)
  })

  it('returns a disposer that cancels the ticker', () => {
    const ticker = fakeTicker()
    const emitter = createHeartbeatEmitter(ticker, () => {})
    const stop = emitter.start(1_000)
    expect(ticker.scheduled).toBe(1)
    stop()
    expect(ticker.cancelled).toBe(1)
  })

  it('seq() returns 0 before any tick', () => {
    const ticker = fakeTicker()
    const emitter = createHeartbeatEmitter(ticker, () => {})
    expect(emitter.seq()).toBe(0)
    emitter.start(1_000)
    expect(emitter.seq()).toBe(0)
  })

  it('rejects intervals below the floor', () => {
    const ticker = fakeTicker()
    const emitter = createHeartbeatEmitter(ticker, () => {})
    expect(() => emitter.start(50)).toThrow(/below the 100 ms floor/)
  })

  it('rejects non-finite intervals', () => {
    const ticker = fakeTicker()
    const emitter = createHeartbeatEmitter(ticker, () => {})
    expect(() => emitter.start(Number.NaN)).toThrow(/positive finite number/)
    expect(() => emitter.start(0)).toThrow(/positive finite number/)
    expect(() => emitter.start(-1)).toThrow(/positive finite number/)
  })

  it('honors a custom floor', () => {
    const ticker = fakeTicker()
    const emitter = createHeartbeatEmitter(ticker, () => {}, { floorMs: 500 })
    expect(() => emitter.start(200)).toThrow(/below the 500 ms floor/)
  })

  it('routes errors through onError when provided', () => {
    const ticker = fakeTicker()
    const onError = vi.fn()
    const emitter = createHeartbeatEmitter(ticker, () => {}, { onError })
    // The onError path swallows the throw so the host fiber is not torn down.
    expect(() => emitter.start(50)).toThrow(/floor/)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('starting twice cancels the previous interval', () => {
    const ticker = fakeTicker()
    const emitter = createHeartbeatEmitter(ticker, () => {})
    emitter.start(1_000)
    emitter.start(2_000)
    expect(ticker.scheduled).toBe(2)
    expect(ticker.cancelled).toBe(1)
  })
})
