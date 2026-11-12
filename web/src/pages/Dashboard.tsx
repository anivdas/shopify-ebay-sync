import { AlertTriangle, ArrowRight, Boxes, CircleDollarSign, Clock, Gauge, Hourglass, Play, ShieldAlert, TrendingDown } from 'lucide-react';
import { ago, money, post } from '../api.ts';
import { Badge, BarChart, Button, Callout, Card, cx, Empty, Link, PageHeader, Spinner, Stat, useAction, useRouter } from '../ui.tsx';

const LEVEL: Record<string, { label: string; color: 'green' | 'blue' | 'red' | 'gray' }> = {
  TOP_RATED: { label: 'Top Rated', color: 'green' },
  ABOVE_STANDARD: { label: 'Above Standard', color: 'blue' },
  BELOW_STANDARD: { label: 'Below Standard', color: 'red' },
};

export function Dashboard({ status }: { status: { data: any; loading: boolean; reload: () => void } }) {
  const { navigate } = useRouter();
  const { busy, run } = useAction();
  const d = status.data;
  if (!d)
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );
  const currency = d.ebay.currency;
  const live = (d.counts.published ?? 0) + (d.counts.out_of_stock ?? 0);
  const days = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(Date.now() - (29 - i) * 86400_000).toISOString().slice(0, 10);
    const row = d.salesByDay.find((r: any) => r.day === day);
    return { label: new Date(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), value: row?.revenue ?? 0 };
  });
  const standards = d.standards;

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description={d.shopify.test?.shop ? `${d.shopify.test.shop} ⇄ eBay${d.ebay.test?.username ? ` (${d.ebay.test.username})` : ''}` : 'Overview of your Shopify ⇄ eBay sync'} />

      {!d.checklist.complete && (
        <div className="card relative overflow-hidden p-6">
          <div className="pointer-events-none absolute -top-20 -right-20 size-64 rounded-full bg-brand-500/20 blur-3xl" />
          <h2 className="text-lg font-semibold">Let's get you set up</h2>
          <p className="mt-1 max-w-xl text-sm text-zinc-500 dark:text-zinc-400">Connect Shopify and eBay, choose your shipping policies and confirm your pricing rules. It takes about 20 minutes.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {d.checklist.steps
              .filter((s: any) => !s.optional)
              .map((s: any) => (
                <Badge key={s.key} color={s.done ? 'green' : 'gray'}>
                  {s.done ? '✓' : '○'} {s.title}
                </Badge>
              ))}
          </div>
          <Link to="/setup" className="btn-primary mt-5">
            Continue setup <ArrowRight className="size-4" />
          </Link>
        </div>
      )}
      {d.checklist.warnings.map((w: string) => (
        <Callout key={w} kind="warn">
          {w}
        </Callout>
      ))}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Live on eBay" value={live} sub={`${d.counts.out_of_stock ?? 0} out of stock · ${d.counts.draft ?? 0} drafts`} icon={<Boxes className="size-4" />} onClick={() => navigate('/listings')} />
        <Stat label="Sales (30 days)" value={money(d.sales30.revenue, currency)} sub={`${d.sales30.units} units`} icon={<CircleDollarSign className="size-4" />} onClick={() => navigate('/reports')} />
        <Stat label="Held for review" value={d.held} sub="Large price changes" tone={d.held ? 'warn' : 'default'} icon={<ShieldAlert className="size-4" />} onClick={() => navigate('/listings?filter=held')} />
        <Stat label="Market below floor" value={d.belowFloor} sub="Competitors cheaper than +min%" tone={d.belowFloor ? 'warn' : 'default'} icon={<TrendingDown className="size-4" />} onClick={() => navigate('/listings?filter=below')} />
        <Stat label="Stale listings" value={d.stale} sub="No recent sales" tone={d.stale ? 'warn' : 'default'} icon={<Hourglass className="size-4" />} onClick={() => navigate('/listings?filter=stale')} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="eBay revenue" description="Last 30 days" className="lg:col-span-2">
          <BarChart data={days} format={(v) => money(v, currency)} height={170} />
        </Card>
        <Card title="Seller standards" description={standards?.at ? `Checked ${ago(standards.at)}` : 'From eBay Analytics'}>
          {standards?.current ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Gauge className="size-8 text-brand-500" />
                <div>
                  <Badge color={LEVEL[standards.current]?.color ?? 'gray'}>{LEVEL[standards.current]?.label ?? standards.current}</Badge>
                  <p className="mt-1 text-xs text-zinc-500">
                    Projected: <b>{LEVEL[standards.projected]?.label ?? standards.projected ?? 'n/a'}</b>
                  </p>
                </div>
              </div>
              {standards.weak?.length ? (
                <Callout kind="warn" title="Metrics to watch">
                  {standards.weak.join(', ')}
                </Callout>
              ) : (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">All metrics are on track.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Shows up after the first check, once eBay is connected.</p>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Recent alerts" actions={<Link to="/activity" className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">View all</Link>} padded={false}>
          {d.alerts.length ? (
            <ul className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {d.alerts.map((a: any) => (
                <li key={a.id} className="flex gap-3 px-5 py-3">
                  <AlertTriangle className={cx('mt-0.5 size-4 shrink-0', a.level === 'error' ? 'text-rose-500' : 'text-amber-500')} />
                  <div className="min-w-0">
                    <p className="text-sm">{a.message}</p>
                    <p className="text-xs text-zinc-500">{ago(a.ts)}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No alerts" description="Warnings about stock, prices and errors show up here." />
          )}
        </Card>
        <Card title="Background jobs" description="Runs automatically on the schedule set in Settings" padded={false}>
          <ul className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
            {d.jobs.map((j: any) => (
              <li key={j.name} className="flex items-center gap-3 px-5 py-2.5">
                <span className={cx('size-2 shrink-0 rounded-full', j.running ? 'animate-pulse bg-brand-500' : j.ok === false ? 'bg-rose-500' : j.ok ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600')} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{j.label}</p>
                  <p className="truncate text-xs text-zinc-500" title={j.error ?? j.summary ?? ''}>
                    {j.running ? 'Running...' : j.error ? `Failed: ${j.error}` : j.summary ? `${j.summary} · ${ago(j.lastEnd)}` : 'Not run yet'}
                  </p>
                </div>
                <span className="hidden items-center gap-1 text-xs text-zinc-400 sm:flex">
                  <Clock className="size-3" /> {j.next ? ago(j.next) : 'soon'}
                </span>
                <Button
                  variant="ghost"
                  className="p-1.5"
                  title="Run now"
                  loading={busy === j.name}
                  onClick={() => run(j.name, () => post(`/api/jobs/${j.name}/run`).then(() => setTimeout(status.reload, 1500)), `${j.label} started`)}
                >
                  {busy !== j.name && <Play className="size-3.5" />}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
