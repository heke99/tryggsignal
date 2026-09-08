import { currentTenant } from '@/lib/tenant/context';
import { requireTenantSession } from '@/lib/auth/guard';

export default async function MunicipalityAdminLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant();
  await requireTenantSession(tenant, '/kommunadmin');
  return children;
}
