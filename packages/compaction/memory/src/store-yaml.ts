/**
 * YAML-backed implementation of {@link MemoryStore}. Reads and writes
 * one document at the configured path; the document is a small
 * hand-rolled format (key/value/tag triples) rather than a YAML
 * dependency, because the data shape is fixed and a custom parser
 * keeps the package zero-dep beyond schemastery.
 *
 * The on-disk format is line-oriented and human-readable:
 *
 * ```text
 * # memory.yaml — written by @deepseek-ai/dsh-compaction-memory
 * @note repo-style
 * @tags coding repo
 * The repo uses tabs, not spaces; commit messages are imperative.
 *
 * @note user-name
 * @tags user
 * Tom
 * ```
 *
 * The file is rewritten on every write (write-through cache in
 * memory; the disk copy is a serialization of the current state).
 * Concurrent writes serialize through a single in-memory queue.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { open, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Buffer } from 'node:buffer'
import type { MemoryNote, MemoryStore, MemoryWriteError } from './types.ts'
import { DEFAULT_MEMORY_LIMITS, type MemoryLimits } from './types.ts'
import { validateRemember } from './validate.ts'

const HEADER = '# memory.yaml — written by @deepseek-ai/dsh-compaction-memory'
const NOTE_PREFIX_KEY = '@note '
const NOTE_PREFIX_TAGS = '@tags '
const NOTE_LINE_MAX_BYTES = 1024

/**
 * Construct a YAML-backed memory store at the configured path. The
 * constructor reads the file once (if present) and validates the
 * contents; subsequent writes serialize through `pending`.
 *
 * @param options - the file path and validation limits.
 * @returns the {@link MemoryStore}.
 */
export function createYamlMemoryStore(options: {
  path: string
  limits?: MemoryLimits
  now?: () => number
}): MemoryStore {
  const limits = options.limits ?? DEFAULT_MEMORY_LIMITS
  const now = options.now ?? (() => Date.now())
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
  let notes: Map<string, MemoryNote> = loadFromFile(options.path, now)
  let pending: Promise<void> = Promise.resolve()

  const serialize = (state: ReadonlyMap<string, MemoryNote>): string => {
    const lines: string[] = [HEADER]
    const sorted = [...state.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    for (const note of sorted) {
      lines.push(`${NOTE_PREFIX_KEY}${note.key}`)
      if (note.tags.length > 0) lines.push(`${NOTE_PREFIX_TAGS}${note.tags.join(' ')}`)
      for (const line of note.value.split('\n')) {
        const bytes = Buffer.byteLength(line, 'utf8')
        if (bytes > NOTE_LINE_MAX_BYTES) {
          throw new Error(`memory note "${note.key}" carries a ${bytes}-byte line; the per-line ceiling is ${NOTE_LINE_MAX_BYTES}`)
        }
        lines.push(line)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  const sortNotes = (): readonly MemoryNote[] =>
    [...notes.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  return {
    async readAll(): Promise<readonly MemoryNote[]> {
      await pending
      return sortNotes()
    },
    async readOne(key: string): Promise<MemoryNote | null> {
      await pending
      return notes.get(key) ?? null
    },
    async write(note: MemoryNote): Promise<void> {
      const error = validateRemember(note.key, note.value, note.tags, limits)
      if (error !== null) throw error
      pending = pending.then(async () => {
        const next = new Map(notes)
        if (next.size >= limits.maxNotes && !next.has(note.key)) {
          const err: MemoryWriteError = {
            code: 'io-error',
            message: `memory store holds ${next.size} notes; the limit is ${limits.maxNotes}`,
            key: note.key,
            cause: 'limit',
          }
          throw err
        }
        next.set(note.key, note)
        await atomicWrite(options.path, serialize(next))
        notes = next
      })
      await pending
    },
    async remove(key: string): Promise<boolean> {
      let removed = false
      pending = pending.then(async () => {
        if (!notes.has(key)) return
        const next = new Map(notes)
        next.delete(key)
        await atomicWrite(options.path, serialize(next))
        notes = next
        removed = true
      })
      await pending
      return removed
    },
  } satisfies MemoryStore
}

/**
 * Read and parse one YAML memory file. Missing files return an empty
 * map. Malformed lines are skipped silently (the format is for human
 * readability, not adversarial input).
 *
 * @param path - the file path.
 * @param now - wall-clock supplier for `updatedAt`.
 * @returns the parsed notes.
 */
function loadFromFile(path: string, now: () => number): Map<string, MemoryNote> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  const out = new Map<string, MemoryNote>()
  let current: { key: string; tags: string[]; value: string[]; updatedAt: number } | null = null
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('#') || line.length === 0) continue
    if (line.startsWith(NOTE_PREFIX_KEY)) {
      if (current !== null) out.set(current.key, finalize(current))
      current = { key: line.slice(NOTE_PREFIX_KEY.length).trim(), tags: [], value: [], updatedAt: now() }
      continue
    }
    if (line.startsWith(NOTE_PREFIX_TAGS)) {
      if (current === null) continue
      current.tags = line.slice(NOTE_PREFIX_TAGS.length).trim().split(/\s+/).filter(Boolean)
      continue
    }
    if (current !== null) current.value.push(line)
  }
  if (current !== null) out.set(current.key, finalize(current))
  return out
}

function finalize(input: { key: string; tags: string[]; value: string[]; updatedAt: number }): MemoryNote {
  return { key: input.key, tags: input.tags, value: input.value.join('\n'), updatedAt: input.updatedAt }
}

/**
 * Write a string to disk atomically: write to a sibling temp file,
 * fsync, rename over the target. The sibling lives in the same
 * directory so the rename is atomic on POSIX filesystems.
 *
 * @param path - the destination path.
 * @param body - the file contents.
 */
async function atomicWrite(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  const handle = await open(tmp, 'wx', 0o600)
  try {
    await writeFile(handle, body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
}

/**
 * Build an in-memory store from a snapshot. Tests use this to seed
 * deterministic state without touching the disk.
 *
 * @param seed - the initial notes (defaults to empty).
 * @returns the {@link MemoryStore}.
 */
export function createInMemoryMemoryStore(seed: readonly MemoryNote[] = []): MemoryStore {
  const state = new Map<string, MemoryNote>()
  for (const note of seed) state.set(note.key, note)
  return {
    async readAll(): Promise<readonly MemoryNote[]> {
      return [...state.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    },
    async readOne(key: string): Promise<MemoryNote | null> {
      return state.get(key) ?? null
    },
    async write(note: MemoryNote): Promise<void> {
      state.set(note.key, note)
    },
    async remove(key: string): Promise<boolean> {
      return state.delete(key)
    },
  } satisfies MemoryStore
}
