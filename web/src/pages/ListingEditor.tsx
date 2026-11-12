import { ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, ExternalLink, Lock, RefreshCw, Rocket, Save, Search, Trash2, Unlock, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, del, money, pct, post, put, useApi } from '../api.ts';
import { Badge, Button, Callout, Card, cx, Field, Link, PageHeader, Spinner, StatusBadge, Toggle, useAction, useConfirm, useRouter } from '../ui.tsx';
import { MarketDetails } from './Market.tsx';

type Aspect = { name: string; required: boolean; recommended: boolean; multi: boolean; freeText: boolean; values: string[] };

export function ListingEditor({ id }: { id: number }) {
  const { navigate } = useRouter();
  const q = useApi(`/api/listings/${id}`);
  const status = useApi('/api/status');
  const profiles = useApi('/api/profiles');
  const policies = useApi(status.data?.ebay?.connected ? '/api/ebay/policies' : null);
  const locations = useApi(status.data?.ebay?.connected ? '/api/ebay/locations' : null);
  const [draft, setDraft] = useState<any>(null);
  const [items, setItems] = useState<Record<number, any>>({});
  const [issues, setIssues] = useState<any[] | null>(null);
  const [marketVariant, setMarketVariant] = useState<string | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const currency = status.data?.ebay?.currency ?? 'USD';
  const l = q.data?.listing;

  useEffect(() => {
    if (!l) return;
    setDraft({ ...l });
    setItems({});
    setMarketVariant((v) => v ?? l.items[0]?.shopify_variant_id ?? null);
  }, [q.data]);

  const validate = () => post(`/api/listings/${id}/validate`).then((r) => setIssues(r.issues));
  useEffect(() => {
    if (l) validate().catch(() => undefined);
  }, [l?.id]);

  const dirty = useMemo(() => {
    if (!l || !draft) return false;
    const keys = ['title', 'category_id', 'aspects', 'description_html', 'image_urls', 'varies_by', 'fulfillment_policy_id', 'payment_policy_id', 'return_policy_id', 'merchant_location_key', 'best_offer_enabled', 'locked_fields', 'profile_id'];
    return keys.some((k) => JSON.stringify(draft[k]) !== JSON.stringify(l[k])) || Object.keys(items).length > 0;
  }, [draft, l, items]);

  if (!l || !draft)
    return (
      <div className="flex justify-center py-20">
        {q.error ? <Callout kind="error">{q.error}</Callout> : <Spinner className="size-6" />}
      </div>
    );

  const set = (k: string, v: unknown) => setDraft((d: any) => ({ ...d, [k]: v }));
  const setItem = (iid: number, k: string, v: unknown) => setItems((s) => ({ ...s, [iid]: { ...s[iid], id: iid, [k]: v } }));
  const save = async () => {
    const patch: any = {};
    for (const k of Object.keys(draft)) if (JSON.stringify(draft[k]) !== JSON.stringify(l[k])) patch[k] = draft[k];
    if (Object.keys(items).length) patch.items = Object.values(items);
    await put(`/api/listings/${id}`, patch);
    await q.reload();
    await validate();
  };
  const locked = new Set<string>(draft.locked_fields ?? []);
  const toggleLock = (f: string) => set('locked_fields', locked.has(f) ? [...locked].filter((x) => x !== f) : [...locked, f]);
  const LockBtn = ({ f }: { f: string }) => (
    <button type="button" onClick={() => toggleLock(f)} title={locked.has(f) ? 'Locked: "Refresh from Shopify" will not overwrite this' : 'Unlocked: "Refresh from Shopify" updates this'} className={cx('rounded-md p-1 transition', locked.has(f) ? 'text-brand-500' : 'text-zinc-400 hover:text-zinc-600')}>
      {locked.has(f) ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
    </button>
  );
  const errors = issues?.filter((i) => i.level === 'error') ?? [];
  const warnings = issues?.filter((i) => i.level === 'warning') ?? [];
  const live = ['published', 'out_of_stock'].includes(l.status);

  return (
    <div>
      <Link to="/listings" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> All listings
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {l.product_title}
            <StatusBadge status={l.status} />
            {l.kind === 'group' && <Badge color="violet">Multi-variation</Badge>}
          </span>
        }
        description={
          <span className="flex flex-wrap gap-3">
            <a href={l.shopify_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
              Shopify product <ExternalLink className="size-3" />
            </a>
            {l.ebay_url && (
              <a href={l.ebay_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                eBay item {l.ebay_listing_id} <ExternalLink className="size-3" />
              </a>
            )}
          </span>
        }
        actions={
          <>
            <Button loading={busy === 'refresh'} onClick={() => run('refresh', () => post(`/api/listings/${id}/refresh`).then(() => q.reload()), 'Refreshed from Shopify')} title="Pull latest title, description, images, price and stock from Shopify (locked fields are kept)">
              <RefreshCw className="size-4" /> Refresh from Shopify
            </Button>
            <Button disabled={!dirty} loading={busy === 'save'} onClick={() => run('save', save, 'Saved')}>
              <Save className="size-4" /> Save
            </Button>
            <Button
              variant="primary"
              loading={busy === 'publish'}
              disabled={errors.length > 0 && !dirty}
              onClick={() =>
                run(
                  'publish',
                  async () => {
                    if (dirty) await save();
                    await post(`/api/listings/${id}/publish`);
                    await q.reload();
                    await validate();
                  },
                  live ? 'eBay listing updated' : 'Published to eBay!',
                )
              }
            >
              <Rocket className="size-4" /> {live ? 'Update on eBay' : 'Publish to eBay'}
            </Button>
          </>
        }
      />
      {l.last_error && (
        <div className="mb-4">
          <Callout kind="error" title="eBay reported a problem">
            {l.last_error}
          </Callout>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card title="Title & category">
            <div className="space-y-4">
              <Field label={<span className="flex items-center gap-1">eBay title <LockBtn f="title" /></span>} hint={<span className={cx(draft.title.length > 80 && 'text-rose-500')}>{draft.title.length}/80 characters. Lead with brand, model and key specs; buyers search by these.</span>}>
                <input className="input text-base font-medium" maxLength={80} value={draft.title} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <CategoryPicker value={{ id: draft.category_id, name: draft.category_name }} defaultQuery={l.product_title} onChange={(c) => setDraft((d: any) => ({ ...d, category_id: c.id, category_name: c.name }))} />
            </div>
          </Card>

          {draft.category_id && <AspectsEditor categoryId={draft.category_id} aspects={draft.aspects} variesBy={draft.varies_by} items={l.items} kind={l.kind} onChange={(a) => set('aspects', a)} onVariesBy={(v) => set('varies_by', v)} />}

          <Card title={<span className="flex items-center gap-1">Description <LockBtn f="description" /></span>} description="HTML. Scripts and iframes are stripped automatically.">
            <div className="grid gap-4 lg:grid-cols-2">
              <textarea rows={18} className="input font-mono text-xs" value={draft.description_html} onChange={(e) => set('description_html', e.target.value)} />
              <iframe title="preview" sandbox="" className="h-[420px] w-full rounded-xl border border-zinc-200 bg-white dark:border-white/10" srcDoc={draft.description_html} />
            </div>
          </Card>

          <Card title={<span className="flex items-center gap-1">Photos <LockBtn f="images" /></span>} description="The first photo is the main image. eBay allows up to 24, at least 500px on the longest side.">
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-6">
              {draft.image_urls.map((u: string, idx: number) => (
                <div key={u} className="group relative aspect-square overflow-hidden rounded-xl ring-1 ring-zinc-200 dark:ring-white/10">
                  <img src={`${u}${u.includes('?') ? '&' : '?'}width=240`} className="size-full object-cover" alt="" />
                  {idx === 0 && <span className="absolute top-1.5 left-1.5 rounded-md bg-black/60 px-1.5 text-[10px] text-white">Main</span>}
                  <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-gradient-to-t from-black/60 p-1.5 opacity-0 transition group-hover:opacity-100">
                    {idx > 0 && (
                      <button className="rounded bg-white/90 p-1 text-zinc-800" onClick={() => { const a = [...draft.image_urls]; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; set('image_urls', a); }}>
                        <ArrowUp className="size-3" />
                      </button>
                    )}
                    {idx < draft.image_urls.length - 1 && (
                      <button className="rounded bg-white/90 p-1 text-zinc-800" onClick={() => { const a = [...draft.image_urls]; [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]]; set('image_urls', a); }}>
                        <ArrowDown className="size-3" />
                      </button>
                    )}
                    <button className="rounded bg-white/90 p-1 text-rose-600" onClick={() => set('image_urls', draft.image_urls.filter((x: string) => x !== u))}>
                      <X className="size-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Pricing & stock" description="eBay price = Shopify price + your markup, always kept inside your range. Lock a price to set it manually." padded={false}>
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full min-w-[820px]">
                <thead className="border-b border-zinc-100 dark:border-white/[0.06]">
                  <tr>
                    <th className="table-head">Variant / SKU</th>
                    <th className="table-head">Shopify</th>
                    <th className="table-head">Range</th>
                    <th className="table-head">Markup</th>
                    <th className="table-head">eBay price</th>
                    <th className="table-head">Stock</th>
                    <th className="table-head">Profit</th>
                    <th className="table-head" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
                  {l.items.map((i: any) => {
                    const e = items[i.id] ?? {};
                    const lockedPrice = e.price_locked ?? i.price_locked;
                    return (
                      <tr key={i.id}>
                        <td className="table-cell">
                          <div className="font-medium">{i.variant_title ?? 'Default'}</div>
                          {l.status === 'draft' ? (
                            <input className="input mt-1 w-40 py-1 font-mono text-xs" value={e.sku ?? i.sku} onChange={(ev) => setItem(i.id, 'sku', ev.target.value)} />
                          ) : (
                            <div className="font-mono text-xs text-zinc-500">{i.sku}</div>
                          )}
                        </td>
                        <td className="table-cell tabular-nums">
                          {money(i.shopify_price, currency)}
                          {i.shopify_compare_at > i.shopify_price && <div className="text-xs text-zinc-500 line-through">{money(i.shopify_compare_at, currency)}</div>}
                        </td>
                        <td className="table-cell text-xs text-zinc-500 tabular-nums">
                          {money(i.floor, currency)}
                          <br />
                          {money(i.ceiling, currency)}
                        </td>
                        <td className="table-cell">
                          <div className="relative w-24">
                            <input type="number" step={0.1} disabled={lockedPrice} className="input py-1 pr-6 text-sm" value={e.markup_pct ?? i.markup_pct ?? ''} placeholder="auto" onChange={(ev) => setItem(i.id, 'markup_pct', ev.target.value === '' ? null : Number(ev.target.value))} />
                            <span className="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-zinc-400">%</span>
                          </div>
                        </td>
                        <td className="table-cell">
                          <div className="flex items-center gap-1.5">
                            {lockedPrice ? (
                              <input type="number" step={0.01} className="input w-24 py-1 text-sm" value={e.manual_price ?? i.manual_price ?? i.target_price ?? ''} onChange={(ev) => setItem(i.id, 'manual_price', Number(ev.target.value))} />
                            ) : (
                              <span className="font-semibold tabular-nums">{money(i.target_price, currency)}</span>
                            )}
                            <button className={cx('rounded-md p-1', lockedPrice ? 'text-brand-500' : 'text-zinc-400 hover:text-zinc-600')} title={lockedPrice ? 'Manual price (click to go back to automatic)' : 'Automatic (click to set manually)'} onClick={() => setItem(i.id, 'price_locked', !lockedPrice)}>
                              {lockedPrice ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
                            </button>
                          </div>
                          <div className="text-xs text-zinc-500">{pct(i.current_pct)} now</div>
                        </td>
                        <td className="table-cell text-sm tabular-nums">
                          {i.target_qty} <span className="text-xs text-zinc-500">/ {i.inventory_tracked ? i.shopify_qty : '∞'}</span>
                        </td>
                        <td className="table-cell text-sm tabular-nums">{i.profit?.hasCost ? <span className={cx(i.profit.net < 0 && 'text-rose-500')}>{money(i.profit.net, currency)}</span> : <span className="text-xs text-zinc-400">no cost</span>}</td>
                        <td className="table-cell">
                          <button className={cx('text-xs font-medium', marketVariant === i.shopify_variant_id ? 'text-brand-600' : 'text-zinc-500 hover:text-zinc-800')} onClick={() => setMarketVariant(i.shopify_variant_id)}>
                            Market
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Ready to publish?" actions={<Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => validate()}>Re-check</Button>}>
            {issues === null ? (
              <Spinner />
            ) : !issues.length ? (
              <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-4" /> Everything looks good.
              </p>
            ) : (
              <ul className="space-y-2">
                {errors.map((i, n) => (
                  <li key={`e${n}`} className="flex gap-2 text-sm text-rose-600 dark:text-rose-400">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-rose-500" />
                    {i.message}
                  </li>
                ))}
                {warnings.map((i, n) => (
                  <li key={`w${n}`} className="flex gap-2 text-sm text-amber-700 dark:text-amber-300">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Policies & options">
            <div className="space-y-4">
              <Field label="Profile">
                <select className="input" value={draft.profile_id ?? ''} onChange={(e) => set('profile_id', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">None (defaults)</option>
                  {(profiles.data?.profiles ?? []).map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              {[
                ['fulfillment_policy_id', 'Shipping policy', policies.data?.fulfillment],
                ['payment_policy_id', 'Payment policy', policies.data?.payment],
                ['return_policy_id', 'Return policy', policies.data?.returns],
              ].map(([k, label, list]: any) => (
                <Field key={k} label={label}>
                  <select className="input" value={draft[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
                    <option value="">Select...</option>
                    {(list ?? []).map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
              <Field label="Ships from">
                <select className="input" value={draft.merchant_location_key ?? ''} onChange={(e) => set('merchant_location_key', e.target.value)}>
                  <option value="">Select...</option>
                  {(locations.data?.locations ?? []).map((x: any) => (
                    <option key={x.merchantLocationKey} value={x.merchantLocationKey}>
                      {x.name ?? x.merchantLocationKey}
                    </option>
                  ))}
                </select>
              </Field>
              <Toggle
                checked={!!draft.best_offer_enabled}
                disabled={l.kind === 'group'}
                onChange={(v) => set('best_offer_enabled', v)}
                label="Accept Best Offers"
                description={l.kind === 'group' ? "eBay doesn't support Best Offer on multi-variation listings." : 'Auto-accept and auto-decline thresholds follow your pricing settings.'}
              />
            </div>
          </Card>

          <Card
            title="eBay market"
            description={l.kind === 'group' ? 'Pick a variant in the pricing table' : undefined}
            actions={
              <Button variant="ghost" className="px-2 py-1 text-xs" loading={busy === 'research'} onClick={() => run('research', () => post(`/api/listings/${id}/research`).then(() => q.reload()), 'Research complete')}>
                Research now
              </Button>
            }
          >
            {marketVariant && <MarketDetails key={`${marketVariant}-${q.data?.listing?.items?.[0]?.market?.taken_at ?? ''}`} variantId={marketVariant} currency={currency} />}
          </Card>

          <Card title="Danger zone">
            <div className="flex flex-wrap gap-2">
              {live && (
                <Button
                  loading={busy === 'end'}
                  onClick={async () => {
                    if (await confirm({ title: 'End this listing on eBay?', body: 'It will be removed from eBay. You can publish it again later.', confirm: 'End listing', danger: true }))
                      run('end', () => post(`/api/listings/${id}/end`).then(() => q.reload()), 'Listing ended');
                  }}
                >
                  End on eBay
                </Button>
              )}
              <Button
                variant="ghost"
                className="text-rose-600"
                disabled={live}
                title={live ? 'End the listing first' : undefined}
                onClick={async () => {
                  if (await confirm({ title: 'Delete this listing?', body: 'It is removed from this app. The Shopify product is not affected.', confirm: 'Delete', danger: true }))
                    run('del', () => del(`/api/listings/${id}`).then(() => navigate('/listings')), 'Deleted');
                }}
              >
                <Trash2 className="size-4" /> Delete
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CategoryPicker({ value, defaultQuery, onChange }: { value: { id: string | null; name: string | null }; defaultQuery: string; onChange: (c: { id: string; name: string }) => void }) {
  const [q, setQ] = useState(defaultQuery);
  const [results, setResults] = useState<any[] | null>(null);
  const { busy, run } = useAction();
  const search = () => run('cat', async () => setResults((await api(`/api/ebay/categories?q=${encodeURIComponent(q)}`)).categories));
  return (
    <div>
      <span className="label">eBay category</span>
      {value.id && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-brand-500/[0.06] px-3 py-2 text-sm ring-1 ring-brand-500/15">
          <CheckCircle2 className="size-4 shrink-0 text-brand-500" />
          <span className="min-w-0 flex-1 truncate">{value.name}</span>
          <span className="font-mono text-xs text-zinc-500">#{value.id}</span>
        </div>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <input className="input pl-9" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Describe the item to find a category" />
        </div>
        <Button loading={busy === 'cat'} onClick={search}>
          {value.id ? 'Change' : 'Find category'}
        </Button>
      </div>
      {results && (
        <ul className="mt-2 max-h-64 divide-y divide-zinc-100 overflow-y-auto rounded-xl border border-zinc-200 dark:divide-white/[0.05] dark:border-white/10">
          {results.map((c) => (
            <li key={c.id}>
              <button
                className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-white/[0.04]"
                onClick={() => {
                  onChange({ id: c.id, name: c.path });
                  setResults(null);
                }}
              >
                {c.path} <span className="font-mono text-xs text-zinc-400">#{c.id}</span>
              </button>
            </li>
          ))}
          {!results.length && <li className="px-3 py-3 text-sm text-zinc-500">No suggestions. Try different words.</li>}
        </ul>
      )}
    </div>
  );
}

function AspectsEditor({ categoryId, aspects, variesBy, items, kind, onChange, onVariesBy }: { categoryId: string; aspects: Record<string, string[]>; variesBy: string[]; items: any[]; kind: string; onChange: (a: Record<string, string[]>) => void; onVariesBy: (v: string[]) => void }) {
  const { data, loading, error } = useApi<{ aspects: Aspect[] }>(`/api/ebay/aspects?categoryId=${categoryId}`);
  const [showAll, setShowAll] = useState(false);
  const optionNames = [...new Set(items.flatMap((i) => Object.keys(i.options)))];
  const defs = data?.aspects ?? [];
  const known = new Set(defs.map((d) => d.name));
  const custom = Object.keys(aspects).filter((k) => !known.has(k));
  const visible = defs.filter((d) => d.required || d.recommended || showAll || aspects[d.name]?.length);
  const setVal = (name: string, raw: string, multi: boolean) => {
    const vals = multi ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw.trim() ? [raw] : [];
    const next = { ...aspects };
    if (vals.length) next[name] = vals;
    else delete next[name];
    onChange(next);
  };
  const coveredByVariant = (name: string) => kind === 'group' ? variesBy.includes(name) : items.every((i) => i.options[name]);

  return (
    <Card
      title="Item specifics"
      description="Required ones must be filled in. Recommended ones help buyers find you in search filters."
      actions={
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all (${defs.length})`}
        </Button>
      }
    >
      {kind === 'group' && (
        <div className="mb-5 rounded-xl bg-violet-500/[0.06] p-4 ring-1 ring-violet-500/15">
          <span className="label">Variations vary by</span>
          <div className="flex flex-wrap gap-2">
            {optionNames.map((n) => (
              <button key={n} onClick={() => onVariesBy(variesBy.includes(n) ? variesBy.filter((x) => x !== n) : [...variesBy, n])} className={cx('rounded-full px-3 py-1 text-sm ring-1 transition', variesBy.includes(n) ? 'bg-brand-500 text-white ring-brand-500' : 'ring-zinc-300 dark:ring-white/15')}>
                {n}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">These come from your Shopify options. Each variant's values (e.g. Red / XL) are sent to eBay automatically.</p>
        </div>
      )}
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Callout kind="error">{error}</Callout>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((d) => {
            const v = aspects[d.name] ?? [];
            const covered = !v.length && coveredByVariant(d.name);
            const listId = `asp-${d.name.replace(/\W/g, '')}`;
            return (
              <Field
                key={d.name}
                label={
                  <span className="flex items-center gap-1.5 normal-case">
                    {d.name}
                    {d.required && <Badge color="red">Required</Badge>}
                    {!d.required && d.recommended && <Badge color="blue">Recommended</Badge>}
                  </span>
                }
                hint={covered ? 'Filled in automatically from each variant' : d.multi ? 'Separate multiple values with commas' : undefined}
              >
                {!d.freeText && d.values.length ? (
                  <select className={cx('input', d.required && !v.length && !covered && 'border-rose-400')} value={v[0] ?? ''} onChange={(e) => setVal(d.name, e.target.value, false)}>
                    <option value="">{covered ? '(from variants)' : 'Select...'}</option>
                    {d.values.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input list={listId} className={cx('input', d.required && !v.length && !covered && 'border-rose-400')} value={v.join(', ')} placeholder={covered ? '(from variants)' : ''} onChange={(e) => setVal(d.name, e.target.value, d.multi)} />
                    <datalist id={listId}>
                      {d.values.slice(0, 100).map((x) => (
                        <option key={x} value={x} />
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
            );
          })}
          {custom.map((k) => (
            <Field key={k} label={<span className="normal-case">{k} <Badge>custom</Badge></span>}>
              <input className="input" value={aspects[k].join(', ')} onChange={(e) => setVal(k, e.target.value, true)} />
            </Field>
          ))}
        </div>
      )}
    </Card>
  );
}
