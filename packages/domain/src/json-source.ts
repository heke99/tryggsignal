/** Project JSON codec v1: UTF-16 key order, not an RFC 8785/JCS claim.
 * Keep this codec shared by integration and migration provenance. Changing its
 * output requires a new version; never silently re-hash historical evidence.
 */
export const SOURCE_JSON_CODEC = 'canonical-json-v1' as const;

function serialize(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 100) throw new Error('Integration payload exceeds maximum nesting depth');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error('Unsafe numeric integration value; encode large integers as strings');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error('Integration payload must contain only lossless JSON values');
  }
  if (seen.has(value)) throw new Error('Integration payload contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // JSON would silently drop named/symbol properties and invoke getters.
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new Error('Integration payload contains a sparse array or non-JSON array properties');
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          throw new Error('Integration payload contains a sparse array or accessor');
        }
        items.push(serialize(descriptor.value, seen, depth + 1));
      }
      return '[' + items.join(',') + ']';
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Integration payload must use plain JSON objects');
    }
    const keys = Object.keys(value).sort();
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new Error('Integration payload contains non-JSON properties');
    }
    return (
      '{' +
      keys
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !('value' in descriptor)) {
            throw new Error('Integration payload contains an accessor');
          }
          return JSON.stringify(key) + ':' + serialize(descriptor.value, seen, depth + 1);
        })
        .join(',') +
      '}'
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set(), 0);
}

/** Read only own data properties. Mapping must not consult prototypes or run code. */
export function readOwnDataPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const segment of path.split('.')) {
    if (
      segment.length === 0 ||
      ['__proto__', 'constructor', 'prototype'].includes(segment) ||
      current === null ||
      typeof current !== 'object'
    ) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}
