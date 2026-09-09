/** Count summaries are validated evidence, not a substitute for reading the target. */
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
  for (const count of [input.sourceCaseCount, input.targetCaseCount, input.sourceDocumentCount, input.targetDocumentCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Reconciliation counts must be nonnegative safe integers');
  }
  for (const ids of [input.missingIds, input.duplicateIds, input.hashMismatchIds, input.brokenRelationIds,
    input.unmappedStatuses, input.unmappedClassifications, input.orphanDocumentIds]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new Error('Reconciliation issue identities must be nonempty strings');
    }
  }
  const caseDelta = input.targetCaseCount - input.sourceCaseCount;
  const documentDelta = input.targetDocumentCount - input.sourceDocumentCount;
  const failures: string[] = [];
  if (caseDelta !== 0) failures.push(`Case count mismatch: source ${input.sourceCaseCount}, target ${input.targetCaseCount}`);
  if (documentDelta !== 0) failures.push(`Document count mismatch: source ${input.sourceDocumentCount}, target ${input.targetDocumentCount}`);
  if (input.missingIds.length) failures.push(`${input.missingIds.length} missing record(s)`);
  if (input.duplicateIds.length) failures.push(`${input.duplicateIds.length} duplicate record(s)`);
  if (input.hashMismatchIds.length) failures.push(`${input.hashMismatchIds.length} document(s) with a checksum mismatch`);
  if (input.brokenRelationIds.length) failures.push(`${input.brokenRelationIds.length} broken relation(s)`);
  if (input.unmappedStatuses.length) failures.push(`${input.unmappedStatuses.length} unmapped status value(s)`);
  if (input.unmappedClassifications.length) failures.push(`${input.unmappedClassifications.length} unmapped classification(s)`);
  if (input.orphanDocumentIds.length) failures.push(`${input.orphanDocumentIds.length} orphan document(s)`);
  return {
    result: failures.length ? 'RED' : 'GREEN', failures,
    counts: {
      caseDelta, documentDelta, missing: input.missingIds.length, duplicates: input.duplicateIds.length,
      hashMismatches: input.hashMismatchIds.length, brokenRelations: input.brokenRelationIds.length,
      unmappedStatuses: input.unmappedStatuses.length, unmappedClassifications: input.unmappedClassifications.length,
      orphanDocuments: input.orphanDocumentIds.length,
    },
  };
}
