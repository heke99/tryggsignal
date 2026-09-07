import { describe, expect, it } from 'vitest';
import {
  applyMapping,
  assertRawCaptured,
  captureRaw,
  IrreversibleTransformError,
  reconcile,
  type MappingVersion,
} from '@tryggsignal/migration-engine';

const raw = captureRaw({
  sourceSystem: 'LEGACY_X',
  sourceVersion: '2019.4',
  sourceObject: 'ARENDE',
  sourcePrimaryKey: '4711',
  rawPayload: { AR_NR: 'B 2019-4711', RUBRIK: 'Nybyggnad', STATUS: 'P', HANDL: 'AB' },
  exportedAt: '2026-09-01T00:00:00Z',
});

const mapping: MappingVersion = {
  mappingKey: 'legacy_x_case',
  version: 3,
  entityType: 'case',
  rules: [
    { kind: 'copy', from: 'AR_NR', to: 'external_case_number' },
    { kind: 'copy', from: 'RUBRIK', to: 'title' },
    { kind: 'constant', to: 'process_type', value: 'BYGGLOV' },
    {
      kind: 'lookup',
      from: 'STATUS',
      to: 'status',
      table: { P: 'IN_REVIEW', A: 'CLOSED' },
      onMissing: 'ERROR',
    },
  ],
};

describe('raw capture (masterplan 56)', () => {
  it('hashes the original payload', () => {
    expect(raw.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(captureRaw({ ...raw }).sourceHash).toBe(raw.sourceHash);
  });

  it('refuses to transform before raw has been captured', () => {
    expect(() => assertRawCaptured(null)).toThrow(IrreversibleTransformError);
    expect(() => applyMapping({ ...raw, rawPayload: undefined } as never, mapping)).toThrow(
      IrreversibleTransformError,
    );
  });
});

describe('mapping (masterplan 55/22)', () => {
  it('maps fields and attaches provenance', () => {
    const mapped = applyMapping(raw, mapping);
    expect(mapped.canonical).toMatchObject({
      external_case_number: 'B 2019-4711',
      title: 'Nybyggnad',
      process_type: 'BYGGLOV',
      status: 'IN_REVIEW',
      source_system: 'LEGACY_X',
      source_record_id: '4711',
      source_version: '2019.4',
      migration_mapping_version: 3,
    });
    expect(mapped.errors).toEqual([]);
  });

  it('reports an unmapped value instead of defaulting it', () => {
    const unknown = captureRaw({
      ...raw,
      rawPayload: { ...(raw.rawPayload as object), STATUS: 'Z' },
    });
    const mapped = applyMapping(unknown, mapping);
    expect(mapped.errors).toEqual([
      expect.objectContaining({ code: 'UNMAPPED_VALUE', field: 'status' }),
    ]);
  });
});

describe('reconciliation (masterplan 59)', () => {
  const clean = {
    sourceCaseCount: 1200,
    targetCaseCount: 1200,
    sourceDocumentCount: 9000,
    targetDocumentCount: 9000,
    missingIds: [],
    duplicateIds: [],
    hashMismatchIds: [],
    brokenRelationIds: [],
    unmappedStatuses: [],
    unmappedClassifications: [],
    orphanDocumentIds: [],
  };

  it('is GREEN only when everything reconciles', () => {
    expect(reconcile(clean).result).toBe('GREEN');
  });

  it('is RED on a count mismatch and names it', () => {
    const report = reconcile({ ...clean, targetCaseCount: 1199 });
    expect(report.result).toBe('RED');
    expect(report.counts.caseDelta).toBe(-1);
    expect(report.failures[0]).toContain('Case count mismatch');
  });

  it('is RED on checksum mismatches and orphan documents', () => {
    const report = reconcile({
      ...clean,
      hashMismatchIds: ['d1', 'd2'],
      orphanDocumentIds: ['d9'],
      unmappedStatuses: ['Z'],
    });
    expect(report.result).toBe('RED');
    expect(report.failures).toHaveLength(3);
  });
});
