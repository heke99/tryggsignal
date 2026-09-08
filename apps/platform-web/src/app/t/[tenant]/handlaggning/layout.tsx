import { currentTenant } from '@/lib/tenant/context';
import { requireTenantUserType } from '@/lib/auth/guard';

export default async function CaseworkerLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant();
  await requireTenantUserType(tenant, 'STAFF', '/handlaggning');
  return children;
}
