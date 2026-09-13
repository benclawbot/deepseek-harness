/**
 * The `runtime/world-state` prompt section: a registered system-prompt
 * contributor whose text derives from `ctx.runtimeIdentity.current()` at every
 * assembly. The section is profile-generic; every shipped profile sees
 * the same section text shape, and per-profile differences (a present
 * or absent `canonicalUrl`, a present or absent `sourceRoot`) appear in
 * the rendered text rather than the section name.
 *
 * The section is registered inside the package's own `apply()`; profile
 * bundles do not need to know the section exists. A profile that wants
 * to suppress the section (a one-shot non-interactive layer) reads
 * `ctx.config` inside its provider and signals suppression by returning
 * `null` from `snapshot()`; the registry treats `null` as "no identity
 * known" and the section renders empty.
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, PromptSection, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { RuntimeIdentity } from './types.ts'

/**
 * The canonical section name registered by this package. One name,
 * one slot; profile bundles do not register competing sections.
 */
export const RUNTIME_WORLD_STATE_SECTION = 'runtime/world-state'

/**
 * Render the section text from a {@link RuntimeIdentity}. Empty when
 * the identity is `null` (no provider registered, or a profile that
 * suppresses identity) so the contribution stays in the cooperative
 * assembly without poisoning the prompt.
 *
 * @param identity - the current identity, or `null`.
 * @returns the section text.
 */
export function renderWorldState(identity: RuntimeIdentity | null): string {
  if (identity === null) return ''
  const lines: string[] = []
  lines.push('You are running inside the DeepSeek Harness.')
  lines.push(`Profile: ${identity.profile}`)
  if (identity.canonicalUrl !== undefined) {
    lines.push(`Canonical URL: ${identity.canonicalUrl}`)
  }
  lines.push(`Build fingerprint: ${identity.buildFingerprint}`)
  if (identity.sourceRoot !== undefined) {
    lines.push(`Source checkout: ${identity.sourceRoot}`)
  }
  const caps: string[] = []
  if (identity.capabilities.hasNetworkSurface) caps.push('network')
  if (identity.capabilities.hasFilesystem) caps.push('filesystem')
  if (identity.capabilities.hasShell) caps.push('shell')
  if (identity.capabilities.hasSandbox) caps.push('sandbox')
  lines.push(`Capabilities: ${caps.join(', ') || '(none)'}`)
  lines.push(`Process id: ${identity.processId}`)
  return lines.join('\n')
}

/**
 * Build the {@link PromptSection} for the runtime-world-state slot. The
 * section order is allocated through `getSectionOrder()` so the
 * centrally-owned placement in `core/system-prompt` is the single source
 * of truth; this package adds `RUNTIME_WORLD_STATE` to the allocation
 * alongside `WEB_SURFACE` (which it supersedes).
 *
 * @param ctx - cordis context carrying `ctx.runtimeIdentity`.
 * @param systemPrompt - the system-prompt registry service.
 * @returns the prompt section registration.
 */
export function buildWorldStateSection(ctx: Context, systemPrompt: SystemPrompt): PromptSection {
  return {
    name: RUNTIME_WORLD_STATE_SECTION,
    order: systemPrompt.getSectionOrder('RUNTIME_WORLD_STATE'),
    text: (_assemble: AssembleContext): string => renderWorldState(ctx.runtimeIdentity.current()),
  }
}

/**
 * Register the `runtime/world-state` section on `ctx.systemPrompt`. The
 * registration is owned by the inject callback's lifetime; when
 * `ctx.systemPrompt` is unavailable, the section is queued and
 * registered the moment the service becomes available. Section
 * registration is itself a Cordis effect (`system-prompt/change`
 * notifies observers), so the framework tears it down on fiber
 * unload without an explicit disposer.
 *
 * @param ctx - cordis context carrying both `ctx.runtimeIdentity` and `ctx.systemPrompt`.
 */
export function registerWorldStateSection(ctx: Context): void {
  ctx.inject(['systemPrompt'], (injectedCtx) => {
    injectedCtx.systemPrompt.section(buildWorldStateSection(injectedCtx, injectedCtx.systemPrompt))
  })
}
