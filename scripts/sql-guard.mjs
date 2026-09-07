#!/usr/bin/env node
// Masterplan 138/139: "DISABLE ROW LEVEL SECURITY" is never an acceptable fix,
// and no privileged credential may be committed to the repository.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
const forbidden = [
  { pattern: /disable\s+row\s+level\s+security/i, reason: 'RLS may never be disabled' },
  { pattern: /service_role_key\s*=\s*['"]ey/i, reason: 'service-role key literal' },
  { pattern: /\bTO\s+public\b/i, reason: 'grants to PUBLIC are forbidden' },
];

let failures = 0;
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  for (const { pattern, reason } of forbidden) {
    if (pattern.test(sql)) {
      console.error(`FAIL ${file}: ${reason}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`sql-guard: ${failures} violation(s)`);
  process.exit(1);
}
console.log('sql-guard: OK');
