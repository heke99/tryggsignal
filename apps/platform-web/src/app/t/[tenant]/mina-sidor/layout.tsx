import { currentTenant } from '@/lib/tenant/context';
import { requireTenantSession } from '@/lib/auth/guard';

export default async function CitizenPortalLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant();
  await requireTenantSession(tenant, '/mina-sidor');
  return children;
}
