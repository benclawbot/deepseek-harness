/** ChatGPT account controls use the Host's installed pi-ai authorization flow. */

import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProviderAuthorizationFrame, ProviderAuthorizationPromptView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations, CodexAuthorizationStatus } from './operations.ts'
import type { en } from './locales.ts'
import styles from './CodexOAuthControl.module.css'
import shared from './ModelsSection.module.css'

/** Render ChatGPT OAuth state and its browser authorization conversation. */
export function CodexOAuthControl({ operations, t }: {
  operations: ModelsOperations
  t: (key: keyof typeof en) => string
}) {
  const [status, setStatus] = useState<CodexAuthorizationStatus | undefined>()
  const [dialog, setDialog] = useState(false)
  const [busy, setBusy] = useState(false)
  /** The failure the human is told about, and the Host's own diagnostic beside it. */
  const [failure, setFailure] = useState<{ message: string; detail: string }>()
  const [notice, setNotice] = useState<Extract<ProviderAuthorizationFrame, { type: 'notice' }>>()
  const [question, setQuestion] = useState<{ id: string; prompt: ProviderAuthorizationPromptView }>()
  const [answer, setAnswer] = useState('')
  const active = useRef<AbortController>()

  const refresh = async (): Promise<void> => {
    setStatus(await operations.codexAuthorizationStatus())
  }
  useEffect(() => {
    let current = true
    void operations.codexAuthorizationStatus().then((value) => { if (current) setStatus(value) })
    return () => { current = false; active.current?.abort() }
  }, [operations])
  const stored = status?.kind === 'ready' ? status : undefined
  const refuse = (message: string, error: unknown): void => {
    setFailure({ message, detail: error instanceof Error ? error.message : String(error) })
  }

  const receive = (frame: ProviderAuthorizationFrame): void => {
    if (frame.type === 'notice') setNotice(frame)
    if (frame.type === 'prompt') {
      // A select answers with one of its option ids, so it starts on the first
      // option: an empty answer is not a choice the flow can accept.
      setQuestion({ id: frame.id, prompt: frame.prompt })
      setAnswer(frame.prompt.kind === 'select' ? frame.prompt.options[0]?.id ?? '' : '')
    }
    if (frame.type === 'settled') {
      setBusy(false)
      if (frame.status === 'authorized') { setDialog(false); void refresh() }
    }
    if (frame.type === 'failed') { setBusy(false); setFailure({ message: t('chatgptLoginFailed'), detail: frame.message }) }
  }

  const start = async (): Promise<void> => {
    const controller = new AbortController()
    active.current = controller
    setDialog(true)
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    setQuestion(undefined)
    try { await operations.authorizeCodex(receive, controller.signal) }
    catch (error) {
      // A withdrawal is the Cancel button's own doing; anything else is the Host
      // refusing or losing the attempt, and its diagnostic is what the human needs.
      if (!controller.signal.aborted) { setBusy(false); refuse(t('chatgptLoginFailed'), error) }
    }
    finally { if (active.current === controller) active.current = undefined }
  }

  const cancel = (): void => {
    active.current?.abort()
    active.current = undefined
    setBusy(false)
    setQuestion(undefined)
    setDialog(false)
  }

  const submitAnswer = async (active: { id: string }, value: string): Promise<void> => {
    try {
      await operations.answerCodexPrompt(active.id, value)
      setQuestion(undefined)
      setAnswer('')
    } catch (error) { refuse(t('chatgptLoginFailed'), error) }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    const refusal = await operations.signOutCodex()
    setBusy(false)
    if (refusal !== undefined) setFailure({ message: t('chatgptSignOutFailed'), detail: refusal })
    else await refresh()
  }

  return <section className={styles.root} aria-label={t('chatgptAuthorization')}>
    <div className={styles.status} role="status">
      {status === undefined
        ? t('chatgptReading')
        : status.kind === 'unreadable'
          ? t('chatgptStateUnreadable')
          : status.signedIn
            ? t('chatgptSignedIn')
            : status.available
              ? t('chatgptSignedOut')
              : t('chatgptUnavailable')}
    </div>
    <div className={styles.actions}>
      {stored?.signedIn === true
        ? <Button variant="outline" disabled={busy} onClick={() => { void signOut() }}>{t('chatgptSignOut')}</Button>
        : <Button variant="primary" disabled={busy || (stored !== undefined && (!stored.available || stored.inFlight))}
          onClick={() => { void start() }}>{t('chatgptSignIn')}</Button>}
      {failure !== undefined && <p className={styles.error} role="alert">
        <span>{failure.message}</span>
        <span className={styles.detail}> {failure.detail}</span>
      </p>}
    </div>
    <Modal open={dialog} headless title={t('chatgptLoginTitle')} onClose={cancel} className={styles.dialog as string}>
      <div className={styles.dialogBody}>
        <h2>{t('chatgptLoginTitle')}</h2>
        <p className={failure === undefined ? undefined : styles.dialogError}>
          {failure === undefined
            ? notice?.message ?? t('chatgptLoginDescription')
            : `${failure.message} ${failure.detail}`}
        </p>
        {notice !== undefined && busy && <p>{t('chatgptWorking')}</p>}
        {notice?.url !== undefined && <a href={notice.url} target="_blank" rel="noreferrer">{t('chatgptOpenBrowser')}</a>}
        {notice?.code !== undefined && <p><span>{t('chatgptCopyCode')}: </span><code>{notice.code}</code></p>}
        {question !== undefined && <form className={styles.prompt} onSubmit={(event) => {
          event.preventDefault()
          void submitAnswer(question, answer)
        }}>
          <label htmlFor="chatgpt-oauth-answer">{question.prompt.message}</label>
          {question.prompt.kind === 'select'
            ? <select id="chatgpt-oauth-answer" className={`${shared['input']} ${shared['selectInput']}`}
              value={answer} onChange={(event) => { setAnswer(event.target.value) }}>
              {question.prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            : <input id="chatgpt-oauth-answer" className={styles.promptInput}
              type={question.prompt.kind === 'secret' ? 'password' : 'text'}
              autoComplete="off" placeholder={question.prompt.placeholder} value={answer}
              onChange={(event) => { setAnswer(event.target.value) }} />}
          <Button variant="primary" type="submit">{t('chatgptPromptSubmit')}</Button>
        </form>}
      </div>
      <div className={styles.dialogActions}>
        <Button variant="outline" onClick={cancel}>{t('chatgptCancel')}</Button>
      </div>
    </Modal>
  </section>
}
