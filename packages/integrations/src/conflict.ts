/**
 * Masterplan 68: field ownership is declared per integration. There is no
 * general last-write-wins, and a change on a field the other side owns is
 * surfaced as a conflict rather than applied.
 */

export type FieldOwner = 'LEGACY' | 'KOMMUN_OS' | 'SHARED_MANUAL';

export interface FieldChange {
  readonly field: string;
  readonly localValue: unknown;
  readonly incomingValue: unknown;
}

export type FieldDecision =
  | { readonly field: string; readonly action: 'APPLY'; readonly value: unknown }
  | { readonly field: string; readonly action: 'IGNORE'; readonly reason: string }
  | { readonly field: string; readonly action: 'CONFLICT'; readonly reason: string };

export function resolveInboundChanges(
  changes: readonly FieldChange[],
  ownership: Readonly<Record<string, FieldOwner>>,
  defaultOwner: FieldOwner = 'KOMMUN_OS',
): readonly FieldDecision[] {
  return changes.map((change) => {
    if (Object.is(change.localValue, change.incomingValue)) {
      return { field: change.field, action: 'IGNORE', reason: 'No change' };
    }
    const owner = ownership[change.field] ?? defaultOwner;
    switch (owner) {
      case 'LEGACY':
        return { field: change.field, action: 'APPLY', value: change.incomingValue };
      case 'KOMMUN_OS':
        return {
          field: change.field,
          action: 'IGNORE',
          reason: 'Field is owned by Tryggsignal; the source system is not authoritative for it.',
        };
      case 'SHARED_MANUAL':
        return {
          field: change.field,
          action: 'CONFLICT',
          reason: 'Shared field changed on both sides; a caseworker must decide.',
        };
    }
  });
}
