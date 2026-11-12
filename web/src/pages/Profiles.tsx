import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, del, post, put, useApi } from '../api.ts';
import { Badge, Button, Callout, Card, Drawer, Empty, Field, PageHeader, Toggle, useAction, useConfirm } from '../ui.tsx';

const EMPTY = {
  name: '',
  category_id: '',
  category_name: '',
  fulfillment_policy_id: '',
  payment_policy_id: '',
  return_policy_id: '',
  merchant_location_key: '',
  title_template: '',
  description_template: '',
  default_aspects: {} as Record<string, string[]>,
  best_offer_enabled: null as number | null,
  markup_min_pct: null as number | null,
  markup_max_pct: null as number | null,
};

export function Profiles() {
  const list = useApi('/api/profiles');
  const status = useApi('/api/status');
  const policies = useApi(status.data?.ebay?.connected ? '/api/ebay/policies' : null);
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: number }) | null>(null);
  const [catResults, setCatResults] = useState<any[] | null>(null);
  const [aspectText, setAspectText] = useState('');
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const profiles = (list.data?.profiles ?? []) as any[];

  const open = (p?: any) => {
    const v = p ? { ...EMPTY, ...p } : { ...EMPTY };
    setEdit(v);
    setCatResults(null);
    setAspectText(Object.entries(v.default_aspects ?? {}).map(([k, vals]) => `${k}: ${(vals as string[]).join(', ')}`).join('\n'));
  };
  const set = (k: string, v: unknown) => setEdit((e) => (e ? { ...e, [k]: v } : e));
  const save = () =>
    run(
      'save',
      async () => {
        const default_aspects = Object.fromEntries(
          aspectText
            .split('\n')
            .map((line) => line.split(':'))
            .filter((p) => p.length >= 2 && p[0].trim())
            .map(([k, ...rest]) => [k.trim(), rest.join(':').split(',').map((s) => s.trim()).filter(Boolean)]),
        );
        const body = { ...edit, default_aspects };
        if (edit?.id) await put(`/api/profiles/${edit.id}`, body);
        else await post('/api/profiles', body);
        setEdit(null);
        list.reload();
      },
      'Profile saved',
    );
  const policySelect = (k: string, label: string, opts: any[] = []) => (
    <Field label={label}>
      <select className="input" value={(edit as any)?.[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
        <option value="">Use default</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div>
      <PageHeader
        title="Listing profiles"
        description="Reusable presets for groups of similar products: category, policies, templates and item specifics. Pick one when bulk-listing."
        actions={
          <Button variant="primary" onClick={() => open()}>
            <Plus className="size-4" /> New profile
          </Button>
        }
      />
      {!profiles.length ? (
        <Card>
          <Empty icon={<Tags className="size-6" />} title="No profiles yet" description='Example: a "Headphones" profile with the right eBay category, your standard shipping policy and Type = "Over-Ear".' action={<Button variant="primary" onClick={() => open()}>Create a profile</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {profiles.map((p) => (
            <div key={p.id} className="card group p-5">
              <div className="flex items-start justify-between">
                <h3 className="font-semibold">{p.name}</h3>
                <div className="flex opacity-60 transition group-hover:opacity-100">
                  <button className="btn-ghost p-1.5" onClick={() => open(p)}>
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    className="btn-ghost p-1.5 text-rose-500"
                    onClick={async () => {
                      if (await confirm({ title: `Delete "${p.name}"?`, body: 'Listings using it keep their current settings.', confirm: 'Delete', danger: true })) run('del', () => del(`/api/profiles/${p.id}`).then(list.reload));
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{p.category_name || 'Category auto-detected'}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(p.markup_min_pct ?? p.markup_max_pct) !== null && <Badge color="violet">+{p.markup_min_pct ?? '?'}–{p.markup_max_pct ?? '?'}%</Badge>}
                {p.best_offer_enabled ? <Badge color="blue">Best Offer</Badge> : null}
                {Object.keys(p.default_aspects).length > 0 && <Badge>{Object.keys(p.default_aspects).length} item specifics</Badge>}
                {p.title_template && <Badge>Custom title</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}

      <Drawer
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? 'Edit profile' : 'New profile'}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" loading={busy === 'save'} disabled={!edit?.name} onClick={save}>
              Save profile
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-5">
            <Field label="Name">
              <input className="input" value={edit.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Headphones" />
            </Field>
            <div>
              <span className="label">eBay category</span>
              {edit.category_id && (
                <div className="mb-2 flex items-center justify-between rounded-xl bg-brand-500/[0.06] px-3 py-2 text-sm">
                  <span className="truncate">{edit.category_name}</span>
                  <button className="text-xs text-zinc-500 hover:underline" onClick={() => setEdit({ ...edit, category_id: '', category_name: '' })}>
                    clear
                  </button>
                </div>
              )}
              <input
                className="input"
                placeholder="Type and press Enter to search categories (leave empty to auto-detect per product)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = (e.target as HTMLInputElement).value;
                    run('cat', async () => setCatResults((await api(`/api/ebay/categories?q=${encodeURIComponent(v)}`)).categories));
                  }
                }}
              />
              {catResults && (
                <ul className="mt-2 max-h-52 divide-y divide-zinc-100 overflow-y-auto rounded-xl border border-zinc-200 dark:divide-white/5 dark:border-white/10">
                  {catResults.map((c) => (
                    <li key={c.id}>
                      <button className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-white/5" onClick={() => { setEdit({ ...edit, category_id: c.id, category_name: c.path }); setCatResults(null); }}>
                        {c.path}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {policySelect('fulfillment_policy_id', 'Shipping', policies.data?.fulfillment)}
              {policySelect('payment_policy_id', 'Payment', policies.data?.payment)}
              {policySelect('return_policy_id', 'Returns', policies.data?.returns)}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Min markup %" hint="Empty = global setting">
                <input type="number" step={0.5} className="input" value={edit.markup_min_pct ?? ''} onChange={(e) => set('markup_min_pct', e.target.value === '' ? null : Number(e.target.value))} />
              </Field>
              <Field label="Max markup %" hint="Empty = global setting">
                <input type="number" step={0.5} className="input" value={edit.markup_max_pct ?? ''} onChange={(e) => set('markup_max_pct', e.target.value === '' ? null : Number(e.target.value))} />
              </Field>
            </div>
            <Toggle checked={!!edit.best_offer_enabled} onChange={(v) => set('best_offer_enabled', v ? 1 : 0)} label="Enable Best Offer" description="Single-variation listings only" />
            <Field label="Title template" hint="Empty = default. Placeholders: {brand} {title} {options} {type} {sku}">
              <input className="input font-mono" value={edit.title_template ?? ''} onChange={(e) => set('title_template', e.target.value)} placeholder="{brand} {title} {options}" />
            </Field>
            <Field label="Default item specifics" hint='One per line, e.g. "Type: Over-Ear" or "Features: Bluetooth, Noise Cancelling"'>
              <textarea rows={5} className="input font-mono text-xs" value={aspectText} onChange={(e) => setAspectText(e.target.value)} />
            </Field>
            <Field label="Description template (HTML)" hint="Empty = default. Use {{title}} and {{description}}.">
              <textarea rows={8} className="input font-mono text-xs" value={edit.description_template ?? ''} onChange={(e) => set('description_template', e.target.value)} />
            </Field>
            <Callout kind="info">Profiles apply when listings are created. Existing listings can switch profile in the listing editor.</Callout>
          </div>
        )}
      </Drawer>
    </div>
  );
}
