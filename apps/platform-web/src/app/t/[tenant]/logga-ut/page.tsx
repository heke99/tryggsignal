import { redirect } from 'next/navigation';
import { currentTenant } from '@/lib/tenant/context';
import { signOut } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function SignOut() {
  async function submit(): Promise<void> {
    'use server';
    const context = await currentTenant();
    await signOut(context);
    redirect('/login');
  }

  const tenant = await currentTenant();

  return (
    <main id="innehall">
      <h1>Logga ut</h1>
      <p className="meta">Sessionen för {tenant.resolvedHostname} avslutas.</p>
      <form action={submit} className="card">
        <button type="submit">Logga ut</button>
      </form>
    </main>
  );
}
