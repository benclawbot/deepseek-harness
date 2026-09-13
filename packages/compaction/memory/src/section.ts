/**
 * The `memory/notes` prompt section. Registered once by this package's
 * `apply()`; the text is rebuilt from `ctx.memory.readSync()` at every
 * assembly so the model sees the latest remembered notes without any
 * further plumbing.
 *
 * When no notes are stored, the section contributes empty text — the
 * cooperative assembly skips empty contributions, so the prompt is
 * clean for fresh installs.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, PromptSection, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { MemoryProviderService } from './registry.ts'
import type { MemoryNote } from './types.ts'

/**
 * The canonical section name the package registers. One name; profile
 * bundles do not register competing sections.
 */
export const MEMORY_SECTION_NAME = 'memory/notes'

/**
 * Render the section text from the latest committed notes. Empty
 * when the list is empty so the contribution stays in the cooperative
 * assembly without polluting the prompt.
 *
 * @param notes - the current notes, or `null` when the provider is
 *   unavailable (a one-shot layer that has not registered).
 * @returns the section text.
 */
export function renderMemorySection(notes: readonly MemoryNote[]): string {
  if (notes.length === 0) return ''
  const lines: string[] = []
  lines.push('Remembered notes (persistent across sessions).')
  for (const note of notes) {
    lines.push('')
    lines.push(`### ${note.key}`)
    if (note.tags.length > 0) lines.push(`tags: ${note.tags.join(', ')}`)
    lines.push(note.value)
  }
  lines.push('')
  lines.push('Use the `remember` tool to add or update a note; the model chooses the key and the value.')
  return lines.join('\n')
}

/**
 * Build the {@link PromptSection} for the memory-notes slot. The
 * section order is allocated through `getSectionOrder()` so the
 * centrally-owned placement in `core/system-prompt` is the single
 * source of truth; this package adds `MEMORY_NOTES` to the allocation.
 *
 * @param ctx - cordis context carrying `ctx.memory`.
 * @param systemPrompt - the system-prompt registry service.
 * @returns the prompt section registration.
 */
export function buildMemorySection(ctx: Context, systemPrompt: SystemPrompt): PromptSection {
  const service = ctx.memory as MemoryProviderService
  return {
    name: MEMORY_SECTION_NAME,
    order: systemPrompt.getSectionOrder('MEMORY_NOTES'),
    text: (_assemble: AssembleContext): string => renderMemorySection(service.readSync()),
  }
}

/**
 * Register the `memory/notes` section on `ctx.systemPrompt`. The
 * registration is owned by the inject callback's lifetime; when
 * `ctx.systemPrompt` is unavailable, the section is queued and
 * registered the moment the service becomes available.
 *
 * @param ctx - cordis context carrying both `ctx.memory` and
 *   `ctx.systemPrompt`.
 */
export function registerMemorySection(ctx: Context): void {
  ctx.inject(['systemPrompt'], (injectedCtx) => {
    injectedCtx.systemPrompt.section(buildMemorySection(injectedCtx, injectedCtx.systemPrompt))
  })
}
