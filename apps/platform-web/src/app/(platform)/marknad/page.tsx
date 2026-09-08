import { MarketingHome } from '@tryggsignal/marketing';

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'tryggsignal.se';

/**
 * Masterplan 157: the apex and `www` resolve to the MARKETING surface. It renders
 * the same component as `apps/marketing-web`, so whichever deployment serves the
 * public site, the content is identical.
 */
export default function MarketingSurface() {
  return <MarketingHome rootDomain={ROOT_DOMAIN} />;
}
