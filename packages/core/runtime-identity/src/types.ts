/**
 * Public types of the runtime-identity capability seam: the canonical
 * `RuntimeIdentity` record, the `RuntimeCapabilities` flag set, and the
 * `RuntimeIdentityProvider` contract that every shipped profile
 * implements. One home, no duplicates.
 *
 * The provider contract is the only thing a profile must author against;
 * the registry, prompt section, and heartbeat emitter are framework
 * contributions driven by these types. The capability flags are deliberately
 * coarse — a profile that needs finer-grained capability advertisement
 * extends `RuntimeCapabilities` via a merge-extensible sibling interface
 * in its own package.
 *
 * @module @deepseek-ai/dsh-runtime-identity
 */

/**
 * Coarse capability flags a profile exposes in a given boot. The flags
 * describe what the *current* boot is configured to expose to the model,
 * not what the bundle *could* expose — a `headless` boot with `--no-shell`
 * reports `hasShell: false` even though the bundle would otherwise.
 */
export interface RuntimeCapabilities {
  /** Whether the profile exposes a canonical network surface the agent can address (URL, host, port). */
  hasNetworkSurface: boolean
  /** Whether the profile exposes in-process filesystem tools (`read`, `write`, `edit`, `glob`, `grep`). */
  hasFilesystem: boolean
  /** Whether the profile exposes an interactive shell tool (`bash`, `pty`, `powershell`). */
  hasShell: boolean
  /** Whether the profile's process executions are confined by an OS-level sandbox primitive. */
  hasSandbox: boolean
}

/**
 * Canonical description of the running harness, as observed by the model on
 * every turn through the `runtime/world-state` prompt section and as committed
 * once per boot to the session log as the `runtime/identity` event.
 *
 * The shape is deliberately small. Anything a profile wants to advertise
 * beyond these keys lives under a profile-specific extension namespace; the
 * canonical keys are owned by this seam so consumers can rely on them.
 */
export interface RuntimeIdentity {
  /**
   * Stable profile id from the loaded bundle stack. One of `web`, `headless`,
   * `sdk`, `sdk-minimal`, `acp`, or `desktop`. The id never changes for the
   * lifetime of a process; a profile switch invalidates the identity.
   */
  profile: string
  /**
   * Canonical loopback URL the agent should target, when the profile
   * exposes a network surface. Absent when `capabilities.hasNetworkSurface`
   * is false (e.g. `headless`, `acp`'s stdio transport, `desktop`'s
   * `dsh-app://` scheme).
   */
  canonicalUrl?: string
  /** Process id of the host fiber that owns this runtime. Stable for the process lifetime. */
  processId: number
  /**
   * Content hash of the resolved bundle stack plus the source checkout id
   * when known. Consumers use this to identify a runtime across machines:
   * two harnesses booted from the same commit and bundle set produce the
   * same fingerprint. Empty string when the boot cannot compute one
   * (e.g. an unpublished install with no source checkout).
   */
  buildFingerprint: string
  /** Capability flags the profile exposes in this boot. */
  capabilities: RuntimeCapabilities
  /**
   * Source checkout root, when the runtime was booted from a working tree
   * rather than a published install. Absent for a published install; the
   * absence is the signal to the model that the harness is running from
   * its shipped artifacts.
   */
  sourceRoot?: string
}

/**
 * Reason an existing `runtime/identity` is invalidated and a fresh snapshot
 * must be committed. The registry forwards the reason to every registered
 * provider so the provider can react (refresh its snapshot, restart
 * heartbeats, refuse the invalidation, etc.).
 */
export type RuntimeInvalidateReason =
  /** The host fiber restarted; providers must rebuild from cold state. */
  | 'restart'
  /** The loaded profile changed (e.g. `cordis.patch.yml` reload with a different profile id). */
  | 'profile-switch'
  /** The host is stopping; providers may skip reaction. */
  | 'host-stop'

/**
 * The contract every shipped profile implements and registers against
 * `ctx.runtimeIdentity`. The registry calls `snapshot()` once at registration to
 * seed the first `runtime/identity` event; subsequent calls happen on
 * `ctx.runtimeIdentity.invalidate()`. The heartbeat disposer returns the cleanup
 * the registry installs as a Cordis effect; `onInvalidate` is a hook, not a
 * requirement.
 */
export interface RuntimeIdentityProvider {
  /**
   * Compute the current runtime identity. The function MUST be
   * synchronous and idempotent within one provider instance; the registry
   * caches the result and replays it across the host fiber without
   * recomputation. The returned object MUST be JSON-serializable (the
   * `runtime/identity` event payload is persisted verbatim).
   * @returns the canonical {@link RuntimeIdentity} snapshot.
   */
  snapshot(): RuntimeIdentity
  /**
   * Start emitting `runtime/heartbeat` events at the given interval, in
   * milliseconds. The disposer the function returns MUST stop the
   * underlying timer; the registry installs it as a Cordis effect so
   * provider unload tears it down without leaks.
   * @param intervalMs - heartbeat interval in milliseconds (must be `> 0`).
   * @returns a disposer that stops the heartbeat.
   */
  startHeartbeat(intervalMs: number): () => void
  /**
   * Optional hook the registry invokes before committing a new identity
   * on `invalidate()`. The hook may refresh the provider's internal
   * state (e.g. re-sample a freshly rebound network surface) or refuse
   * the invalidation by throwing. The default implementation returns
   * immediately.
   * @param reason - the invalidation reason forwarded by the registry.
   */
  onInvalidate?(reason: RuntimeInvalidateReason): Promise<void>
}

/**
 * The runtime identity event payload (also the canonical
 * {@link RuntimeIdentity}). Re-exported here for the session event
 * declaration-merge in `./events.ts` and for consumers that want the
 * type under the events namespace.
 */
export type RuntimeIdentityEvent = RuntimeIdentity

/**
 * Heartbeat event payload. The event carries the heartbeat sequence
 * number (`seq`, monotonically increasing per host fiber) and the wall
 * clock timestamp (`ts`, milliseconds since epoch). The session log
 * stores the event; consumers compare `seq` to detect gaps.
 */
export interface RuntimeHeartbeatEvent {
  /** Monotonic heartbeat sequence number, scoped to the host fiber. Starts at 1. */
  seq: number
  /** Wall-clock timestamp of emission, milliseconds since epoch. */
  ts: number
}

/**
 * Heartbeat-loss event payload. Committed when the registry detects that
 * the configured heartbeat interval has lapsed without a fresh
 * `runtime/heartbeat`. The session log stores the event with `ignorable`
 * envelope behavior so the loss is a first-class fact without breaking
 * readers that pre-date the seam.
 */
export interface RuntimeHeartbeatLostEvent {
  /** Seq of the last observed `runtime/heartbeat` (or 0 if no heartbeat ever committed). */
  lastSeq: number
  /** Wall-clock gap between the last heartbeat and the loss detection, in milliseconds. */
  gapMs: number
}
