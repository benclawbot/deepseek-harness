/**
 * Validation helpers for the memory seam. The rules are conservative
 * by default; profile-specific configurations can relax them, but the
 * defaults catch the most common mistakes (empty keys, oversized
 * values, runaway tag lists) without making the model jump through
 * hoops.
 *
 * @module @deepseek-ai/dsh-compaction-memory
 */

import { DEFAULT_MEMORY_LIMITS, MEMORY_KEY_PATTERN, MEMORY_TAG_PATTERN, type MemoryLimits, type MemoryWriteError } from './types.ts'

/** UTF-8 byte length of a string. The package's value limit is in bytes, not characters. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Validate one incoming `remember()` call against the package limits.
 *
 * @param key - the candidate note key.
 * @param value - the candidate note value.
 * @param tags - the candidate note tags.
 * @param limits - the limits to enforce.
 * @returns `null` when the call passes; a {@link MemoryWriteError} otherwise.
 */
export function validateRemember(
  key: string,
  value: string,
  tags: readonly string[],
  limits: MemoryLimits = DEFAULT_MEMORY_LIMITS,
): MemoryWriteError | null {
  if (key.length === 0) {
    return { code: 'key-empty', message: 'memory key must not be empty' }
  }
  if (!MEMORY_KEY_PATTERN.test(key)) {
    return {
      code: 'key-invalid',
      message: `memory key "${key}" must match ${MEMORY_KEY_PATTERN}; use a short, lower-case identifier`,
      key,
    }
  }
  if (value.length === 0) {
    return { code: 'value-empty', message: `memory value for "${key}" must not be empty`, key }
  }
  const bytes = utf8Bytes(value)
  if (bytes > limits.maxValueBytes) {
    return {
      code: 'value-too-long',
      message: `memory value for "${key}" is ${bytes} bytes; the limit is ${limits.maxValueBytes}`,
      key,
      maxBytes: limits.maxValueBytes,
    }
  }
  if (tags.length > limits.maxTags) {
    return {
      code: 'too-many-tags',
      message: `memory note "${key}" carries ${tags.length} tags; the limit is ${limits.maxTags}`,
      key,
      maxTags: limits.maxTags,
      observed: tags.length,
    }
  }
  for (const tag of tags) {
    if (!MEMORY_TAG_PATTERN.test(tag)) {
      return {
        code: 'too-many-tags',
        message: `memory tag "${tag}" must match ${MEMORY_TAG_PATTERN}; use a short, lower-case token`,
        key,
        maxTags: limits.maxTags,
        observed: tags.length,
      }
    }
  }
  return null
}

/** A single tag's normalized form: lower-case, trimmed, deduped. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase()
    if (normalized.length === 0) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}
