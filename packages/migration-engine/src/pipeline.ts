/**
 * Masterplan 54–59: the migration pipeline is a permanent product feature, not a
 * one-off script.
 *
 *   SOURCE → EXTRACT → RAW → PROFILE → MAP → VALIDATE → TRANSFORM → CANONICAL
 *          → RECONCILE → IMPORT → VERIFY
 */
import { createHash } from 'node:crypto';

export const MIGRATION_STAGES = [
  'EXTRACT',
  'RAW',
  'PROFILE',
  'MAP',
  'VALIDATE',
  'TRANSFORM',
  'CANONICAL',
  'RECONCILE',
  'IMPORT',
  'VERIFY',
] as const;

export type MigrationStage = (typeof MIGRATION_STAGES)[number];

export const SUPPORTED_FORMATS = [
  'CSV',
  'XLSX',
  'XML',
  'JSON',
  'ZIP',
  'SQL',
  'PDF',
  'PDF/A',
  'TIFF',
  'JPEG',
  'PNG',
  'GeoJSON',
  'GeoPackage',
  'Shapefile',
  'FGS',
  'SIARD',
] as const;

export type MigrationFormat = (typeof SUPPORTED_FORMATS)[number];

export interface RawObject {
  readonly sourceSystem: string;
  readonly sourceVersion: string | null;
  readonly sourceObject: string;
  readonly sourcePrimaryKey: string;
  readonly rawPayload: unknown;
  readonly sourceHash: string;
  readonly exportedAt: string | null;
}

export class IrreversibleTransformError extends Error {}

/**
 * Masterplan 56: never transform before the original payload is stored. This is
 * the guard that makes that rule mechanical rather than a convention.
 */
export function captureRaw(input: Omit<RawObject, 'sourceHash'>): RawObject {
  const sourceHash = createHash('sha256')
    .update(JSON.stringify(input.rawPayload ?? null))
    .digest('hex');
  return { ...input, sourceHash };
}

export function assertRawCaptured(object: Partial<RawObject> | null): asserts object is RawObject {
  if (object === null || object.sourceHash === undefined || object.rawPayload === undefined) {
    throw new IrreversibleTransformError(
      'Refusing to transform: the original payload has not been captured (masterplan 56).',
    );
  }
}

export type MappingRule =
  | { readonly kind: 'copy'; readonly from: string; readonly to: string }
  | { readonly kind: 'constant'; readonly to: string; readonly value: unknown }
  | {
      readonly kind: 'lookup';
      readonly from: string;
      readonly to: string;
      readonly table: Readonly<Record<string, string>>;
      /** Unmapped values are reported, never silently defaulted. */
      readonly onMissing: 'ERROR' | 'PASSTHROUGH';
    };

export interface MappingVersion {
  readonly mappingKey: string;
  readonly version: number;
  readonly entityType: string;
  readonly rules: readonly MappingRule[];
}

export interface MappedObject {
  readonly canonical: Record<string, unknown>;
  readonly errors: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly mappingVersion: number;
}

function read(payload: unknown, path: string): unknown {
  let current = payload;
  for (const segment of path.split('.')) {
    if (
      !segment ||
      ['__proto__', 'constructor', 'prototype'].includes(segment) ||
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function applyMapping(raw: RawObject, mapping: MappingVersion): MappedObject {
  assertRawCaptured(raw);

  const canonical: Record<string, unknown> = {};
  const errors: { field: string; code: string; message: string }[] = [];

  for (const rule of mapping.rules) {
    if (!rule.to.trim() || ['__proto__', 'constructor', 'prototype'].includes(rule.to)) {
      throw new Error('Migration mapping has an invalid target field');
    }
    switch (rule.kind) {
      case 'constant':
        canonical[rule.to] = rule.value;
        break;
      case 'copy':
        canonical[rule.to] = read(raw.rawPayload, rule.from);
        break;
      case 'lookup': {
        const source = read(raw.rawPayload, rule.from);
        const key = typeof source === 'string' ? source : String(source ?? '');
        // Only explicitly configured entries are mappings; inherited members
        // must take the ordinary unmapped-value path.
        const mapped = Object.prototype.hasOwnProperty.call(rule.table, key)
          ? rule.table[key]
          : undefined;
        if (mapped === undefined) {
          if (rule.onMissing === 'ERROR') {
            errors.push({
              field: rule.to,
              code: 'UNMAPPED_VALUE',
              message: `No mapping for "${key}" in ${mapping.mappingKey} v${mapping.version}`,
            });
          } else {
            canonical[rule.to] = source;
          }
        } else {
          canonical[rule.to] = mapped;
        }
        break;
      }
    }
  }

  // Provenance travels with the record (masterplan 22).
  canonical['source_system'] = raw.sourceSystem;
  canonical['source_record_id'] = raw.sourcePrimaryKey;
  canonical['source_version'] = raw.sourceVersion;
  canonical['migration_mapping_version'] = mapping.version;

  return { canonical, errors, mappingVersion: mapping.version };
}
