/** Remote browser interaction for the installed ChatGPT Codex login flow. */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ProviderAuthorizationFrame, ProviderAuthorizationPromptView } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** ChatGPT OAuth operations available to the Models settings page. */
    providerAuthorizationController: ProviderAuthorizationController
  }
}

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const ANSWER_LIMIT = 16_384

interface PendingAnswer {
  readonly resolve: (answer: string) => void
  readonly reject: (error: Error) => void
}

/** Host service for ChatGPT OAuth controls on Models settings. */
export class ProviderAuthorizationController extends TypertRemoteService {
  static inject = ['authorization', 'credentials']
  /** Live prompt answers are process-local and never enter a credential store. */
  private readonly prompts = new Map<string, PendingAnswer>()
  /** @param ctx - Host carrying the existing authorization and credential services. */
  constructor(ctx: Context) {
    super(ctx, 'providerAuthorizationController', { namespace: 'providerAuthorization' })
  }

  /** Return only whether the installed flow and stored grant exist. */
  @Remote
  async state(): Promise<{ available: boolean; signedIn: boolean; inFlight: boolean }> {
    const flow = this.ctx.authorization.describe(KEY)
    const stored = await this.ctx.credentials.describeRecord(KEY)
    return { available: flow !== undefined, signedIn: stored.configured, inFlight: flow?.inFlight ?? false }
  }

  /**
   * Run pi-ai's existing login flow and stream its safe UI interaction frames.
   * @param method - flow method selected from the installed OAuth flow.
   * @param signal - stream lifetime; disconnect withdraws the authorization attempt.
   * @returns notices, prompts, and the terminal result, never the credential record.
   */
  @Remote({ mode: 'stream' })
  async *authorize(method: string, signal: AbortSignal): AsyncIterable<ProviderAuthorizationFrame> {
    if (method !== 'oauth') throw new RemoteError('gateway/bad-request', 'unsupported authorization method', {})
    const flow = this.ctx.authorization.describe(KEY)
    if (flow === undefined || !flow.methods.some(candidate => candidate.id === method)) {
      throw new RemoteError('gateway/bad-request', 'ChatGPT OAuth is unavailable', {})
    }
    const queue = new FrameQueue()
    const answer = async (prompt: AuthorizationPrompt): Promise<string> => {
      const id = randomUUID()
      const pending = Promise.withResolvers<string>()
      this.prompts.set(id, { resolve: pending.resolve, reject: pending.reject })
      const abort = (): void => { pending.reject(new Error('authorization prompt withdrawn')) }
      prompt.signal?.addEventListener('abort', abort, { once: true })
      queue.push({ type: 'prompt', id, prompt: promptView(prompt) })
      try { return await pending.promise }
      finally {
        this.prompts.delete(id)
        prompt.signal?.removeEventListener('abort', abort)
      }
    }
    const running = this.ctx.authorization.begin({
      key: KEY,
      method,
      signal,
      interaction: {
        notify: (notice) => {
          queue.push({
            type: 'notice', message: notice.message,
            ...(notice.url === undefined ? {} : { url: notice.url }),
            ...(notice.code === undefined ? {} : { code: notice.code }),
          })
        },
        prompt: answer,
      },
    }).then(
      (outcome) => { queue.push({ type: 'settled', status: outcome.status }) },
      (error: unknown) => {
        // The surface asked why sign-in failed; only the flow knows, and its
        // diagnostic carries no grant material.
        const message = error instanceof Error ? error.message : String(error)
        queue.push({ type: 'failed', message })
      },
    ).finally(() => { queue.end() })
    signal.addEventListener('abort', () => { this.ctx.authorization.cancel(KEY) }, { once: true })
    try {
      for await (const frame of queue.read()) yield frame
    } finally {
      if (!signal.aborted) this.ctx.authorization.cancel(KEY)
      await running
    }
  }

  /** Answer one active pi-ai prompt without returning the answer to the Host UI. */
  @Remote
  answer(id: string, value: string | null): void {
    const pending = this.prompts.get(id)
    if (pending === undefined) return
    if (value === null) pending.reject(new Error('authorization prompt declined'))
    else if (value.length > ANSWER_LIMIT) throw new RemoteError('gateway/bad-request', 'authorization answer is too long', {})
    else pending.resolve(value)
  }

  /** Remove the local OAuth record; no token or provider response crosses back. */
  @Remote
  async signOut(): Promise<void> {
    await this.ctx.credentials.deleteRecord(KEY)
  }
}

export default ProviderAuthorizationController

/** Keep only prompt fields the renderer needs and omit AbortSignal. */
function promptView(prompt: AuthorizationPrompt): ProviderAuthorizationPromptView {
  switch (prompt.kind) {
    case 'select': return { kind: 'select', message: prompt.message, options: prompt.options }
    case 'secret': return {
      kind: 'secret', message: prompt.message,
      ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
    }
    case 'text': return {
      kind: 'text', message: prompt.message,
      ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
    }
  }
}

/** Small pull queue that retains notices emitted before the first read. */
class FrameQueue {
  private readonly frames: ProviderAuthorizationFrame[] = []
  private waiter: (() => void) | undefined
  private done = false

  push(frame: ProviderAuthorizationFrame): void {
    if (this.done) return
    this.frames.push(frame)
    this.waiter?.()
  }

  end(): void { this.done = true; this.waiter?.() }

  async *read(): AsyncGenerator<ProviderAuthorizationFrame> {
    while (!this.done || this.frames.length > 0) {
      if (this.frames.length > 0) { yield this.frames.shift() as ProviderAuthorizationFrame; continue }
      await new Promise<void>((resolve) => { this.waiter = resolve })
      this.waiter = undefined
    }
  }
}
