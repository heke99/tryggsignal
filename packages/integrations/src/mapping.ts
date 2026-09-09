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

export function readPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function sourceHash(payload: unknown): string {
  const serialized = JSON.stringify(canonicalize(payload));
  if (serialized === undefined) {
    throw new Error('Integration payload cannot be serialized deterministically');
  }
  return createHash('sha256').update(serialized).digest('hex');
}

export function mapExternalCase(item: unknown, mapping: CaseMapping): ExternalCase | null {
  const externalId = asString(readPath(item, mapping.externalId));
  const caseNumber = asString(readPath(item, mapping.caseNumber));
  if (externalId === null || caseNumber === null) return null;

  return {
    externalId,
    caseNumber,
    title: asString(readPath(item, mapping.title)) ?? caseNumber,
    status: asString(readPath(item, mapping.status)) ?? 'UNKNOWN',
    sourceVersion:
      mapping.sourceVersion === undefined ? null : asString(readPath(item, mapping.sourceVersion)),
    sourceUpdatedAt:
      mapping.sourceUpdatedAt === undefined
        ? null
        : asString(readPath(item, mapping.sourceUpdatedAt)),
    sourceHash: sourceHash(item),
    mappingVersion: mapping.mappingVersion ?? '1',
    raw: item,
  };
}

export function mapExternalCaseItems(
  payload: unknown,
  mapping: CaseMapping,
): readonly ExternalCase[] {
  const rawItems = mapping.itemsPath === undefined ? payload : readPath(payload, mapping.itemsPath);
  if (!Array.isArray(rawItems)) return [];
  return rawItems.flatMap((item) => {
    const mapped = mapExternalCase(item, mapping);
    return mapped === null ? [] : [mapped];
  });
}
