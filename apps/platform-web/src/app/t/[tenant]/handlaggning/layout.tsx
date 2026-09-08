import { currentTenant } from '@/lib/tenant/context';
import { requireTenantSession } from '@/lib/auth/guard';

export default async function CaseworkerLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant();
  await requireTenantSession(tenant, '/handlaggning');
  return children;
}
