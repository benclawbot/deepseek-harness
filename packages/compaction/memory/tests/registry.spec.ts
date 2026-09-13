/**
 * Tests for the memory registry: list, get, remember, forget, and
 * validation error surfacing.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MemoryProviderService, createInMemoryMemoryProvider } from '../src/registry.ts'
import type { MemoryWriteError } from '../src/types.ts'

const NOW = (): number => 1_700_000_000_000

function makeProvider(): { provider: MemoryProviderService } {
  const ctx = new Context()
  const { provider } = createInMemoryMemoryProvider(ctx, [], NOW)
  return { provider }
}

describe('MemoryProviderService', () => {
  it('returns an empty list when nothing has been remembered', async () => {
    const { provider } = makeProvider()
    expect(await provider.list()).toEqual([])
  })

  it('persists a new note and reads it back', async () => {
    const { provider } = makeProvider()
    const note = await provider.remember('user-name', 'Tom', ['user'])
    expect(note.key).toBe('user-name')
    expect(note.value).toBe('Tom')
    expect(note.tags).toEqual(['user'])
    expect(note.updatedAt).toBe(NOW())
    expect(await provider.get('user-name')).toEqual(note)
  })

  it('overwrites an existing note on a duplicate key', async () => {
    const { provider } = makeProvider()
    await provider.remember('k', 'first')
    const second = await provider.remember('k', 'second')
    expect(second.value).toBe('second')
    const all = await provider.list()
    expect(all.length).toBe(1)
    expect(all[0]?.value).toBe('second')
  })

  it('removes a note by key', async () => {
    const { provider } = makeProvider()
    await provider.remember('a', 'one')
    await provider.remember('b', 'two')
    expect(await provider.forget('a')).toBe(true)
    expect(await provider.forget('absent')).toBe(false)
    expect((await provider.list()).map(n => n.key)).toEqual(['b'])
  })

  it('normalizes tags on every write', async () => {
    const { provider } = makeProvider()
    const note = await provider.remember('k', 'v', ['Coding', 'CODING', ' coding '])
    expect(note.tags).toEqual(['coding'])
  })

  it('surfaces a structured error for an invalid key', async () => {
    const { provider } = makeProvider()
    let caught: unknown
    try {
      await provider.remember('Invalid-Key', 'value')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const typed = caught as MemoryWriteError
    expect(typed.code).toBe('key-invalid')
  })

  it('surfaces a structured error for an empty value', async () => {
    const { provider } = makeProvider()
    await expect(provider.remember('k', '')).rejects.toMatchObject({ code: 'value-empty' })
  })

  it('reads committed state through get after concurrent writes', async () => {
    const { provider } = makeProvider()
    await Promise.all([
      provider.remember('a', 'one'),
      provider.remember('b', 'two'),
      provider.remember('c', 'three'),
    ])
    const all = await provider.list()
    expect(all.map(n => n.key).sort()).toEqual(['a', 'b', 'c'])
    expect(await provider.get('b')).toMatchObject({ key: 'b', value: 'two' })
  })
})
