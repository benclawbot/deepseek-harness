import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import ProviderAuthorizationController from '../src/provider-authorization.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const fibers: Array<{ dispose(): Promise<void> }> = []

async function boot(flow: AuthorizationFlow): Promise<{
  ctx: Context
  controller: ProviderAuthorizationController
}> {
  const ctx = new Context()
  fibers.push(await ctx.plugin(MemoryCredentials))
  fibers.push(await ctx.plugin(AuthorizationService))
  ctx.authorization.registerFlow(flow)
  fibers.push(await ctx.plugin(ProviderAuthorizationController))
  return { ctx, controller: ctx.providerAuthorizationController }
}

afterEach(async () => { await Promise.all(fibers.splice(0).map(fiber => fiber.dispose())) })

describe('ChatGPT OAuth Remote', () => {
  it('streams notices and prompts through the registered flow without returning grant data', async () => {
    const { controller } = await boot({
      key: KEY, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        session.notify({ message: 'Continue in your browser', url: 'https://auth.example/login' })
        const code = await session.prompt({ kind: 'text', message: 'Paste the callback code' })
        await session.commit({ kind: 'grant', payload: { access: 'sensitive-token', code } })
      },
    })
    const stream = new AbortController()
    const frames = controller.authorize('oauth', stream.signal)[Symbol.asyncIterator]()

    const notice = await frames.next()
    if (notice.done) throw new Error('the flow sent no notice')
    expect(notice.value).toMatchObject({ type: 'notice', url: 'https://auth.example/login' })
    const question = await frames.next()
    if (question.done) throw new Error('the flow asked no question')
    expect(question.value).toMatchObject({ type: 'prompt', prompt: { kind: 'text' } })
    const promptId = question.value.type === 'prompt' ? question.value.id : ''
    controller.answer(promptId, 'callback-value')
    const settled = await frames.next()
    if (settled.done) throw new Error('the flow never settled')

    expect(settled.value).toEqual({ type: 'settled', status: 'authorized' })
    expect(JSON.stringify([question.value, settled.value])).not.toContain('sensitive-token')
    await expect(controller.state()).resolves.toEqual({ available: true, signedIn: true, inFlight: false })
    await expect(controller.signOut()).resolves.toBeUndefined()
    await expect(controller.state()).resolves.toEqual({ available: true, signedIn: false, inFlight: false })
    expect(remoteMethods(controller).map(method => method.method)).toEqual(['state', 'authorize', 'answer', 'signOut'])
  })

  it('settles cancellation when the browser interaction stream closes', async () => {
    let started = false
    const { controller } = await boot({
      key: KEY, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        started = true
        await new Promise<void>((resolve) => {
          session.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      },
    })
    const lifetime = new AbortController()
    const iterator = controller.authorize('oauth', lifetime.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    while (!started) await Promise.resolve()
    lifetime.abort()
    await expect(pending).resolves.toMatchObject({ value: { type: 'settled', status: 'cancelled' } })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(controller.state()).resolves.toMatchObject({ inFlight: false, signedIn: false })
  })
})
