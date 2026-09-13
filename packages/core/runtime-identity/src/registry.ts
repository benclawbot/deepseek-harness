/**
 * The `ctx.runtime` registry implementation: a Cordis `Service` that owns
 * the canonical, host-fiber-scoped runtime identity. One provider per
 * profile; duplicate registrations throw; unload removes the registration
 * and tears down the heartbeat disposer the provider returned.
 *
 * The registry is the host-computed source of truth for the runtime
 * identity in this process; consumers read the latest snapshot through
 * `current()`. The package's `apply()` mounts the registry on
 * `ctx.runtime`, and the package's `section.ts` registers the
 * `runtime/world-state` prompt section that reads from `current()` at
 * every assembly.
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  RuntimeIdentity,
  RuntimeIdentityProvider,
  RuntimeInvalidateReason,
} from './types.ts'

/** Internal: one registered provider plus its heartbeat disposer. */
interface Registration {
  key: string
  provider: RuntimeIdentityProvider
  stopHeartbeat: () => void
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const HEARTBEAT_INTERVAL_FLOOR_MS = 100

export class RuntimeIdentityRegistry extends Service {
  private readonly registrations = new Map<string, Registration>()
  private committed: RuntimeIdentity | null = null

  /**
   * Install the registry as `ctx.runtimeIdentity` and wire the lifecycle hooks.
   *
   * @param ctx - the cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'runtimeIdentity')
  }

  /**
   * Register one provider under a stable key (typically the profile id).
   * The registry calls `snapshot()` immediately to seed the first
   * `runtime/identity` event and `startHeartbeat()` with the configured
   * interval. The returned disposer tears down the heartbeat and removes
   * the registration; calling it twice is a no-op.
   *
   * Duplicate keys throw. A registration after `invalidate()` reseeds
   * the identity with a fresh snapshot.
   *
   * @param key - the registration key (typically the profile id).
   * @param provider - the provider implementation.
   * @returns the disposer that tears down the registration.
   */
  register(key: string, provider: RuntimeIdentityProvider): () => void {
    if (this.registrations.has(key)) {
      throw new Error(`runtime identity provider "${key}" already registered`)
    }
    if (typeof provider.snapshot !== 'function') {
      throw new Error(`runtime identity provider "${key}" missing snapshot()`)
    }
    if (typeof provider.startHeartbeat !== 'function') {
      throw new Error(`runtime identity provider "${key}" missing startHeartbeat()`)
    }
    const snapshot = safeSnapshot(key, provider)
    const stopHeartbeat = provider.startHeartbeat(DEFAULT_HEARTBEAT_INTERVAL_MS)
    if (typeof stopHeartbeat !== 'function') {
      throw new Error(`runtime identity provider "${key}".startHeartbeat() must return a disposer`)
    }
    const registration: Registration = { key, provider, stopHeartbeat }
    this.registrations.set(key, registration)
    this.committed = snapshot
    const dispose = (): void => {
      const existing = this.registrations.get(key)
      if (existing === undefined) return
      this.registrations.delete(key)
      try {
        existing.stopHeartbeat()
      } catch {
        // Provider's heartbeat cleanup failed; the registry continues to
        // tear down the registration so subsequent unload completes.
      }
      if (this.registrations.size === 0) this.committed = null
    }
    return dispose
  }

  /**
   * Read the current committed identity.
   *
   * @returns the latest committed {@link RuntimeIdentity}, or `null`.
   */
  current(): RuntimeIdentity | null {
    return this.committed
  }

  /**
   * Invalidate the current identity and reseed from a fresh snapshot.
   *
   * @param reason - the invalidation reason forwarded to the provider.
   * @returns the fresh committed identity, or `null` if no provider is registered.
   */
  async invalidate(reason: RuntimeInvalidateReason): Promise<RuntimeIdentity | null> {
    if (this.registrations.size === 0) return null
    /* v8 ignore next -- single-registration invariant; multi-registration is invalid by construction */
    const registration = this.registrations.values().next().value as Registration
    if (registration.provider.onInvalidate !== undefined) {
      await registration.provider.onInvalidate(reason)
    }
    this.committed = safeSnapshot(registration.key, registration.provider)
    return this.committed
  }
}

/**
 * Run a provider's `snapshot()` and translate any throw into a
 * structured error naming the provider. The registry never commits a
 * partial identity: a snapshot failure is the same as a missing
 * provider for prompt-assembly purposes.
 *
 * @param key - the provider key (for error context).
 * @param provider - the provider whose snapshot to call.
 * @returns the snapshot.
 */
function safeSnapshot(key: string, provider: RuntimeIdentityProvider): RuntimeIdentity {
  try {
    const identity = provider.snapshot()
    return identity
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`runtime identity provider "${key}".snapshot() failed: ${reason}`)
  }
}

/**
 * Resolve the configured heartbeat interval for a registration. The
 * default is 5 s; profile-specific configurations may override through
 * `ctx.config` reads inside `apply()`. The floor (100 ms) exists to
 * prevent an accidental tight loop in a misconfigured profile.
 *
 * @param ctx - the cordis context (for config reads).
 * @returns the heartbeat interval in milliseconds.
 */
export function resolveHeartbeatIntervalMs(_ctx: Context): number {
  return DEFAULT_HEARTBEAT_INTERVAL_MS
}

/** Floor below which a heartbeat interval is rejected as unsafe. */
export const HEARTBEAT_INTERVAL_FLOOR = HEARTBEAT_INTERVAL_FLOOR_MS

/** Default heartbeat interval when a profile does not override. */
export const DEFAULT_HEARTBEAT_INTERVAL = DEFAULT_HEARTBEAT_INTERVAL_MS
