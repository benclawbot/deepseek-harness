/**
 * Public types of the user-invokable compaction memory seam: the
 * `MemoryNote` record, the persistent `MemoryStore` interface, and
 * the `MemoryProvider` Cordis service. The note shape is intentionally
 * small — anything more elaborate is a future RFC.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * One remembered note the user (via the model) has chosen to persist
 * across sessions. Notes are append-only on disk: an updated note is
 * a new entry with the same key, and the store keeps the latest.
 *
 * `key` is a stable identifier the model chooses (e.g. `repo-style`,
 * `user-name`). `value` is free-form prose. `tags` is an optional set
 * of short strings the model uses to scope what to recall later.
 */
export interface MemoryNote {
  /** Stable identifier the model chooses; appears in `/memory list` and the prompt section. */
  key: string
  /** Free-form prose; the model can read it back verbatim. */
  value: string
  /** Optional short tags; empty array when omitted. */
  tags: readonly string[]
  /** Unix milliseconds when the note was last updated. */
  updatedAt: number
}

/**
 * Reason a memory write was rejected. The `key` field is always present
 * (the write targeted a specific key); the rest vary by code.
 */
export type MemoryWriteError =
  | { code: 'key-empty'; message: string }
  | { code: 'key-invalid'; message: string; key: string }
  | { code: 'value-empty'; message: string; key: string }
  | { code: 'value-too-long'; message: string; key: string; maxBytes: number }
  | { code: 'too-many-tags'; message: string; key: string; maxTags: number; observed: number }
  | { code: 'io-error'; message: string; key: string; cause: string }

/**
 * Persistent storage backend for memory notes. The default
 * implementation is file-backed at `$DSH_HOME/memory.yaml`; tests
 * inject an in-memory backend.
 */
export interface MemoryStore {
  /** Read every note in deterministic (key ascending) order. */
  readAll(): Promise<readonly MemoryNote[]>
  /** Read one note by key, or `null` when the key is absent. */
  readOne(key: string): Promise<MemoryNote | null>
  /** Insert or replace one note; throws {@link MemoryWriteError} on validation failure. */
  write(note: MemoryNote): Promise<void>
  /** Remove one note by key; returns `true` when a note was removed. */
  remove(key: string): Promise<boolean>
}

/** Validation limits the memory package enforces on writes. */
export interface MemoryLimits {
  /** Maximum note value length in bytes; defaults to 8192. */
  maxValueBytes: number
  /** Maximum number of tags per note; defaults to 8. */
  maxTags: number
  /** Maximum number of stored notes; defaults to 256. */
  maxNotes: number
}

/** Options the package's {@link createFileMemoryStore} factory accepts. */
export interface FileMemoryStoreOptions {
  /** Absolute path to the YAML file the store reads and writes. */
  path: string
  /** Validation limits applied to every write. Defaults to {@link DEFAULT_MEMORY_LIMITS}. */
  limits?: Partial<MemoryLimits>
}

/** Validation limits applied to writes when no override is given. */
export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
  maxValueBytes: 8192,
  maxTags: 8,
  maxNotes: 256,
}

/**
 * The Cordis service interface for the memory seam. One provider per
 * host fiber; consumers (the model-facing `remember` tool and the
 * session-start prompt section) read through `list()` and `get()`.
 *
 * `register()` is the only path that adds a note; the validation and
 * persistence rules live in {@link MemoryStore}, the registry just
 * forwards.
 */
export interface MemoryProvider {
  /** Read every note in deterministic order. */
  list(): Promise<readonly MemoryNote[]>
  /** Read one note by key. */
  get(key: string): Promise<MemoryNote | null>
  /**
   * Insert or replace one note.
   *
   * @param key - the note key.
   * @param value - the note value.
   * @param tags - optional tags.
   * @returns the committed note on success; throws {@link MemoryWriteError} on validation failure.
   */
  remember(key: string, value: string, tags?: readonly string[]): Promise<MemoryNote>
  /** Remove one note by key. */
  forget(key: string): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The user-invokable compaction memory seam; consumers read through here. */
    memory: MemoryProvider
  }
}

/**
 * Compute the absolute path to the persistent memory file under a given
 * DSH home. The default lives at `$DSH_HOME/memory.yaml`; an empty home
 * falls back to `<cwd>/memory.yaml` so non-installed test runs work.
 *
 * @param dshHome - the resolved DSH home, or empty string.
 * @param cwd - the process working directory, used as the fallback.
 * @returns the absolute path.
 */
export function resolveMemoryPath(dshHome: string, cwd: string): string {
  const base = dshHome.length > 0 ? dshHome : cwd
  return base.endsWith('/') ? `${base}memory.yaml` : `${base}/memory.yaml`
}

/**
 * Stable identifier the package uses for the prompt section it registers
 * on every boot. The text derives from the latest committed note set so
 * the model sees remembered facts at session start.
 */
export const MEMORY_SECTION_NAME = 'memory/notes'

/** Validation regex: a memory key is a short identifier the model chooses. */
export const MEMORY_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

/** Validation: a memory tag is a short token the model uses to scope recall. */
export const MEMORY_TAG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * The package's plugin contract — `apply()` mounts the provider on
 * `ctx.memory` and registers the prompt section. The default export
 * mirrors the convention every other capability seam in the repo
 * follows, so `ctx.plugin(CompactionMemory)` mounts it.
 */
export interface CompactionMemoryPlugin {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: Context): void
}
