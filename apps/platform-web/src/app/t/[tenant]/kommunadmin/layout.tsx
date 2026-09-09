import { currentTenant } from '@/lib/tenant/context';
import { requireTenantUserType } from '@/lib/auth/guard';

export default async function MunicipalityAdminLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant();
  await requireTenantUserType(tenant, 'STAFF', '/kommunadmin');
  return children;
}
