/**
 * Tests for the memory-seam validation rules. The validate helpers
 * are pure functions; the registry tests exercise the same rules
 * end-to-end through the registry.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import { describe, expect, it } from 'vitest'
import { validateRemember, normalizeTags } from '../src/validate.ts'
import { DEFAULT_MEMORY_LIMITS } from '../src/types.ts'

describe('validateRemember', () => {
  it('accepts a well-formed call', () => {
    expect(validateRemember('repo-style', 'tabs over spaces', ['coding'])).toBeNull()
  })

  it('rejects an empty key', () => {
    const error = validateRemember('', 'value', [])
    expect(error?.code).toBe('key-empty')
  })

  it('rejects an invalid key shape', () => {
    const error = validateRemember('Repo-Style', 'value', [])
    expect(error?.code).toBe('key-invalid')
  })

  it('rejects an empty value', () => {
    const error = validateRemember('k', '', [])
    expect(error?.code).toBe('value-empty')
  })

  it('rejects an oversized value', () => {
    const error = validateRemember('k', 'x'.repeat(DEFAULT_MEMORY_LIMITS.maxValueBytes + 1), [])
    expect(error?.code).toBe('value-too-long')
  })

  it('rejects a tag list that exceeds the limit', () => {
    const error = validateRemember('k', 'v', Array.from({ length: DEFAULT_MEMORY_LIMITS.maxTags + 1 }, (_, i) => `t${i}`))
    expect(error?.code).toBe('too-many-tags')
  })
})

describe('normalizeTags', () => {
  it('dedupes case-insensitive tags', () => {
    expect(normalizeTags(['Coding', 'coding', 'CODING'])).toEqual(['coding'])
  })

  it('trims whitespace', () => {
    expect(normalizeTags(['  coding  ', ''])).toEqual(['coding'])
  })

  it('preserves order of first occurrence', () => {
    expect(normalizeTags(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
  })
})
