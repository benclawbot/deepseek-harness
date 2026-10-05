/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** A notice or question the Models page can render without seeing credentials. */
export type ProviderAuthorizationFrame =
  | { readonly type: 'notice'; readonly message: string; readonly url?: string; readonly code?: string }
  | { readonly type: 'prompt'; readonly id: string; readonly prompt: ProviderAuthorizationPromptView }
  | { readonly type: 'settled'; readonly status: 'authorized' | 'cancelled' }
  /** The attempt broke; `message` is the flow's own diagnostic, never a credential. */
  | { readonly type: 'failed'; readonly message: string }

/** One choice of a select prompt, as the page renders it. */
export interface ProviderAuthorizationOptionView {
  readonly id: string
  readonly label: string
}

/** JSON-safe prompt fields, with the per-attempt AbortSignal removed. */
export type ProviderAuthorizationPromptView =
  | { readonly kind: 'text' | 'secret'; readonly message: string; readonly placeholder?: string }
  | { readonly kind: 'select'; readonly message: string; readonly options: readonly ProviderAuthorizationOptionView[] }
