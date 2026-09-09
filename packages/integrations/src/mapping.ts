import { createHash } from 'node:crypto';
import { canonicalJson, readOwnDataPath } from '@tryggsignal/domain';
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
  return readOwnDataPath(payload, path);
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  // Large database identifiers must arrive as strings, not rounded JS numbers.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** Shared codec v1 preserves H hashes for valid JSON while migration uses the
 * same deterministic representation, independent of JSONB object key order.
 */
export function sourceHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function mapExternalCase(item: unknown, mapping: CaseMapping): ExternalCase | null {
  const externalId = asString(readPath(item, mapping.externalId));
  const caseNumber = asString(readPath(item, mapping.caseNumber));
  if (externalId === null || caseNumber === null || !externalId.trim() || !caseNumber.trim()) {
    return null;
  }
  const mappingVersion = mapping.mappingVersion ?? '1';
  if (
    mappingVersion !== mappingVersion.trim() ||
    mappingVersion.length < 1 ||
    mappingVersion.length > 100
  ) {
    throw new Error('Mapping version must contain 1-100 characters without surrounding whitespace');
  }
  const sourceUpdatedAt =
    mapping.sourceUpdatedAt === undefined
      ? null
      : asString(readPath(item, mapping.sourceUpdatedAt));
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
export function mapExternalCaseItems(
  payload: unknown,
  mapping: CaseMapping,
): readonly ExternalCase[] {
  const rawItems = mapping.itemsPath === undefined ? payload : readPath(payload, mapping.itemsPath);
  if (!Array.isArray(rawItems))
    throw new Error('Integration mapping did not resolve to an item array');
  return rawItems.map((item, index) => {
    const mapped = mapExternalCase(item, mapping);
    if (mapped === null)
      throw new Error(`Integration row ${index} has no stable identity or case number`);
    return mapped;
  });
}
