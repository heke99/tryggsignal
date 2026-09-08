-- P36 hardening: Supabase may retain/directly grant EXECUTE to API roles even
-- when PUBLIC has been revoked. The branding control-plane RPCs are server-only,
-- so deny anon/authenticated explicitly and grant only service_role.

revoke execute on function public.resolve_tenant_branding(uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.list_tenant_branding_versions(uuid)
  from public, anon, authenticated;
revoke execute on function public.save_tenant_branding_draft(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text,
  boolean, text, boolean
) from public, anon, authenticated;
revoke execute on function public.register_branding_asset(
  uuid, uuid, text, text, text, text, integer, integer, bigint
) from public, anon, authenticated;
revoke execute on function public.discard_branding_asset(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.set_tenant_branding_asset(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.publish_tenant_branding(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.rollback_tenant_branding(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.resolve_tenant_branding(uuid, integer) to service_role;
grant execute on function public.list_tenant_branding_versions(uuid) to service_role;
grant execute on function public.save_tenant_branding_draft(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text,
  boolean, text, boolean
) to service_role;
grant execute on function public.register_branding_asset(
  uuid, uuid, text, text, text, text, integer, integer, bigint
) to service_role;
grant execute on function public.discard_branding_asset(uuid, uuid) to service_role;
grant execute on function public.set_tenant_branding_asset(uuid, uuid, text, uuid, uuid)
  to service_role;
grant execute on function public.publish_tenant_branding(uuid, uuid, uuid) to service_role;
grant execute on function public.rollback_tenant_branding(uuid, uuid) to service_role;
