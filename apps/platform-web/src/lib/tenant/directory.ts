import { createClient } from '@supabase/supabase-js';
import { ControlPlaneTenantDirectory } from '@tryggsignal/database';
import type { TenantDirectory, TenantDomainRecord, TenantRecord } from '@tryggsignal/tenancy';

/**
 * Masterplan 185: tenant routing must not add a database round trip to every
 * request. Resolved domains are cached briefly in the running instance, keyed by
 * the verified hostname, and negative results are cached for a shorter time so a
 * newly activated domain becomes reachable quickly.
 */
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 5_000;

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

class CachedDirectory implements TenantDirectory {
  private readonly domains = new Map<string, CacheEntry<TenantDomainRecord | null>>();
  private readonly tenants = new Map<string, CacheEntry<TenantRecord | null>>();

  constructor(private readonly inner: TenantDirectory) {}

  private static read<T>(
    store: Map<string, CacheEntry<T>>,
    key: string,
  ): CacheEntry<T> | undefined {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  private static write<T>(store: Map<string, CacheEntry<T>>, key: string, value: T): T {
    store.set(key, {
      value,
      expiresAt: Date.now() + (value === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS),
    });
    return value;
  }

  async findDomain(normalizedHostname: string): Promise<TenantDomainRecord | null> {
    const cached = CachedDirectory.read(this.domains, normalizedHostname);
    if (cached !== undefined) return cached.value;
    return CachedDirectory.write(
      this.domains,
      normalizedHostname,
      await this.inner.findDomain(normalizedHostname),
    );
  }

  async findTenant(tenantId: string): Promise<TenantRecord | null> {
    const cached = CachedDirectory.read(this.tenants, tenantId);
    if (cached !== undefined) return cached.value;
    return CachedDirectory.write(this.tenants, tenantId, await this.inner.findTenant(tenantId));
  }
}

/** Directory used until the control plane is configured for this environment. */
const emptyDirectory: TenantDirectory = {
  async findDomain() {
    return null;
  },
  async findTenant() {
    return null;
  },
};

let cached: TenantDirectory | undefined;

export function tenantDirectory(): TenantDirectory {
  if (cached !== undefined) return cached;

  const url = process.env.CONTROL_PLANE_SUPABASE_URL;
  const key = process.env.CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY;

  if (url === undefined || key === undefined) {
    // No control plane configured (local build, preview without secrets): resolve
    // nothing rather than falling back to a default tenant.
    cached = emptyDirectory;
    return cached;
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cached = new CachedDirectory(new ControlPlaneTenantDirectory(client));
  return cached;
}
