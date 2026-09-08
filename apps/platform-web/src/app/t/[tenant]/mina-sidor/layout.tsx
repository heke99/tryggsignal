import { currentTenant } from '@/lib/tenant/context';
import { requireTenantUserType } from '@/lib/auth/guard';

export default async function CitizenPortalLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant();
  await requireTenantUserType(tenant, 'EXTERNAL', '/mina-sidor');
  return children;
}
