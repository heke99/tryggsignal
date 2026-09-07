# Runbook — custom domain provisioning and rollback

Masterplan 166, 167, 168, 190, 191, 206.

## Preconditions

- The municipality tenant exists and is `ACTIVE` in `platform.tenants`.
- The municipality controls the domain and can create DNS records.
- The hostname is not in `platform.reserved_subdomains` and is not already present in
  `platform.tenant_domains` for another tenant.

## Steps

1. **Register** the domain: insert into `platform.tenant_domains` with `status = 'PENDING'`,
   `domain_type = 'CUSTOM_DOMAIN'`, `ownership_status = 'UNVERIFIED'`.
2. **Check takeover history**: query `platform.domain_release_history` for the hostname. If a
   previous tenant held it, require a documented approval before continuing.
3. **Add the domain to the Vercel project** and store `vercel_project_id` / `provider_domain_id`.
4. **Publish DNS instructions** to the municipality and set `status = 'AWAITING_DNS'`.
5. **Verify ownership**: when the provider reports verification, set `ownership_status = 'VERIFIED'`
   and `status = 'VERIFYING'`.
6. **Confirm DNS and TLS**: set `dns_status = 'OK'` and `tls_status = 'ISSUED'` from the provider's
   own status, never by assumption.
7. **Activate**: set `status = 'ACTIVE'`. The `domain_active_requires_verification` constraint rejects
   activation unless ownership, DNS and TLS all hold.
8. **Verify serving**: request the host and confirm it resolves to the correct tenant, that
   `/platform` is not reachable, that login works on the new host, and that no other tenant's data is
   reachable (see `tests/rls/authorization_matrix.sql` and the domain test matrix in masterplan 201).
9. **Make canonical** if agreed: set `is_canonical = true` (a partial unique index enforces one
   canonical domain per tenant) and update `platform.tenants.canonical_hostname`.

Each status change is written to `platform.domain_events` by trigger.

## Rollback

1. Set `status = 'DISABLED'` on the custom domain. The platform subdomain
   `<kommun>.tryggsignal.se` keeps serving, so the municipality is never dark.
2. If the domain is canonical, move `is_canonical` back to the platform subdomain **before**
   disabling, and update `platform.tenants.canonical_hostname` in the same transaction.
3. Record the reason in `platform.domain_events`; on permanent removal also insert into
   `platform.domain_release_history` so the hostname cannot be silently taken over.
