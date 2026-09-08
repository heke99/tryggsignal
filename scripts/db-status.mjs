#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

for (const path of ['.env.local', '.env.development.local']) {
  if (existsSync(path)) {
    try {
      loadEnvFile(path);
    } catch {
      // Explicit process environment still takes precedence; a malformed local
      // file is reported by the missing-variable checks below.
    }
  }
}

function fail(message) {
  console.error(`db:status ERROR: ${message}`);
  process.exitCode = 1;
}

function envSecretName(reference) {
  return `TS_SECRET_${reference.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

const url = process.env.CONTROL_PLANE_SUPABASE_URL;
const reference = process.env.CONTROL_PLANE_SECRET_REFERENCE;

if (!url) {
  fail('CONTROL_PLANE_SUPABASE_URL is missing.');
} else if (!reference) {
  fail('CONTROL_PLANE_SECRET_REFERENCE is missing.');
} else {
  const secretName = envSecretName(reference);
  const credential = process.env[secretName];

  if (!credential) {
    fail(`${secretName} is missing for reference "${reference}".`);
  } else {
    const headers = {
      apikey: credential,
      'content-type': 'application/json',
    };
    if (credential.startsWith('eyJ')) {
      headers.authorization = `Bearer ${credential}`;
    }

    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/tryggsignal_db_status`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        fail(`control-plane status RPC returned HTTP ${response.status}.`);
      } else {
        const status = await response.json();
        console.log(JSON.stringify(status, null, 2));

        const queueValues = Object.values(status.queues ?? {});
        const rpcValues = Object.values(status.required_rpcs ?? {});

        if (status.ok !== true) fail('database did not report ok=true.');
        if (queueValues.length !== 10 || queueValues.some((value) => value !== true)) {
          fail('one or more required durable queues are unavailable.');
        }
        if (rpcValues.length === 0 || rpcValues.some((value) => value !== true)) {
          fail('one or more required runtime RPCs are unavailable.');
        }
        if (status.rls_unprotected_tables !== 0) {
          fail(`${status.rls_unprotected_tables} application table(s) do not have RLS enabled.`);
        }

        console.log(
          'db:status: Supabase security/performance advisors remain a platform-side gate; run them after schema changes.',
        );
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
