/**
 * The human-facing `/memory` slash command. Surfaces the same store
 * the model-facing `remember` tool writes to; the command grammar is
 * a small verb-led surface:
 *
 *   /memory                — list every note (the default)
 *   /memory list           — same as the default
 *   /memory show <key>     — show one note by key
 *   /memory forget <key>   — remove one note by key
 *
 * The command is a thin shim over `ctx.memory`; the store owns the
 * persistence and the validation rules.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** The slash command name. */
export const MEMORY_COMMAND_NAME = 'memory'

const USAGE = 'Usage: /memory [list | show <key> | forget <key>]'

/**
 * Render every note as a list of `key: value (tags)` triples. The
 * output is human-readable; the model never sees it directly.
 *
 * @param notes - the notes to render.
 * @returns the rendered text.
 */
function renderList(notes: readonly { key: string; value: string; tags: readonly string[]; updatedAt: number }[]): string {
  if (notes.length === 0) return 'No remembered notes. Use the `remember` model tool to add one.'
  const lines: string[] = [`${notes.length} remembered note${notes.length === 1 ? '' : 's'}:`]
  for (const note of notes) {
    const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''
    const preview = note.value.length > 80 ? `${note.value.slice(0, 77)}...` : note.value
    lines.push(`  ${note.key}${tags}: ${preview}`)
  }
  return lines.join('\n')
}

/**
 * The `/memory` command definition. The handler reads through
 * `ctx.memory`; the store owns persistence and validation.
 */
export const memoryCommandDefinition: CommandDefinition = {
  name: MEMORY_COMMAND_NAME,
  description: 'Inspect and manage the user-invokable compaction memory.',
  handler: async (_invocation: CommandInvocation): Promise<CommandResult> => {
    return { kind: 'error', text: USAGE }
  },
}

/**
 * Register the `/memory` command on `ctx.commands`. The companion
 * plugin mounts the registry; this function only adds the command.
 *
 * @param ctx - cordis context carrying `ctx.memory`.
 */
export function registerMemoryCommand(ctx: Context): void {
  const definition: CommandDefinition = {
    name: MEMORY_COMMAND_NAME,
    description: 'Inspect and manage the user-invokable compaction memory.',
    handler: async (invocation) => {
      const trimmed = invocation.rawInput.trim()
      if (trimmed === '' || trimmed === 'list') {
        const notes = await ctx.memory.list()
        return { kind: 'success', text: renderList(notes) }
      }
      if (trimmed === 'show') {
        return { kind: 'error', text: `${USAGE}\n(show requires a key)` }
      }
      const showMatch = /^show\s+(\S+)$/.exec(trimmed)
      if (showMatch !== null && showMatch[1] !== undefined) {
        const key = showMatch[1]
        const note = await ctx.memory.get(key)
        if (note === null) {
          return { kind: 'error', text: `No note with key "${key}". Use \`/memory list\` to see every key.` }
        }
        const tags = note.tags.length > 0 ? `\ntags: ${note.tags.join(', ')}` : ''
        return { kind: 'success', text: `${note.key}${tags}\n\n${note.value}` }
      }
      const forgetMatch = /^forget\s+(\S+)$/.exec(trimmed)
      if (forgetMatch !== null && forgetMatch[1] !== undefined) {
        const key = forgetMatch[1]
        const removed = await ctx.memory.forget(key)
        if (removed) return { kind: 'success', text: `Forgot note "${key}".` }
        return { kind: 'error', text: `No note with key "${key}" to forget.` }
      }
      return { kind: 'error', text: USAGE }
    },
  }
  ctx.commands.register(definition)
}
