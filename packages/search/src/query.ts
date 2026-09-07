/**
 * Masterplan 46–48: Postgres-first search whose authorization filter is part of
 * the query, not applied afterwards in the UI.
 */

export interface SearchRequest {
  readonly query: string;
  readonly entityTypes?: readonly ('CASE' | 'DOCUMENT' | 'PROPERTY' | 'PARTY')[];
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface SearchBinding {
  readonly text: string;
  readonly params: readonly unknown[];
}

export class InvalidSearchError extends Error {}

const MAX_LIMIT = 100;

/**
 * Builds a parameterized query against `search.entities`. RLS on that table is
 * what enforces access; this function must never add a bypass, and it never
 * interpolates user input into SQL.
 */
export function buildSearchQuery(request: SearchRequest): SearchBinding {
  const query = request.query.trim();
  if (query.length === 0) throw new InvalidSearchError('An empty search would scan the whole index');
  if (query.length > 200) throw new InvalidSearchError('Search query is too long');

  const limit = Math.min(Math.max(request.limit ?? 20, 1), MAX_LIMIT);
  const params: unknown[] = [query, limit];
  let text = `
    select e.entity_type, e.entity_id, e.case_id, e.title, e.subtitle,
           ts_rank(e.search_vector, websearch_to_tsquery('swedish', $1)) as rank
    from search.entities e
    where (e.search_vector @@ websearch_to_tsquery('swedish', $1)
           or e.title ilike '%' || $1 || '%')`;

  if (request.entityTypes !== undefined && request.entityTypes.length > 0) {
    params.push(request.entityTypes);
    text += `\n      and e.entity_type = any($${params.length})`;
  }

  if (request.cursor != null && request.cursor !== '') {
    params.push(request.cursor);
    text += `\n      and e.id > $${params.length}`;
  }

  text += `\n    order by rank desc, e.id asc\n    limit $2`;

  return { text, params };
}
