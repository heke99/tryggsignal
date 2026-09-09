import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, readOwnDataPath } from '@tryggsignal/domain';
import { sourceHash } from '@tryggsignal/integrations';
import {
  applyMapping,
  assertRawCaptured,
  captureRaw,
  IrreversibleTransformError,
  reconcile,
  type MappingVersion,
} from '@tryggsignal/migration-engine';

const input = {
  sourceSystem: 'SYNTHETIC',
  sourceVersion: '1',
  sourceObject: 'case',
  sourcePrimaryKey: 'case-1',
  rawPayload: { z: { title: 'Original' }, a: [1, null, true], status: 'OPEN' },
  exportedAt: '2026-09-09T00:00:00Z',
};
const mapping: MappingVersion = {
  mappingKey: 'synthetic-case',
  version: 1,
  entityType: 'case',
  rules: [{ kind: 'copy', from: 'z', to: 'nested' }],
};
const clean = {
  sourceCaseCount: 2,
  targetCaseCount: 2,
  sourceDocumentCount: 3,
  targetDocumentCount: 3,
  missingIds: [],
  duplicateIds: [],
  hashMismatchIds: [],
  brokenRelationIds: [],
  unmappedStatuses: [],
  unmappedClassifications: [],
  orphanDocumentIds: [],
};

describe('shared integration/migration JSON codec', () => {
  it('preserves H hash bytes and ignores object key order through a JSONB-style round trip', () => {
    const raw = captureRaw(input);
    expect(raw.sourceHashVersion).toBe('canonical-json-v1');
    expect(raw.sourceHash).toBe(sourceHash(input.rawPayload));
    const reordered = { status: 'OPEN', a: [1, null, true], z: { title: 'Original' } };
    expect(() => assertRawCaptured({ ...raw, rawPayload: reordered })).not.toThrow();
    expect(raw.sourceHash).toBe(sourceHash(reordered));
  });

  it('never aliases the caller or mapped output to captured raw evidence', () => {
    const original = { nested: { value: 1 } };
    const raw = captureRaw({ ...input, rawPayload: original });
    original.nested.value = 9;
    expect(raw.rawPayload).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(raw)).toBe(true);
    const mapped = applyMapping(raw, {
      ...mapping,
      rules: [{ kind: 'copy', from: 'nested', to: 'nested' }],
    });
    (mapped.canonical['nested'] as { value: number }).value = 7;
    expect(() => assertRawCaptured(raw)).not.toThrow();
    expect(raw.rawPayload).toEqual({ nested: { value: 1 } });
  });

  it('rejects changed payloads and invalid checksums before mapping', () => {
    const raw = captureRaw(input);
    expect(() => applyMapping({ ...raw, rawPayload: {} }, mapping)).toThrow(
      IrreversibleTransformError,
    );
    expect(() => assertRawCaptured({ ...raw, sourceHash: 'invalid' })).toThrow(
      IrreversibleTransformError,
    );
  });

  it('verifies legacy hashes without silently rewriting or upgrading their codec', () => {
    const legacy = {
      ...input,
      sourceHash: createHash('sha256').update(JSON.stringify(input.rawPayload)).digest('hex'),
    };
    expect(() => assertRawCaptured(legacy)).not.toThrow();
    expect('sourceHashVersion' in legacy).toBe(false);
    expect(() => assertRawCaptured({ ...legacy, sourceHashVersion: 'unknown' } as never)).toThrow(
      IrreversibleTransformError,
    );
  });

  it.each([undefined, NaN, Infinity, BigInt(1), Number.MAX_SAFE_INTEGER + 1])(
    'rejects lossy non-JSON input %s',
    (value) => {
      expect(() => captureRaw({ ...input, rawPayload: { value } })).toThrow();
    },
  );

  it('does not invoke getters or accept hidden/symbol/sparse-array data', () => {
    let invoked = false;
    const getter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        invoked = true;
        return 'not data';
      },
    });
    expect(() => canonicalJson(getter)).toThrow();
    expect(readOwnDataPath(getter, 'value')).toBeUndefined();
    expect(invoked).toBe(false);
    expect(() => canonicalJson({ [Symbol('hidden')]: 'lost' })).toThrow();
    expect(() => canonicalJson(Object.defineProperty({}, 'hidden', { value: 'lost' }))).toThrow();
    expect(() => canonicalJson(new Array(2))).toThrow();
  });
});

describe('safe versioned migration mapping', () => {
  it.each(['__proto__', 'constructor', 'prototype', 'source_system', 'source_record_id'])(
    'rejects unsafe or reserved target %s',
    (to) => {
      expect(() =>
        applyMapping(captureRaw(input), {
          ...mapping,
          rules: [{ kind: 'constant', to, value: 'not canonical provenance' }],
        }),
      ).toThrow(/target/);
    },
  );

  it('rejects duplicate targets rather than applying last-write-wins', () => {
    expect(() =>
      applyMapping(captureRaw(input), {
        ...mapping,
        rules: [
          { kind: 'constant', to: 'title', value: 'first' },
          { kind: 'constant', to: 'title', value: 'second' },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('does not read inherited source or lookup properties', () => {
    const raw = captureRaw({ ...input, rawPayload: { status: 'constructor' } });
    const mapped = applyMapping(raw, {
      ...mapping,
      rules: [
        { kind: 'copy', from: 'constructor', to: 'title' },
        { kind: 'lookup', from: 'status', to: 'status', table: {}, onMissing: 'ERROR' },
      ],
    });
    expect(mapped.errors.map((error) => error.code)).toEqual([
      'MISSING_SOURCE_VALUE',
      'UNMAPPED_VALUE',
    ]);
    expect(mapped.canonical).not.toHaveProperty('title');
    expect(mapped.canonical).not.toHaveProperty('status');
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid mapping version %s', (version) => {
    expect(() => applyMapping(captureRaw(input), { ...mapping, version })).toThrow();
  });
});

describe('reconciliation input contract', () => {
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'cannot report GREEN for matching invalid counts %s',
    (count) => {
      expect(() => reconcile({ ...clean, sourceCaseCount: count, targetCaseCount: count })).toThrow(
        RangeError,
      );
    },
  );

  it('requires structured finding arrays', () => {
    expect(() => reconcile({ ...clean, missingIds: {} } as never)).toThrow(TypeError);
  });

  it('keeps genuine empty exports and equal valid counts distinct from invalid inputs', () => {
    expect(reconcile(clean).result).toBe('GREEN');
    expect(
      reconcile({
        ...clean,
        sourceCaseCount: 0,
        targetCaseCount: 0,
        sourceDocumentCount: 0,
        targetDocumentCount: 0,
      }).result,
    ).toBe('GREEN');
    expect(reconcile({ ...clean, orphanDocumentIds: ['document-1'] }).result).toBe('RED');
  });
});
