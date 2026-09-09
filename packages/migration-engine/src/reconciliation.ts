/**
 * Masterplan 59: a migration is not finished because an import script exited 0.
 * The reconciliation report is the gate.
 */

export interface ReconciliationInput {
  readonly sourceCaseCount: number;
  readonly targetCaseCount: number;
  readonly sourceDocumentCount: number;
  readonly targetDocumentCount: number;
  readonly missingIds: readonly string[];
  readonly duplicateIds: readonly string[];
  readonly hashMismatchIds: readonly string[];
  readonly brokenRelationIds: readonly string[];
  readonly unmappedStatuses: readonly string[];
  readonly unmappedClassifications: readonly string[];
  readonly orphanDocumentIds: readonly string[];
}

export interface ReconciliationReport {
  readonly result: 'GREEN' | 'RED';
  readonly failures: readonly string[];
  readonly counts: {
    readonly caseDelta: number;
    readonly documentDelta: number;
    readonly missing: number;
    readonly duplicates: number;
    readonly hashMismatches: number;
    readonly brokenRelations: number;
    readonly unmappedStatuses: number;
    readonly unmappedClassifications: number;
    readonly orphanDocuments: number;
  };
}

export function reconcile(input: ReconciliationInput): ReconciliationReport {
  for (const count of [
    input.sourceCaseCount,
    input.targetCaseCount,
    input.sourceDocumentCount,
    input.targetDocumentCount,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('Reconciliation counts must be nonnegative safe integers');
    }
  }
  for (const findings of [
    input.missingIds,
    input.duplicateIds,
    input.hashMismatchIds,
    input.brokenRelationIds,
    input.unmappedStatuses,
    input.unmappedClassifications,
    input.orphanDocumentIds,
  ]) {
    if (!Array.isArray(findings) || findings.some((value) => typeof value !== 'string')) {
      throw new TypeError('Reconciliation findings must be arrays of strings');
    }
  }
  const caseDelta = input.targetCaseCount - input.sourceCaseCount;
  const documentDelta = input.targetDocumentCount - input.sourceDocumentCount;

  const failures: string[] = [];
  if (caseDelta !== 0) {
    failures.push(
      `Case count mismatch: source ${input.sourceCaseCount}, target ${input.targetCaseCount}`,
    );
  }
  if (documentDelta !== 0) {
    failures.push(
      `Document count mismatch: source ${input.sourceDocumentCount}, target ${input.targetDocumentCount}`,
    );
  }
  if (input.missingIds.length > 0) failures.push(`${input.missingIds.length} missing record(s)`);
  if (input.duplicateIds.length > 0)
    failures.push(`${input.duplicateIds.length} duplicate record(s)`);
  if (input.hashMismatchIds.length > 0) {
    failures.push(`${input.hashMismatchIds.length} document(s) with a checksum mismatch`);
  }
  if (input.brokenRelationIds.length > 0) {
    failures.push(`${input.brokenRelationIds.length} broken relation(s)`);
  }
  if (input.unmappedStatuses.length > 0) {
    failures.push(`Unmapped status value(s): ${input.unmappedStatuses.join(', ')}`);
  }
  if (input.unmappedClassifications.length > 0) {
    failures.push(`Unmapped classification(s): ${input.unmappedClassifications.join(', ')}`);
  }
  if (input.orphanDocumentIds.length > 0) {
    failures.push(`${input.orphanDocumentIds.length} orphan document(s)`);
  }

  return {
    result: failures.length === 0 ? 'GREEN' : 'RED',
    failures,
    counts: {
      caseDelta,
      documentDelta,
      missing: input.missingIds.length,
      duplicates: input.duplicateIds.length,
      hashMismatches: input.hashMismatchIds.length,
      brokenRelations: input.brokenRelationIds.length,
      unmappedStatuses: input.unmappedStatuses.length,
      unmappedClassifications: input.unmappedClassifications.length,
      orphanDocuments: input.orphanDocumentIds.length,
    },
  };
}
