import { Barcode, CheckCircle2, ScanLine, Search, Stethoscope, Undo2, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ago, post, useApi } from '../api.ts';
import { Badge, Button, Callout, Card, cx, Empty, Modal, PageHeader, Spinner, useAction, useConfirm } from '../ui.tsx';

const SEV_COLOR = { high: 'red', medium: 'amber', low: 'gray' } as const;

export function Catalog() {
  const q = useApi('/api/catalog');
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<string>('problems');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(100);
  const [edits, setEdits] = useState<Record<string, { barcode?: string; cost?: string; country?: string }>>({});
  const [fillCountry, setFillCountry] = useState('');
  const [skuOpen, setSkuOpen] = useState(false);
  const d = q.data;
  const issues = d?.issues ?? {};

  const scan = () => run('scan', async () => q.setData(await post('/api/catalog/scan')), 'Catalog scanned');
  const rows = useMemo(() => {
    const all = (d?.rows ?? []) as any[];
    const term = search.toLowerCase();
    return all.filter((r) => {
      if (term && !`${r.productTitle} ${r.variantTitle ?? ''} ${r.sku ?? ''} ${r.barcode ?? ''} ${r.vendor}`.toLowerCase().includes(term)) return false;
      if (filter === 'all') return true;
      if (filter === 'problems') return r.issues.some((i: string) => issues[i]?.severity !== 'low');
      return r.issues.includes(filter);
    });
  }, [d, filter, search]);

  const editCount = Object.keys(edits).length;
  const saveEdits = () =>
    run(
      'edits',
      async () => {
        const byId = new Map((d.rows as any[]).map((r) => [r.variantId, r]));
        const changes = Object.entries(edits).map(([variantId, e]) => ({
          variantId,
          productId: byId.get(variantId).productId,
          ...(e.barcode !== undefined ? { barcode: e.barcode.replace(/\D/g, '') } : {}),
          ...(e.cost !== undefined ? { cost: e.cost === '' ? null : Number(e.cost) } : {}),
          ...(e.country !== undefined ? { country: e.country.trim().toUpperCase() || null } : {}),
        }));
        const bad = changes.find((c) => c.country && !/^[A-Z]{2}$/.test(c.country));
        if (bad) throw new Error(`"${bad.country}" is not a 2-letter country code (e.g. US, JP, KR)`);
        const r = await post('/api/catalog/apply', { changes, label: 'Catalog edits' });
        setEdits({});
        q.setData(await post('/api/catalog/scan'));
        if (r.failed.length) throw new Error(`${r.done} saved, ${r.failed.length} product(s) failed: ${r.failed[0].error}`);
        return r;
      },
      (r: any) => `Saved ${r.done} variant(s) to Shopify`,
    );

  if (q.loading && !d)
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );

  return (
    <div>
      <PageHeader
        title="Catalog health"
        description="Checks your Shopify products for what eBay and this app need, and fixes the common problems for you."
        actions={
          <>
            {d?.undo?.changes?.length > 0 && (
              <Button
                loading={busy === 'undo'}
                onClick={async () => {
                  if (await confirm({ title: `Undo "${d.undo.label}"?`, body: `Restores the previous values of ${d.undo.changes.length} variant(s) in Shopify (changed ${ago(d.undo.at)}).`, confirm: 'Undo' }))
                    run('undo', async () => q.setData(await post('/api/catalog/undo')), 'Undone');
                }}
              >
                <Undo2 className="size-4" /> Undo last change
              </Button>
            )}
            <Button variant="primary" loading={busy === 'scan'} onClick={scan}>
              <ScanLine className="size-4" /> {d?.at ? 'Re-scan' : 'Scan my catalog'}
            </Button>
          </>
        }
      />

      {!d?.at ? (
        <Card>
          <Empty
            icon={<Stethoscope className="size-6" />}
            title="Scan your Shopify catalog"
            description="Reads every product and variant (nothing is changed) and lists missing SKUs, duplicate SKUs, missing or invalid barcodes, untracked stock, missing costs and photos."
            action={<Button variant="primary" loading={busy === 'scan'} onClick={scan}>Scan now</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <div className="card flex flex-col items-center justify-center p-6 text-center">
              <HealthRing value={d.summary.variants ? d.summary.healthy / d.summary.variants : 1} />
              <p className="mt-3 text-sm font-medium">
                {d.summary.healthy} of {d.summary.variants} variants ready
              </p>
              <p className="text-xs text-zinc-500">
                {d.summary.products} products · scanned {ago(d.at)}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Object.entries(issues).map(([k, info]: any) => (
                <button
                  key={k}
                  onClick={() => setFilter(filter === k ? 'problems' : k)}
                  className={cx('card p-3 text-left transition hover:-translate-y-0.5', filter === k && 'ring-2 ring-brand-500', d.summary.counts[k] === 0 && 'opacity-60')}
                >
                  <div className="flex items-center justify-between">
                    <Badge color={d.summary.counts[k] ? SEV_COLOR[info.severity as 'high'] : 'green'}>{info.severity}</Badge>
                    {d.summary.counts[k] === 0 && <CheckCircle2 className="size-4 text-emerald-500" />}
                  </div>
                  <div className="mt-2 text-xl font-semibold tabular-nums">{d.summary.counts[k]}</div>
                  <div className="text-xs text-zinc-500">{info.label}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <FixCard
              title="Generate SKUs"
              icon={<Wand2 className="size-4" />}
              count={d.summary.counts.sku_missing + d.summary.counts.sku_duplicate + d.summary.counts.sku_invalid}
              body="Creates readable, unique SKUs like SONY-WH1000XM5-BLK from brand, model and options. You review every SKU before anything is saved."
              action={<Button variant="primary" onClick={() => setSkuOpen(true)}>Preview SKUs</Button>}
            />
            <FixCard
              title="Turn on stock tracking"
              icon={<CheckCircle2 className="size-4" />}
              count={d.summary.counts.not_tracked}
              body="Shopify has to count stock for a variant before it can sync with eBay. Current quantities aren't changed."
              action={
                <Button
                  disabled={!d.summary.counts.not_tracked}
                  loading={busy === 'track'}
                  onClick={async () => {
                    if (await confirm({ title: `Track stock for ${d.summary.counts.not_tracked} variant(s)?`, body: 'Turns on "Track quantity" in Shopify. Make sure the quantities are right afterwards: untracked variants usually show 0.', confirm: 'Turn on tracking' }))
                      run('track', async () => q.setData(await post('/api/catalog/track-all')), 'Tracking turned on');
                  }}
                >
                  Turn on for all
                </Button>
              }
            />
            <FixCard
              title="Barcodes & costs"
              icon={<Barcode className="size-4" />}
              count={d.summary.counts.barcode_missing + d.summary.counts.barcode_invalid + d.summary.counts.no_cost}
              body="Real UPC/EAN codes come from the manufacturer (printed on the box) and can't be made up. Type them in below, or use a USB barcode scanner (it types like a keyboard)."
              action={<Button onClick={() => setFilter('barcode_missing')}>Show missing barcodes</Button>}
            />
          </div>

          <Card
            padded={false}
            title={filter === 'problems' ? 'Variants that need attention' : filter === 'all' ? 'All variants' : issues[filter]?.label}
            description={filter !== 'problems' && filter !== 'all' ? issues[filter]?.help : 'Edit barcodes, costs and country of origin inline, then save.'}
            actions={
              <>
                <select className="input w-auto py-1.5 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="problems">Needs attention</option>
                  <option value="all">All variants</option>
                  {Object.entries(issues).map(([k, i]: any) => (
                    <option key={k} value={k}>
                      {i.label}
                    </option>
                  ))}
                </select>
                <Button variant="primary" disabled={!editCount} loading={busy === 'edits'} onClick={saveEdits}>
                  Save {editCount || ''} change{editCount === 1 ? '' : 's'}
                </Button>
              </>
            }
          >
            <div className="border-b border-zinc-100 p-3 dark:border-white/[0.06]">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
                <input className="input pl-9" placeholder="Filter by title, SKU, barcode or brand" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {filter === 'no_country' && rows.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>Set country of origin for the {rows.length} variant(s) shown:</span>
                  <input className="input w-20 py-1 font-mono uppercase" maxLength={2} placeholder="KR" value={fillCountry} onChange={(e) => setFillCountry(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
                  <Button
                    className="px-2 py-1 text-xs"
                    disabled={fillCountry.length !== 2}
                    onClick={() => setEdits((s) => Object.fromEntries([...Object.entries(s), ...rows.map((r) => [r.variantId, { ...s[r.variantId], country: fillCountry }])]))}
                  >
                    Fill
                  </Button>
                  <span>Narrow the list with the search box first (e.g. a brand). Nothing is saved until you click Save.</span>
                </div>
              )}
            </div>
            {!rows.length ? (
              <Empty icon={<CheckCircle2 className="size-6" />} title="Nothing to fix here" description="Every variant in this view looks good." />
            ) : (
              <div className="scrollbar-thin overflow-x-auto">
                <table className="w-full min-w-[900px]">
                  <thead className="border-b border-zinc-100 dark:border-white/[0.06]">
                    <tr>
                      <th className="table-head">Product</th>
                      <th className="table-head">SKU</th>
                      <th className="table-head">UPC / EAN</th>
                      <th className="table-head">Cost</th>
                      <th className="table-head" title="Country of origin (2-letter code)">Origin</th>
                      <th className="table-head">Issues</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
                    {rows.slice(0, limit).map((r) => {
                      const e = edits[r.variantId] ?? {};
                      const setE = (k: 'barcode' | 'cost' | 'country', v: string) => setEdits((s) => ({ ...s, [r.variantId]: { ...s[r.variantId], [k]: v } }));
                      const bc = e.barcode ?? r.barcode ?? '';
                      return (
                        <tr key={r.variantId} className="align-top">
                          <td className="table-cell max-w-[300px]">
                            <div className="flex gap-3">
                              {r.image ? <img src={`${r.image}${r.image.includes('?') ? '&' : '?'}width=64`} className="size-9 shrink-0 rounded-md object-cover" alt="" /> : <div className="size-9 shrink-0 rounded-md bg-zinc-100 dark:bg-white/5" />}
                              <div className="min-w-0">
                                <div className="line-clamp-1 font-medium">{r.productTitle}</div>
                                <div className="text-xs text-zinc-500">
                                  {r.vendor || <span className="text-amber-600">no brand</span>}
                                  {r.variantTitle && ` · ${r.variantTitle}`}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="table-cell font-mono text-xs">{r.sku ?? <span className="font-sans text-amber-600">missing</span>}</td>
                          <td className="table-cell">
                            <input
                              inputMode="numeric"
                              className={cx('input w-40 py-1 font-mono text-xs', bc && !/^\d{12,14}$/.test(bc) && 'border-amber-400')}
                              placeholder="scan or type"
                              value={bc}
                              onChange={(ev) => setE('barcode', ev.target.value)}
                              onKeyDown={(ev) => {
                                if (ev.key === 'Enter') (ev.currentTarget.closest('tr')?.nextElementSibling?.querySelector('input') as HTMLInputElement | null)?.focus();
                              }}
                            />
                          </td>
                          <td className="table-cell">
                            <input type="number" step={0.01} min={0} className="input w-24 py-1 text-xs" placeholder="0.00" value={e.cost ?? (r.cost ?? '')} onChange={(ev) => setE('cost', ev.target.value)} />
                          </td>
                          <td className="table-cell">
                            <input
                              className="input w-16 py-1 font-mono text-xs uppercase"
                              maxLength={2}
                              placeholder="--"
                              title="Country of origin, e.g. US, JP, KR, GB"
                              value={e.country ?? (r.country ?? '')}
                              onChange={(ev) => setE('country', ev.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
                            />
                          </td>
                          <td className="table-cell">
                            <div className="flex flex-wrap gap-1">
                              {r.issues.map((i: string) => (
                                <Badge key={i} color={SEV_COLOR[issues[i].severity as 'high']} title={issues[i].help}>
                                  {issues[i].label}
                                </Badge>
                              ))}
                              {!r.issues.length && <Badge color="green">OK</Badge>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {rows.length > limit && (
                  <div className="border-t border-zinc-100 p-3 text-center dark:border-white/[0.06]">
                    <Button variant="ghost" onClick={() => setLimit((l) => l + 200)}>
                      Show more ({rows.length - limit} left)
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      <SkuModal open={skuOpen} onClose={() => setSkuOpen(false)} onApplied={(data) => q.setData(data)} />
    </div>
  );
}

function FixCard({ title, icon, count, body, action }: { title: string; icon: React.ReactNode; count: number; body: string; action: React.ReactNode }) {
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span className="rounded-lg bg-brand-500/10 p-1.5 text-brand-500">{icon}</span>
          {title}
        </h3>
        {count > 0 ? <Badge color="amber">{count} to fix</Badge> : <Badge color="green">All good</Badge>}
      </div>
      <p className="mt-2 flex-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
      <div className="mt-4">{action}</div>
    </div>
  );
}

function HealthRing({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 90 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#f43f5e';
  return (
    <div className="relative size-28">
      <svg viewBox="0 0 36 36" className="size-full -rotate-90">
        <circle cx="18" cy="18" r="15.9" fill="none" strokeWidth="3" className="stroke-zinc-200 dark:stroke-white/10" />
        <circle cx="18" cy="18" r="15.9" fill="none" strokeWidth="3" strokeLinecap="round" stroke={color} strokeDasharray={`${pct} 100`} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-2xl font-semibold tabular-nums">{pct}%</div>
    </div>
  );
}

function SkuModal({ open, onClose, onApplied }: { open: boolean; onClose: () => void; onApplied: (data: any) => void }) {
  const [mode, setMode] = useState<'missing' | 'problems' | 'all'>('problems');
  const [proposals, setProposals] = useState<any[] | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const preview = (m = mode) =>
    run('preview', async () => {
      const r = await post('/api/catalog/sku-preview', { mode: m });
      setProposals(r.proposals);
      setSkip(new Set());
      setOverrides({});
    });
  const chosen = (proposals ?? []).filter((p) => !skip.has(p.variantId));
  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setProposals(null);
      }}
      title="Generate SKUs"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!chosen.length}
            loading={busy === 'apply'}
            onClick={() =>
              run(
                'apply',
                async () => {
                  const r = await post('/api/catalog/apply', {
                    label: 'Generate SKUs',
                    changes: chosen.map((p) => ({ variantId: p.variantId, productId: p.productId, sku: (overrides[p.variantId] ?? p.proposed).trim() })),
                  });
                  onApplied(await post('/api/catalog/scan'));
                  onClose();
                  setProposals(null);
                  if (r.failed.length) throw new Error(`${r.done} saved, ${r.failed.length} product(s) failed: ${r.failed[0].error}`);
                  return r;
                },
                (r: any) => `Saved ${r.done} SKU(s) to Shopify. You can undo this from the Catalog page.`,
              )
            }
          >
            Save {chosen.length} SKU{chosen.length === 1 ? '' : 's'} to Shopify
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            { v: 'missing', t: 'Only missing', d: 'Fill in variants that have no SKU' },
            { v: 'problems', t: 'Missing + problems', d: 'Also fix duplicates and SKUs eBay rejects (recommended)' },
            { v: 'all', t: 'Regenerate all', d: 'Replace every SKU with the new format' },
          ].map((o) => (
            <button
              key={o.v}
              onClick={() => {
                setMode(o.v as any);
                preview(o.v as any);
              }}
              className={cx('rounded-xl border p-3 text-left transition', mode === o.v ? 'border-brand-500 bg-brand-500/[0.06] ring-4 ring-brand-500/10' : 'border-zinc-200 hover:border-zinc-300 dark:border-white/10')}
            >
              <div className="text-sm font-medium">{o.t}</div>
              <div className="mt-0.5 text-xs text-zinc-500">{o.d}</div>
            </button>
          ))}
        </div>
        {mode === 'all' && (
          <Callout kind="warn" title="Only regenerate all SKUs if nothing else depends on them">
            Warehouse systems, shipping apps, POS or supplier sheets that use your current SKUs would stop matching.
          </Callout>
        )}
        <p className="text-xs text-zinc-500">
          Format: <span className="font-mono">BRAND-MODEL-OPTIONS</span>, e.g. <span className="font-mono">SONY-WH1000XM5-BLK</span> or <span className="font-mono">ACME-ORGCOTCRETEE-NAV-XL</span>. Model numbers in the title are used when found. For duplicates, the first variant keeps its SKU. Every SKU is unique and eBay-safe, and you can edit any of them below.
        </p>
        {!proposals ? (
          <Button loading={busy === 'preview'} onClick={() => preview()}>
            Preview SKUs
          </Button>
        ) : !proposals.length ? (
          <Callout kind="success">Nothing to change. All SKUs are present, unique and eBay-safe.</Callout>
        ) : (
          <div className="scrollbar-thin max-h-[420px] overflow-auto rounded-xl border border-zinc-200 dark:border-white/10">
            <table className="w-full">
              <thead className="sticky top-0 bg-white dark:bg-zinc-900">
                <tr>
                  <th className="table-head w-8">
                    <input type="checkbox" className="size-4 accent-brand-500" checked={!skip.size} onChange={(e) => setSkip(e.target.checked ? new Set() : new Set(proposals.map((p) => p.variantId)))} />
                  </th>
                  <th className="table-head">Product</th>
                  <th className="table-head">Current</th>
                  <th className="table-head">New SKU</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
                {proposals.map((p) => (
                  <tr key={p.variantId} className={cx(skip.has(p.variantId) && 'opacity-40')}>
                    <td className="table-cell">
                      <input type="checkbox" className="size-4 accent-brand-500" checked={!skip.has(p.variantId)} onChange={() => setSkip((s) => { const n = new Set(s); n.has(p.variantId) ? n.delete(p.variantId) : n.add(p.variantId); return n; })} />
                    </td>
                    <td className="table-cell">
                      <div className="line-clamp-1 text-sm">{p.productTitle}</div>
                      {p.variantTitle && <div className="text-xs text-zinc-500">{p.variantTitle}</div>}
                    </td>
                    <td className="table-cell font-mono text-xs text-zinc-500">{p.current ?? '—'}</td>
                    <td className="table-cell">
                      <input className="input w-56 py-1 font-mono text-xs" maxLength={50} value={overrides[p.variantId] ?? p.proposed} onChange={(e) => setOverrides((o) => ({ ...o, [p.variantId]: e.target.value.toUpperCase().replace(/[^A-Z0-9_.\-]/g, '') }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
