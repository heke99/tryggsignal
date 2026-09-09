import { createHash } from 'node:crypto';
import type { ExternalCase } from './contract';

export interface CaseMapping {
  readonly externalId: string;
  readonly caseNumber: string;
  readonly title: string;
  readonly status: string;
  readonly sourceVersion?: string;
  readonly sourceUpdatedAt?: string;
  readonly itemsPath?: string;
  readonly nextCursorPath?: string;
  readonly mappingVersion?: string;
}

/** Mapping paths only read own data, never an inherited prototype property. */
export function readPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const segment of path.split('.')) {
    if (
      segment.length === 0 ||
      ['__proto__', 'constructor', 'prototype'].includes(segment) ||
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  // Large database identifiers must arrive as strings, not rounded JS numbers.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** JSON-only canonical serialization, with locale-independent UTF-16 key order.
 * Do not silently drop undefined/functions or convert NaN to null: provenance
 * must describe precisely the payload that will be persisted as JSON.
 * This is the project's versioned JSON contract, not a claim of RFC 8785/JCS.
 */
function canonicalJson(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 100) throw new Error('Integration payload exceeds maximum nesting depth');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error('Unsafe numeric integration value; encode large integers as strings');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error('Integration payload must contain only lossless JSON values');
  }
  if (seen.has(value)) throw new Error('Integration payload contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error('Integration payload contains a sparse array');
        }
        items.push(canonicalJson(value[index], seen, depth + 1));
      }
      return '[' + items.join(',') + ']';
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Integration payload must use plain JSON objects');
    }
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key], seen, depth + 1))
        .join(',') +
      '}'
    );
  } finally {
    seen.delete(value);
  }
}

export function sourceHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload, new Set(), 0)).digest('hex');
}

export function mapExternalCase(item: unknown, mapping: CaseMapping): ExternalCase | null {
  const externalId = asString(readPath(item, mapping.externalId));
  const caseNumber = asString(readPath(item, mapping.caseNumber));
  if (externalId === null || caseNumber === null || !externalId.trim() || !caseNumber.trim()) {
    return null;
  }
  const mappingVersion = mapping.mappingVersion ?? '1';
  if (mappingVersion !== mappingVersion.trim() || mappingVersion.length < 1 || mappingVersion.length > 100) {
    throw new Error('Mapping version must contain 1-100 characters without surrounding whitespace');
  }
  const sourceUpdatedAt =
    mapping.sourceUpdatedAt === undefined ? null : asString(readPath(item, mapping.sourceUpdatedAt));
  if (sourceUpdatedAt !== null && !Number.isFinite(Date.parse(sourceUpdatedAt))) {
    throw new Error('Source update timestamp is invalid');
  }
  return {
    externalId,
    caseNumber,
    title: asString(readPath(item, mapping.title)) ?? caseNumber,
    status: asString(readPath(item, mapping.status)) ?? 'UNKNOWN',
    sourceVersion:
      mapping.sourceVersion === undefined ? null : asString(readPath(item, mapping.sourceVersion)),
    sourceUpdatedAt,
    sourceHash: sourceHash(item),
    mappingVersion,
    raw: item,
  };
}

/** A corrupt page is not an empty page. Reject it before advancing a checkpoint. */
export function mapExternalCaseItems(payload: unknown, mapping: CaseMapping): readonly ExternalCase[] {
  const rawItems = mapping.itemsPath === undefined ? payload : readPath(payload, mapping.itemsPath);
  if (!Array.isArray(rawItems)) throw new Error('Integration mapping did not resolve to an item array');
  return rawItems.map((item, index) => {
    const mapped = mapExternalCase(item, mapping);
    if (mapped === null) throw new Error(`Integration row ${index} has no stable identity or case number`);
    return mapped;
  });
}
