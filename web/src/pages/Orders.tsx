import { Receipt } from 'lucide-react';
import { ago, money, useApi } from '../api.ts';
import { Badge, Card, Empty, PageHeader, Spinner } from '../ui.tsx';

const S: Record<string, { label: string; color: 'green' | 'amber' | 'red' | 'gray' | 'blue' }> = {
  applied: { label: 'Stock reduced', color: 'green' },
  restocked: { label: 'Cancelled · restocked', color: 'blue' },
  cancelled: { label: 'Cancelled', color: 'gray' },
  unmatched: { label: 'No match', color: 'amber' },
  error: { label: 'Retrying', color: 'red' },
  dry_run: { label: 'Dry run', color: 'gray' },
};

export function Orders() {
  const q = useApi('/api/orders', { refreshMs: 60_000 });
  const status = useApi('/api/status');
  const currency = status.data?.ebay?.currency ?? 'USD';
  const orders = (q.data?.orders ?? []) as any[];
  return (
    <div>
      <PageHeader title="eBay sales" description="Every eBay sale and what the app did in Shopify. Fulfil the orders in eBay Seller Hub as usual." />
      <Card padded={false}>
        {q.loading && !q.data ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !orders.length ? (
          <Empty icon={<Receipt className="size-6" />} title="No eBay sales yet" description="New eBay orders are checked every few minutes. Orders placed before the app was connected are ignored." />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead className="border-b border-zinc-100 dark:border-white/[0.06]">
                <tr>
                  <th className="table-head">When</th>
                  <th className="table-head">Item</th>
                  <th className="table-head text-right">Qty</th>
                  <th className="table-head text-right">Total</th>
                  <th className="table-head">Shopify</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
                {orders.map((o) => (
                  <tr key={`${o.order_id}-${o.line_item_id}`}>
                    <td className="table-cell text-xs whitespace-nowrap text-zinc-500" title={o.ordered_at}>
                      {ago(o.ordered_at)}
                      <div className="font-mono">{o.order_id}</div>
                    </td>
                    <td className="table-cell">
                      <div className="line-clamp-1 font-medium">{o.title}</div>
                      <div className="font-mono text-xs text-zinc-500">{o.sku ?? 'no SKU'}</div>
                    </td>
                    <td className="table-cell text-right tabular-nums">{o.quantity}</td>
                    <td className="table-cell text-right tabular-nums">{money(o.total, currency)}</td>
                    <td className="table-cell">
                      <Badge color={S[o.status]?.color ?? 'gray'}>{S[o.status]?.label ?? o.status}</Badge>
                      {o.message && <div className="mt-1 text-xs text-zinc-500">{o.message.replace(/^\[\d+\]\s*/, '')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
