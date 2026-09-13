/**
 * Runtime-identity capability seam: Service Definition + Provider contract
 * + Consumer prompt section. The merge-extensible provider contract lives
 * in `./types.ts`; the registry implementation in `./registry.ts`; the
 * `runtime/world-state` prompt section in `./section.ts`; the heartbeat
 * emitter in `./heartbeat.ts`. The session event vocabulary lives in
 * `./events.ts`; the type-only re-export from `./index.ts` projects it
 * onto every consumer that imports from this package.
 *
 * The capability seam is mandatory: `verify-application-entrypoints`
 * rejects any profile that does not transitively depend on a package
 * that registers a provider against this seam. The web profile is the
 * first consumer (it retires its bespoke `app:web-surface` section to
 * use the generic one).
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

import { Context } from '@deepseek-ai/cordis'
import { RuntimeIdentityRegistry } from './registry.ts'
import { registerWorldStateSection } from './section.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The runtime-identity registry: providers register here, prompt sections read from here. */
    runtimeIdentity: RuntimeIdentityRegistry
  }
}

// Type-only re-export of the session event declaration-merge. The
// declaration-merge lives in `./events.ts`; the explicit re-export here
// keeps the module edge in the emitted `.d.ts` so consumers receive the
// three new event types in `SessionEventMap` without an extra import.
// (`import type {}` is stripped by the declaration emitter because the
// file declares a module but exports no values, so it would not reach
// downstream type graphs.)
export type {} from './events.ts'

export type {
  RuntimeCapabilities,
  RuntimeHeartbeatEvent,
  RuntimeHeartbeatLostEvent,
  RuntimeIdentity,
  RuntimeIdentityEvent,
  RuntimeIdentityProvider,
  RuntimeInvalidateReason,
} from './types.ts'
export { RuntimeIdentityRegistry } from './registry.ts'
export { RUNTIME_WORLD_STATE_SECTION, renderWorldState, registerWorldStateSection } from './section.ts'
export {
  createHeartbeatEmitter,
  nodeTicker,
  type HeartbeatEmitter,
  type HeartbeatEmitterOptions,
  type HeartbeatTicker,
} from './heartbeat.ts'
export {
  DEFAULT_HEARTBEAT_INTERVAL,
  HEARTBEAT_INTERVAL_FLOOR,
  resolveHeartbeatIntervalMs,
} from './registry.ts'

/** Stable Cordis plugin name. */
export const name = 'runtime-identity'

/**
 * Services the plugin requires before its `apply()` can mount the
 * registry and register the prompt section. `runtime` is provided by
 * this same plugin; `systemPrompt` is an external dependency.
 */
export const inject = ['systemPrompt']

/**
 * Mount the runtime-identity registry and register the
 * `runtime/world-state` prompt section. Profile bundles register
 * providers against the mounted registry; this plugin does not
 * register a default provider.
 *
 * @param ctx - cordis context carrying the injected services.
 */
export function apply(ctx: Context): void {
  // The registry constructor installs itself as `ctx.runtime`; the
  // section registration waits for `ctx.systemPrompt` to become
  // available and then registers the prompt section. Both are Cordis
  // effects; unload tears them down.
  new RuntimeIdentityRegistry(ctx)
  registerWorldStateSection(ctx)
}

/**
 * Default export for `ctx.plugin(RuntimeIdentity)`. Cordis mounts the
 * class as a plugin; the static `apply` (above) drives the boot
 * sequence. The default-export form mirrors the convention every other
 * core capability seam in the repo follows.
 */
export default { name, inject, apply }
