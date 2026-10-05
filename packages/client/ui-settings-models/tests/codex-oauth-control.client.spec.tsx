// @vitest-environment jsdom
/** ChatGPT sign-in, cancellation, sign-out, and connection status in the provider editor. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderAuthorizationFrame } from '@deepseek-ai/dsh-api-remotes/client'
import { CodexOAuthControl } from '../src/client/CodexOAuthControl.tsx'
import type { CodexAuthorizationStatus, ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]
const ready = (state: { available?: boolean; signedIn?: boolean; inFlight?: boolean }): CodexAuthorizationStatus => ({
  kind: 'ready',
  available: state.available ?? true,
  signedIn: state.signedIn ?? false,
  inFlight: state.inFlight ?? false,
})
const SIGNED_OUT = ready({})
/** A Client newer than its Host: the Remote namespace is not installed at all. */
const UNREADABLE: CodexAuthorizationStatus = { kind: 'unreadable', message: 'remote.providerAuthorization is not a namespace' }

/** The Host operations under test, with a captured frame sink and abort signal. */
function operations(overrides: Partial<ModelsOperations> = {}) {
  const state = vi.fn<ModelsOperations['codexAuthorizationStatus']>().mockResolvedValue(SIGNED_OUT)
  const answer = vi.fn<ModelsOperations['answerCodexPrompt']>().mockResolvedValue(undefined)
  const signOut = vi.fn<ModelsOperations['signOutCodex']>().mockResolvedValue(undefined)
  let emit = (_frame: ProviderAuthorizationFrame): void => {}
  let signal: AbortSignal | undefined
  /** The Host stream stays open until the attempt settles or the client cancels. */
  const stream = Promise.withResolvers<undefined>()
  const bound: ModelsOperations = {
    discoverModels: vi.fn(),
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings: vi.fn(),
    codexAuthorizationStatus: state,
    authorizeCodex: vi.fn<ModelsOperations['authorizeCodex']>((onFrame, abortSignal) => {
      signal = abortSignal
      emit = onFrame
      return stream.promise
    }),
    answerCodexPrompt: answer,
    signOutCodex: signOut,
    ...overrides,
  }
  return {
    operations: bound,
    state,
    answer,
    signOut,
    /** Deliver one Host frame to the mounted control. */
    deliver: async (frame: ProviderAuthorizationFrame) => {
      await act(async () => { emit(frame) })
      if (frame.type === 'settled' || frame.type === 'failed') stream.resolve(undefined)
    },
    aborted: () => signal?.aborted,
  }
}

/** Mount the control over the given operations and wait for its first status read. */
async function mount(bound: ModelsOperations) {
  render(<CodexOAuthControl operations={bound} t={t} />)
  await waitFor(() => { expect(screen.getByRole('status').textContent).not.toBe(en.chatgptReading) })
}

it('offers sign-in while the stored grant is absent', async () => {
  const test = operations()
  await mount(test.operations)
  expect(screen.getByRole('status').textContent).toBe(en.chatgptSignedOut)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  expect(screen.getByRole('dialog')).not.toBeNull()
  expect(screen.getByText(en.chatgptLoginDescription).textContent).toBe(en.chatgptLoginDescription)
})

it('reports an installation without the ChatGPT flow and keeps sign-in disabled', async () => {
  const test = operations({ codexAuthorizationStatus: vi.fn().mockResolvedValue(ready({ available: false })) })
  await mount(test.operations)
  expect(screen.getByRole('status').textContent).toBe(en.chatgptUnavailable)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatgptSignIn }).disabled).toBe(true)
})

it('disables sign-in while the Host already runs an attempt', async () => {
  const test = operations({ codexAuthorizationStatus: vi.fn().mockResolvedValue(ready({ inFlight: true })) })
  await mount(test.operations)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatgptSignIn }).disabled).toBe(true)
})

it('names the Host gap instead of reporting a silent sign-out, and still allows a try', async () => {
  const test = operations({ codexAuthorizationStatus: vi.fn().mockResolvedValue(UNREADABLE) })
  await mount(test.operations)
  expect(screen.getByRole('status').textContent).toBe(en.chatgptStateUnreadable)
  const button = screen.getByRole<HTMLButtonElement>('button', { name: en.chatgptSignIn })
  expect(button.disabled).toBe(false)
  await act(async () => { fireEvent.click(button) })
  expect(screen.getByRole('dialog')).not.toBeNull()
})

it('reports a refusal from the Host with its own diagnostic', async () => {
  const test = operations({
    authorizeCodex: vi.fn().mockRejectedValue(new Error('ChatGPT OAuth is unavailable')),
  })
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(en.chatgptLoginFailed)
  expect(alert.textContent).toContain('ChatGPT OAuth is unavailable')
})

it('reports a rejection that is not an Error with its own text', async () => {
  const test = operations({ authorizeCodex: vi.fn().mockRejectedValue('stream carrier gone') })
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  expect((await screen.findByRole('alert')).textContent).toContain('stream carrier gone')
})

it('drops a status read that lands after unmount', async () => {
  const pending = Promise.withResolvers<CodexAuthorizationStatus>()
  const test = operations({ codexAuthorizationStatus: vi.fn(() => pending.promise) })
  const view = render(<CodexOAuthControl operations={test.operations} t={t} />)
  view.unmount()
  await act(async () => { pending.resolve(SIGNED_OUT) })
  expect(screen.queryByRole('status')).toBeNull()
})

it('renders the browser notice with its link and verification code', async () => {
  const test = operations()
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({ type: 'notice', message: 'Waiting for the browser', url: 'https://auth.example/start', code: 'ABCD-1234' })
  expect(screen.getByRole<HTMLAnchorElement>('link', { name: en.chatgptOpenBrowser }).href)
    .toBe('https://auth.example/start')
  expect(screen.getByText('ABCD-1234')).not.toBeNull()
  expect(screen.getByText(en.chatgptWorking)).not.toBeNull()
})

it('answers a text prompt and a select prompt in one attempt', async () => {
  const test = operations()
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({
    type: 'prompt', id: 'p1',
    prompt: { kind: 'text', message: 'Paste the verification code', placeholder: 'code' },
  })
  await act(async () => { fireEvent.change(screen.getByLabelText('Paste the verification code'), { target: { value: 'ABCD-1234' } }) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptPromptSubmit })) })
  expect(test.answer).toHaveBeenCalledWith('p1', 'ABCD-1234')
  await test.deliver({
    type: 'prompt', id: 'p2',
    prompt: { kind: 'select', message: 'Pick a plan', options: [{ id: 'free', label: 'Free' }] },
  })
  await act(async () => { fireEvent.change(screen.getByLabelText('Pick a plan'), { target: { value: 'free' } }) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptPromptSubmit })) })
  expect(test.answer).toHaveBeenCalledWith('p2', 'free')
})

it('offers no choice to submit when a select arrives without options', async () => {
  const test = operations()
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({ type: 'prompt', id: 'p6', prompt: { kind: 'select', message: 'Pick one', options: [] } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptPromptSubmit })) })
  expect(test.answer).toHaveBeenCalledWith('p6', '')
})

it('masks a secret prompt', async () => {
  const test = operations()
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({ type: 'prompt', id: 'p3', prompt: { kind: 'secret', message: 'Device code' } })
  expect(screen.getByLabelText<HTMLInputElement>('Device code').type).toBe('password')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptPromptSubmit })) })
  expect(test.answer).toHaveBeenCalledWith('p3', '')
})

it('reports a failed answer without ending the attempt', async () => {
  const test = operations({ answerCodexPrompt: vi.fn().mockRejectedValue(new Error('prompt gone')) })
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({ type: 'prompt', id: 'p4', prompt: { kind: 'text', message: 'Code' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptPromptSubmit })) })
  expect(screen.getByRole('alert').textContent).toContain('prompt gone')
})

it('closes on authorization and swaps to sign-out', async () => {
  const state = vi.fn<ModelsOperations['codexAuthorizationStatus']>()
    .mockResolvedValueOnce(SIGNED_OUT)
    .mockResolvedValue(ready({ signedIn: true }))
  const test = operations({ codexAuthorizationStatus: state })
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({ type: 'settled', status: 'authorized' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(screen.getByRole('status').textContent).toBe(en.chatgptSignedIn)
  expect(screen.getByRole('button', { name: en.chatgptSignOut })).not.toBeNull()
})

it('stays open when the attempt is cancelled by the Host', async () => {
  const test = operations()
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({ type: 'settled', status: 'cancelled' })
  expect(screen.getByText(en.chatgptLoginDescription)).not.toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatgptSignIn }).disabled).toBe(false)
})

it('aborts the stream when the user cancels the dialog', async () => {
  const test = operations()
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptCancel })) })
  expect(test.aborted()).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps a settled dialog for a rejection that arrives after cancellation', async () => {
  let reject: (error: Error) => void = () => {}
  const pending = new Promise<undefined>((_, fail) => { reject = fail })
  const test = operations({ authorizeCodex: vi.fn(() => pending) })
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptCancel })) })
  const settled = pending.catch(() => undefined)
  await act(async () => { reject(new Error('stream ended')) })
  await act(async () => { await settled })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('reports a failed attempt with the flow diagnostic in the alert and the dialog', async () => {
  const test = operations()
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({ type: 'failed', message: 'no account is signed in on this device' })
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain(en.chatgptLoginFailed)
  expect(alert.textContent).toContain('no account is signed in on this device')
  // The dialog is where the human is looking when the flow breaks.
  expect(screen.getByRole('dialog').textContent).toContain('no account is signed in on this device')
})

it('starts a select prompt on its first option, so Continue sends a real choice', async () => {
  const test = operations()
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignIn })) })
  await test.deliver({
    type: 'prompt', id: 'p5',
    prompt: {
      kind: 'select', message: 'Select OpenAI Codex login method:',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device_code', label: 'Device code login (headless)' },
      ],
    },
  })
  const select = screen.getByLabelText<HTMLSelectElement>('Select OpenAI Codex login method:')
  expect(select.value).toBe('browser')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptPromptSubmit })) })
  expect(test.answer).toHaveBeenCalledWith('p5', 'browser')
})

it('signs out and reads the stored grant again', async () => {
  const state = vi.fn<ModelsOperations['codexAuthorizationStatus']>()
    .mockResolvedValueOnce(ready({ signedIn: true }))
    .mockResolvedValue(SIGNED_OUT)
  const test = operations({ codexAuthorizationStatus: state })
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignOut })) })
  expect(test.signOut).toHaveBeenCalled()
  await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en.chatgptSignedOut) })
})

it('reports a sign-out refusal with the Host diagnostic', async () => {
  const test = operations({
    codexAuthorizationStatus: vi.fn().mockResolvedValue(ready({ signedIn: true })),
    signOutCodex: vi.fn().mockResolvedValue('credential store is read-only'),
  })
  await mount(test.operations)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.chatgptSignOut })) })
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(en.chatgptSignOutFailed)
  expect(alert.textContent).toContain('credential store is read-only')
})
