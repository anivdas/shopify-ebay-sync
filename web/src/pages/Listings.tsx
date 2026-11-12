import { Boxes, Check, ExternalLink, Hourglass, Layers, RefreshCw, Search, ShieldAlert, Sparkles, Wand2 } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { money, pct, post, useApi } from '../api.ts';
import { Badge, Button, Card, cx, Empty, Link, PageHeader, Spinner, StatusBadge, Tabs, useAction, useConfirm, useRouter } from '../ui.tsx';
import { SuggestionCell } from './Market.tsx';

type Filter = 'all' | 'published' | 'out_of_stock' | 'draft' | 'error' | 'ended' | 'held' | 'below' | 'stale';

export function Listings() {
  const { navigate } = useRouter();
  const initial = (new URLSearchParams(location.search).get('filter') as Filter) || 'all';
  const [filter, setFilter] = useState<Filter>(initial);
  const [q, setQ] = useState('');
  const list = useApi('/api/listings', { refreshMs: 60_000 });
  const status = useApi('/api/status');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const currency = status.data?.ebay?.currency ?? 'USD';
  const all = (list.data?.listings ?? []) as any[];

  const rows = useMemo(() => {
    const term = q.toLowerCase();
    return all.filter((l) => {
      if (term && !`${l.title} ${l.product_title} ${l.items.map((i: any) => i.sku).join(' ')}`.toLowerCase().includes(term)) return false;
      if (filter === 'all') return true;
      if (filter === 'held') return l.items.some((i: any) => i.held_price);
      if (filter === 'below') return l.items.some((i: any) => i.market?.position === 'market_below_floor');
      if (filter === 'stale') return l.stale;
      return l.status === filter;
    });
  }, [all, filter, q]);

  const count = (f: (l: any) => boolean) => all.filter(f).length;
  const bulk = async (action: string, label: string) => {
    const ids = [...sel];
    if (['end', 'delete'].includes(action) && !(await confirm({ title: `${label} ${ids.length} listing(s)?`, body: action === 'end' ? 'They will be removed from eBay. You can republish later.' : 'They will be removed from this app.', confirm: label, danger: true }))) return;
    await run(
      action,
      async () => {
        const r = await post('/api/listings/bulk-action', { ids, action });
        list.reload();
        const failed = r.results.filter((x: any) => !x.ok);
        if (failed.length) throw new Error(`${ids.length - failed.length} done, ${failed.length} failed: ${failed[0].error}`);
        setSel(new Set());
      },
      `${label}: done`,
    );
  };

  return (
    <div>
      <PageHeader
        title="eBay listings"
        description="Prices stay within your markup range and stock follows Shopify automatically."
        actions={
          <Button onClick={() => navigate('/products')} variant="primary">
            <Sparkles className="size-4" /> New listing
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setSel(new Set());
          }}
          tabs={[
            { value: 'all', label: 'All', count: all.length },
            { value: 'published', label: 'Live', count: count((l) => l.status === 'published') },
            { value: 'out_of_stock', label: 'Out of stock', count: count((l) => l.status === 'out_of_stock') },
            { value: 'draft', label: 'Drafts', count: count((l) => l.status === 'draft') },
            { value: 'error', label: 'Errors', count: count((l) => l.status === 'error') },
            { value: 'ended', label: 'Ended', count: count((l) => l.status === 'ended') },
            { value: 'held', label: <span className="flex items-center gap-1"><ShieldAlert className="size-3.5" />Held</span>, count: count((l) => l.items.some((i: any) => i.held_price)) },
            { value: 'below', label: 'Below floor', count: count((l) => l.items.some((i: any) => i.market?.position === 'market_below_floor')) },
            { value: 'stale', label: <span className="flex items-center gap-1"><Hourglass className="size-3.5" />Stale</span>, count: count((l) => l.stale) },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <input className="input pl-9" placeholder="Search title or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {sel.size > 0 && (
        <div className="card animate-in sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-2 px-4 py-2.5 shadow-lg dark:bg-zinc-900">
          <span className="mr-2 text-sm font-medium">{sel.size} selected</span>
          <Button loading={busy === 'publish'} onClick={() => bulk('publish', 'Publish / update')}>Publish / update</Button>
          <Button loading={busy === 'research'} onClick={() => bulk('research', 'Research prices')}>Research prices</Button>
          <Button loading={busy === 'apply-suggestions'} onClick={() => bulk('apply-suggestions', 'Apply suggestions')}>Apply suggestions</Button>
          <Button loading={busy === 'refresh'} onClick={() => bulk('refresh', 'Refresh from Shopify')}>Refresh from Shopify</Button>
          <Button loading={busy === 'end'} onClick={() => bulk('end', 'End')}>End on eBay</Button>
          <Button variant="ghost" loading={busy === 'delete'} onClick={() => bulk('delete', 'Delete')}>Delete</Button>
          <Button variant="ghost" className="ml-auto" onClick={() => setSel(new Set())}>Clear</Button>
        </div>
      )}

      <Card padded={false}>
        {list.loading && !list.data ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <Empty icon={<Boxes className="size-6" />} title={all.length ? 'Nothing matches this filter' : 'No eBay listings yet'} description={all.length ? undefined : 'Pick Shopify products to create your first eBay listing.'} action={!all.length && <Button variant="primary" onClick={() => navigate('/products')}>Browse Shopify products</Button>} />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[1100px]">
              <thead className="border-b border-zinc-100 dark:border-white/[0.06]">
                <tr>
                  <th className="table-head w-10">
                    <input type="checkbox" className="size-4 accent-brand-500" checked={sel.size === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                  </th>
                  <th className="table-head">Listing</th>
                  <th className="table-head">Shopify</th>
                  <th className="table-head">eBay price</th>
                  <th className="table-head">Stock</th>
                  <th className="table-head">Est. profit</th>
                  <th className="table-head min-w-[220px]">Suggestion</th>
                  <th className="table-head" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
                {rows.map((l) => (
                  <Fragment key={l.id}>
                    {l.items.map((i: any, idx: number) => (
                      <ItemRow key={i.id} l={l} i={i} first={idx === 0} span={l.items.length} selected={sel.has(l.id)} currency={currency} onSelect={(v) => setSel((s) => { const n = new Set(s); v ? n.add(l.id) : n.delete(l.id); return n; })} onChanged={list.reload} />
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function ItemRow({ l, i, first, span, selected, currency, onSelect, onChanged }: { l: any; i: any; first: boolean; span: number; selected: boolean; currency: string; onSelect: (v: boolean) => void; onChanged: () => void }) {
  const { busy, run } = useAction();
  const price = i.ebay_price ?? i.target_price;
  const suggestionDiffers = i.market?.recommended_price && Math.abs(i.market.recommended_price - (i.target_price ?? 0)) >= 0.01;
  return (
    <tr className={cx('align-top transition hover:bg-zinc-50/80 dark:hover:bg-white/[0.02]', selected && 'bg-brand-500/[0.04]', !first && 'border-t-0')}>
      {first && (
        <>
          <td className="table-cell" rowSpan={span}>
            <input type="checkbox" className="size-4 accent-brand-500" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
          </td>
          <td className="table-cell max-w-[320px]" rowSpan={span}>
            <Link to={`/listings/${l.id}`} className="group flex gap-3">
              {l.image_urls[0] ? <img src={`${l.image_urls[0]}${l.image_urls[0].includes('?') ? '&' : '?'}width=96`} className="size-12 shrink-0 rounded-lg object-cover ring-1 ring-zinc-200 dark:ring-white/10" alt="" /> : <div className="size-12 shrink-0 rounded-lg bg-zinc-100 dark:bg-white/5" />}
              <div className="min-w-0">
                <p className="line-clamp-2 text-sm font-medium group-hover:text-brand-600 dark:group-hover:text-brand-400">{l.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={l.status} />
                  {l.kind === 'group' && (
                    <Badge color="violet">
                      <Layers className="size-3" /> {span} variations
                    </Badge>
                  )}
                  {l.stale && <Badge color="amber">Stale</Badge>}
                  {l.best_offer_enabled && <Badge color="blue">Best Offer</Badge>}
                </div>
                {l.last_error && <p className="mt-1 line-clamp-2 text-xs text-rose-500">{l.last_error}</p>}
              </div>
            </Link>
          </td>
        </>
      )}
      <td className="table-cell">
        <div className="tabular-nums">{money(i.shopify_price, currency)}</div>
        <div className="text-xs text-zinc-500">{l.kind === 'group' ? Object.values(i.options).join(' / ') : i.sku}</div>
      </td>
      <td className="table-cell">
        <div className="font-medium tabular-nums">{money(price, currency)}</div>
        <div className="text-xs text-zinc-500">
          {pct(i.current_pct)}
          {i.price_locked && ' · manual'}
        </div>
        {i.held_price && (
          <div className="mt-1 rounded-lg bg-amber-500/10 p-1.5 text-[11px] text-amber-700 dark:text-amber-300" title={i.held_reason}>
            Held: {money(i.held_price, currency)}
            <button className="ml-1 font-semibold underline" disabled={busy === 'approve'} onClick={() => run('approve', () => post(`/api/items/${i.id}/approve-price`).then(onChanged), 'Approved, pushing to eBay')}>
              Approve
            </button>
          </div>
        )}
      </td>
      <td className="table-cell tabular-nums">
        <div>
          {i.ebay_qty ?? i.target_qty} <span className="text-xs text-zinc-500">on eBay</span>
        </div>
        <div className="text-xs text-zinc-500">{i.inventory_tracked ? `${i.shopify_qty ?? 0} in Shopify` : 'not tracked'}</div>
        {i.sold_30d > 0 && <div className="text-xs text-emerald-600">{i.sold_30d} sold / 30d</div>}
      </td>
      <td className="table-cell">
        {i.profit ? (
          <>
            <div className={cx('font-medium tabular-nums', i.profit.net < 0 && 'text-rose-500')}>{i.profit.hasCost ? money(i.profit.net, currency) : '—'}</div>
            <div className="text-xs text-zinc-500" title={i.fee_source === 'actual' ? 'Based on real eBay fees' : 'Estimated fees'}>
              {i.profit.hasCost ? `${i.profit.margin}% margin` : 'add cost in Shopify'}
              {i.fee_source === 'actual' ? ' · real fees' : ''}
            </div>
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="table-cell">
        <SuggestionCell market={i.market} currency={currency} currentPrice={i.target_price} />
        {suggestionDiffers && (
          <Button variant="ghost" className="mt-1 -ml-2 px-2 py-1 text-xs" loading={busy === 'apply'} onClick={() => run('apply', () => post(`/api/items/${i.id}/apply-suggestion`).then(onChanged), 'Suggestion applied')}>
            <Wand2 className="size-3.5" /> Apply
          </Button>
        )}
      </td>
      <td className="table-cell text-right">
        {first && (
          <div className="flex justify-end gap-1">
            <Button variant="ghost" className="p-1.5" title="Research now" loading={busy === 'research'} onClick={() => run('research', () => post(`/api/listings/${l.id}/research`).then(onChanged), 'Research complete')}>
              {busy !== 'research' && <RefreshCw className="size-3.5" />}
            </Button>
            {l.ebay_url && (
              <a href={l.ebay_url} target="_blank" rel="noreferrer" className="btn-ghost p-1.5" title="View on eBay">
                <ExternalLink className="size-3.5" />
              </a>
            )}
            {l.status === 'draft' && (
              <Link to={`/listings/${l.id}`} className="btn-secondary px-2.5 py-1 text-xs">
                <Check className="size-3.5" /> Review
              </Link>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
