import { useState } from 'react';
import { money, useApi } from '../api.ts';
import { Badge, BarChart, Callout, Card, cx, Empty, Link, PageHeader, Spinner, Stat, Tabs } from '../ui.tsx';

export function Reports() {
  const [months, setMonths] = useState<'3' | '6' | '12'>('6');
  const r = useApi(`/api/reports/profit?months=${months}`);
  const status = useApi('/api/status');
  const currency = status.data?.ebay?.currency ?? 'USD';
  const d = r.data;
  const totals = (d?.months ?? []).reduce(
    (a: any, m: any) => ({ revenue: a.revenue + m.revenue, fees: a.fees + m.fees + m.otherFees, cost: a.cost + m.cost, net: a.net + m.net, units: a.units + m.units }),
    { revenue: 0, fees: 0, cost: 0, net: 0, units: 0 },
  );
  const estimated = (d?.months ?? []).some((m: any) => m.estimatedFees);
  return (
    <div>
      <PageHeader
        title="Profit reports"
        description="eBay sales after fees and cost of goods. Fees come from eBay's Finances API when available."
        actions={<Tabs value={months} onChange={setMonths} tabs={[{ value: '3', label: '3 months' }, { value: '6', label: '6 months' }, { value: '12', label: '12 months' }]} />}
      />
      {!d ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Revenue" value={money(totals.revenue, currency)} sub={`${totals.units} units`} />
            <Stat label="eBay fees" value={money(totals.fees, currency)} sub={totals.revenue ? `${((totals.fees / totals.revenue) * 100).toFixed(1)}% of revenue` : undefined} />
            <Stat label="Cost of goods" value={money(totals.cost, currency)} sub="From Shopify item cost" />
            <Stat label="Net profit" value={money(totals.net, currency)} tone={totals.net < 0 ? 'bad' : 'good'} />
            <Stat label="Margin" value={totals.revenue ? `${((totals.net / totals.revenue) * 100).toFixed(1)}%` : '—'} />
          </div>
          {estimated && <Callout kind="info">Some fees are estimates (from Settings, Pricing) because eBay hasn't reported the real fees yet. They update automatically.</Callout>}
          <Card title="Net profit by month">
            <BarChart data={d.months.map((m: any) => ({ label: m.month, value: Math.max(0, m.net) }))} format={(v) => money(v, currency)} height={180} />
          </Card>
          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <Card title="Products: best to worst" padded={false}>
              {d.products.length ? (
                <div className="scrollbar-thin max-h-[480px] overflow-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-white dark:bg-zinc-950">
                      <tr>
                        <th className="table-head">Product</th>
                        <th className="table-head text-right">Units</th>
                        <th className="table-head text-right">Revenue</th>
                        <th className="table-head text-right">Fees</th>
                        <th className="table-head text-right">Net</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
                      {d.products.map((p: any) => (
                        <tr key={p.sku}>
                          <td className="table-cell">
                            <div className="line-clamp-1 font-medium">{p.title ?? p.sku}</div>
                            <div className="font-mono text-xs text-zinc-500">{p.sku}</div>
                          </td>
                          <td className="table-cell text-right tabular-nums">{p.units}</td>
                          <td className="table-cell text-right tabular-nums">{money(p.revenue, currency)}</td>
                          <td className="table-cell text-right text-zinc-500 tabular-nums">{money(p.fees, currency)}</td>
                          <td className={cx('table-cell text-right font-medium tabular-nums', p.net < 0 && 'text-rose-500')}>{p.cost ? money(p.net, currency) : <Badge title="Add item cost in Shopify for profit">no cost</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No sales yet" description="eBay sales appear here once they come in." />
              )}
            </Card>
            <Card title="Stale listings" description="Live listings with no sales recently" padded={false}>
              {d.stale.length ? (
                <ul className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
                  {d.stale.map((s: any) => (
                    <li key={s.id} className="px-5 py-3">
                      <Link to={`/listings/${s.id}`} className="line-clamp-1 text-sm font-medium hover:underline">
                        {s.title}
                      </Link>
                      <p className="text-xs text-zinc-500">{s.last_sale_at ? `Last sale ${new Date(s.last_sale_at).toLocaleDateString()}` : `No sales since ${new Date(s.published_at).toLocaleDateString()}`}</p>
                    </li>
                  ))}
                  <li className="px-5 py-3 text-xs text-zinc-500">
                    Ideas: check the market panel, add missing item specifics or photos, enable Best Offer, or end the listing.
                  </li>
                </ul>
              ) : (
                <Empty title="Nothing stale" description="All live listings have sold recently." />
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
