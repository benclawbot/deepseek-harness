# Profile owners: who registers a `RuntimeIdentityProvider`

Companion to [`2026-09-15-runtime-self-model.md`](./2026-09-15-runtime-self-model.md). The repo has six shipped entry points that own a running process and therefore own a runtime identity — five are `dsh-*` profiles; one is the Electron desktop host. Each receives one small change: a `RuntimeIdentityProvider` implementation sourced from state the launcher already has. No launcher is rewritten.

`dsh-base` is *not* on this list. It is the shared first layer of the web, headless, sdk, and acp profiles; it owns the registry wiring and the prompt section, but the identity itself comes from the profile-specific bundle that sits on top.

---

## 1. `web` profile — `packages/bundle/web-app/`

**Existing state.** The bundle's `apply()` already computes the canonical loopback URL at bind time (`localWebUrl(runtimeCtx)`), publishes the `app:web-surface` prompt section, and registers the `DSH_WEB_URL` shell environment ([`packages/bundle/web-app/src/index.ts:225-251`](../../packages/bundle/web-app/src/index.ts)). It also samples the LAN trust snapshot from `ctx.webServer.host`.

**What the provider sources from.** `ctx.webServer` for `port` and host binding; the same `localWebUrl` for `canonicalUrl`; `SOURCE_ROOT` (the dsh source checkout) for `sourceRoot`; the bundle's resolved package set for `buildFingerprint`; the profile id `web` is constant.

**Smallest plausible change.** A `RuntimeIdentityProvider` registered after `ctx.webServer` has bound. The `app:web-surface` prompt section retires; the `runtime/world-state` section carries the same URL plus the rest. The `DSH_WEB_URL` shell environment stays — it is a useful per-process variable the runtime identity service does not replace.

**Subtleties.**

- The current `app:web-surface` is registered only when `config.surfaceContext` is true. The new section follows the same gate.
- The postmortem-0003 regression test lives in this bundle's tests; it must be updated to read `runtime/world-state` instead of `app:web-surface`, and it must assert the prompt section names the canonical URL the agent already knows.

---

## 2. `headless` profile — `packages/bundle/headless/`

**Existing state.** A one-shot runner with no server. Its `apply()` reads `argv` and `cwd`, runs one task, and exits. The bundle owns the `argv`-to-task-args resolution and writes the session log on completion.

**What the provider sources from.** `process.pid` for `processId`; the resolved CLI arguments for `capabilities` (a `--profile headless` invocation has no filesystem, no network surface, no sandbox beyond what bash inherits); the resolved bundle stack for `buildFingerprint`; the profile id `headless` is constant. `canonicalUrl` is undefined (no network surface); `sourceRoot` is undefined when launched from a published install.

**Smallest plausible change.** A `RuntimeIdentityProvider` registered at `apply()` start. No prompt section when `surfaceContext` is the default off; no heartbeat (one-shot, no host to lose). The capability flags describe *what this headless invocation was asked to do*, not what the bundle *could* do.

**Subtleties.**

- A headless session's runtime identity is necessarily thin. The seam's contract must allow an identity with no `canonicalUrl` and no `sourceRoot` without treating them as bugs.
- A `--no-record` flag would be the headless analog of the `web` profile's `surfaceContext: false`; the implementation PR owns the question of whether such a flag should also suppress the runtime identity event from the log.

---

## 3. `sdk` profile — `packages/bundle/sdk-app/`

**Existing state.** The SDK JSON-RPC server. Its `apply()` mounts a Node HTTP/WS server and accepts typed JSON-RPC calls from a TypeScript or Python SDK client. The bundle owns the framed byte pipe and the version-matched client-asset serving.

**What the provider sources from.** `ctx.webServer` for `port` (the SDK server is a web server under the hood); `process.pid` for `processId`; the SDK protocol version for `buildFingerprint`; the profile id `sdk` is constant. `canonicalUrl` is the SDK server's loopback URL; the SDK client connects to it through `authenticatedUrl`.

**Smallest plausible change.** A `RuntimeIdentityProvider` registered after the SDK server binds. Heartbeat at the standard 5 s interval so a host that silently dies surfaces as `runtime/heartbeat-lost`; the SDK client can choose to subscribe to the event over its own mux stream.

**Subtleties.**

- The SDK profile is the profile that most needs the heartbeat. Its failure mode is a stuck JSON-RPC pipe that never errors; the heartbeat is the only externally observable signal that the host is gone.
- The Python SDK launches `dsh --profile sdk` by default; the runtime identity event should be the basis of a future "where is my Python SDK runtime?" diagnostic.

---

## 4. `sdk-minimal` profile — `packages/bundle/sdk-minimal/`

**Existing state.** A repository-owned standalone bundle that does *not* apply `dsh-base`. It is the deliberate exception: one bundle owns its complete explicit SDK tree. The bundle's `apply()` mounts a smaller, self-contained JSON-RPC surface.

**What the provider sources from.** The same as `sdk` minus anything it does not have. The profile id is `sdk-minimal`; `capabilities` reflect the smaller tool and provider set. No `canonicalUrl` if the minimal profile runs stdio-only (a possible future variant).

**Smallest plausible change.** A `RuntimeIdentityProvider` registered inside the bundle's own `apply()`. The minimal profile is the right place to demonstrate that the seam is independent of `dsh-base` — the registry wiring lives in `core/runtime-identity`, not in the base bundle.

**Subtleties.**

- This profile's value to the proposal is *evidence*: a working `RuntimeIdentityProvider` outside `dsh-base` proves the seam is reusable. The implementation PR should land this profile second (after `web`) so the seam is exercised under both compositions.

---

## 5. `acp` profile — `packages/bundle/acp-app/`

**Existing state.** The ACP server (`dsh --profile acp`, `@deepseek-ai/dsh-acp`). Postmortem [0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) is from this profile. The bundle owns the ACP codec, the stdio transport, and the bridge to the host's `ctx.agents`.

**What the provider sources from.** `process.pid` for `processId`; the resolved bundle stack for `buildFingerprint`; the ACP protocol version (already negotiated at `initialize`) as a capability flag; the profile id `acp` is constant. There is no `canonicalUrl` because ACP is stdio, not network.

**Smallest plausible change.** A `RuntimeIdentityProvider` registered inside the ACP bridge's `apply()`. Heartbeat at 1 s (the shortest shipped interval) so an editor that loses its stdio pipe gets a `runtime/heartbeat-lost` event the moment the harness dies.

**Subtleties.**

- ACP's failure mode is the opposite of the web's: there is no URL to misread, but the editor cannot tell a healthy stdio pipe from a frozen one without explicit liveness. The 1 s heartbeat is the answer.
- The postmortem-0001 guardrails (no `export default`, `ctx.get` for optional services) are about plugin *loading*, not plugin *identity*; they remain valid and are unrelated to this change.

---

## 6. Desktop host — `apps/desktop-host/`

**Existing state.** The Electron desktop application carries its exact dsh production runtime in signed application resources ([architecture](../../../../docs/architecture.md#desktop-application)). The private Desktop Host package loads the bundled dsh backend and matching client graph under its bundled upstream Node.js. Unary RPC, Remote streams, and version-matched client assets cross versioned framed byte pipes with Node IPC reserved for lifecycle control.

**What the provider sources from.** The Electron main process's `process.pid` (which owns the host fiber); the bundled dsh version + the renderer version for `buildFingerprint`; the Electron `app.getPath('exe')` for `sourceRoot`; the profile id `desktop` is constant. There is no `canonicalUrl` in the loopback sense because the desktop composition opens no Web server or loopback port.

**Smallest plausible change.** A `RuntimeIdentityProvider` registered inside the desktop host's `apply()`. Heartbeat at the standard 5 s interval. The renderer receives the runtime identity through the existing private RPC pipe; the security model (no Web server, no loopback port) is unchanged.

**Subtleties.**

- The desktop profile is the only one whose `canonicalUrl` is permanently undefined. The seam must accept this without complaint.
- The renderer's `dsh-app://` protocol is a private URI scheme, not a URL the agent can `curl`. The runtime identity should still include the protocol scheme and the version-matched asset hash so the agent knows which renderer binary is in front of it.
- The desktop host is the only profile owner that is *not* a `packages/bundle/*` package; the verification gate must extend to `apps/desktop-host` in addition to `dsh-*` profile bundles. A natural rule: any Node-application entry class that owns a host fiber must transitively depend on a package that registers a `RuntimeIdentityProvider`. This is wider than the current `verify-application-entrypoints` rule and is the single biggest gate change in the implementation PR.

---

## Owners by package

| Profile | Owner package | Entry class | Existing launcher state to source from |
|---|---|---|---|
| `web` | `packages/bundle/web-app` | `node-application` | `ctx.webServer` bind, `localWebUrl`, `SOURCE_ROOT` |
| `headless` | `packages/bundle/headless` | `node-application` | `argv`, `cwd`, resolved task args |
| `sdk` | `packages/bundle/sdk-app` | `node-application` | `ctx.webServer` bind, SDK protocol version |
| `sdk-minimal` | `packages/bundle/sdk-minimal` | `node-application` | Same as `sdk`, minus `dsh-base` |
| `acp` | `packages/bundle/acp-app` | `node-application` | `process.pid`, ACP protocol version |
| `desktop` | `apps/desktop-host` | `desktop-host` | Electron main `pid`, bundled dsh + renderer versions |

Each owner ships one provider. The implementation PR lands `web` first (because postmortem 0003 has a regression test that demands the section exist) and `sdk-minimal` second (because it is the cleanest evidence that the seam is independent of `dsh-base`). The remaining four land in parallel; the verify gate lands after at least three ship.
