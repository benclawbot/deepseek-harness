/**
 * The Models page's ChatGPT sign-in, answered over the real seam: the pi-ai
 * login registration the provider offers, and the Remote controller the
 * settings surface calls. Both halves have to agree on one credential key, or
 * the page reports a sign-in that cannot happen.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import ProviderAuthorizationController from '../../../api/settings-controller/src/provider-authorization.ts'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from '../src/auth.ts'
import { registerPiAiFlows } from '../src/login.ts'

const CODEX = recordKeyFor('openai-codex')
const dirs: string[] = []
const fibers: Array<{ dispose(): Promise<void> }> = []

/** The record store, the seam, every pi-ai login flow, and the page's controller. */
async function harness(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-authorization-'))
  dirs.push(dir)
  const ctx = new Context()
  fibers.push(await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false }))
  fibers.push(await ctx.plugin(AuthorizationService))
  registerPiAiFlows(ctx, { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })
  fibers.push(await ctx.plugin(ProviderAuthorizationController))
  return ctx
}

afterEach(async () => {
  await Promise.all(fibers.splice(0).map(fiber => fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('ChatGPT sign-in over the authorization seam', () => {
  it('reports the installed OAuth flow as available and nothing stored', async () => {
    const ctx = await harness()
    const controller = ctx.providerAuthorizationController

    await expect(controller.state()).resolves.toEqual({ available: true, signedIn: false, inFlight: false })
    // The same key the page's sign-out deletes, so a stored grant is the one the
    // state reports rather than a record the page cannot address.
    await controller.signOut()
    await expect(controller.state()).resolves.toMatchObject({ signedIn: false })
    expect(ctx.authorization.describe(CODEX)?.methods.map(one => one.id)).toEqual(['oauth'])
  })

  it('refuses a method the installed flow does not offer', async () => {
    const ctx = await harness()

    const attempt = ctx.providerAuthorizationController.authorize('api-key', new AbortController().signal)
    await expect(attempt[Symbol.asyncIterator]().next()).rejects.toThrow('unsupported authorization method')
  })
})
