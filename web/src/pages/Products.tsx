import { ChevronDown, ChevronRight, LineChart as LineIcon, Package, Plus, Search, Sparkles, Stethoscope } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { api, money, post, useApi } from '../api.ts';
import { Badge, Button, Callout, Card, cx, Empty, Field, Link, Modal, PageHeader, Spinner, StatusBadge, Toggle, useAction, useRouter } from '../ui.tsx';
import { MarketDetails } from './Market.tsx';

type Selection = Record<string, 'all' | string[]>;

export function Products() {
  const { navigate } = useRouter();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const after = cursors[cursors.length - 1];
  const list = useApi(`/api/shopify/products?first=50${query ? `&q=${encodeURIComponent(query)}` : ''}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
  const status = useApi('/api/status');
  const profiles = useApi('/api/profiles');
  const [selected, setSelected] = useState<Selection>({});
  const [expanded, setExpanded] = useState<Record<string, any[] | 'loading'>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [market, setMarket] = useState<{ productId: string; title: string } | null>(null);
  const { busy, run } = useAction();
  const currency = status.data?.ebay?.currency ?? 'USD';

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setCursors([null]);
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const products = (list.data?.products ?? []) as any[];
  const selectedCount = Object.keys(selected).length;
  const fullyLinked = (p: any) => p.linked && p.linked.linked_variants >= p.variantsCount;

  const toggleExpand = async (p: any) => {
    if (expanded[p.id]) return setExpanded(({ [p.id]: _, ...rest }) => rest);
    setExpanded((e) => ({ ...e, [p.id]: 'loading' }));
    try {
      const r = await api(`/api/shopify/products/${encodeURIComponent(p.id)}`);
      setExpanded((e) => ({ ...e, [p.id]: r.product.variants }));
    } catch {
      setExpanded(({ [p.id]: _, ...rest }) => rest);
    }
  };
  const toggleProduct = (p: any) =>
    setSelected((s) => {
      const n = { ...s };
      if (n[p.id]) delete n[p.id];
      else n[p.id] = 'all';
      return n;
    });
  const toggleVariant = (p: any, vid: string, all: any[]) =>
    setSelected((s) => {
      const current = s[p.id] === 'all' ? all.filter((v) => !v.linked).map((v) => v.id) : (s[p.id] as string[] | undefined) ?? [];
      const set = new Set(current);
      set.has(vid) ? set.delete(vid) : set.add(vid);
      const n = { ...s };
      if (set.size) n[p.id] = [...set];
      else delete n[p.id];
      return n;
    });
  const variantChecked = (p: any, v: any) => selected[p.id] === 'all' ? !v.linked : (selected[p.id] as string[] | undefined)?.includes(v.id) ?? false;

  const listOne = (p: any) =>
    run('one-' + p.id, async () => {
      const r = await post('/api/listings', { productId: p.id, mode: 'auto' });
      navigate(`/listings/${r.ids[0]}`);
    });

  if (status.data && !status.data.shopify.test?.ok)
    return (
      <div>
        <PageHeader title="Shopify products" />
        <Card>
          <Empty icon={<Package className="size-6" />} title="Connect Shopify first" description="Your Shopify catalog shows up here once the connection is set up." action={<Button variant="primary" onClick={() => navigate('/setup')}>Open setup</Button>} />
        </Card>
      </div>
    );

  return (
    <div>
      <PageHeader
        title="Shopify products"
        description="Pick the products you want to sell on eBay. Shopify stays the source of truth for content, price and stock."
        actions={
          <>
            <Link to="/catalog" className="btn-secondary">
              <Stethoscope className="size-4" /> Catalog health
            </Link>
            <Button variant="primary" disabled={!selectedCount} onClick={() => setBulkOpen(true)}>
              <Sparkles className="size-4" /> Create eBay listings{selectedCount ? ` (${selectedCount})` : ''}
            </Button>
          </>
        }
      />
      <Card padded={false}>
        <div className="flex items-center gap-3 border-b border-zinc-100 p-3 dark:border-white/[0.06]">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
            <input className="input pl-9" placeholder="Search products (title, SKU, barcode, vendor...)" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {list.loading && <Spinner />}
        </div>
        {list.error && (
          <div className="p-4">
            <Callout kind="error">{list.error}</Callout>
          </div>
        )}
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-zinc-100 dark:border-white/[0.06]">
              <tr>
                <th className="table-head w-10" />
                <th className="table-head">Product</th>
                <th className="table-head">Price</th>
                <th className="table-head">Stock</th>
                <th className="table-head">eBay</th>
                <th className="table-head text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {products.map((p) => {
                const variants = expanded[p.id];
                return (
                  <Fragment key={p.id}>
                    <tr className={cx('transition hover:bg-zinc-50/80 dark:hover:bg-white/[0.02]', selected[p.id] && 'bg-brand-500/[0.04]')}>
                      <td className="table-cell">
                        <input type="checkbox" className="size-4 accent-brand-500" disabled={fullyLinked(p)} checked={!!selected[p.id]} onChange={() => toggleProduct(p)} />
                      </td>
                      <td className="table-cell">
                        <div className="flex items-center gap-3">
                          {p.image ? <img src={`${p.image}${p.image.includes('?') ? '&' : '?'}width=80`} className="size-11 rounded-lg object-cover ring-1 ring-zinc-200 dark:ring-white/10" alt="" /> : <div className="size-11 rounded-lg bg-zinc-100 dark:bg-white/5" />}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <button className="text-zinc-400 hover:text-zinc-700" title="Show variants" onClick={() => toggleExpand(p)}>
                                {variants ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                              </button>
                              <span className="truncate font-medium">{p.title}</span>
                              {p.status !== 'ACTIVE' && <Badge>{p.status.toLowerCase()}</Badge>}
                            </div>
                            <div className="pl-5 text-xs text-zinc-500">
                              {p.vendor || <span className="text-amber-600">no brand</span>}
                              {p.variantsCount > 1 && ` · ${p.variantsCount} variants`}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="table-cell tabular-nums">{p.minPrice === p.maxPrice ? money(p.minPrice, currency) : `${money(p.minPrice, currency)} – ${money(p.maxPrice, currency)}`}</td>
                      <td className="table-cell tabular-nums">{p.totalInventory ?? '—'}</td>
                      <td className="table-cell">
                        {p.linked ? (
                          <div className="flex items-center gap-1.5">
                            <StatusBadge status={p.linked.status} />
                            {!fullyLinked(p) && <span className="text-xs text-zinc-500">{p.variantsCount - p.linked.linked_variants} unlisted</span>}
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-400">Not listed</span>
                        )}
                      </td>
                      <td className="table-cell text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" title="Check eBay market" onClick={() => setMarket({ productId: p.id, title: p.title })}>
                            <LineIcon className="size-4" />
                          </Button>
                          {p.linked && (
                            <Button variant="ghost" onClick={() => navigate(`/listings/${p.linked.listing_id}`)}>
                              Open
                            </Button>
                          )}
                          {!fullyLinked(p) && (
                            <Button loading={busy === 'one-' + p.id} onClick={() => listOne(p)}>
                              <Plus className="size-4" /> List
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {variants === 'loading' && (
                      <tr>
                        <td colSpan={6} className="table-cell pl-16">
                          <Spinner />
                        </td>
                      </tr>
                    )}
                    {Array.isArray(variants) &&
                      variants.map((v: any) => (
                        <tr key={v.id} className="bg-zinc-50/60 text-sm dark:bg-white/[0.015]">
                          <td className="table-cell pl-8">
                            <input type="checkbox" className="size-4 accent-brand-500" disabled={!!v.linked} checked={variantChecked(p, v)} onChange={() => toggleVariant(p, v.id, variants)} />
                          </td>
                          <td className="table-cell pl-16 text-zinc-600 dark:text-zinc-300">
                            {v.title === 'Default Title' ? 'Default' : v.title}
                            <div className="flex flex-wrap gap-1.5 text-xs">
                              <span className={v.sku ? 'font-mono text-zinc-500' : 'text-amber-600'}>{v.sku || 'no SKU'}</span>
                              <span className={v.barcode ? 'text-zinc-400' : 'text-amber-600'}>{v.barcode ? `UPC ${v.barcode}` : 'no barcode'}</span>
                            </div>
                          </td>
                          <td className="table-cell tabular-nums">{money(Number(v.price), currency)}</td>
                          <td className="table-cell tabular-nums">{v.inventoryItem.tracked ? v.inventoryQuantity : <span className="text-amber-600">not tracked</span>}</td>
                          <td className="table-cell">{v.linked ? <StatusBadge status={v.linked.status} /> : <span className="text-xs text-zinc-400">—</span>}</td>
                          <td className="table-cell" />
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!list.loading && !products.length && <Empty icon={<Package className="size-6" />} title="No products found" description={q ? 'Try a different search.' : 'Your Shopify store has no products yet.'} />}
        </div>
        <div className="flex items-center justify-between border-t border-zinc-100 p-3 dark:border-white/[0.06]">
          <Button variant="ghost" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
            Previous
          </Button>
          <Button variant="ghost" disabled={!list.data?.pageInfo?.hasNextPage} onClick={() => setCursors((c) => [...c, list.data.pageInfo.endCursor])}>
            Next
          </Button>
        </div>
      </Card>

      <BulkModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        selected={selected}
        profiles={profiles.data?.profiles ?? []}
        onDone={() => {
          setSelected({});
          navigate('/listings');
        }}
      />

      <Modal open={!!market} onClose={() => setMarket(null)} title={`eBay market: ${market?.title ?? ''}`} wide>
        {market && <MarketCheck productId={market.productId} currency={currency} />}
      </Modal>
    </div>
  );
}

function MarketCheck({ productId, currency }: { productId: string; currency: string }) {
  const [variantId, setVariantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    post('/api/market/check', { productId })
      .then((r) => setVariantId(r.latest?.shopify_variant_id ?? null))
      .catch((e) => setError(e.message));
  }, [productId]);
  if (error) return <Callout kind="error">{error}</Callout>;
  if (!variantId)
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-sm text-zinc-500">
        <Spinner className="size-5" /> Searching eBay for identical brand-new items...
      </div>
    );
  return <MarketDetails variantId={variantId} currency={currency} />;
}

function BulkModal({ open, onClose, selected, profiles, onDone }: { open: boolean; onClose: () => void; selected: Selection; profiles: any[]; onDone: () => void }) {
  const [mode, setMode] = useState<'auto' | 'separate'>('auto');
  const [profileId, setProfileId] = useState<string>('');
  const [publish, setPublish] = useState(false);
  const { busy, run } = useAction();
  const count = Object.keys(selected).length;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Create eBay listings for ${count} product${count === 1 ? '' : 's'}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'bulk'}
            onClick={() =>
              run(
                'bulk',
                async () => {
                  const r = await post('/api/listings/bulk', {
                    products: Object.entries(selected).map(([productId, v]) => ({ productId, variantIds: v === 'all' ? undefined : v })),
                    mode,
                    profileId: profileId ? Number(profileId) : null,
                    publish,
                  });
                  if (r.errors.length) throw new Error(`${r.created.length} created; ${r.errors.length} failed: ${r.errors[0].error}`);
                  onClose();
                  onDone();
                  return r;
                },
                (r: any) => `${r.created.length} draft listing(s) created${publish ? '; publishing in the background' : ''}`,
              )
            }
          >
            Create {publish ? '& publish' : 'drafts'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Listing profile" hint="Profiles set the category, policies, templates and item specifics. Leave empty to use defaults and auto-detect the category.">
          <select className="input" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">Default settings</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <span className="label">Products with variants (size, color...)</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { v: 'auto', t: 'One multi-variation listing', d: 'Buyers pick the size/color from a dropdown (recommended by eBay)' },
              { v: 'separate', t: 'Separate listing per variant', d: 'Each variant gets its own listing and title' },
            ].map((o) => (
              <button key={o.v} onClick={() => setMode(o.v as any)} className={cx('rounded-xl border p-3 text-left transition', mode === o.v ? 'border-brand-500 bg-brand-500/[0.06] ring-4 ring-brand-500/10' : 'border-zinc-200 hover:border-zinc-300 dark:border-white/10')}>
                <div className="text-sm font-medium">{o.t}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{o.d}</div>
              </button>
            ))}
          </div>
        </div>
        <Toggle checked={publish} onChange={setPublish} label="Publish right away" description="Otherwise drafts are created for you to review first (recommended for your first listings)." />
        <Callout kind="info">Prices are set automatically within your markup range after a quick eBay market check.</Callout>
      </div>
    </Modal>
  );
}
