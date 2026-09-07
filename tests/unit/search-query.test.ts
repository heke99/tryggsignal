import { describe, expect, it } from 'vitest';
import { buildSearchQuery, InvalidSearchError } from '@tryggsignal/search';

describe('search query builder (masterplan 46/48)', () => {
  it('parameterizes the query text', () => {
    const binding = buildSearchQuery({ query: "Björnen 1:2'; drop table core.cases; --" });
    expect(binding.text).not.toContain('drop table');
    expect(binding.params[0]).toBe("Björnen 1:2'; drop table core.cases; --");
  });

  it('caps the page size', () => {
    expect(buildSearchQuery({ query: 'bygglov', limit: 5000 }).params[1]).toBe(100);
    expect(buildSearchQuery({ query: 'bygglov', limit: 0 }).params[1]).toBe(1);
  });

  it('filters by entity type through a bound parameter', () => {
    const binding = buildSearchQuery({ query: 'bygglov', entityTypes: ['CASE', 'DOCUMENT'] });
    expect(binding.text).toContain('e.entity_type = any($3)');
    expect(binding.params[2]).toEqual(['CASE', 'DOCUMENT']);
  });

  it('never adds an access filter of its own — RLS owns that', () => {
    const binding = buildSearchQuery({ query: 'bygglov' });
    expect(binding.text).not.toMatch(/authority_id\s*=/);
  });

  it('rejects an empty or oversized query', () => {
    expect(() => buildSearchQuery({ query: '   ' })).toThrow(InvalidSearchError);
    expect(() => buildSearchQuery({ query: 'a'.repeat(201) })).toThrow(InvalidSearchError);
  });
});
