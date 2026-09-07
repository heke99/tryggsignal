import { redirect } from 'next/navigation';

/**
 * Every real request is rewritten by the proxy to a platform surface or a tenant
 * route. Reaching `/` directly means host resolution did not happen.
 */
export default function RootPage() {
  redirect('/domain-not-found');
}
