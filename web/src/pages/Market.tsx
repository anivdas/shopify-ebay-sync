import { ExternalLink, Info } from 'lucide-react';
import { ago, money, pct, useApi } from '../api.ts';
import { Badge, Callout, LineChart, Spinner } from '../ui.tsx';

export const POSITION: Record<string, { label: string; color: 'green' | 'amber' | 'blue' | 'gray'; tip: string }> = {
  in_range: { label: 'Competitive', color: 'green', tip: 'You undercut the cheapest identical new listing while staying in your markup range.' },
  market_below_floor: { label: 'Market below floor', color: 'amber', tip: 'Competitors sell for less than your minimum markup allows. You stay at your floor price.' },
  market_above_ceiling: { label: 'Cheapest on eBay', color: 'blue', tip: 'Competitors are above your maximum markup. You are priced at your ceiling and are the cheapest.' },
  no_data: { label: 'No comps', color: 'gray', tip: 'No identical brand-new listings found. Using the middle of your range.' },
};

/** Compact "suggestion" cell for tables. */
export function SuggestionCell({ market, currency, currentPrice }: { market: any; currency: string; currentPrice?: number | null }) {
  if (!market) return <span className="text-xs text-zinc-400">Not researched yet</span>;
  const pos = POSITION[market.position] ?? POSITION.no_data;
  const diff = currentPrice && market.recommended_price ? market.recommended_price - currentPrice : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="font-semibold tabular-nums">{money(market.recommended_price, currency)}</span>
        <span className="text-xs text-zinc-500">{pct(market.recommended_pct)}</span>
        {Math.abs(diff) >= 0.01 && <span className={diff > 0 ? 'text-xs text-emerald-600' : 'text-xs text-rose-600'}>{diff > 0 ? '▲' : '▼'}</span>}
      </div>
      <Badge color={pos.color} title={pos.tip}>
        {pos.label}
      </Badge>
      <div className="text-[11px] leading-tight text-zinc-500">
        Low {money(market.active_min, currency)} · {market.active_count} active
        <br />
        {market.sold_available ? (
          <>
            Sold 6w: {market.sold_count ? `${money(market.sold_median, currency)} median (${market.sold_qty} sold)` : 'none'}
          </>
        ) : (
          <span title="Sold data needs eBay Marketplace Insights approval">Sold data: not available</span>
        )}
      </div>
    </div>
  );
}

export function MarketDetails({ variantId, currency }: { variantId: string; currency: string }) {
  const { data, loading } = useApi(`/api/market/${encodeURIComponent(variantId)}`);
  if (loading && !data)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  const m = data?.latest;
  if (!m) return <p className="text-sm text-zinc-500">No research yet. Click "Research now".</p>;
  const pos = POSITION[m.position] ?? POSITION.no_data;
  const history = data.history as any[];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <Badge color={pos.color}>{pos.label}</Badge>
        <span>Researched {ago(m.taken_at)}</span>·<span>{m.match_type === 'gtin' ? `Exact barcode match (${m.query})` : `Title match: "${m.query}"`}</span>
      </div>
      {m.match_type !== 'gtin' && (
        <Callout kind="info">
          Without a UPC/EAN barcode in Shopify, matching uses the title, brand and model numbers. Check that the comps below really are the same product.
        </Callout>
      )}
      <p className="text-sm">{m.reason}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Suggested price', `${money(m.recommended_price, currency)} (${pct(m.recommended_pct)})`],
          ['Lowest active (new)', money(m.active_min, currency)],
          ['Median active', money(m.active_median, currency)],
          ['Median sold (6 wks)', m.sold_available ? money(m.sold_median, currency) : 'n/a'],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl bg-zinc-50 p-3 dark:bg-white/[0.04]">
            <div className="text-[11px] text-zinc-500">{k}</div>
            <div className="mt-0.5 font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      {!m.sold_available && (
        <p className="flex items-start gap-1.5 text-xs text-zinc-500">
          <Info className="mt-0.5 size-3.5 shrink-0" /> Sold-item prices need eBay Marketplace Insights API approval (see Setup, Extras).
        </p>
      )}
      <div>
        <h4 className="label">Price history</h4>
        <LineChart
          series={[
            { name: 'Lowest active', color: '#f59e0b', points: history.map((h) => h.active_min) },
            { name: 'Median sold', color: '#10b981', points: history.map((h) => h.sold_median) },
            { name: 'Suggested', color: '#6366f1', points: history.map((h) => h.recommended_price) },
            { name: 'Shopify price', color: '#a1a1aa', points: history.map((h) => h.base_price) },
          ]}
        />
      </div>
      <div>
        <h4 className="label">Comparable listings</h4>
        <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-100 dark:divide-white/[0.05] dark:border-white/[0.06]">
          {(m.comps as any[]).map((c) => (
            <li key={`${c.type}-${c.itemId}`} className="flex items-center gap-3 px-3 py-2">
              <Badge color={c.type === 'sold' ? 'green' : 'gray'}>{c.type === 'sold' ? 'Sold' : 'Active'}</Badge>
              <a href={c.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm hover:underline">
                {c.title}
              </a>
              <span className="text-xs text-zinc-500">{c.type === 'sold' ? ago(c.lastSoldDate) : c.seller}</span>
              <span className="w-24 text-right text-sm font-medium tabular-nums">
                {money(c.type === 'sold' ? c.price : c.total, currency)}
                {c.type === 'active' && c.shipping > 0 && <span className="block text-[10px] font-normal text-zinc-500">incl. {money(c.shipping, currency)} ship</span>}
              </span>
              <ExternalLink className="size-3.5 shrink-0 text-zinc-400" />
            </li>
          ))}
          {!m.comps.length && <li className="px-3 py-4 text-center text-sm text-zinc-500">No identical brand-new listings found.</li>}
        </ul>
      </div>
    </div>
  );
}
