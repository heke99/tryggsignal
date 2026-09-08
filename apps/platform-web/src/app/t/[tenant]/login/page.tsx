import { redirect } from 'next/navigation';
import { currentTenant } from '@/lib/tenant/context';
import { safeReturnTo } from '@tryggsignal/identity';
import {
  AuthNotConfiguredError,
  SignInRejectedError,
  issueSignInState,
  signInWithPassword,
  checkSignInState,
} from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Masterplan 178/183: sign-in is per tenant, on the tenant's own host, and the
 * form carries a signed state bound to this tenant and domain.
 */
export default async function TenantLogin({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}) {
  const tenant = await currentTenant();
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);

  let state: string | null = null;
  let configurationError: string | null = null;
  try {
    state = issueSignInState(tenant, returnTo);
  } catch (error) {
    configurationError =
      error instanceof AuthNotConfiguredError
        ? 'Inloggning är inte konfigurerad i den här miljön.'
        : 'Inloggning kunde inte förberedas.';
  }

  async function submit(formData: FormData): Promise<void> {
    'use server';
    const context = await currentTenant();
    const submittedState = String(formData.get('state') ?? '');
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');

    let target: string;
    try {
      target = checkSignInState(context, submittedState);
    } catch {
      redirect('/login?error=state');
    }

    try {
      await signInWithPassword(context, email, password);
    } catch (error) {
      if (error instanceof SignInRejectedError || error instanceof AuthNotConfiguredError) {
        redirect('/login?error=credentials');
      }
      throw error;
    }

    redirect(target);
  }

  return (
    <main id="innehall">
      <h1>Logga in</h1>
      <p className="meta">
        Inloggning sker mot {tenant.tenantSlug}s konfigurerade identitetsleverantör. Sessionen är
        bunden till {tenant.resolvedHostname} och följer inte med till någon annan kommun.
      </p>

      {params.error !== undefined && (
        <p role="alert" className="card">
          {params.error === 'state'
            ? 'Inloggningsförsöket kunde inte verifieras. Försök igen.'
            : 'Fel e-postadress eller lösenord.'}
        </p>
      )}

      {configurationError !== null ? (
        <p role="status" className="card">
          {configurationError}
        </p>
      ) : (
        <form action={submit} className="card">
          <input type="hidden" name="state" value={state ?? ''} />
          <p>
            <label htmlFor="email">E-postadress</label>
            <br />
            <input id="email" name="email" type="email" autoComplete="username" required />
          </p>
          <p>
            <label htmlFor="password">Lösenord</label>
            <br />
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </p>
          <button type="submit">Logga in</button>
        </form>
      )}
    </main>
  );
}
