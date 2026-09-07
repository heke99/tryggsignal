import { describe, expect, it } from 'vitest';
import { resolveValue, type ValueCandidate } from '@tryggsignal/domain';

const candidate = (
  value: string,
  level: 'AUTHORITATIVE' | 'REFERENCE' | 'AI_DERIVED',
  source: string,
): ValueCandidate<string> => ({
  value,
  provenance: {
    sourceSystem: source,
    sourceRecordId: null,
    sourceVersion: null,
    sourceUpdatedAt: null,
    lastSyncedAt: null,
    mappingVersion: null,
    authoritativeLevel: level,
    locallyModified: false,
    locallyModifiedBy: null,
  },
});

describe('resolveValue (masterplan 24)', () => {
  it('lets an authoritative source win over an AI derivation', () => {
    const result = resolveValue([
      candidate('Kv Björnen 1:2', 'AI_DERIVED', 'ai'),
      candidate('BJÖRNEN 1:2', 'AUTHORITATIVE', 'lantmateriet'),
    ]);
    expect(result.kind).toBe('RESOLVED');
    if (result.kind === 'RESOLVED') expect(result.winner.value).toBe('BJÖRNEN 1:2');
  });

  it('surfaces a conflict between two equally authoritative sources', () => {
    const result = resolveValue([
      candidate('A', 'AUTHORITATIVE', 'lantmateriet'),
      candidate('B', 'AUTHORITATIVE', 'legacy'),
    ]);
    expect(result.kind).toBe('CONFLICT');
  });

  it('does not report a conflict when equal-rank sources agree', () => {
    const result = resolveValue([
      candidate('A', 'REFERENCE', 'boverket'),
      candidate('A', 'REFERENCE', 'scb'),
    ]);
    expect(result.kind).toBe('RESOLVED');
  });

  it('returns EMPTY without candidates', () => {
    expect(resolveValue<string>([]).kind).toBe('EMPTY');
  });
});
