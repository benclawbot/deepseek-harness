/**
 * Tests for the YAML-backed memory store: round-trip persistence,
 * atomic writes, and concurrent serialization.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createYamlMemoryStore, createInMemoryMemoryStore } from '../src/store-yaml.ts'
import type { MemoryNote } from '../src/types.ts'

const NOW = (): number => 1_700_000_000_000

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-'))
  return join(dir, 'memory.yaml')
}

function note(key: string, value: string, tags: readonly string[] = []): MemoryNote {
  return { key, value, tags, updatedAt: NOW() }
}

describe('createInMemoryMemoryStore', () => {
  it('reads an empty list when seeded empty', async () => {
    const store = createInMemoryMemoryStore()
    expect(await store.readAll()).toEqual([])
  })

  it('sorts notes by key', async () => {
    const store = createInMemoryMemoryStore([note('b', 'B'), note('a', 'A'), note('c', 'C')])
    const all = await store.readAll()
    expect(all.map(n => n.key)).toEqual(['a', 'b', 'c'])
  })
})

describe('createYamlMemoryStore', () => {
  it('round-trips notes through the file', async () => {
    const path = tmpFile()
    try {
      const writer = createYamlMemoryStore({ path, now: NOW })
      await writer.write(note('repo-style', 'tabs over spaces', ['coding']))
      await writer.write(note('user-name', 'Tom', ['user']))
      const reader = createYamlMemoryStore({ path, now: NOW })
      const all = await reader.readAll()
      expect(all).toEqual([
        note('repo-style', 'tabs over spaces', ['coding']),
        note('user-name', 'Tom', ['user']),
      ])
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('reads the file as a human-readable YAML', async () => {
    const path = tmpFile()
    try {
      const store = createYamlMemoryStore({ path, now: NOW })
      await store.write(note('k', 'v1'))
      await store.write(note('k', 'v2'))
      const raw = readFileSync(path, 'utf8')
      expect(raw).toContain('@note k')
      expect(raw).toContain('v2')
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('removes a note by key', async () => {
    const path = tmpFile()
    try {
      const store = createYamlMemoryStore({ path, now: NOW })
      await store.write(note('a', 'one'))
      await store.write(note('b', 'two'))
      expect(await store.remove('a')).toBe(true)
      const all = await store.readAll()
      expect(all.map(n => n.key)).toEqual(['b'])
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('serializes concurrent writes through the pending queue', async () => {
    const path = tmpFile()
    try {
      const store = createYamlMemoryStore({ path, now: NOW })
      await Promise.all([
        store.write(note('a', 'one')),
        store.write(note('b', 'two')),
        store.write(note('c', 'three')),
      ])
      const all = await store.readAll()
      expect(all.map(n => n.key).sort()).toEqual(['a', 'b', 'c'])
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })
})
