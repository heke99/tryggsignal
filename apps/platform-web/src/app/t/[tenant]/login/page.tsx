import { redirect } from 'next/navigation';
import { currentTenant } from '@/lib/tenant/context';
import { safeReturnTo } from '@tryggsignal/identity';
import {
  AuthNotConfiguredError,
  RateLimitRejectedError,
  SignInRejectedError,
  issueSignInState,
  signInWithPassword,
  checkSignInState,
} from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

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
      if (error instanceof RateLimitRejectedError) {
        redirect('/login?error=rate-limit');
      }
      if (error instanceof SignInRejectedError) {
        redirect('/login?error=credentials');
      }
      if (error instanceof AuthNotConfiguredError) {
        redirect('/login?error=configuration');
      }
      throw error;
    }

    redirect(target);
  }

  const errorText =
    params.error === 'state'
      ? 'Inloggningsförsöket kunde inte verifieras. Försök igen.'
      : params.error === 'rate-limit'
        ? 'För många inloggningsförsök. Försök igen om en stund.'
        : params.error === 'configuration'
          ? 'Kommunens inloggning är inte färdigkonfigurerad.'
          : params.error === 'credentials'
            ? 'Fel e-postadress eller lösenord.'
            : null;

  return (
    <main id="innehall">
      <h1>Logga in</h1>
      <p className="meta">
        Inloggning sker mot {tenant.tenantSlug}s konfigurerade identitetsleverantör. Sessionen är
        bunden till {tenant.resolvedHostname} och följer inte med till någon annan kommun.
      </p>

      {errorText !== null && (
        <p role="alert" className="card">
          {errorText}
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
