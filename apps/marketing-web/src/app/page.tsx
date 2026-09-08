import { MarketingHome } from '@tryggsignal/marketing';

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'tryggsignal.se';

export default function Home() {
  return <MarketingHome rootDomain={ROOT_DOMAIN} />;
}
