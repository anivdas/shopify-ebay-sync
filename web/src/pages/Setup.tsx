import { Check, ChevronRight, PartyPopper } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi } from '../api.ts';
import { Badge, Button, Callout, cx, Link, PageHeader, Spinner } from '../ui.tsx';
import { EbayConnectSection, EbayKeysSection, PoliciesSection, PricingSection, ShopifySection, SyncSection } from './sections.tsx';

const STEPS = [
  { key: 'shopify', title: 'Connect Shopify', blurb: 'Lets the app read your products and adjust stock when items sell on eBay.' },
  { key: 'ebayKeys', title: 'eBay developer keys', blurb: 'Free keys that let this app talk to eBay for you.' },
  { key: 'ebayConnect', title: 'Connect eBay account', blurb: 'Sign in to eBay and approve access for this app.' },
  { key: 'policies', title: 'Shipping & policies', blurb: 'Default shipping, payment and return policies, and where you ship from.' },
  { key: 'pricing', title: 'Pricing rules', blurb: 'How your eBay prices relate to Shopify, and how repricing works.' },
  { key: 'extras', title: 'Extras (optional)', blurb: 'Phone alerts, instant updates, and sold-price data.' },
];

export function Setup({ onChange }: { onChange: () => void }) {
  const status = useApi('/api/status');
  const [step, setStep] = useState<string | null>(null);
  const checklist = status.data?.checklist;
  const done = (key: string) => (key === 'extras' ? false : !!checklist?.steps.find((s: any) => s.key === key)?.done);

  useEffect(() => {
    if (!checklist || step) return;
    const qs = new URLSearchParams(location.search);
    if (qs.get('ebay') === 'connected') return setStep('policies');
    setStep(STEPS.find((s) => !done(s.key))?.key ?? 'extras');
  }, [checklist]);

  const refresh = () => {
    status.reload();
    onChange();
  };
  if (!checklist)
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );

  const idx = STEPS.findIndex((s) => s.key === step);
  const current = STEPS[idx];
  const next = () => setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)].key);

  return (
    <div>
      <PageHeader title="Setup" description="About 20 minutes from start to your first eBay listing. You can come back to any step later in Settings." />
      {checklist.complete && (
        <div className="mb-6">
          <Callout kind="success" title="You're all set!">
            Everything required is configured. Head to <Link to="/products" className="font-medium underline">Shopify products</Link> to list your first item on eBay.
          </Callout>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <ol className="space-y-1">
          {STEPS.map((s, i) => {
            const isDone = done(s.key);
            return (
              <li key={s.key}>
                <button
                  onClick={() => setStep(s.key)}
                  className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition', step === s.key ? 'bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-white/[0.06] dark:ring-white/10' : 'hover:bg-zinc-100 dark:hover:bg-white/[0.04]')}
                >
                  <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', isDone ? 'bg-emerald-500 text-white' : step === s.key ? 'bg-brand-500 text-white' : 'bg-zinc-200 text-zinc-600 dark:bg-white/10 dark:text-zinc-300')}>
                    {isDone ? <Check className="size-3.5" /> : i + 1}
                  </span>
                  <span className={cx('font-medium', !isDone && step !== s.key && 'text-zinc-500')}>{s.title}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <section className="card animate-in p-6" key={step}>
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium tracking-wide text-brand-600 uppercase dark:text-brand-400">Step {idx + 1} of {STEPS.length}</p>
              <h2 className="mt-1 text-lg font-semibold">{current?.title}</h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{current?.blurb}</p>
            </div>
            {done(current?.key ?? '') && <Badge color="green">Done</Badge>}
          </div>
          {step === 'shopify' && <ShopifySection onSaved={refresh} />}
          {step === 'ebayKeys' && <EbayKeysSection onSaved={refresh} />}
          {step === 'ebayConnect' && <EbayConnectSection onSaved={refresh} />}
          {step === 'policies' && <PoliciesSection onSaved={refresh} />}
          {step === 'pricing' && <PricingSection onSaved={refresh} />}
          {step === 'extras' && <Extras status={status.data} />}
          {step !== 'extras' && (
            <div className="mt-8 flex justify-end border-t border-zinc-100 pt-5 dark:border-white/[0.06]">
              <Button variant={done(current.key) ? 'primary' : 'ghost'} onClick={next}>
                {done(current.key) ? 'Continue' : 'Skip for now'} <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Extras({ status }: { status: any }) {
  const insights = status.ebay.test?.insightsAccess;
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          Sold-price data (last 6 weeks) {insights ? <Badge color="green">Enabled</Badge> : <Badge color="amber">Needs eBay approval</Badge>}
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Prices of active listings work out of the box. Prices of <b>sold</b> items come from eBay's <i>Marketplace Insights API</i>, which eBay only gives to approved apps. To request it, sign in at developer.ebay.com, open your app's keyset and request access to the Marketplace Insights API through the Application Growth Check. Once approved, click <b>Test</b> under Settings, Connections. The app picks it up automatically.
        </p>
      </div>
      <SyncSection />
      <div className="rounded-2xl bg-gradient-to-br from-emerald-500/10 to-brand-500/5 p-6 text-center ring-1 ring-emerald-500/20">
        <PartyPopper className="mx-auto size-8 text-emerald-500" />
        <h3 className="mt-2 font-semibold">Ready to list!</h3>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">Pick Shopify products and turn them into eBay listings in a few clicks.</p>
        <Link to="/products" className="btn-primary mt-4">
          Go to Shopify products
        </Link>
      </div>
    </div>
  );
}
