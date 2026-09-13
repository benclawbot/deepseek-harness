/**
 * The user-invokable compaction memory seam: Service Definition +
 * Provider contract + Consumer surface (model-facing `remember` tool
 * and human-facing `/memory` slash command). The merge-extensible
 * `MemoryNote` and `MemoryStore` types live in `./types.ts`; the
 * file-backed store in `./store-yaml.ts`; the Cordis registry in
 * `./registry.ts`; the prompt section in `./section.ts`; the tool in
 * `./tool.ts`; the slash command in `./command.ts`.
 *
 * The package is opt-in: a profile bundle mounts it like any other
 * capability seam, and the model sees the `memory/notes` prompt
 * section from the first turn. The default store writes to
 * `$DSH_HOME/memory.yaml`; tests inject the in-memory store.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveMemoryPath } from './types.ts'
import type { CompactionMemoryPlugin } from './types.ts'
import { createFileBackedMemoryProvider } from './registry.ts'
import { registerMemorySection } from './section.ts'
import { rememberTool } from './tool.ts'
import { registerMemoryCommand } from './command.ts'

// Type-only re-export of the cordis Context merge for `ctx.memory`.
import type {} from './types.ts'

export type {
  CompactionMemoryPlugin,
  FileMemoryStoreOptions,
  MemoryLimits,
  MemoryNote,
  MemoryStore,
  MemoryWriteError,
} from './types.ts'
export { DEFAULT_MEMORY_LIMITS, MEMORY_KEY_PATTERN, MEMORY_TAG_PATTERN, resolveMemoryPath } from './types.ts'
export { MemoryProviderService, createFileBackedMemoryProvider, createInMemoryMemoryProvider } from './registry.ts'
export { createInMemoryMemoryStore, createYamlMemoryStore } from './store-yaml.ts'
export { MEMORY_SECTION_NAME, renderMemorySection, registerMemorySection, buildMemorySection } from './section.ts'
export { REMEMBER_TOOL_NAME, rememberTool } from './tool.ts'
export { MEMORY_COMMAND_NAME, registerMemoryCommand } from './command.ts'

/** Stable Cordis plugin name. */
export const name = 'compaction-memory'

/**
 * Services the plugin requires before its `apply()` can mount the
 * registry and register the prompt section, the tool, and the slash
 * command. `memory` is provided by this same plugin; the others are
 * external dependencies.
 */
export const inject = ['commands', 'systemPrompt', 'tools', 'launchEnvironment']

/**
 * Mount the memory registry and register the prompt section, the
 * model-facing `remember` tool, and the human-facing `/memory` slash
 * command. The default export mirrors the convention every other
 * capability seam in the repo follows, so `ctx.plugin(CompactionMemory)`
 * mounts it.
 *
 * The plugin reads the DSH home from `ctx.launchEnvironment` and
 * resolves the persistent store path through `resolveMemoryPath`;
 * callers that want a non-default location pass `path` through the
 * bundle's own configuration layer (a future RFC; this PR keeps the
 * default).
 *
 * @param ctx - cordis context carrying the injected services.
 */
export function apply(ctx: Context): void {
  const launch = ctx.get('launchEnvironment')
  const dshHome = launch?.values?.DSH_HOME ?? ''
  const cwd = launch?.cwd ?? process.cwd()
  const path = resolveMemoryPath(dshHome, cwd)
  // The provider is constructed and registered as `ctx.memory`; the
  // section, tool, and command register against it. The tool's
  // `execute` callback captures the provider from the cordis context
  // (no `ctx` handle on `ToolRunContext`); the section, the slash
  // command, and the tool all read through the same registry.
  const provider = createFileBackedMemoryProvider(ctx, path)
  registerMemorySection(ctx)
  ctx.tools.register(rememberTool(provider))
  registerMemoryCommand(ctx)
}

/**
 * Default export for `ctx.plugin(CompactionMemory)`. Cordis mounts the
 * namespace plugin; the static `apply` (above) drives the boot
 * sequence. The default-export form mirrors the convention every other
 * capability seam in the repo follows.
 */
export default { name, inject, apply } satisfies CompactionMemoryPlugin
