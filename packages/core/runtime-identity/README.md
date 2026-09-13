# `@deepseek-ai/dsh-runtime-identity`

The runtime-identity capability seam. The merge-extensible provider
contract, the `ctx.runtime` registry, the `runtime/world-state` prompt
section, and the heartbeat event emitter. Every shipped profile registers
a provider against this seam so the harness's own runtime is logged and
model-visible.

## Why this package exists

The session log is the source of the model-visible context, and
`model-visible ⟺ logged` is the repo's golden rule
([architecture](../../../../docs/architecture.md#session-log)). The rule
is applied to every domain fact the agent sees — tools, projections,
commands, sandbox verdicts — but it is not applied to the running
harness itself. Postmortem
[0003](../../../../docs/postmortem/0003-web-agent-gui-feedback-loop.md)
documents the failure mode for one profile (the Web GUI); the same gap
recurs in `headless`, `sdk`, `sdk-minimal`, `acp`, and the Electron
desktop host. This package closes the gap by giving every profile the
same one-line identity commitment and the same prompt-side answer to
"which server am I running in?"

## Capability seam roles

- **Service Definition** (this package): the `RuntimeIdentity` record,
  the `RuntimeCapabilities` flag set, the `RuntimeIdentityProvider`
  contract, and the `RuntimeIdentityRegistry` Cordis service.
- **Service Provider** (every shipped profile): each profile's bundle
  implements `RuntimeIdentityProvider` and registers it against
  `ctx.runtime` in its `apply()`.
- **Consumer** (the system-prompt assembler): the
  `runtime/world-state` section registered by this package reads
  `ctx.runtime.current()` at every assembly and renders the canonical
  identity text.

The seam is mandatory: `verify-application-entrypoints` rejects any
profile that does not transitively depend on a package that registers a
provider.

## Public surface

```ts
import {
  RuntimeIdentityRegistry,
  RUNTIME_WORLD_STATE_SECTION,
  renderWorldState,
  registerWorldStateSection,
  createHeartbeatEmitter,
  nodeTicker,
  DEFAULT_HEARTBEAT_INTERVAL,
  HEARTBEAT_INTERVAL_FLOOR,
} from '@deepseek-ai/dsh-runtime-identity'
import type {
  RuntimeIdentity,
  RuntimeCapabilities,
  RuntimeIdentityProvider,
  RuntimeInvalidateReason,
  RuntimeIdentityEvent,
  RuntimeHeartbeatEvent,
  RuntimeHeartbeatLostEvent,
} from '@deepseek-ai/dsh-runtime-identity'
```

The package also augments `@deepseek-ai/dsh-session/types`'s
`SessionEventMap` with three event types: `runtime/identity`,
`runtime/heartbeat`, and `runtime/heartbeat-lost`. Consumers receive the
augmentation through the type-only side effect of importing from the
package root.

## Provider contract

A provider is a small object with three methods:

```ts
const webProvider: RuntimeIdentityProvider = {
  snapshot: () => ({
    profile: 'web',
    canonicalUrl: 'http://127.0.0.1:3080',
    processId: process.pid,
    buildFingerprint: computeFingerprint(),
    capabilities: {
      hasNetworkSurface: true,
      hasFilesystem: true,
      hasShell: true,
      hasSandbox: true,
    },
    sourceRoot: '/Users/me/deepseek-harness',
  }),
  startHeartbeat: (intervalMs) => {
    const emitter = createHeartbeatEmitter(nodeTicker, (event) => {
      session.append('runtime/heartbeat', event)
    })
    return emitter.start(intervalMs)
  },
}
```

The registry calls `snapshot()` once at registration to seed the first
`runtime/identity` event. The disposer returned by `startHeartbeat()`
is installed as a Cordis effect; provider unload tears it down without
leaks.

## Profile-generic prompt section

`runtime/world-state` is registered once by this package's `apply()`.
Its text derives from `ctx.runtime.current()` at every assembly. The
section is profile-generic; per-profile differences appear in the
rendered text rather than the section name. The Web bundle's existing
`app:web-surface` section retires to use this one.

## Configuration

The package exposes no `Config`. Profile-specific overrides (a shorter
heartbeat interval for `acp`, a `surfaceContext: false` opt-out for
one-shot layers) live in the profile bundles, not here.

## Required adjacent changes

Three changes outside this package complete the seam:

1. **Add `RUNTIME_WORLD_STATE` to the prompt-section order allocation**
   in `packages/core/system-prompt/src/index.ts`. The constant sits at
   `10100`, the slot the Web profile's retiring `WEB_SURFACE` occupies.
   Without this constant, `getSectionOrder('RUNTIME_WORLD_STATE')` does
   not resolve.
2. **Regenerate `packages/core/session/src/known-event-types.ts`** via
   `pnpm run gen-persistence-catalog` so the three new event types
   enter the persistence read vocabulary. The generator reads every
   `SessionEventMap` declaration merge across the repository.
3. **Extend `scripts/verify-application-entrypoints.ts`** with a rule
   that any `dsh-*` profile whose entry class is `node-application`
   must transitively depend on a package that registers a provider.
   `verify-cordis-config` gets the matching YAML rule.

Each of these lands in a separate PR per the proposal's delivery plan.

## Invariant companion

`./invariant` (`name = 'runtime-identity-invariant'`,
`inject = ['invariants']`) installs three relational checks against the
session log: heartbeat seq is strictly monotonic; heartbeat-lost
`lastSeq` matches the last observed heartbeat; two `runtime/identity`
events with the same `buildFingerprint` are refused. Load the companion
alongside `@deepseek-ai/dsh-invariants` to enable the checks.

## Tests

The package ships four test files:

- `tests/registry.spec.ts` — registration, duplicate detection,
  dispose, invalidate.
- `tests/section.spec.ts` — text rendering for full / partial / null
  identities and empty capabilities.
- `tests/heartbeat.spec.ts` — monotonic seq, floor enforcement,
  ticker delegation, dispose.
- `tests/invariant.spec.ts` — the three validation rules the
  invariant companion enforces.

Coverage target is 100% per the repo's `test:coverage` CI gate.
