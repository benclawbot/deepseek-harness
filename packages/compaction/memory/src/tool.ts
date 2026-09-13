/**
 * The model-facing `remember` tool. Defined through the package's own
 * `defineTool` helper so the schema, description, and execution shape
 * follow the same conventions every other tool in the repo uses.
 *
 * The tool accepts a `key`, a `value`, and an optional `tags` array.
 * Validation runs in the registry's `remember()` method; the execute
 * body surfaces validation failures by throwing, which the tool
 * pipeline translates into a structured tool failure the model can
 * read.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** The model-facing tool name. */
export const REMEMBER_TOOL_NAME = 'remember'

/** Description prose for the model; explains what the tool does and what it persists. */
const DESCRIPTION =
  'Persist a fact, preference, or context the model should remember across sessions. '
  + 'A note is a (key, value, optional tags) triple. The key must be a short lower-case '
  + 'identifier (e.g. "user-name", "repo-style"); the value is free-form prose; the tags '
  + 'are optional short tokens the model can use to scope recall later. Existing notes '
  + 'with the same key are overwritten; every write is durable across runs.'

/**
 * The `remember` tool's parameter specification. Stable across the
 * repo's tool catalog; the registry serializes it into the model-visible
 * schema. `tags` is optional and therefore omits `required: true` rather
 * than setting it to false — `ParameterPropertySpec` accepts only the
 * literal `true`.
 */
const parameters = {
  key: {
    type: 'string',
    required: true,
    description: 'A short lower-case identifier for the note (e.g. "user-name", "repo-style").',
  },
  value: {
    type: 'string',
    required: true,
    description: 'Free-form prose the model should remember.',
  },
  tags: {
    type: 'array',
    description: 'Optional short tokens the model uses to scope recall.',
    items: {
      type: 'string',
      description: 'A short lower-case tag.',
    },
  },
} as const

/**
 * The output schema. The model sees a structured result with the
 * committed key, value, tags, and the `updatedAt` timestamp.
 */
const output = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true, description: 'The committed note key.' },
    value: { type: 'string', required: true, description: 'The committed note value.' },
    tags: {
      type: 'array',
      required: true,
      items: { type: 'string', required: true, description: 'A short lower-case tag.' },
    },
    updatedAt: { type: 'integer', required: true, description: 'Unix milliseconds.' },
  },
} as const

/**
 * Build the {@link ToolDefinition} for the `remember` tool.
 *
 * @param memory - the memory provider the tool reads through. The
 *   caller captures this from the cordis context at registration time
 *   because tool `execute` callbacks don't receive a context handle.
 * @returns the tool definition ready for `ctx.tools.register()`.
 */
export function rememberTool(memory: {
  remember: (key: string, value: string, tags: readonly string[]) => Promise<{
    key: string
    value: string
    tags: readonly string[]
    updatedAt: number
  }>
}) {
  return defineTool({
    name: REMEMBER_TOOL_NAME,
    description: DESCRIPTION,
    parameters,
    output: {
      schema: output,
      render: (_args, value) => {
        const v = value as {
          key: string
          value: string
          tags: readonly string[]
          updatedAt: number
        }
        return [{
          type: 'text',
          text: `remembered "${v.key}" (${v.tags.length} tag${v.tags.length === 1 ? '' : 's'})`,
        }]
      },
    },
    async execute(args) {
      // The tool registry validates `args` against `parameters` before
      // calling `execute`, so the cast below is total over the
      // parameter spec's `required` + `optional` keys.
      const a = args as { key: string; value: string; tags?: string[] }
      // Validation lives in the registry's `remember()`; throwing here
      // surfaces the structured error to the tool pipeline.
      const note = await memory.remember(a.key, a.value, a.tags ?? [])
      return {
        key: note.key,
        value: note.value,
        tags: note.tags,
        updatedAt: note.updatedAt,
      }
    },
  })
}
