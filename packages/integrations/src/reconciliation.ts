import type { ExternalCase } from './contract';

export interface RecordedExternalRecord {
  readonly externalId: string;
  readonly sourceHash: string | null;
  readonly sourceVersion: string | null;
  readonly mappingVersion: string | null;
  readonly internalId: string | null;
}

export interface ReconciliationIssue {
  readonly externalId: string;
  readonly kind: 'DUPLICATE_SOURCE' | 'NEW' | 'CHANGED' | 'MISSING_INTERNAL' | 'MISSING_SOURCE';
}

export interface ReconciliationResult {
  readonly sourceCount: number;
  readonly recordedCount: number;
  readonly unchangedCount: number;
  readonly newCount: number;
  readonly changedCount: number;
  readonly missingInternalCount: number;
  readonly missingSourceCount: number;
  readonly duplicateSourceCount: number;
  readonly result: 'GREEN' | 'RED';
  readonly issues: readonly ReconciliationIssue[];
}

export function reconcileCases(
  sourceCases: readonly ExternalCase[],
  recorded: readonly RecordedExternalRecord[],
): ReconciliationResult {
  const issues: ReconciliationIssue[] = [];
  const sourceById = new Map<string, ExternalCase>();
  let duplicateSourceCount = 0;

  for (const item of sourceCases) {
    if (sourceById.has(item.externalId)) {
      duplicateSourceCount += 1;
      issues.push({ externalId: item.externalId, kind: 'DUPLICATE_SOURCE' });
      continue;
    }
    sourceById.set(item.externalId, item);
  }

  const recordedById = new Map(recorded.map((item) => [item.externalId, item] as const));
  let unchangedCount = 0;
  let newCount = 0;
  let changedCount = 0;
  let missingInternalCount = 0;
  let missingSourceCount = 0;

  for (const [externalId, source] of sourceById) {
    const existing = recordedById.get(externalId);
    if (existing === undefined) {
      newCount += 1;
      issues.push({ externalId, kind: 'NEW' });
      continue;
    }
    if (existing.internalId === null) {
      missingInternalCount += 1;
      issues.push({ externalId, kind: 'MISSING_INTERNAL' });
    }
    if (
      existing.sourceHash !== source.sourceHash ||
      existing.sourceVersion !== source.sourceVersion ||
      existing.mappingVersion !== source.mappingVersion
    ) {
      changedCount += 1;
      issues.push({ externalId, kind: 'CHANGED' });
    } else {
      unchangedCount += 1;
    }
  }

  for (const item of recorded) {
    if (!sourceById.has(item.externalId)) {
      missingSourceCount += 1;
      issues.push({ externalId: item.externalId, kind: 'MISSING_SOURCE' });
    }
  }

  return {
    sourceCount: sourceCases.length,
    recordedCount: recorded.length,
    unchangedCount,
    newCount,
    changedCount,
    missingInternalCount,
    missingSourceCount,
    duplicateSourceCount,
    result:
      duplicateSourceCount === 0 &&
      newCount === 0 &&
      changedCount === 0 &&
      missingInternalCount === 0 &&
      missingSourceCount === 0
        ? 'GREEN'
        : 'RED',
    issues,
  };
}
