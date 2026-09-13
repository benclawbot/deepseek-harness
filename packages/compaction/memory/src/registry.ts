/**
 * The `ctx.memory` Cordis service. Wraps a {@link MemoryStore} with the
 * `MemoryProvider` surface the package's other consumers (the
 * model-facing tool, the prompt section, the slash command) read
 * through. The provider normalizes tags and timestamps every write.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryNote, MemoryProvider, MemoryStore, MemoryWriteError } from './types.ts'
import { normalizeTags, validateRemember } from './validate.ts'
import { DEFAULT_MEMORY_LIMITS } from './types.ts'
import { createInMemoryMemoryStore, createYamlMemoryStore } from './store-yaml.ts'

/**
 * Install the registry as `ctx.memory` and wire the lifecycle hooks.
 * The service takes a fully-constructed {@link MemoryStore}; the
 * factory below ({@link createFileBackedMemoryProvider}) handles
 * path resolution and limit defaults.
 *
 * @param ctx - the cordis context that owns the service.
 * @param store - the underlying persistence layer.
 * @param now - wall-clock supplier for `updatedAt`. Defaults to `Date.now`.
 */
export class MemoryProviderService extends Service implements MemoryProvider {
  private readonly store: MemoryStore
  private readonly now: () => number
  /**
   * Synchronous cache of the latest notes. Updated by every read or
   * write so the prompt section's synchronous text function can read
   * the latest state without awaiting.
   */
  private cache: readonly MemoryNote[] = []

  constructor(ctx: Context, store: MemoryStore, now: () => number = () => Date.now()) {
    super(ctx, 'memory')
    this.store = store
    this.now = now
    // Eagerly populate the synchronous cache so the prompt section's
    // first assembly sees the persisted state on a fresh boot.
    void this.list()
  }

  /**
   * Read every note in deterministic order. Updates the synchronous
   * cache as a side effect; the prompt section reads through it.
   *
   * @returns the notes keyed ascending.
   */
  async list(): Promise<readonly MemoryNote[]> {
    const all = await this.store.readAll()
    this.cache = all
    return all
  }

  /**
   * Read one note by key. Updates the synchronous cache as a side
   * effect.
   *
   * @param key - the key.
   * @returns the note, or `null` when the key is absent.
   */
  async get(key: string): Promise<MemoryNote | null> {
    const note = await this.store.readOne(key)
    if (note !== null) {
      // Re-read the full set so the cache reflects the up-to-date
      // view (a single-key get is too narrow for the prompt).
      this.cache = await this.store.readAll()
    }
    return note
  }

  /**
   * Insert or replace one note. Tags are normalized to lower-case,
   * deduped, and trimmed; the resulting note is what every consumer
   * sees.
   *
   * @param key - the note key.
   * @param value - the note value.
   * @param tags - optional tags.
   * @returns the committed note on success; throws {@link MemoryWriteError} on validation failure.
   */
  async remember(key: string, value: string, tags: readonly string[] = []): Promise<MemoryNote> {
    const normalizedTags = normalizeTags(tags)
    const error = validateRemember(key, value, normalizedTags, DEFAULT_MEMORY_LIMITS)
    if (error !== null) throw error
    const note: MemoryNote = {
      key,
      value,
      tags: normalizedTags,
      updatedAt: this.now(),
    }
    await this.store.write(note)
    this.cache = await this.store.readAll()
    return note
  }

  /**
   * Remove one note by key.
   *
   * @param key - the key.
   * @returns `true` when a note was removed.
   */
  async forget(key: string): Promise<boolean> {
    const removed = await this.store.remove(key)
    if (removed) this.cache = await this.store.readAll()
    return removed
  }

  /**
   * Synchronous read for the prompt section's text function. Returns
   * the latest committed snapshot the registry has cached; an empty
   * array when nothing has been read or written yet.
   *
   * @returns the cached notes.
   */
  readSync(): readonly MemoryNote[] {
    return this.cache
  }
}

/**
 * Build a {@link MemoryProviderService} backed by an in-memory store
 * (the test path). The store is created with an empty seed unless
 * `seed` is provided.
 *
 * @param ctx - the cordis context.
 * @param seed - the initial notes; default `[]`.
 * @param now - wall-clock supplier for `updatedAt`.
 * @returns the {@link MemoryProviderService} factory plus the
 *   underlying store so tests can inspect committed state.
 */
export interface InMemoryMemoryProviderHandle {
  /** The provider the model-facing consumers read through. */
  readonly provider: MemoryProviderService
  /** The underlying store so tests can read committed state. */
  readonly store: MemoryStore
}

export function createInMemoryMemoryProvider(
  ctx: Context,
  seed: readonly MemoryNote[] = [],
  now: () => number = () => Date.now(),
): InMemoryMemoryProviderHandle {
  const store = createInMemoryMemoryStore(seed)
  const provider = new MemoryProviderService(ctx, store, now)
  return { provider, store }
}

/**
 * Build a {@link MemoryProviderService} backed by the file store at
 * `path`. The path resolves through {@link resolveMemoryPath} when the
 * caller passes the DSH home rather than the full file path.
 *
 * @param ctx - the cordis context.
 * @param path - the file path.
 * @param now - wall-clock supplier for `updatedAt`.
 * @returns the {@link MemoryProviderService}.
 */
export function createFileBackedMemoryProvider(
  ctx: Context,
  path: string,
  now: () => number = () => Date.now(),
): MemoryProviderService {
  const store = createYamlMemoryStore({ path, now })
  return new MemoryProviderService(ctx, store, now)
}

/** Re-export so consumers can construct a typed write error. */
export type { MemoryWriteError }
