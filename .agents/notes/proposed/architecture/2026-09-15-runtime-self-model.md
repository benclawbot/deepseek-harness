# Agent Note: A first-class runtime self-model for every shipped profile

Status: proposed

English | [中文](2026-09-15-runtime-self-model.zh.md)

## Problem

The session log is the durable source of the model-visible context, and `model-visible ⟺ logged` is the repo's golden rule ([architecture](../../../../docs/architecture.md#session-log); [session-log decision](../../../../.agents/notes/implemented/architecture/2026-08-19-session-projection-mandatory-seam.md)). The rule is applied to every domain fact the agent sees — tools, projections, commands, sandbox verdicts — but it is **not applied to the running harness itself**. The agent in any session has no first-class, logged, durable answer to four questions it asks implicitly on every turn:

- *Which application profile owns this session, and what is its canonical network surface?*
- *Which process is serving me right now, and is it still alive?*
- *Which source checkout built this runtime, and what was its bundle stack?*
- *What capabilities is this particular profile configured to expose?*

Postmortem [0003](../../../../docs/postmortem/0003-web-agent-gui-feedback-loop.md) is the smoking gun for one profile. A web agent edited its own GUI source, then validated a *replacement* `dsh web` server on port 3334 while the *existing* page on port 3081 had already picked up the change. The root cause was diagnosed as "no model-visible identity for the current GUI, canonical URL, or runtime mode." The fix shipped — the Web bundle now publishes the canonical loopback URL in the logged `app:web-surface` prompt section and the `DSH_WEB_URL` environment ([`packages/bundle/web-app/src/index.ts:50`](../../../../packages/bundle/web-app/src/index.ts)) — but it is a one-profile band-aid under a section name that names the web specifically. The same gap recurs in `headless`, `sdk`, `sdk-minimal`, `acp`, and the Electron desktop host; none of them publish their own identity to the model in a structured, logged, replayable way.

The consequences break into three classes:

- **Self-validation failures.** A web agent cannot reliably distinguish its current page from a replacement server, its current process from an orphan, or its current build from a stale one. The postmortem class is the visible symptom; the latent symptom is any tool result the agent receives about a UI state it cannot tie back to the surface it is actually using.
- **No model-visible host lifecycle.** Heartbeats, liveness, profile switches, restart, and the difference between "the harness paused" and "the harness crashed" reach the model only as a generic error string when they reach it at all. Postmortem [0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) shows the cost of diagnosing without a recorded topology; the same lack makes recovery from a host restart opaque to the model.
- **Cross-process orchestration has no canonical identity.** A session that starts a long-running subagent cannot later re-locate the subagent's runtime from the log alone; two cooperating sessions on one machine cannot address each other except by ad-hoc file or socket paths; fork/merge across machines is impossible because the origin graph is not logged.

The architecture already does this kind of seam correctly elsewhere. [`dsh-session-projection`](../../../../packages/session/session-projection/) is the pattern: a registered service that owns one fact-class, computed on the host, surfaced through a stable read face, replayable from the log. The runtime self-model is the same shape applied to the harness's own execution.

## Proposal

Four pieces, applied incrementally. No loop change; `agent-loop`'s prompt assembly and event log already carry the new contributions.

### A new core service: `ctx.runtime`

A new package [`packages/core/runtime-identity`](../../../../packages/core/runtime-identity/) publishes `ctx.runtime`, a stable Service Definition that every profile consumes and every profile's launcher implements against.

```ts ignore-check
export interface RuntimeIdentity {
  /** Stable profile id from the loaded bundle stack (e.g. `web`, `headless`, `sdk`, `sdk-minimal`, `acp`, `desktop`). */
  profile: string
  /** Canonical loopback URL the client should target, when the profile has a network surface. */
  canonicalUrl?: string
  /** Process id of the host fiber, for cross-instance identification in the log. */
  processId: number
  /** Build fingerprint: a content hash of the resolved bundle stack plus the source checkout id, when known. */
  buildFingerprint: string
  /** Capability flags the profile exposes in this boot (filesystem, network, sandbox, persistence). */
  capabilities: RuntimeCapabilities
  /** Source checkout root, when the runtime was booted from a working tree rather than a published install. */
  sourceRoot?: string
}

export interface RuntimeIdentityProvider {
  /** Snapshot the current runtime identity. Called once at boot and on every `runtime/identity` event trigger. */
  snapshot(): RuntimeIdentity
  /** Start emitting `runtime/heartbeat` events at the configured interval. Returns a disposer. */
  startHeartbeat(intervalMs: number): () => void
  /** Optional: hook for the provider to react to `runtime/identity` invalidation (e.g. a profile switch). */
  onInvalidate?(reason: 'restart' | 'profile-switch' | 'host-stop'): Promise<void>
}

declare module 'cordis' {
  interface Context {
    runtime: RuntimeIdentityRegistry
  }
}
```

`RuntimeIdentityRegistry` follows the established `SessionProjectionRegistry` shape: a `register(provider)` returning a disposer, a `current()` returning the latest committed identity (host-computed from the log, identical to the read-through pattern), and an `invalidate(reason)` for the rare profile-switch case. Registration is an effect; unload removes the key from subsequent reads. The package owns `./invariant` asserting one live registration per host fiber.

### Three new session events

Extend `SessionEventMap` with the log-only event pair plus one state event:

```ts ignore-check
'runtime/identity':         RuntimeIdentity           // committed at boot, on profile switch, on invalidate
'runtime/heartbeat':        { seq: number; ts: number } // ignorable; emitted at the configured interval
'runtime/heartbeat-lost':   { lastSeq: number; gapMs: number } // committed when the heartbeat lapses
```

All three carry `ignorable: true` envelopes so pre-existing log readers refuse neither old logs (no new required-on-read keys) nor new logs (old readers ignore them). The existing session-log version mechanism ([decision](../../../../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md)) owns the format-version bump if the envelope shape ever requires it; this proposal does not require one.

`runtime/heartbeat` is the high-frequency event. Its persistence follows the projection-cache pattern: throttled writes (count/interval, configurable), with two mandatory flush points — `turn/end` and detach — so a crash between writes costs at most one lost heartbeat, never a wrong identity. The default interval is 5000 ms; `headless` and `acp` ship shorter (1000 ms) because their failure modes are quieter.

### A profile-generic prompt section

The Web bundle's `app:web-surface` becomes `runtime/world-state`. The section text is rendered once per turn from the latest committed `runtime/identity` event by the same assembly path that already consumes `PromptSection` ([system-prompt subsystem](../../../../docs/subsystems/system-prompt.md#prompt-sections)). The section name is owned by `dsh-runtime-identity`; each profile's launcher registers the same section and the registry deduplicates by name. `surfaceContext` (the Web bundle's existing opt-out flag) generalizes to a per-profile boolean with the same semantics: a one-shot non-interactive layer suppresses it.

The text template (illustrative, not normative):

```text
You are running inside the DeepSeek Harness.
Profile: {{profile}}
Canonical URL: {{canonicalUrl}}
Build fingerprint: {{buildFingerprint}}
Source checkout: {{sourceRoot}}
Capabilities: {{capabilities}}
Last heartbeat: {{lastHeartbeatTs}} (seq {{lastHeartbeatSeq}})
```

`headless` and `sdk-minimal` render only `Profile`, `Build fingerprint`, `Capabilities`, and `Last heartbeat` — the absence of `Canonical URL` and `Source checkout` is the signal that the profile has neither.

### A capability seam with mandatory coverage

Each shipped profile implements `RuntimeIdentityProvider` and registers it inside its bundle's `apply()`. `verify-application-entrypoints` ([scripts](../../../../scripts/verify-application-entrypoints.ts)) grows one rule: every `dsh-*` profile whose entry class is `node-application` must transitively depend on a package that registers a `RuntimeIdentityProvider`. `verify-cordis-config` rejects a profile whose `cordis.yml` omits the registration row.

The six profile owners (see the [companion list](./profile-owners.md)) each receive one small change: a `RuntimeIdentityProvider` implementation sourced from the profile's existing launcher state (`packages/bundle/web-app`'s bind-time URL, `packages/bundle/headless`'s `argv` and `cwd`, `packages/bundle/acp-app`'s stdio descriptor, etc.). No launcher is rewritten; the existing service values are already the right inputs.

## Alternatives considered

**Generalize `app:web-surface` to a profile-aware section.** Rejected: the section name and the `DSH_WEB_URL` environment are web-specific by design (the URL has a meaning only a network-surface profile can fill), and the environment lives in `ctx.webServer`'s scope, not `ctx.runtime`'s. Renaming loses the postmortem-0003 traceability for one fix while gaining it for none of the others; the right move is a new section owned by a new service.

**A `runtime_info` tool the agent calls on demand.** Rejected: the model would not know when to call it, the result would not be durable, and a tool whose job is to answer a question the harness should answer proactively is a workaround for the missing seam. This is exactly the postmortem-0003 lesson — the agent edited the right thing and validated the wrong one because the truth was not where it needed to be when the model asked.

**An out-of-band metadata channel separate from the session log.** Rejected: it directly contradicts `model-visible ⟺ logged`. A separate channel would also need its own replay, fork, and resume semantics; the log already has them.

**Letting each profile own its own prompt section rather than a generic one.** Rejected: the six profiles would ship six near-identical sections with six near-identical environments, and the next profile (a future `dsh-ide-app`, a future `dsh-cli-app`) would invent a seventh. One section, one service, one name; profiles contribute providers.

**Shoehorning runtime identity through `prepareCall`.** Rejected: `prepareCall` is per-request and not durable; the model needs the identity on every turn but the runtime identity rarely changes, so emitting it on every model request would burn tokens to repeat the same fact. The session-event-plus-prompt-section shape carries the fact once and replays it.

**A purely host-side diagnostics API with no model visibility.** Rejected: it does not address the root cause and would coexist with the missing prompt-side answer. The postmortem series keeps showing that the agent and the host share a workspace but not a model; this design closes that gap rather than documenting it.

**Embedding identity in the system prompt's prefix string.** Rejected: the prefix is rendered by `PERSONA_PREFIX_SECTION` and is meant to be user-configurable; mixing runtime identity into it loses the projection layer's whole-value discipline and makes per-profile opt-out impossible.

**Heartbeat at sub-second intervals for fast liveness.** Rejected: sub-second is a different problem (transport-level liveness, not runtime identity), and the heartbeat's job is to detect *missing* runtime, not *latent* one. Five seconds with one-interval grace plus a `runtime/heartbeat-lost` event is the right resolution for this seam.

**Naming the service `ctx.host` instead of `ctx.runtime`.** Rejected: `ctx.host` already names the host-side fiber concept in the codebase, and reusing it conflates the runtime identity with the fiber that owns it. `ctx.runtime` keeps the term the docs and postmortems already use.

**Putting the registry under `ctx.sessionPersistence` or `ctx.webhookRuntime`.** Rejected: session persistence is for session logs, webhook runtime is for ingress; both are domain seams. Runtime identity is its own fact-class and belongs in `core/`.

## Acceptance criteria

- Every shipped profile (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`, `desktop`) registers a `RuntimeIdentityProvider` in the same change. `verify-application-entrypoints` fails any profile that does not.
- A session's first `turn/start` is preceded by exactly one committed `runtime/identity` event for that session's runtime, replayable on resume.
- The system prompt on every turn includes a `runtime/world-state` section whose text is derived from the latest committed `runtime/identity` event; the section is suppressed only when the profile opts out.
- A web agent asked "what server is hosting this session?" answers from the prompt section, not from a tool call or a fresh `curl`.
- A web agent cannot validate a replacement server as its own current one: the prompt section names the canonical URL the agent already knows about, and a tool result from a different URL visibly disagrees with the prompt.
- A `runtime/heartbeat-lost` event is committed within one heartbeat interval plus configured grace (default 5 s + 2 s) when the host stops responding; the event is the only signal a UI or a follow-up session needs to surface the failure.
- Heartbeats persist at the configured throttle (default every 30 s) with mandatory flush points at `turn/end` and detach; a crash between throttled writes costs at most one lost heartbeat and never a wrong identity.
- Resume and fork replay the `runtime/identity` event from the log; a forked session at turn boundary T carries its parent's identity into the fork lineage and may override it via the new session's own `runtime/identity`.
- `verify-cordis-config` rejects a profile `cordis.yml` that mounts a runtime but lacks the registration row, with a message naming the offending row id.
- An empty-logic regression test reproduces postmortem 0003's specific mistake: the agent receives a tool result from `http://127.0.0.1:3334` while its prompt section names `http://127.0.0.1:3081`. The test asserts that the agent prompt exposes the mismatch.

## Risks

- **Privacy and exposure.** A logged runtime identity leaks server topology (port, host literal), source paths, and build fingerprints into the session log. The session log is already shipped through the wire in some profiles and may be exported. Mitigation: a per-profile opt-out for `canonicalUrl` and `sourceRoot` (default-on for `web`, default-off for `headless` and `acp`), a redaction layer in `dsh-session-projection`'s wire view that hashes the build fingerprint unless the session declares `record: 'full'`, and an explicit `surfaceContext: false` opt-out already generalized from the Web bundle.
- **Heartbeat volume.** A 5 s interval produces ~17 K heartbeat events per day for an idle session. Mitigation: heartbeat events are `ignorable: true`, persisted at throttled intervals (default 30 s), and compacted at every `turn/end` and detach; the projection cache carries the latest value without re-emitting the events. The wire-side cost is one event per turn at most.
- **Backward compatibility.** Adding members to `SessionEventMap` requires the existing envelope mechanism to keep old log readers compatible. The `ignorable: true` envelope is the repo's standard answer; if a future change requires the events to be required-on-read, `SESSION_FORMAT_VERSION` bumps with the adjacent-migration rule.
- **Profile fragmentation.** If every profile invents its own identity shape, the seam's value collapses to the Web band-aid it is replacing. Mitigation: the registry contract is the canonical source for the keys (`profile`, `canonicalUrl`, `processId`, `buildFingerprint`, `capabilities`, `sourceRoot`); providers register their *specifics* under an extension map but the canonical keys are owned by the registry. `verify-cordis-config` enforces the canonical key set.
- **False-positive `heartbeat-lost` during legitimate pauses.** A breakpoint in dev mode or a long-running tool that pauses the host event loop could trigger the loss event. Mitigation: heartbeat interval and grace period are configurable per profile; the dev mode ships 30 s interval / 30 s grace; `acp` ships 1 s / 3 s because its failure mode is quieter.
- **Test surface.** Runtime identity is inherently per-host. Following the postmortem-0001 lesson that hand-built plugins cannot validate how plugins load, the package ships real-Loader, real-subprocess, and real-process-state coverage from day one; no test may substitute a hand-constructed `RuntimeIdentityProvider` for the real registration path.
- **Profile-switch mid-session.** A session that switches profiles mid-run (e.g. via `dsh` CLI's `--profile` reload) invalidates the identity. The proposed `invalidate(reason)` hook covers the explicit case; an implicit switch (live reload of `cordis.patch.yml`) requires the live-patch path to call the hook. This is the seam's hardest sub-problem and is called out for the implementation PR rather than solved in this proposal.

## Delivery plan

1. **Host base**: `core/runtime-identity` package — registry, provider contract, the three session events, the prompt section. Mergeable with zero providers registered (section absent, events never emitted, registry empty).
2. **Web profile first**: `dsh-web-app` registers the Web `RuntimeIdentityProvider`; the existing `app:web-surface` section retires to use the new generic section's keys. This PR carries the postmortem-0003 regression test and the first end-to-end coverage of the seam.
3. **Other profiles in parallel**: `dsh-headless`, `dsh-sdk-app`, `dsh-sdk-minimal`, `dsh-acp-app`, the Electron desktop host — one provider each, no launcher rewrite.
4. **Verify gates**: extend `verify-application-entrypoints` and `verify-cordis-config` to enforce the registration. Land after at least three profiles ship so the gate exercises the full check.
5. **Wire view redaction**: the projection-style wire view for `runtime/identity`, with the redaction policy above. Lands after the four core profiles ship so the redaction surface has real consumers.
6. **Cross-instance orchestration primitives**: a future proposal builds on this seam — subagent re-location, fork/merge across machines, the runtime-aware cost/latency dashboard. Out of scope here; called out so the seam is not over-fitted to the immediate needs.
