// @vitest-environment jsdom
/**
 * The ChatGPT operations as the Client binds them: what each Remote answer
 * becomes, and the stream a sign-in attempt rides.
 */

import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ProviderAuthorizationFrame } from '@deepseek-ai/dsh-api-remotes/client'
import { createModelsOperations } from '../src/client/operations.ts'

afterEach(() => { vi.restoreAllMocks() })

const ok = <T>(value: T) => ({ ok: true as const, value })
const refused = (message: string) => ({
  ok: false as const,
  error: new RemoteError('gateway/internal', message, {}),
})

/** Operations bound to exactly the namespace faces the ChatGPT controls call. */
function operationsWith(providerAuthorization: object, stream?: object) {
  const ctx = Object.assign(new Context(), {
    remote: { providerAuthorization, ...(stream === undefined ? {} : { $stream: stream }) },
  })
  return createModelsOperations(ctx)
}

it('restates a ready answer as the stored sign-in state', async () => {
  const state = { available: true, signedIn: true, inFlight: false }
  const operations = operationsWith({ state: vi.fn(() => Promise.resolve(ok(state))) })

  await expect(operations.codexAuthorizationStatus()).resolves.toEqual({ kind: 'ready', ...state })
})

it('reports a Host refusal as unreadable, carrying its diagnostic', async () => {
  const operations = operationsWith({ state: vi.fn(() => Promise.resolve(refused('namespace is gone'))) })

  await expect(operations.codexAuthorizationStatus()).resolves.toEqual({
    kind: 'unreadable',
    message: 'namespace is gone',
  })
})

it('reports a Client newer than its Host as unreadable rather than signed out', async () => {
  const operations = operationsWith({})

  await expect(operations.codexAuthorizationStatus()).resolves.toMatchObject({ kind: 'unreadable' })
})

it('streams the attempt until it settles, then releases the stream', async () => {
  const frames: ProviderAuthorizationFrame[] = [
    { type: 'notice', message: 'Continue in your browser', url: 'https://auth.example/start' },
    { type: 'settled', status: 'authorized' },
    { type: 'failed', message: 'never reached' },
  ]
  const dispose = vi.fn(() => Promise.resolve())
  const open = vi.fn((_method: string, _signal?: AbortSignal) => undefined)
  let next = 0
  const stream = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const frame = frames[next]
        next += 1
        return Promise.resolve(frame === undefined
          ? { done: true as const, value: undefined }
          : { done: false as const, value: { value: frame, accept: () => {}, reject: () => {} } })
      },
    }),
    dispose,
  }
  const streamFactory = vi.fn(() => stream)
  const operations = createModelsOperations(Object.assign(new Context(), {
    remote: {
      providerAuthorization: { authorize: open },
      $stream: vi.fn((options: { open: (signal: AbortSignal) => unknown }) => {
        options.open(new AbortController().signal)
        return streamFactory()
      }),
    },
  }))

  const seen: ProviderAuthorizationFrame[] = []
  await operations.authorizeCodex((frame) => { seen.push(frame) }, new AbortController().signal)

  // The settled frame ends the attempt, so the frame behind it is never delivered.
  expect(seen).toEqual([frames[0], frames[1]])
  expect(open).toHaveBeenCalledWith('oauth', expect.any(AbortSignal))
  expect(dispose).toHaveBeenCalled()
})

it('disposes the stream when the caller withdraws mid-attempt', async () => {
  // The real carrier ends its pending read on dispose; the stub does the same,
  // which is what lets the withdrawal reach the loop instead of hanging it.
  let end: (() => void) | undefined
  const dispose = vi.fn(() => {
    end?.()
    return Promise.resolve()
  })
  const stream = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<never>>((resolve) => {
        end = () => { resolve({ done: true as const, value: undefined }) }
      }),
    }),
    dispose,
  }
  const operations = createModelsOperations(Object.assign(new Context(), {
    remote: {
      providerAuthorization: { authorize: vi.fn() },
      $stream: vi.fn(() => stream),
    },
  }))
  const controller = new AbortController()

  const attempt = operations.authorizeCodex(() => {}, controller.signal)
  controller.abort()
  await attempt

  expect(dispose).toHaveBeenCalled()
})

it('reports a failure that is not an Error as unreadable, keeping its text', async () => {
  // A missing namespace can fail the property read itself, and Cordis rejects a
  // structural assembly fault with a plain reason; the control shows that text
  // rather than losing it.
  const remote = {
    get providerAuthorization(): never { throw 'remote.providerAuthorization is not a namespace' },
  }
  const operations = createModelsOperations(Object.assign(new Context(), { remote }))

  await expect(operations.codexAuthorizationStatus()).resolves.toEqual({
    kind: 'unreadable',
    message: 'remote.providerAuthorization is not a namespace',
  })
})

it('fails the attempt when the stream ends without a result', async () => {
  const dispose = vi.fn(() => Promise.resolve())
  let ended: (() => Error) | undefined
  // The carrier asks `ended` for the error that ends an attempt with no result,
  // so the stub's completed read rejects with exactly what it returns.
  const stream = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const error = ended?.()
        return error === undefined
          ? Promise.resolve({ done: true as const, value: undefined })
          : Promise.reject(error)
      },
    }),
    dispose,
  }
  const operations = createModelsOperations(Object.assign(new Context(), {
    remote: {
      providerAuthorization: { authorize: vi.fn() },
      $stream: vi.fn((options: { ended: () => Error }) => {
        ended = options.ended
        return stream
      }),
    },
  }))

  await expect(operations.authorizeCodex(() => {}, new AbortController().signal))
    .rejects.toThrow('ChatGPT authorization stream ended')
  expect(ended?.()).toBeInstanceOf(Error)
  expect(dispose).toHaveBeenCalled()
})

it('answers a prompt and reports a sign-out refusal', async () => {
  const answer = vi.fn(() => Promise.resolve(ok(undefined)))
  const signOut = vi.fn(() => Promise.resolve(refused('credential store is read-only')))
  const operations = operationsWith({ answer, signOut })

  await operations.answerCodexPrompt('p1', 'ABCD-1234')
  await expect(operations.signOutCodex()).resolves.toBe('credential store is read-only')
  expect(answer).toHaveBeenCalledWith('p1', 'ABCD-1234')
})

it('reports a successful sign-out as no refusal', async () => {
  const operations = operationsWith({ signOut: vi.fn(() => Promise.resolve(ok(undefined))) })

  await expect(operations.signOutCodex()).resolves.toBeUndefined()
})
